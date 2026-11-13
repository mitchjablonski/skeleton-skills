#!/usr/bin/env python3
"""Controlled teardown -> candidate integration. Never enables strict mode."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import resource
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
MAX_OUTPUT = 16384
INNER = r'''
import json, os, pathlib, time
stage=pathlib.Path('/stage')
plan=b'// fixture exterior\n// SKEL[1] selected\ninitial\nwriter-placeholder:0\n// /SKEL[1]\n// SKEL[2] other\npreserved\n// /SKEL[2]\n'
context=b'controlled fixture context:0\n'
(stage/'plan.js').write_bytes(plan)
(stage/'context.txt').write_bytes(context)
for index,name in enumerate(('plan.js','context.txt')):
    os.link(stage/name,stage/('writer-%d'%index))
    launcher=os.fork()
    if launcher==0:
        os.setsid()
        if os.fork(): os._exit(0)
        fd=os.open(str(stage/name),os.O_WRONLY|os.O_APPEND)
        (stage/('ready-%d'%index)).write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid()}))
        end=time.monotonic()+20
        count=0
        while time.monotonic()<end:
            os.write(fd,b'x')
            count+=1
            time.sleep(.005)
        os._exit(0)
    os.waitpid(launcher,0)
(stage/'init').write_text(json.dumps({'pid':1,'namespace':os.readlink('/proc/self/ns/pid')}))
time.sleep(20)
'''

def load_checkpoint():
    spec=importlib.util.spec_from_file_location('strict_checkpoint_fixture',HERE/'strict-checkpoint-probe.py')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.INNER=INNER
    return module

def cleanup(root,parent,token):
    if root.is_symlink() or root.resolve()!=root or root.parent!=parent:
        raise RuntimeError('unsafe cleanup root')
    if not re.fullmatch(r'strict-candidate-probe-[A-Za-z0-9_-]{8}',root.name):
        raise RuntimeError('unsafe cleanup prefix')
    marker=root/'.fixture-owner'
    if marker.is_symlink() or not marker.is_file() or marker.stat().st_nlink!=1 or marker.read_text()!=token:
        raise RuntimeError('cleanup ownership marker mismatch')
    shutil.rmtree(root)

def run_helper(node,stage,scratch,number):
    output=scratch/('helper-%d.out'%number)
    errors=scratch/('helper-%d.err'%number)
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE,(MAX_OUTPUT,MAX_OUTPUT))
        resource.setrlimit(resource.RLIMIT_CPU,(15,15))
    with output.open('wb') as out,errors.open('wb') as err:
        process=subprocess.Popen([str(node),str(HERE/'strict-candidate-inner.mjs'),'--source',str(stage)],
            stdin=subprocess.DEVNULL,stdout=out,stderr=err,env={},start_new_session=True,preexec_fn=limits)
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=8)
            raise RuntimeError('candidate helper timed out')
    if output.stat().st_size>MAX_OUTPUT or errors.stat().st_size>MAX_OUTPUT:
        raise RuntimeError('helper output limit')
    if process.returncode:
        raise RuntimeError('candidate helper failed: '+output.read_text()[:1024]+errors.read_text()[:1024])
    value=json.loads(output.read_text())
    if value.get('ok') is not True or value.get('strictState')!='unverified' or value.get('completionVerified') is not False:
        raise RuntimeError('invalid helper result')
    return value

def main():
    result={'ok':False,'strictState':'unverified','scope':'controlled synchronous fixture teardown and mock candidate integration'}
    root=None
    safe_cleanup=False
    namespace_handles={}
    code=2
    try:
        parser=argparse.ArgumentParser()
        parser.add_argument('--node',required=True)
        parser.add_argument('--node-sha256',required=True)
        args=parser.parse_args()
        if not sys.platform.startswith('linux') or not str(pathlib.Path(sys.executable).resolve()).startswith('/usr/'):
            raise ValueError('requires system /usr Python on Linux')
        if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal') or not shutil.which('bwrap'):
            raise ValueError('requires pidfd APIs and Bubblewrap')
        node=pathlib.Path(args.node)
        if not node.is_absolute() or not node.is_file() or not os.access(node,os.X_OK) or not re.fullmatch('[a-f0-9]{64}',args.node_sha256):
            raise ValueError('invalid pinned Node executable')
        digest=hashlib.sha256()
        with node.open('rb') as stream:
            while chunk:=stream.read(1024*1024): digest.update(chunk)
        if digest.hexdigest()!=args.node_sha256:
            raise ValueError('Node SHA256 mismatch')
        own=os.pidfd_open(os.getpid())
        try: signal.pidfd_send_signal(own,0)
        finally: os.close(own)
        fixture=load_checkpoint()
        original_members=fixture.members
        def pinned_members(namespace):
            observed=original_members(namespace)
            if observed and namespace not in namespace_handles:
                pid=next(iter(observed))
                handle=os.open('/proc/%d/ns/pid'%pid,os.O_RDONLY)
                if os.readlink('/proc/self/fd/%d'%handle)!=namespace:
                    os.close(handle)
                    raise RuntimeError('namespace changed while pinning identity')
                namespace_handles[namespace]=handle
            return observed
        fixture.members=pinned_members
        parent=pathlib.Path(tempfile.gettempdir()).resolve()
        root=pathlib.Path(tempfile.mkdtemp(prefix='strict-candidate-probe-',dir=parent))
        os.chmod(root,0o700)
        token=str(uuid.uuid4())
        (root/'.fixture-owner').write_text(token)
        code=1
        rounds=[]
        for number in (1,2):
            safe_cleanup=False
            evidence=fixture.one_round(shutil.which('bwrap'),root,number,rounds[-1]['namespace'] if rounds else None)
            safe_cleanup=True
            stage=root/('stage-%d'%number)
            for name in ('writer-0','writer-1','init','ready-0','ready-1'): (stage/name).unlink()
            if any((stage/name).stat().st_nlink!=1 for name in ('plan.js','context.txt')):
                raise RuntimeError('fixture aliases remain after teardown')
            helper=run_helper(node,stage,root,number)
            rounds.append({**evidence,'candidateIntegration':helper,'helperInvokedAfterTeardown':True})
        result.update(ok=True,code='candidate-probe-passed',rounds=rounds,freshNamespaceRestart=True,fillExecution='host-controlled mock only')
        code=0
    except (OSError,ValueError,KeyError,RuntimeError,subprocess.SubprocessError) as exc:
        result.update(code='candidate-probe-failed' if code==1 else 'candidate-probe-unsupported',error=str(exc)[:2048])
    finally:
        for handle in namespace_handles.values(): os.close(handle)
        if root is not None:
            if safe_cleanup:
                try: cleanup(root,parent,token)
                except (OSError,RuntimeError) as exc:
                    result.update(ok=False,code='cleanup-failed',error=str(exc)[:1024]); code=1
            else:
                # Failed fixture teardown is not permission to remove writable storage.
                result.update(ok=False,retainedScratch=str(root)); code=1
    print(json.dumps(result,sort_keys=True))
    return code

if __name__=='__main__':
    raise SystemExit(main())

