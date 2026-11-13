#!/usr/bin/env python3
"""Pinned real Claude CLI fill, deterministic local API, controlled namespace teardown."""
import importlib.util
import json
import os
import pathlib
import select
import socket
import struct
import base64
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
MAX=16384
SUPERVISOR=r'''
import json,os,pathlib,subprocess,time,sys
control=pathlib.Path('/control')
(control/'init').write_text(json.dumps({'pid':os.getpid(),'namespace':os.readlink('/proc/self/ns/pid')}))
with (control/'inner.out').open('wb') as out,(control/'inner.err').open('wb') as err:
 child=subprocess.Popen(['/opt/node','/opt/inner.mjs',sys.argv[1]],stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={},pass_fds=(int(sys.argv[1]),))
 code=child.wait(timeout=75)
(control/'supervisor-complete').write_text(json.dumps({'innerExit':code}))
time.sleep(90)
'''
CHECKS={'clientExitZero','versionRead','policyNegatives','noHttpRefusals','requestsCrossed','noOutputOverflow','relayDescriptorAbsentFromCli'}

def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def read_json(file):
 if file.stat().st_size>MAX: raise RuntimeError('metadata output limit')
 return json.loads(file.read_bytes())

def wait_until(fn,label,seconds=12):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  result=fn()
  if result:return result
  time.sleep(.05)
 raise RuntimeError('timeout: '+label)

