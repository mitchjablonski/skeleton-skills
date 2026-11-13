#!/usr/bin/env python3
"""Actual CLI relay through sibling isolated real TLS lab; no internet or inference."""
import importlib.util
import json
import os
import pathlib
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import uuid
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
SERVICE=r'''
import json,os,pathlib,subprocess,sys,time,resource
fd,host,scenario,sentinel=sys.argv[1:]
if os.readlink('/proc/self/ns/net')==host:raise RuntimeError('service netns equals host')
def ip(*args):return json.loads(subprocess.check_output(['/usr/sbin/ip','-j',*args],text=True,timeout=3))
if [x['ifname'] for x in ip('link','show')]!=['lo']:raise RuntimeError('external interface')
subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True,timeout=3)
subprocess.run(['/usr/sbin/ip','addr','add','8.8.8.8/32','dev','lo'],check=True,timeout=3)
routes=ip('route','show','table','all')+ip('-6','route','show','table','all')
if any(x.get('dev')!='lo' or x.get('dst')=='default' for x in routes):raise RuntimeError('external route')
pathlib.Path('/control/init').write_text(json.dumps({'pid':os.getpid(),'pidNamespace':os.readlink('/proc/self/ns/pid'),'networkNamespace':os.readlink('/proc/self/ns/net'),'userNamespace':os.readlink('/proc/self/ns/user'),'onlyLoopback':True,'noDefaultRoute':True}))
resource.setrlimit(resource.RLIMIT_FSIZE,(1048576,1048576));resource.setrlimit(resource.RLIMIT_CPU,(90,90))
child=subprocess.Popen(['/opt/node','/service/test/live/strict-relay-tls-service.mjs',fd,host,scenario,sentinel],stdin=sys.stdin,stdout=sys.stdout,stderr=sys.stderr,env={},pass_fds=(int(fd),))
code=child.wait(timeout=90)
pathlib.Path('/control/child-exit').write_text(json.dumps({'code':code}))
time.sleep(90)
'''

def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def profile(pid):
 root=pathlib.Path('/proc')/str(pid)/'net'
 interfaces=[line.split(':')[0].strip() for line in (root/'dev').read_text().splitlines() if ':' in line]
 if interfaces!=['lo']:raise RuntimeError('outside interface')
 if any((c:=line.split())[0]!='lo' or c[1]=='00000000' for line in (root/'route').read_text().splitlines()[1:]):raise RuntimeError('outside IPv4 route')
 for line in (root/'ipv6_route').read_text().splitlines():
  c=line.split();flags=int(c[8],16)
  if len(c)!=10 or c[-1]!='lo' or (c[0]=='0'*32 and c[1]=='00' and (not(flags&0x200) or flags&1)):raise RuntimeError('outside IPv6 route')

