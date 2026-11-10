use std::process::Command;

fn check_unread_output(signal: bool) {
    let scratch = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let result = Command::new("python3")
        .args(["-c", r#"
import json,os,select,signal,subprocess,sys,threading,time
binary,home,terminate=sys.argv[1:]
p=subprocess.Popen([binary,'--home',home,'serve'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
child=None
provider=None
pidfile=os.path.join(home,'provider.pid')
try:
 code="import os,time;path=%r;open(path+'.tmp','w').write(str(os.getpid()));os.rename(path+'.tmp',path);time.sleep(60)" % pidfile
 p.stdin.write((json.dumps({'method':'start','program':sys.executable,'args':['-c',code],'cwd':home})+'\n').encode());p.stdin.flush()
 acknowledgement=b''
 deadline=time.monotonic()+3
 while b'\n' not in acknowledgement:
  remaining=deadline-time.monotonic()
  assert remaining>0 and select.select([p.stdout],[],[],remaining)[0],'start acknowledgement timed out'
  block=os.read(p.stdout.fileno(),4096)
  assert block,'prototype exited before start acknowledgement'
  acknowledgement+=block
 child=json.loads(acknowledgement.split(b'\n',1)[0])['started']
 deadline=time.monotonic()+3
 while not os.path.exists(pidfile):
  assert time.monotonic()<deadline,'provider did not start'
  time.sleep(.01)
 provider=int(open(pidfile).read())
 def flood():
  try:
   p.stdin.write(b'{"method":"hello"}\n'*10000);p.stdin.flush()
  except (BrokenPipeError,ValueError): pass
 threading.Thread(target=flood,daemon=True).start()
 time.sleep(.5)
 if terminate == "yes": p.send_signal(signal.SIGTERM)
 try: p.wait(timeout=4)
 except subprocess.TimeoutExpired: raise AssertionError('unread stdout blocked bounded shutdown')
 assert p.returncode in (0,1),p.returncode
 if terminate == 'no':
  assert p.returncode == 1,p.returncode
  assert b'control stdout did not drain' in p.stderr.read()
 for pid in [child,provider]:
  deadline=time.monotonic()+2
  while time.monotonic()<deadline:
   try: os.kill(pid,0)
   except ProcessLookupError: break
   time.sleep(.02)
  else: raise AssertionError('holder/provider survived output failure/termination: %s' % pid)
finally:
 if p.poll() is None: p.kill();p.wait()
 for pid in [child,provider]:
  if pid:
   try: os.killpg(pid,signal.SIGKILL)
   except ProcessLookupError: pass
 p.stdin.close();p.stdout.close();p.stderr.close()
"#, env!("CARGO_BIN_EXE_pult-r1"), scratch.path().to_str().unwrap(), if signal { "yes" } else { "no" }])
        .output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn unread_stdout_does_not_prevent_sigterm_cleanup() {
    check_unread_output(true);
}

#[test]
fn unread_stdout_times_out_and_cleans_provider_without_a_signal() {
    check_unread_output(false);
}