def start_host(node,root,sentinel,label):
 host_end,endpoint=socket.socketpair();endpoint.settimeout(15)
 errors=(root/('host-'+label+'.err')).open('wb')
 process=subprocess.Popen([str(node),str(HERE/'strict-relay-host.mjs'),str(host_end.fileno()),str(sentinel)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,pass_fds=(host_end.fileno(),),env={},start_new_session=True)
 host_end.close()
 return process,endpoint,errors

def line(stream):
 data=bytearray();end=time.monotonic()+15
 while len(data)<MAX and time.monotonic()<end:
  if not select.select([stream],[],[],max(0,end-time.monotonic()))[0]:break
  chunk=os.read(stream.fileno(),1)
  if not chunk:break
  if chunk==b'\n':return json.loads(data)
  data.extend(chunk)
 raise RuntimeError('bounded host receipt unavailable')

def send_frame(endpoint,value):
 data=json.dumps(value,separators=(',',':')).encode();endpoint.sendall(struct.pack('!I',len(data))+data)

def recv_frame(endpoint):
 def exact(n):
  result=bytearray()
  while len(result)<n:
   chunk=endpoint.recv(n-len(result))
   if not chunk:raise RuntimeError('relay ended early')
   result.extend(chunk)
  return result
 size=struct.unpack('!I',exact(4))[0]
 if size>MAX:raise RuntimeError('unexpected host reply size')
 return json.loads(exact(size))

def actual_round(client,node,root,number,case,checkpoint,namespace_fds,relay_fd):
 stage=root/('stage-%d'%number)
 control=stage/'control';control.mkdir(mode=0o700)
 home=stage/'home';home.mkdir(mode=0o700);(home/'.claude').mkdir(mode=0o700)
 uid,gid=os.getuid(),os.getgid()
 passwd=stage/'passwd';passwd.write_text('agent:x:%d:%d:Fixture:/home/agent:/bin/bash\n'%(uid,gid))
 group=stage/'group';group.write_text('agent:x:%d:\n'%gid)
 info=stage/'bwrap-info';process=None;init_fd=None;handles={}
 try:
  with info.open('wb') as stream,(stage/'bwrap.err').open('wb') as err:
   command=[shutil.which('bwrap'),'--unshare-all','--as-pid-1','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib']
   if pathlib.Path('/lib64').exists():command+=['--ro-bind','/lib64','/lib64']
   command+=['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/run','--dir','/opt','--dir','/etc','--dir','/home','--dir','/home/agent','--ro-bind',str(passwd),'/etc/passwd','--ro-bind',str(group),'/etc/group','--ro-bind',str(client),'/opt/claude','--ro-bind',str(node),'/opt/node','--ro-bind',str(HERE/'strict-relay-inner.mjs'),'/opt/inner.mjs','--bind',str(home),'/home/agent','--bind',str(stage/'tree'),'/work','--bind',str(control),'/control','--chdir','/work','--info-fd',str(stream.fileno()),'--',sys.executable,'-I','-c',SUPERVISOR,str(relay_fd)]
   def limits():
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE,(2*1024*1024,2*1024*1024))
    resource.setrlimit(resource.RLIMIT_CPU,(90,90))
   process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=err,pass_fds=(stream.fileno(),relay_fd),env={},start_new_session=True,preexec_fn=limits)
   def metadata():
    if process.poll() is not None:raise RuntimeError('namespace launch failed')
    try:return read_json(info)
    except (FileNotFoundError,json.JSONDecodeError):return None
   init_pid=wait_until(metadata,'init metadata')['child-pid']
   init_fd=os.pidfd_open(init_pid);handles[init_pid]=init_fd
   namespace=os.readlink('/proc/%d/ns/pid'%init_pid)
   if namespace==os.readlink('/proc/self/ns/pid') or namespace in namespace_fds:raise RuntimeError('namespace not distinct')
   namespace_fds[namespace]=os.open('/proc/%d/ns/pid'%init_pid,os.O_RDONLY)
   inner_init=wait_until(lambda:read_json(control/'init') if (control/'init').exists() else None,'supervisor ready')
   if inner_init!={'pid':1,'namespace':namespace}:raise RuntimeError('supervisor not namespace PID1')
   def census():
    observed=checkpoint.members(namespace)
    for pid in observed:
     if pid not in handles:
      try:handles[pid]=os.pidfd_open(pid)
      except ProcessLookupError:pass # observed short-lived child exited before handle acquisition
    return observed
   def completed():
    census()
    if process.poll() is not None:raise RuntimeError('supervisor exited early')
    if (control/'client-complete.json').exists() and (control/'supervisor-complete').exists():
     try:return read_json(control/'client-complete.json')
     except json.JSONDecodeError:return None
    return None
   inner=wait_until(completed,'actual CLI complete',90)
   expected_keys={'ok','strictState','clientExit','clientVersion','requests','negatives','checks'}
   if (set(inner)!=expected_keys or inner['ok'] is not True or inner['strictState']!='unverified' or inner['clientExit']!=0 or set(inner['checks'])!=CHECKS or any(v is not True for v in inner['checks'].values()) or inner['negatives']!=['MODEL_TARGET','MODEL_BODY_LIMIT'] or not 4<=inner['requests']<=6 or not isinstance(inner['clientVersion'],str)):
    raise RuntimeError('actual client acceptance failed: '+json.dumps(inner)[:2048])
   if read_json(control/'supervisor-complete')!={'innerExit':0}:raise RuntimeError('inner failed')
   writer=read_json(control/'writer-ready')
   if set(writer)!={'pid','namespace'} or writer['namespace']!=namespace:raise RuntimeError('writer identity invalid')
   observed=census()
   writer_hosts=[pid for pid,(nested,state) in observed.items() if nested==writer['pid'] and state!='Z']
   if len(writer_hosts)!=1:raise RuntimeError('detached writer not alive after CLI exit')
   before=(control/'writer-log').stat().st_size
   time.sleep(.12)
   census()
   after=(control/'writer-log').stat().st_size
   if after<=before:raise RuntimeError('writer did not advance after client exit')
   signal.pidfd_send_signal(init_fd,signal.SIGKILL)
   wait_until(lambda:len(select.select(list(handles.values()),[],[],0)[0])==len(handles),'all observed pidfds exit')
   wait_until(lambda:not any(state!='Z' for _,state in checkpoint.members(namespace).values()),'no live namespace members')
   process.wait(timeout=12)
   return {'namespace':namespace,'trackedProcesses':len(handles),'client':inner,'writerAdvancedAfterClientExit':True,'allPidfdsExitedBeforeCapture':True,'noLiveMembersBeforeCapture':True,'controlLogBytesAfterClientExit':[before,after]}
 finally:
  try:
   if init_fd is not None:
    try:signal.pidfd_send_signal(init_fd,signal.SIGKILL)
    except ProcessLookupError:pass
    if not select.select([init_fd],[],[],12)[0]:raise RuntimeError('namespace init cleanup unproven')
   if process is not None and process.poll() is None:
    try:os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    process.wait(timeout=12)
  finally:
   for handle in handles.values():os.close(handle)
  # Caller retains scratch on every failed round, even if cleanup killed init.