def start_service(node,root,fixtures,scenario,parent_net,relay,census):
 base=root/('service-'+scenario);base.mkdir(mode=0o700)
 controls=base/'control';controls.mkdir(mode=0o700)
 host_end,endpoint=socket.socketpair();endpoint.settimeout(15)
 info=(base/'bwrap-info').open('wb');errors=(base/'err').open('wb')
 modules=root/'service-modules'
 command=['/usr/bin/bwrap','--unshare-all','--as-pid-1','--uid','0','--gid','0','--die-with-parent','--new-session','--cap-add','CAP_NET_ADMIN','--cap-add','CAP_NET_BIND_SERVICE','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib']
 if pathlib.Path('/lib64').exists():command+=['--ro-bind','/lib64','/lib64']
 command+=['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/opt','--ro-bind',str(node),'/opt/node','--ro-bind',str(modules),'/service','--ro-bind',str(fixtures),'/fixtures','--bind',str(controls),'/control','--info-fd',str(info.fileno()),'--',sys.executable,'-I','-c',SERVICE,str(host_end.fileno()),parent_net,scenario,str(root/'outside-private-sentinel')]
 process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,pass_fds=(info.fileno(),host_end.fileno()),env={},start_new_session=True)
 host_end.close();info.close()
 handle=None;held=[];tracked={}
 try:
  def metadata():
   if process.poll() is not None:raise RuntimeError('service launch failed')
   try:return relay.read_json(base/'bwrap-info')
   except (FileNotFoundError,json.JSONDecodeError):return None
  pid=relay.wait_until(metadata,'service init')['child-pid'];handle=os.pidfd_open(pid)
  state=relay.wait_until(lambda:relay.read_json(controls/'init') if (controls/'init').exists() else None,'service ready')
  observed={key:os.readlink('/proc/%d/ns/%s'%(pid,kind)) for key,kind in [('pidNamespace','pid'),('networkNamespace','net'),('userNamespace','user')]}
  if state!={'pid':1,**observed,'onlyLoopback':True,'noDefaultRoute':True}:raise RuntimeError('service metadata mismatch')
  if any(observed[k]==os.readlink('/proc/self/ns/'+kind) for k,kind in [('pidNamespace','pid'),('networkNamespace','net'),('userNamespace','user')]):raise RuntimeError('service not separate')
  profile(pid)
  ready=relay.line(process.stdout)
  if ready!={'event':'ready','scenario':scenario,'networkNamespace':observed['networkNamespace'],'pidNamespace':observed['pidNamespace']}:raise RuntimeError('service entry not ready')
  held=[os.open('/proc/%d/ns/%s'%(pid,n),os.O_RDONLY) for n in ('pid','net','user')]
  tracked={pid:handle}
  for member in census(observed['pidNamespace']):
   if member!=pid:
    try:tracked[member]=os.pidfd_open(member)
    except ProcessLookupError:pass
  if len(tracked)<2:raise RuntimeError('service Node process not observed')
  return {'process':process,'endpoint':endpoint,'errors':errors,'pid':pid,'handle':handle,'tracked':tracked,'held':held,'state':state,'controls':controls}
 except:
  endpoint.close()
  if handle is not None:
   try:signal.pidfd_send_signal(handle,signal.SIGKILL)
   except ProcessLookupError:pass
   select.select([handle],[],[],12);os.close(handle)
  if process.poll() is None:process.kill();process.wait(timeout=12)
  for fd in held:os.close(fd)
  for fd in tracked.values():
   if fd!=handle:os.close(fd)
  process.stdin.close();process.stdout.close()
  errors.close();raise

def service_death(service,checkpoint,relay):
 process=service['process'];tracked=service['tracked'];handles=list(tracked.values())
 try:
  for pid in checkpoint.members(service['state']['pidNamespace']):
   if pid not in tracked:
    try:handles.append(os.pidfd_open(pid))
    except ProcessLookupError:pass
  signal.pidfd_send_signal(service['handle'],signal.SIGKILL)
  relay.wait_until(lambda:len(select.select(handles,[],[],0)[0])==len(handles),'service all pidfds')
  relay.wait_until(lambda:not any(state!='Z' for _,state in checkpoint.members(service['state']['pidNamespace']).values()),'service no live members')
  process.wait(timeout=12)
  process.stdin.close();process.stdout.close()
  return {'allServicePidfdsExited':True,'noLiveServiceMembers':True,'trackedServiceProcesses':len(handles)}
 finally:
  for fd in handles:os.close(fd)
  service['handle']=None
  for fd in service['held']:os.close(fd)
  service['errors'].close()

