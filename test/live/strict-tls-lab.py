#!/usr/bin/env python3
"""No-internet TLS lab. Configures only a verified disposable net namespace."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile

NODE_LIMIT=16384
INNER=r'''
import json,os,pathlib,resource,subprocess,sys
outer=sys.argv[1]
if os.readlink('/proc/self/ns/net')==outer:raise RuntimeError('network namespace not distinct')
ip='/usr/sbin/ip'
def run(*args):return subprocess.check_output([ip,*args],text=True,timeout=3)
links=json.loads(run('-j','link','show'))
if [link['ifname'] for link in links]!=['lo']:raise RuntimeError('outside interface present')
routes=json.loads(run('-j','route','show','table','all'))+json.loads(run('-j','-6','route','show','table','all'))
if any(route.get('dev')!='lo' for route in routes):raise RuntimeError('outside route present')
run('link','set','lo','up')
run('addr','add','8.8.8.8/32','dev','lo')
routes=json.loads(run('-j','route','show','table','all'))+json.loads(run('-j','-6','route','show','table','all'))
if any(route.get('dev')!='lo' or route.get('dst')=='default' for route in routes):raise RuntimeError('unexpected configured route')
resource.setrlimit(resource.RLIMIT_FSIZE,(16384,16384))
resource.setrlimit(resource.RLIMIT_CPU,(30,30))
subprocess.run(['/opt/node','/repo/test/live/strict-tls-lab-inner.mjs','/fixtures',outer],env={},stdin=subprocess.DEVNULL,check=True,timeout=30)
'''

def openssl(root,*args):
    subprocess.run(['/usr/bin/openssl',*map(str,args)],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True,timeout=15)

def certificates(root):
    for name in ('ca','other-ca'):
        openssl(root,'req','-x509','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.crt','-days','2','-subj','/CN=Strict private fixture '+name)
    (root/'index').write_text('');(root/'serial').write_text('1000\n');(root/'newcerts').mkdir()
    for name,host in (('server','api.anthropic.com'),('wrong','wrong.example'),('expired','api.anthropic.com')):
        openssl(root,'req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+host)
        config=root/(name+'.cnf')
        config.write_text('[ca]\ndefault_ca=lab\n[lab]\ndatabase=index\nserial=serial\nnew_certs_dir=newcerts\nunique_subject=no\ncertificate=ca.crt\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=policy\nx509_extensions=extensions\n[policy]\ncommonName=supplied\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:'+host+'\n')
        dates=['-startdate','20200101000000Z','-enddate','20200102000000Z'] if name=='expired' else []
        openssl(root,'ca','-batch','-notext','-config',config.name,'-in',name+'.csr','-out',name+'.crt',*dates)
    # CA private keys and configs never enter the lab's read-only fixture bind.
    public=root/'public';public.mkdir(mode=0o700)
    for name in ('ca.crt','other-ca.crt','server.crt','server.key','wrong.crt','wrong.key','expired.crt','expired.key'):
        shutil.copyfile(root/name,public/name)
    return public

def main():
    result={'ok':False,'strictState':'unverified','scope':'isolated TLS lab; no external DNS or internet'}
    code=2
    try:
        parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);parser.add_argument('--node-sha256',required=True)
        args=parser.parse_args()
        if not sys.platform.startswith('linux') or not str(pathlib.Path(sys.executable).resolve()).startswith('/usr/'):
            raise RuntimeError('system /usr Python Linux required')
        for tool in ('/usr/bin/bwrap','/usr/sbin/ip','/usr/bin/openssl'):
            if not os.access(tool,os.X_OK):raise RuntimeError('required fixture tool unavailable')
        node=pathlib.Path(args.node)
        if not node.is_absolute() or node.is_symlink() or not node.is_file() or not os.access(node,os.X_OK):raise RuntimeError('invalid node executable')
        if len(args.node_sha256)!=64 or any(c not in '0123456789abcdef' for c in args.node_sha256):raise RuntimeError('invalid node digest')
        digest=hashlib.sha256()
        with node.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1048576),b''):digest.update(chunk)
        if digest.hexdigest()!=args.node_sha256:raise RuntimeError('node digest mismatch')
        repo=pathlib.Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix='strict-tls-lab-') as directory:
            root=pathlib.Path(directory);os.chmod(root,0o700)
            code=1;fixtures=certificates(root)
            out=root/'out';err=root/'err'
            command=['/usr/bin/bwrap','--unshare-all','--uid','0','--gid','0','--die-with-parent','--new-session','--cap-add','CAP_NET_ADMIN','--cap-add','CAP_NET_BIND_SERVICE','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib']
            if pathlib.Path('/lib64').exists():command+=['--ro-bind','/lib64','/lib64']
            command+=['--symlink','usr/bin','/bin','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/opt','--ro-bind',str(node.resolve()),'/opt/node','--ro-bind',str(repo),'/repo','--ro-bind',str(fixtures),'/fixtures','--',sys.executable,'-I','-c',INNER,os.readlink('/proc/self/ns/net')]
            with out.open('wb') as output,err.open('wb') as errors:
                process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=output,stderr=errors,env={},start_new_session=True)
                try:process.wait(timeout=45)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5);raise RuntimeError('lab timeout')
            if out.stat().st_size>NODE_LIMIT or err.stat().st_size>NODE_LIMIT:raise RuntimeError('lab diagnostic limit')
            if process.returncode:raise RuntimeError('lab refused or failed: '+err.read_text()[:2048])
            inner=json.loads(out.read_text())
            expected=['valid','wrong-name','untrusted','expired','peer-mismatch','redirect','handshake-timeout','timeout']
            codes=[None,'BROKER_TLS','BROKER_TLS','BROKER_TLS','BROKER_PEER','MODEL_REDIRECT_REFUSED','BROKER_TIMEOUT','BROKER_TIMEOUT']
            expected_rows=[{'case':name,'code':reason,'connections':1,'requests':int(name in ('valid','redirect','timeout')),'strictState':'unverified'} for name,reason in zip(expected,codes)]
            if inner!={'ok':True,'strictState':'unverified','scope':'isolated TLS lab; fixed host-owned DNS answers','rows':expected_rows}:raise RuntimeError('lab result mismatch')
            result.update(ok=True,code='tls-lab-passed',evidence=inner);code=0
    except (OSError,RuntimeError,ValueError,subprocess.SubprocessError) as error:
        result.update(code='unsupported' if code==2 else 'tls-lab-failed',error=str(error)[:3072])
    print(json.dumps(result,sort_keys=True));return code

if __name__=='__main__':raise SystemExit(main())
