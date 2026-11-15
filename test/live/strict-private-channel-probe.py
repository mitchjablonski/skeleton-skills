#!/usr/bin/env python3
"""Development socketpair fixture; trusted same-uid host peers, no human proof.

Run with system Linux Python and --node ABSOLUTE --node-sha256 SHA256.
The separate minimal Bubblewrap worker checks this fixture's descriptor/path
exclusion only, not every profile escape or a trusted PTY.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
MAX=16384

class ArgumentError(ValueError):pass

class ArgumentParser(argparse.ArgumentParser):
 def error(self,message):raise ArgumentError('invalid arguments')

def load():
 spec=importlib.util.spec_from_file_location('private_channel_pin',HERE/'strict-client-probe.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def limits():
 import resource
 resource.setrlimit(resource.RLIMIT_FSIZE,(MAX,MAX))
 resource.setrlimit(resource.RLIMIT_CPU,(15,15))

def launch(command,root,label,fds=()):
 out=(root/(label+'.out')).open('wb');err=(root/(label+'.err')).open('wb')
 try:
  process=subprocess.Popen(list(map(str,command)),stdin=subprocess.DEVNULL,stdout=out,stderr=err,pass_fds=fds,env={},start_new_session=True,preexec_fn=limits)
 finally:out.close();err.close()
 return process,label

def observed_exit(process):
 # WNOWAIT keeps the exited leader as a zombie, reserving its PID/PGID until
 # final group cleanup. Never call poll/wait before that cleanup boundary.
 return os.waitid(os.P_PID,process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)

def reap(item,root):
 process,label=item
 deadline=time.monotonic()+12
 while True:
  status=observed_exit(process)
  if status is not None:break
  if time.monotonic()>deadline:raise RuntimeError('helper timeout')
  time.sleep(0.01)
 out=root/(label+'.out');err=root/(label+'.err')
 if status.si_code!=os.CLD_EXITED or status.si_status!=0 or out.stat().st_size>MAX or err.stat().st_size>MAX:raise RuntimeError('helper failed')
 answer=json.loads(out.read_bytes())
 if answer.get('ok') is not True:raise RuntimeError('helper assertion failed')
 return answer

def denial(root,processes):
 public=root/'public';public.mkdir(mode=0o700);(public/'control').write_text('public fixture control\n')
 script="""import json,os,socket,sys
assert open('/public/control').read()=='public fixture control\\n'
for raw in os.listdir('/proc/self/fd'):
 if int(raw)>2:
  try:os.readlink('/proc/self/fd/'+raw)
  except FileNotFoundError:continue
  raise RuntimeError('unexpected inherited descriptor')