def main():
 result={'ok':False,'strictState':'unverified','scope':'actual CLI relay through sibling isolated TLS service; no internet or inference'}
 code=2;root=None;safe=True;held={};service=None
 try:
  relay=load('combined_relay','strict-relay-probe.py');pin=load('combined_pin','strict-client-probe.py');lab=load('combined_certs','strict-tls-lab.py')
  parser=pin.JsonArgumentParser()
  for n in ('client','client-sha256','node','node-sha256'):parser.add_argument('--'+n,required=True)
  args=parser.parse_args()
  if not sys.platform.startswith('linux') or not str(pathlib.Path(sys.executable).resolve()).startswith('/usr/'):raise RuntimeError('requires system /usr Python Linux')
  for tool in ('/usr/bin/bwrap','/usr/sbin/ip','/usr/bin/openssl'):
   if not os.access(tool,os.X_OK):raise RuntimeError('missing fixture tool')
  client,chash,error=pin.validate_pin(args.client,args.client_sha256,'client')
  if error:return relay.finish({**result,**error},2)
  node,nhash,error=pin.validate_pin(args.node,args.node_sha256,'node')
  if error:return relay.finish({**result,**error},2)
  result.update(clientSha256=chash,nodeSha256=nhash)
  own=os.pidfd_open(os.getpid())
  try:signal.pidfd_send_signal(own,0)
  finally:os.close(own)
  fixture=load('combined_candidate','strict-candidate-probe.py');checkpoint=fixture.load_checkpoint();base_members=checkpoint.members
  parent=pathlib.Path(tempfile.gettempdir()).resolve();root=pathlib.Path(tempfile.mkdtemp(prefix='strict-candidate-probe-',dir=parent));os.chmod(root,0o700)
  token=str(uuid.uuid4());(root/'.fixture-owner').write_text(token);code=1
  certs=root/'certificates';certs.mkdir(mode=0o700);generated=lab.certificates(certs)
  fixtures=root/'runtime-certificates';fixtures.mkdir(mode=0o700)
  for name in ('ca.crt','other-ca.crt','server.crt','server.key'):shutil.copyfile(generated/name,fixtures/name)
  repo=HERE.parents[1];modules=root/'service-modules'
  for relative in ('lib/strict-model-policy.mjs','lib/strict-model-broker.mjs','lib/strict-model-tls-lab.mjs','test/live/strict-relay-host.mjs','test/live/strict-relay-tls-service.mjs'):
   target=modules/relative;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copyfile(repo/relative,target)
  source=root/'source';source.mkdir(mode=0o700)
  (source/'plan.js').write_text('// fixture exterior\n// SKEL[1] selected\ninitial\n// /SKEL[1]\n// SKEL[2] other\npreserved\n// /SKEL[2]\n');(source/'context.txt').write_text('controlled fixture context\n')
  sentinel=root/'outside-private-sentinel';sentinel.write_text('PRIVATE_'+str(uuid.uuid4()));original=sentinel.read_bytes()
  session=root/'host-session';prepared=fixture.session_command(node,root,'prepare',['--prepare',source,session]);rows=[]
  parent_net=os.readlink('/proc/self/ns/net');seen_networks=set();seen_pids=set()
  for number,scenario in enumerate(('valid','untrusted','peer-mismatch','redirect'),1):
   safe=False;service=start_service(node,root,fixtures,scenario,parent_net,relay,base_members)
   for index,fd in enumerate(service['held']):held['service-%s-%d'%(scenario,index)]=os.dup(fd)
   state=service['state'];endpoint=service['endpoint'];process=service['process']
   if state['networkNamespace'] in seen_networks or state['pidNamespace'] in seen_pids:raise RuntimeError('service namespace reused')
   seen_networks.add(state['networkNamespace']);seen_pids.add(state['pidNamespace'])
   worker={}
   def members(namespace):
    observed=base_members(namespace)
    if namespace!=state['pidNamespace'] and observed:
     init=next((pid for pid,(nested,_) in observed.items() if nested==1),None)
     if init is not None and not worker:
      net=os.readlink('/proc/%d/ns/net'%init);user=os.readlink('/proc/%d/ns/user'%init)
      if net in seen_networks or net==parent_net or user==state['userNamespace'] or user==os.readlink('/proc/self/ns/user'):raise RuntimeError('worker not sibling isolated')
      profile(init)
      cap=next(line.split()[1] for line in pathlib.Path('/proc/%d/status'%init).read_text().splitlines() if line.startswith('CapEff:'))
      if int(cap,16)!=0:raise RuntimeError('worker capabilities not dropped')
      held['worker-net']=os.open('/proc/%d/ns/net'%init,os.O_RDONLY);held['worker-user']=os.open('/proc/%d/ns/user'%init,os.O_RDONLY)
      worker.update(networkNamespace=net,userNamespace=user,onlyLoopback=True,noDefaultRoute=True,noEffectiveCapabilities=True)
    return observed
   checkpoint.members=members
   if scenario=='valid':
    stage=root/'stage-1';stage.mkdir(mode=0o700)
    seed=fixture.session_command(node,root,'seed-valid',['--seed',stage/'tree',session])
    if seed.get('captureVersion')!=prepared['captureVersion'] or seed.get('reviewVersion')!=prepared['reviewVersion'] or seed.get('exactStoredClone') is not True:raise RuntimeError('seed mismatch')
    evidence=relay.actual_round(client,node,root,1,'valid',checkpoint,held,endpoint.fileno())
    if not worker:raise RuntimeError('missing worker topology evidence')
    safe=True
    verification=fixture.session_command(node,root,'check-valid',['--check',stage/'tree',session,'valid'])
    if verification.get('outcome')!='accepted' or verification.get('selectedBodyChanged') is not True:raise RuntimeError('fill failed')
    process.stdin.write(b'STOP\n');process.stdin.flush()
    if relay.line(process.stdout)!={'event':'closed'}:raise RuntimeError('revocation failed')
    late={'version':1,'id':evidence['client']['requests']+3,'request':{'method':'POST','target':'/v1/messages','rawHeaders':[],'bodyBase64':'e30='}}
    relay.send_frame(endpoint,late)
    if relay.recv_frame(endpoint)!={'version':1,'id':late['id'],'ok':False,'code':'BROKER_CLOSED'}:raise RuntimeError('late alias not revoked')
    row={'case':scenario,'worker':worker,'actualClient':evidence,'seed':seed,'verification':verification,'lateAliasRefused':True}
   else:
    relay.send_frame(endpoint,{'version':1,'id':1,'request':{'method':'POST','target':'/v1/messages','rawHeaders':[],'bodyBase64':'e30='}})
    refusal=relay.recv_frame(endpoint);expected={'untrusted':'BROKER_TLS','peer-mismatch':'BROKER_PEER','redirect':'MODEL_REDIRECT_REFUSED'}[scenario]
    if refusal!={'version':1,'id':1,'ok':False,'code':expected}:raise RuntimeError('wrong TLS refusal: '+json.dumps(refusal))
    process.stdin.write(b'STOP\n');process.stdin.flush()
    if relay.line(process.stdout)!={'event':'closed'}:raise RuntimeError('negative revocation failed')
    row={'case':scenario,'code':expected}
   endpoint.close();summary=relay.line(process.stdout)
   child=relay.wait_until(lambda:relay.read_json(service['controls']/'child-exit') if (service['controls']/'child-exit').exists() else None,'service child finished')
   if child!={'code':0} or summary.get('snapshot',{}).get('closed') is not True or summary.get('snapshot',{}).get('inFlight')!=0:raise RuntimeError('service broker not settled')
   t=summary.get('tls',{});expected_requests=evidence['client']['requests'] if scenario=='valid' else int(scenario=='redirect')
   if t.get('connects')!=(expected_requests if scenario=='valid' else 1) or t.get('requests')!=expected_requests or t.get('httpRequests')!=expected_requests or t.get('liveSockets')!=0 or t.get('keyObserved') is not bool(expected_requests):raise RuntimeError('TLS request/key counts wrong')
   if scenario=='valid' and (summary.get('toolResultsVerified') is not True or any(x!='8.8.8.8' for x in t['peers']) or any(x!='api.anthropic.com' for x in t['sni'])):raise RuntimeError('real TLS acceptance failed')
   row.update(service=state,tls=t,serviceDeath=service_death(service,checkpoint,relay));service=None;safe=True
   if sentinel.read_bytes()!=original:raise RuntimeError('private sentinel modified')
   rows.append(row)
  result.update(ok=True,code='relay-real-tls-passed',rows=rows,privateSentinelUnchanged=True);code=0
 except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError) as error:result.update(code='unsupported' if code==2 else 'relay-real-tls-failed',error=str(error)[:4096])
 finally:
  if service is not None:
   try:
    service['endpoint'].close()
    if service['handle'] is not None:service_death(service,checkpoint,relay)
   except (OSError,RuntimeError,subprocess.SubprocessError):pass
   safe=False
  for handle in held.values():os.close(handle)
  if root is not None:
   if safe:
    try:fixture.cleanup(root,parent,token)
    except (OSError,RuntimeError) as error:result.update(ok=False,code='cleanup-failed',error=str(error)[:1024]);code=1
   else:result.update(ok=False,retainedScratch=str(root));code=1
 return relay.finish(result,code)
if __name__=='__main__':raise SystemExit(main())
