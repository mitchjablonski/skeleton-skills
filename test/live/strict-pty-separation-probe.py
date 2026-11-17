#!/usr/bin/python3
"""Opt-in Linux synthetic PTY separation fixture. Never human proof."""
import json
import os
import pathlib
import platform
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import tty

HERE=pathlib.Path(__file__).resolve().parent
MAX=32768

def limits():
 import resource
 resource.setrlimit(resource.RLIMIT_FSIZE,(MAX,MAX))
 resource.setrlimit(resource.RLIMIT_CPU,(10,10))

def observed(process):
 return os.waitid(os.P_PID,process.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)

def launch(command,root,label,processes,fds=(),environment=None):
 with (root/(label+'.out')).open('wb') as out,(root/(label+'.err')).open('wb') as err:
  process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=out,stderr=err,pass_fds=fds,env={} if environment is None else environment,start_new_session=True,preexec_fn=limits)
 processes.append((process,label));return process

def launch_control(command,slave,processes):
 process=subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,close_fds=True,env={},start_new_session=True,preexec_fn=limits)
 processes.append((process,'control'));return process

def devpts_mounts():
 with open('/proc/self/mountinfo','rb') as source: data=source.read(1048577)
 assert len(data)<=1048576
 lines=[line.decode('utf-8').strip() for line in data.splitlines() if b' - devpts ' in line]
 assert len(lines)<=16 and all(len(line)<=4096 for line in lines)
 return lines

def result_of(process,root,label):
 deadline=time.monotonic()+10
 while observed(process) is None:
  if time.monotonic()>deadline: raise RuntimeError('helper timeout')
  time.sleep(.01)
 status=observed(process)
 assert status.si_code==os.CLD_EXITED and status.si_status==0
 assert (root/(label+'.out')).stat().st_size<=MAX and (root/(label+'.err')).stat().st_size<=MAX
 result=json.loads((root/(label+'.out')).read_bytes());assert result['ok'] is True
 return result

def read_exact(fd,value):
 deadline=time.monotonic()+3;answer=b''
 while len(answer)<len(value):
  remaining=deadline-time.monotonic()
  assert remaining>0 and select.select([fd],[],[],remaining)[0]
  answer+=os.read(fd,len(value)-len(answer))
 assert answer==value

