#!/usr/bin/python3
"""Private fake diagnostic CLI. No account, system-manager or network access."""
import json,os,sys,pathlib,time,signal,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
name=pathlib.Path(sys.argv[0]).name
scenario=json.loads((root/'scenario.json').read_text()) if (root/'scenario.json').exists() else {}
with (root/'doctor-calls.jsonl').open('a') as log:log.write(json.dumps({'name':name,'args':sys.argv[1:],'pid':os.getpid(),'provider':os.environ.get('PULT_DIAGNOSTIC_PROVIDER'),'env':sorted(os.environ),'environmentPath':os.environ.get('PATH')})+'\n')
args=sys.argv[1:]
phase='version' if args in [['--version'],['-v']] else 'schema' if args[:3]==['app-server','generate-json-schema','--out'] else 'auth' if args[:1] in [['auth'],['login']] else 'network' if name=='curl' else 'shell' if name=='login-shell' else 'other'
label=name+'-'+phase
if scenario.get('hangPhase')==phase or (scenario.get('hangAuth') and phase=='auth'):
 child=subprocess.Popen(['/bin/sleep','120']);(root/('child-'+label)).write_text(str(child.pid));(root/('leader-'+label)).write_text(str(os.getpid()))
 if scenario.get('partialAuth') and phase=='auth' and name=='claude':print('{"loggedIn":true}',flush=True)
 time.sleep(120)
if scenario.get('overflowAuth') and phase=='auth' and name=='claude':
 print('{"loggedIn":true}',flush=True);sys.stderr.write('X'*(4*1024*1024+1));sys.stderr.flush();time.sleep(120)
if scenario.get('hang')==name:
 child=subprocess.Popen(['/bin/sleep','120']);(root/('child-'+label)).write_text(str(child.pid));(root/('leader-'+name)).write_text(str(os.getpid()));time.sleep(120)
if scenario.get('retain')==name or scenario.get('retainPhase')==phase:
 child=subprocess.Popen(['/bin/sleep','120']);(root/('child-'+label)).write_text(str(child.pid))
if scenario.get('overflowStderr')==name:
 print(name+' 1.0.0',flush=True);sys.stderr.write('X'*(4*1024*1024+1));sys.stderr.flush();time.sleep(120)
if scenario.get('overflow')==name:sys.stdout.write('X'*(4*1024*1024+1));sys.stdout.flush();time.sleep(120)
if args in [['--version'],['-v']]:
 if scenario.get('slowVersions'):time.sleep(.2)
 if name=='node':print(scenario.get('nodeVersion','v24.21.0'))
 else:print(name+' 1.0.0'+('x'*scenario.get('longVersion',0)))
elif name=='claude' and args==['auth','status','--json']:
 print(scenario.get('authRaw',json.dumps(scenario.get('auth',{'loggedIn':True,'subscriptionType':'max','authMethod':'claude.ai','email':'person@example.org'}))))
 sys.exit(scenario.get('authExit',0))
elif name=='codex' and args==['login','status']:
 print(scenario.get('codexLine','Logged in using ChatGPT'),file=sys.stderr);sys.exit(scenario.get('codexExit',0))
elif name=='codex' and args[:3]==['app-server','generate-json-schema','--out']:
 if scenario.get('schemaExit'):print('fixture schema failed',file=sys.stderr);sys.exit(scenario['schemaExit'])
 mode=scenario.get('schemaMode');out=pathlib.Path(args[3])
 if mode in ['entries','entries-nonzero','entries-cancel']:
  for i in range(8193):(out/('d'+str(i))).mkdir()
  (out/'a.json').write_text('{}');(root/'schema-entries-ready').write_text('ready')
  if mode=='entries-nonzero':sys.exit(7)
  if mode=='entries-cancel':
   child=subprocess.Popen(['/bin/sleep','120']);(root/('child-'+label)).write_text(str(child.pid));(root/('leader-'+label)).write_text(str(os.getpid()));time.sleep(120)
  sys.exit(0)
 if mode=='files':
  for i in range(4097):(out/(str(i)+'.json')).write_text('{}')
  sys.exit(0)
 if mode in ['depth32','depth33']:
  nested=out
  for i in range(31 if mode=='depth32' else 32):nested=nested/'d';nested.mkdir()
  (nested/'a.json').write_text('{}');sys.exit(0)
 if mode in ['size','total']:
  for i in range(1 if mode=='size' else 9):
   with (out/(str(i)+'.json')).open('wb') as f:f.truncate(8*1024*1024+(1 if mode=='size' else 0))
  sys.exit(0)
 if mode=='special':
  (out/'external').symlink_to(root.parent/'user');os.mkfifo(out/'pipe',0o600);sys.exit(0)
 if not scenario.get('emptySchema'):
  (out/'b.json').write_text('b');(out/'a.json').write_text('a')
elif name=='curl':
 proxy=args[args.index('-x')+1];p=os.environ.get('PULT_DIAGNOSTIC_PROVIDER','claude');net=scenario.get('network',{}).get(p,{})
 if proxy and net.get('proxyExit'):sys.exit(net['proxyExit'])
 print('loc='+net.get('loc','FI'));sys.exit(net.get('exit',0))
elif name=='login-shell':
 if scenario.get('cacheSwap'):
  (root/'env.json').unlink()
  if scenario['cacheSwap']=='symlink':(root/'env.json').symlink_to(root.parent/'user'/'external')
  else:os.mkfifo(root/'env.json',0o600)
 if scenario.get('hugeCache'):sys.stdout.write('A'*(1024*1024)+'=ignored\0')
 sys.stdout.write('PATH='+str(root/'fakebin')+'\0FIXTURE_TOKEN=not-cached-value\0USER=fixture\0')
elif name=='loginctl':print('Linger='+scenario.get('linger','yes'))
elif name=='launchctl':print('gui/501/fixture = {\n state = '+scenario.get('serviceState','running')+'\n'+(' pid = 123\n' if not scenario.get('stoppedService') else '')+' last exit code = '+str(scenario.get('serviceExit','(never exited)'))+'\n}')
elif name=='systemctl':print('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nExecMainPID=123\nExecMainCode=0\nResult=success\nExecMainStatus=0')
else:raise SystemExit('unexpected private diagnostic call '+repr(args))