def main():
 result={'ok':False,'strictState':'unverified','scope':'actual pinned CLI through inherited socketpair to outside mock broker; no model inference'}
 root=None;namespace_fds={};safe_cleanup=True;code=2
 try:
  pin=load('actual_fill_client_pin','strict-client-probe.py')
  parser=pin.JsonArgumentParser()
  for name in ('client','client-sha256','node','node-sha256'):parser.add_argument('--'+name,required=True)
  args=parser.parse_args()
  if not sys.platform.startswith('linux') or not str(pathlib.Path(sys.executable).resolve()).startswith('/usr/'):raise ValueError('requires system /usr Python Linux')
  if not shutil.which('bwrap') or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):raise ValueError('requires Bubblewrap and pidfd APIs')
  client,chash,error=pin.validate_pin(args.client,args.client_sha256,'client')
  if error:result.update(error);return finish(result,2)
  node,nhash,error=pin.validate_pin(args.node,args.node_sha256,'node')
  if error:result.update(error);return finish(result,2)
  result.update(clientSha256=chash,nodeSha256=nhash)
  own=os.pidfd_open(os.getpid())
  try:signal.pidfd_send_signal(own,0)
  finally:os.close(own)
  fixture=load('actual_fill_candidate','strict-candidate-probe.py')
  checkpoint=fixture.load_checkpoint()
  parent=pathlib.Path(tempfile.gettempdir()).resolve()
  root=pathlib.Path(tempfile.mkdtemp(prefix='strict-candidate-probe-',dir=parent));os.chmod(root,0o700)
  token=str(uuid.uuid4());(root/'.fixture-owner').write_text(token)
  source=root/'source';source.mkdir(mode=0o700)
  (source/'plan.js').write_text('// fixture exterior\n// SKEL[1] selected\ninitial\n// /SKEL[1]\n// SKEL[2] other\npreserved\n// /SKEL[2]\n')
  (source/'context.txt').write_text('controlled fixture context\n')
  session=root/'host-session';code=1
  prepared=fixture.session_command(node,root,'prepare',['--prepare',source,session])
  if prepared.get('trace')!=['private-copy','enumerate','independent-capture','durable-capture-put','authority-reference','mock-approve']:raise RuntimeError('prepare order invalid')
  sentinel=root/'outside-private-sentinel';sentinel.write_text('OUTSIDE_PRIVATE_'+str(uuid.uuid4()))
  original_sentinel=sentinel.read_bytes()
  rounds=[]
  for number,case in enumerate(('valid',),1):
   stage=root/('stage-%d'%number);stage.mkdir(mode=0o700)
   seed=fixture.session_command(node,root,'seed-'+case,['--seed',stage/'tree',session])
   if seed!={'ok':True,'strictState':'unverified','action':'seed','reviewVersion':prepared['reviewVersion'],'captureVersion':prepared['captureVersion'],'exactStoredClone':True}:raise RuntimeError('approved clone identity mismatch')
   host,endpoint,host_errors=start_host(node,root,sentinel,'cli')
   try:
    safe_cleanup=False
    evidence=actual_round(client,node,root,number,case,checkpoint,namespace_fds,endpoint.fileno())
    safe_cleanup=True
    host.stdin.write(b'STOP\n');host.stdin.flush()
    if line(host.stdout)!={'event':'closed'}:raise RuntimeError('broker revocation unconfirmed')
    late={'version':1,'id':evidence['client']['requests']+3,'request':{'method':'POST','target':'/v1/messages','rawHeaders':[],'bodyBase64':'e30='}}
    send_frame(endpoint,late)
    late_answer=recv_frame(endpoint)
    if late_answer!={'version':1,'id':late['id'],'ok':False,'code':'BROKER_CLOSED'}:raise RuntimeError('late request not refused')
    endpoint.close()
    summary=line(host.stdout);host.wait(timeout=10)
    if host.returncode or summary.get('send')!=evidence['client']['requests'] or summary.get('credentialAdded') is not True or summary.get('toolResultsVerified') is not True or summary.get('closed') is not True or summary.get('snapshot',{}).get('inFlight')!=0:raise RuntimeError('outside broker accounting failed')
    if sentinel.read_bytes()!=original_sentinel:raise RuntimeError('outside private sentinel changed')
    evidence.update(outsideBroker=summary,lateRequestRefused=True,privateSentinelUnchanged=True)
   finally:
    endpoint.close()
    if host.poll() is None:host.kill();host.wait(timeout=10)
    host_errors.close()
   verification=fixture.session_command(node,root,'check-'+case,['--check',stage/'tree',session,case])
   expected={'ok':True,'strictState':'unverified','action':'check','case':case,'outcome':'accepted' if case=='valid' else 'rejected','code':None if case=='valid' else 'FIXTURE_EXTERIOR','selectedBodyChanged':True,'completionVerified':False}
   if verification!=expected:raise RuntimeError('candidate outcome mismatch')
   rounds.append({**evidence,'case':case,'seed':seed,'verification':verification})
  protocol=[]
  for label,payload,expected in [('oversized',struct.pack('!I',2*1024*1024+1),'RELAY_FRAME_BYTES'),('override',{'version':1,'id':1,'request':{'method':'POST','target':'/v1/messages','rawHeaders':[],'bodyBase64':'e30=','destination':'127.0.0.1'}},'RELAY_FRAME'),('partial',struct.pack('!I',20)+b'{','RELAY_PARTIAL_TIMEOUT')]:
   host,endpoint,errors=start_host(node,root,sentinel,label)
   try:
    if isinstance(payload,bytes):endpoint.sendall(payload)
    else:send_frame(endpoint,payload)
    refusal=recv_frame(endpoint)
    if refusal.get('ok') is not False or refusal.get('code')!=expected:raise RuntimeError('protocol refusal wrong')
    endpoint.close();summary=line(host.stdout);host.wait(timeout=10)
    if summary.get('send')!=0 or summary.get('snapshot',{}).get('inFlight')!=0:raise RuntimeError('malformed protocol reached provider')
    protocol.append(expected)
   finally:
    endpoint.close()
    if host.poll() is None:host.kill();host.wait(timeout=10)
    errors.close()
  result.update(ok=True,code='relay-probe-passed',rounds=rounds,protocolRefusals=protocol);code=0
 except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError) as exc:
  result.update(ok=False,code='actual-fill-probe-failed' if code==1 else 'unsupported',error=str(exc)[:4096])
 finally:
  for handle in namespace_fds.values():os.close(handle)
  if root is not None:
   if safe_cleanup:
    try:fixture.cleanup(root,parent,token)
    except (OSError,RuntimeError) as exc:result.update(ok=False,code='cleanup-failed',error=str(exc)[:1024]);code=1
   else:result.update(ok=False,retainedScratch=str(root));code=1
 return finish(result,code)

def finish(result,code):
 result['strictState']='unverified';print(json.dumps(result,sort_keys=True));return code
if __name__=='__main__':raise SystemExit(main())