for name in sys.argv[1:]:
 try:fd=os.open(name,os.O_RDONLY)
 except FileNotFoundError:pass
 else:os.close(fd);raise RuntimeError('private path readable')
 try:fd=os.open(name+'.worker-canary',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 except FileNotFoundError:pass
 else:os.close(fd);raise RuntimeError('private path writable')
# No pathname listener is created by the host; connecting a guessed private
# pathname must fail as well as reading the private bootstrap/store/capture.
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:s.connect(sys.argv[1]+'.endpoint')
except FileNotFoundError:pass
else:raise RuntimeError('named endpoint reachable')
finally:s.close()
print(json.dumps({'ok':True,'onlyStdioInherited':True,'publicControlReadable':True,'privatePathsDenied':True,'namedEndpointAbsent':True}))
"""
 command=[shutil.which('bwrap'),'--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib']
 if pathlib.Path('/lib64').exists():command+=['--ro-bind','/lib64','/lib64']
 command+=['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--ro-bind',str(public),'/public','--',sys.executable,'-I','-c',script,str(root/'bootstrap.json'),str(root/'authority'/'human-authority.json'),str(root/'captures')]
 item=launch(command,root,'negative');processes.append(item);return reap(item,root)

def main():
 result={'ok':False,'strictState':'unverified','code':'unsupported'};root=None;processes=[];cleanup_ok=True;exit_code=2
 try:
  parser=ArgumentParser(add_help=False);parser.add_argument('--node',required=True);parser.add_argument('--node-sha256',required=True);args=parser.parse_args()
  if not sys.platform.startswith('linux') or not str(pathlib.Path(sys.executable).resolve()).startswith('/usr/') or not shutil.which('bwrap') or not all(hasattr(os,name) for name in ('waitid','P_PID','WEXITED','WNOHANG','WNOWAIT','CLD_EXITED')):raise RuntimeError('unsupported platform')
  pin=load();result['code']='pin-invalid'
  node,digest,error=pin.validate_pin(args.node,args.node_sha256,'node')
  if error:raise RuntimeError('pin validation failed')
  result['code']='unsupported'
  root=pathlib.Path(tempfile.mkdtemp(prefix='strict-private-channel-')).resolve();os.chmod(root,0o700)
  worker=HERE/'strict-private-channel-worker.mjs'
  spec=importlib.util.spec_from_file_location('private_runtime_receipt',HERE/'strict-runtime-receipt.py')
  receipt_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(receipt_module)
  if pathlib.Path(shutil.which('bwrap')).resolve()!=pathlib.Path('/usr/bin/bwrap').resolve():raise RuntimeError('runtime receipt tool mismatch')
  try:
   receipt=receipt_module.capture_runtime_receipt(node,node,root,client_role='node-channel-control',client_entrypoint=worker)
  except receipt_module.ReceiptCleanupFailed:
   cleanup_ok=False;exit_code=1
   raise
  if receipt['descriptor']['client_sha256']!=digest or receipt['descriptor']['node_sha256']!=digest:raise RuntimeError('runtime receipt pin changed')
  result['runtimeReceipt']=receipt
  exit_code=1;result['code']='runtime-failed'
  def run(mode,label):
   item=launch([node,worker,mode,root],root,label);processes.append(item);return reap(item,root)
  prepared=run('prepare','prepare')
  evidence=[]
  for number,round_name in enumerate(('first','replay')):
   left,right=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
   try:
    server=launch([node,worker,'server',root,left.fileno(),round_name],root,'server-'+round_name,(left.fileno(),));processes.append(server)
    left.close()
    # Bootstrap is explicitly fixture injected. The first server owns code
    # derivation; the control client receives it only from the private file.
    deadline=time.monotonic()+5
    while not (root/('ready-'+round_name)).exists():
     if observed_exit(server[0]) is not None or time.monotonic()>deadline:raise RuntimeError('bootstrap unavailable')
     time.sleep(0.01)
    # Launch while a live channel peer is held by this parent. pass_fds=()
    # and close_fds (Popen default) exclude it from the actual worker.
    if number==0:negative=denial(root,processes)
    client=launch([node,worker,'client',root,right.fileno(),round_name],root,'client-'+round_name,(right.fileno(),));processes.append(client);right.close()
    evidence.append(reap(client,root));evidence.append(reap(server,root))
   finally:left.close();right.close()
  verified=run('verify','verify')
  if not evidence[0].get('fixedUnavailable') or not evidence[2].get('retainedResult'):raise RuntimeError('channel evidence missing')
  result.update(ok=True,code='private-channel-probe-passed',nodeSha256=digest,captureVersion=prepared['captureVersion'],reviewVersion=prepared['reviewVersion'],lostReplyUnavailable=True,sameIdRetainedResult=True,durableBytesUnchanged=verified['durableBytesUnchanged'],commands=verified['commands'],journal=verified['journal'],socketpairs=2,protectedObservations=1,negativeWorker=negative);exit_code=0
 except ArgumentError:result['code']='invalid-arguments'
 except (OSError,ValueError,RuntimeError,KeyError,subprocess.SubprocessError):pass
 finally:
  for process,label in processes:
   try:
    # Leader has never been reaped: its reserved PID anchors this PGID.
    try:os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    process.wait(timeout=5)
   except (OSError,subprocess.SubprocessError):cleanup_ok=False
  if root is not None:
   if cleanup_ok:
    try:
     assert root.parent==pathlib.Path(tempfile.gettempdir()).resolve() and root.name.startswith('strict-private-channel-') and not root.is_symlink()
     shutil.rmtree(root)
    except (OSError,AssertionError):cleanup_ok=False
   if not cleanup_ok:result.update(ok=False,code='cleanup-failed',cleanupFailed=True);exit_code=1
  result['strictState']='unverified';print(json.dumps(result,sort_keys=True))
 return exit_code
if __name__=='__main__':raise SystemExit(main())