def main():
 result={'ok':False,'strictState':'unverified','code':'unsupported'};exit_code=2
 root=None;processes=[];fds=[];sockets=[];cleanup=True;descendant_pidfd=None;descendant_started=False
 try:
  if sys.flags.optimize: raise RuntimeError('optimized interpreter unsupported')
  assert len(sys.argv)==1 and sys.platform.startswith('linux')
  assert pathlib.Path(sys.executable).resolve()==pathlib.Path('/usr/bin/python3').resolve()
  assert pathlib.Path('/usr/bin/bwrap').is_file()
  assert all(hasattr(os,name) for name in ('waitid','WNOWAIT','CLD_EXITED','P_PID','WEXITED','WNOHANG','pidfd_open'))
  observations={'kernelRelease':platform.release(),'machine':platform.machine(),'pythonVersion':platform.python_version()}
  assert all(len(value)<=256 for value in observations.values())
  host_mounts=devpts_mounts()
  root=pathlib.Path(tempfile.mkdtemp(prefix='strict-pty-separation-')).resolve();os.chmod(root,0o700)
  # Prerequisite check uses the same namespace/devpts configuration as the worker.
  base=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib']
  if pathlib.Path('/lib64').exists(): base+=['--ro-bind','/lib64','/lib64']
  base+=['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev']
  prerequisite=launch(base+['--','/usr/bin/python3','-I','-c','import os,json; a,b=os.openpty(); print(json.dumps({"ok":True}))'],root,'prerequisite',processes)
  result_of(prerequisite,root,'prerequisite')
  exit_code=1;result['code']='fixture-failed'
  master,slave=os.openpty();fds.extend([master,slave]);tty.setraw(slave)
  ready=root/'control-ready.json';worker=HERE/'strict-pty-separation-worker.py'
  control=launch_control(['/usr/bin/python3','-I',str(worker),'control',str(ready)],slave,processes)
  deadline=time.monotonic()+3
  while not ready.exists():
   assert observed(control) is None and time.monotonic()<deadline;time.sleep(.01)
  # Atomicity is unnecessary here: the trusted helper may still be flushing.
  while True:
   try: target=json.loads(ready.read_bytes());break
   except ValueError: assert time.monotonic()<deadline;time.sleep(.01)
  assert target['sid']==target['pgid']==control.pid
  target['fd']=0
  os.close(slave);fds.remove(slave)
  canary=os.urandom(24).hex().encode()+b'\n';os.write(master,canary);read_exact(master,canary)
  paths=[]
  for name in ('X11-synthetic','wayland-synthetic','bus-synthetic'):
   pathname=str(root/name);listener=socket.socket(socket.AF_UNIX);listener.bind(pathname);listener.listen(1);sockets.append(listener);paths.append(pathname)
   with socket.socket(socket.AF_UNIX) as client:
    client.connect(pathname);accepted,_=listener.accept();accepted.close()
  environment={name:'synthetic-fixture-sentinel' for name in ('DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','WSL_INTEROP','WSLENV')}
  environment_control='import os,json; keys='+repr(tuple(environment))+'; assert all(os.environ.get(key)=="synthetic-fixture-sentinel" for key in keys); print(json.dumps({"ok":True}))'
  positive=launch([arg for arg in base if arg!='--clearenv']+['--','/usr/bin/python3','-I','-c',environment_control],root,'environment-positive',processes,environment=environment)
  result_of(positive,root,'environment-positive')
  agent=launch(base+['--ro-bind',str(worker),'/worker.py','--','/usr/bin/python3','-I','/worker.py','agent',json.dumps(target),*paths],root,'agent',processes,environment=environment)
  evidence=result_of(agent,root,'agent')
  assert observed(control) is None
  assert not select.select([master],[],[],.2)[0], 'unexpected control terminal bytes'
  os.write(master,canary);read_exact(master,canary)
  assert evidence['devptsMounts'], 'missing agent devpts evidence'
  descendant_record=root/'supervised-descendant.json'
  group_leader=launch(['/usr/bin/python3','-I',str(worker),'group-descendant',str(descendant_record)],root,'group-descendant',processes)
  descendant_started=True
  group_result=result_of(group_leader,root,'group-descendant')
  descendant=json.loads(descendant_record.read_bytes())
  assert descendant['pgid']==group_leader.pid==group_result['leaderPgid']
  descendant_pidfd=os.pidfd_open(descendant['pid'])
  assert os.getpgid(descendant['pid'])==group_leader.pid, 'descendant group mismatch'
  assert not select.select([descendant_pidfd],[],[],0)[0], 'descendant not alive before cleanup'
  result.update(ok=True,code='pty-separation-fixture-passed',controlRoundtrips=2,controlStayedAlive=True,controlNoExtraBytes=True,syntheticSocketPositiveControls=3,syntheticEnvironmentPositiveControl=True,agent=evidence,hostDevptsMounts=host_mounts,platform=observations,limitations=['synthetic fixture only','TIOCSTI outcome does not establish causal denial when kernel disables it','no actual WSLg clipboard automation or human bootstrap evidence','no lifecycle death-cascade or hostile session-escaping descendant coverage']);exit_code=0
 except (AssertionError,OSError,ValueError,TypeError,RuntimeError,KeyError,subprocess.SubprocessError): pass
 finally:
  for process,label in processes:
   try:
    # No leader has been reaped; reserve its numeric PID/PGID through signalling.
    try: os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    process.wait(timeout=5)
   except (OSError,subprocess.SubprocessError): cleanup=False
  if descendant_started and descendant_pidfd is None: cleanup=False
  if descendant_pidfd is not None:
   try:
    if not select.select([descendant_pidfd],[],[],5)[0]: cleanup=False
    else: result['supervisedDescendantStopped']=True
   except OSError: cleanup=False
   finally:
    try: os.close(descendant_pidfd)
    except OSError: cleanup=False
  for fd in fds:
   try: os.close(fd)
   except OSError: cleanup=False
  for sock in sockets:
   try: sock.close()
   except OSError: cleanup=False
  if root is not None and cleanup:
   try:
    assert root.parent==pathlib.Path(tempfile.gettempdir()).resolve() and root.name.startswith('strict-pty-separation-') and not root.is_symlink()
    shutil.rmtree(root)
   except (OSError,AssertionError): cleanup=False
  if not cleanup:
   result.update(ok=False,code='cleanup-failed',cleanupFailed=True);exit_code=1
   if root is not None and root.exists(): result['retainedScratch']=str(root)
  print(json.dumps(result,sort_keys=True))
 return exit_code

if __name__=='__main__': raise SystemExit(main())
