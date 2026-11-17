#!/usr/bin/python3
"""Private implementation of the opt-in synthetic PTY fixture, never authority."""
import ctypes
import errno
import fcntl
import json
import os
import select
import signal
import socket
import stat
import subprocess
import sys
import termios
import time
import tty

def identity(fd):
 s=os.fstat(fd)
 return {'dev':s.st_dev,'ino':s.st_ino,'rdev':s.st_rdev}

def initial_fds():
 result=[]
 for raw in os.listdir('/proc/self/fd'):
  try: os.fstat(int(raw))
  except OSError: continue
  result.append(int(raw))
 return sorted(result)

def devpts_mounts():
 with open('/proc/self/mountinfo','rb') as source: data=source.read(1048577)
 assert len(data)<=1048576
 lines=[line.decode('utf-8').strip() for line in data.splitlines() if b' - devpts ' in line]
 assert len(lines)<=16 and all(len(line)<=4096 for line in lines)
 return lines

def main():
 if sys.flags.optimize: raise RuntimeError('optimized interpreter unsupported')
 mode=sys.argv[1]
 if mode=='group-descendant':
  child=subprocess.Popen(['/usr/bin/python3','-I','-c','import time; time.sleep(60)'],stdin=subprocess.DEVNULL,env={},close_fds=True)
  with open(sys.argv[2],'x') as out: json.dump({'pid':child.pid,'pgid':os.getpgid(child.pid)},out)
  print(json.dumps({'ok':True,'leaderPgid':os.getpgrp()}))
  # Intentionally exit without waiting. Host retains this leader with WNOWAIT
  # while testing cleanup of its supervised, same-group sleeping descendant.
  return
 if mode=='control':
  fd=0;ready=sys.argv[2]
  assert initial_fds()==[0,1,2] and all(os.isatty(number) for number in (0,1,2))
  assert os.getsid(0)==os.getpid()
  fcntl.ioctl(fd,termios.TIOCSCTTY,0);tty.setraw(fd)
  assert os.tcgetpgrp(fd)==os.getpgrp()==os.getpid()
  with open(ready,'x') as out: json.dump({'pid':os.getpid(),'sid':os.getsid(0),'pgid':os.getpgrp(),'tty':os.ttyname(fd),'identity':identity(fd)},out)
  # Echo bytes only. Input and output carry fixture randomness, never commands.
  while True:
   data=os.read(fd,1024)
   if not data: break
   os.write(fd,data)
  return
 assert mode=='agent'
 assert initial_fds()==[0,1,2], 'unexpected initial descriptor'
 target=json.loads(sys.argv[2]);socket_paths=sys.argv[3:]
 forbidden=('DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','WSL_INTEROP','WSLENV')
 assert all(name not in os.environ for name in forbidden)
 master,slave=os.openpty();tty.setraw(slave)
 own=identity(slave);assert own!=target['identity']
 assert os.readlink('/proc/self/fd/'+str(slave))==os.ttyname(slave)
 reopened=os.open('/proc/self/fd/'+str(slave),os.O_RDWR|os.O_NOCTTY)
 assert identity(reopened)==own;os.close(reopened)
 readfd,writefd=os.pipe()
 child=os.fork()
 if child==0:
  try:
   # The own-session positive-control child must not survive a timed-out
   # worker. Arm before setsid and close the fork/parent-death race.
   parent=os.getppid()
   libc=ctypes.CDLL(None,use_errno=True)
   assert libc.prctl(1,signal.SIGKILL,0,0,0)==0
   assert os.getppid()==parent and parent!=1
   os.close(readfd);os.close(master);os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
   assert os.tcgetpgrp(slave)==os.getpgrp()==os.getpid()
   try: fcntl.ioctl(slave,termios.TIOCSTI,b'!');outcome='accepted'
   except OSError as error: outcome='errno-'+str(error.errno)
   os.write(writefd,json.dumps({'sid':os.getsid(0),'tiocsti':outcome}).encode());os.close(writefd)
   # A successful ioctl may have queued !; host canary is still independently read.
   data=b''
   while b'own-pty-positive\n' not in data: data+=os.read(slave,128)
   os.write(slave,b'own-pty-reply\n');os._exit(0)
  except BaseException: os._exit(1)
 os.close(writefd)
 os.write(master,b'own-pty-positive\n')
 assert select.select([master],[],[],3)[0]
 answer=os.read(master,1024);assert b'own-pty-reply\n' in answer
 assert select.select([readfd],[],[],3)[0]
 child_evidence=json.loads(os.read(readfd,1024));os.close(readfd)
 # The child is a member of our supervised group until it creates its own
 # session. It is explicitly reaped here; no background own-PTY child remains.
 assert os.waitpid(child,0)[1]==0
 attempts=[]
 for candidate in (target['tty'],'/proc/'+str(target['pid'])+'/fd/'+str(target['fd']),'/proc/'+str(target['pid'])+'/root'+target['tty']):
  try: fd=os.open(candidate,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
  except OSError as error: attempts.append({'pathKind':len(attempts),'errno':error.errno});continue
  try:
   # Numeric PID or pts-number collisions may open an unrelated object.
   actual=identity(fd);assert actual!=target['identity'], 'control terminal reached'
   try: fcntl.ioctl(fd,termios.TIOCSTI,b'?');outcome='accepted-unrelated'
   except OSError as error: outcome='errno-'+str(error.errno)
   attempts.append({'pathKind':len(attempts),'unrelatedObject':True,'tiocsti':outcome})
  finally: os.close(fd)
 for pathname in socket_paths:
  sock=socket.socket(socket.AF_UNIX)
  try:
   try: sock.connect(pathname)
   except OSError as error: assert error.errno in (errno.ENOENT,errno.ENOTDIR,errno.EACCES)
   else: raise AssertionError('host fixture socket reached')
  finally: sock.close()
 os.close(master);os.close(slave)
 print(json.dumps({'ok':True,'initialStdioOnly':True,'ownPtyRoundtrip':True,'ownProcFdReopened':True,'ownSession':child_evidence,'agentPtyIdentity':own,'controlIdentityDifferent':True,'targetAttempts':attempts,'syntheticSocketsExcluded':len(socket_paths),'environmentExcluded':True,'devptsMounts':devpts_mounts()}))

if __name__=='__main__':
 try: main()
 except BaseException:
  print(json.dumps({'ok':False}));sys.exit(1)
