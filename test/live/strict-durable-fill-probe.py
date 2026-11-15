#!/usr/bin/env python3
"""Development-only durable human-writer fixture and contained actual CLI fill."""
import importlib.util
import json
import os
import pathlib
import select
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
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,HERE/file)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def read_json(file):
 if file.stat().st_size>MAX: raise RuntimeError('metadata output limit')
 return json.loads(file.read_bytes())

def session_command(node,root,label,arguments):
 output=root/(label+'.out'); errors=root/(label+'.err')
 def limits():
  import resource
  resource.setrlimit(resource.RLIMIT_FSIZE,(MAX,MAX))
  resource.setrlimit(resource.RLIMIT_CPU,(15,15))
 with output.open('wb') as out,errors.open('wb') as err:
  process=subprocess.Popen([str(node),str(HERE/'strict-durable-fill-worker.mjs'),*map(str,arguments)],stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={},start_new_session=True,preexec_fn=limits)
  try:process.wait(timeout=20)
  except subprocess.TimeoutExpired:
   os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=8)
   raise RuntimeError('durable session helper timeout')
 if process.returncode or output.stat().st_size>MAX or errors.stat().st_size>MAX:
  raise RuntimeError('durable session helper failed: '+output.read_text()[:1024]+errors.read_text()[:1024])
 return read_json(output)

def private_path_denial(session,capture_version):
 # Separate minimal sandbox only; actual CLI mount scoping is defined by actual_round.
 script="""import json,os,sys
for raw in os.listdir('/proc/self/fd'):
 if int(raw)>2:
  try:os.readlink('/proc/self/fd/'+raw)
  except FileNotFoundError:continue
  raise RuntimeError('inherited nonstandard descriptor')
for index,name in enumerate(sys.argv[1:]):
 flags=os.O_RDONLY if index<2 else os.O_WRONLY|os.O_CREAT|os.O_EXCL
 try:
  fd=os.open(name,flags,0o600)
 except FileNotFoundError:pass
 else:
  os.close(fd)
  raise RuntimeError('private host path reachable')
print(json.dumps({'directPrivateReadsDenied':True,'directPrivateWritesDenied':True}))
"""
 command=[shutil.which('bwrap'),'--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib']
 if pathlib.Path('/lib64').exists():command+=['--ro-bind','/lib64','/lib64']
 command+=['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--',sys.executable,'-I','-c',script,str(session/'authority'/'human-authority.json'),str(session/'captures'/(capture_version+'.json')),str(session/'authority'/'worker-canary'),str(session/'captures'/'worker-canary')]
 completed=subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,env={},timeout=15,check=True)
 if len(completed.stdout)>MAX or len(completed.stderr)>MAX:raise RuntimeError('denial metadata limit')
 evidence=json.loads(completed.stdout)
 if evidence!={'directPrivateReadsDenied':True,'directPrivateWritesDenied':True}:raise RuntimeError('private path denial failed')
 return evidence

def main():
 result={'ok':False,'strictState':'unverified','scope':'actual pinned CLI tool execution with local mock; no model inference'}
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
  actual=load('durable_actual_fill','strict-actual-fill-probe.py')
  parent=pathlib.Path(tempfile.gettempdir()).resolve()
  root=pathlib.Path(tempfile.mkdtemp(prefix='strict-candidate-probe-',dir=parent));os.chmod(root,0o700)
  token=str(uuid.uuid4());(root/'.fixture-owner').write_text(token)
  receipt_module=load('durable_runtime_receipt','strict-runtime-receipt.py')
  if pathlib.Path(shutil.which('bwrap')).resolve()!=pathlib.Path('/usr/bin/bwrap').resolve():raise RuntimeError('runtime receipt tool mismatch')
  receipt=receipt_module.capture_runtime_receipt(client,node,root)
  if receipt['descriptor']['client_sha256']!=chash or receipt['descriptor']['node_sha256']!=nhash:raise RuntimeError('runtime receipt pin changed')
  result.update(runtimeReceipt=receipt)
  source=root/'source';source.mkdir(mode=0o700)
  (source/'plan.js').write_text('// fixture exterior\n// SKEL[1] selected\ninitial\n// /SKEL[1]\n// SKEL[2] other\npreserved\n// /SKEL[2]\n')
  (source/'context.txt').write_text('controlled fixture context\n')
  session=root/'host-session';code=1
  prepared=session_command(node,root,'prepare',['--prepare',source,session])
  if prepared.get('trace')!=['private-copy','enumerate','independent-capture','durable-capture-put','authority-reference','protected-observer-under-lock','console-injected-approve','lost-approval-response','console-same-id-retry']:raise RuntimeError('prepare order invalid')
  result.update(privatePathDenial=private_path_denial(session,prepared['captureVersion']))
  for disposable in (source/'plan.js',session/'candidate'/'plan.js'):
   original=disposable.read_bytes()
   poisoned=original.replace(b'initial',b'poisoned-current-source')
   if poisoned==original:raise RuntimeError('stored-byte control sentinel missing')
   disposable.write_bytes(poisoned)
   if disposable.read_bytes()==original:raise RuntimeError('stored-byte control did not differ')
  result.update(disposableSourcesChangedBeforeSeed=True)
  rounds=[]
  for number,case in enumerate(('valid','exterior'),1):
   stage=root/('stage-%d'%number);stage.mkdir(mode=0o700)
   seed=session_command(node,root,'seed-'+case,['--seed',stage/'tree',session])
   if seed!={'ok':True,'strictState':'unverified','action':'seed','reviewVersion':prepared['reviewVersion'],'captureVersion':prepared['captureVersion'],'exactStoredClone':True}:raise RuntimeError('approved clone identity mismatch')
   safe_cleanup=False
   evidence=actual.actual_round(client,node,root,number,case,checkpoint,namespace_fds)
   safe_cleanup=True
   verification=session_command(node,root,'check-'+case,['--check',stage/'tree',session,case])
   expected={'ok':True,'strictState':'unverified','action':'check','case':case,'outcome':'accepted' if case=='valid' else 'rejected','code':None if case=='valid' else 'FIXTURE_EXTERIOR','selectedBodyChanged':True,'completionVerified':False}
   if verification!=expected:raise RuntimeError('candidate outcome mismatch')
   rounds.append({**evidence,'case':case,'seed':seed,'verification':verification})
  result.update(ok=True,code='durable-fill-probe-passed',rounds=rounds);code=0
 except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError) as exc:
  result.update(ok=False,code='durable-fill-probe-failed' if code==1 else 'unsupported',error=str(exc)[:4096])
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




