#!/usr/bin/python3
"""Private fake diagnostic CLI. No account, system-manager or network access."""
import json,os,sys,pathlib,time,signal,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
name=pathlib.Path(sys.argv[0]).name
scenario=json.loads((root/'scenario.json').read_text()) if (root/'scenario.json').exists() else {}
with (root/'doctor-calls.jsonl').open('a') as log:log.write(json.dumps({'name':name,'args':sys.argv[1:],'pid':os.getpid(),'provider':os.environ.get('PULT_DIAGNOSTIC_PROVIDER'),'env':sorted(os.environ)})+'\n')
args=sys.argv[1:]
if scenario.get('hang')==name:
 child=subprocess.Popen(['/bin/sleep','120']);(root/('child-'+name)).write_text(str(child.pid));(root/('leader-'+name)).write_text(str(os.getpid()));time.sleep(120)
if scenario.get('retain')==name:
 child=subprocess.Popen(['/bin/sleep','120']);(root/('child-'+name)).write_text(str(child.pid))
if scenario.get('overflow')==name:sys.stdout.write('X'*(4*1024*1024+1));sys.stdout.flush();time.sleep(120)
if args in [['--version'],['-v']]:
 if scenario.get('slowVersions'):time.sleep(.2)
 if name=='node':print(scenario.get('nodeVersion','v24.21.0'))
 else:print(name+' 1.0.0')
elif name=='claude' and args==['auth','status','--json']:
 print(scenario.get('authRaw',json.dumps(scenario.get('auth',{'loggedIn':True,'subscriptionType':'max','authMethod':'claude.ai','email':'person@example.org'}))))
 sys.exit(scenario.get('authExit',0))
elif name=='codex' and args==['login','status']:
 print(scenario.get('codexLine','Logged in using ChatGPT'),file=sys.stderr);sys.exit(scenario.get('codexExit',0))
elif name=='codex' and args[:3]==['app-server','generate-json-schema','--out']:
 if scenario.get('schemaExit'):print('fixture schema failed',file=sys.stderr);sys.exit(scenario['schemaExit'])
 if not scenario.get('emptySchema'):
  out=pathlib.Path(args[3]);(out/'b.json').write_text('b');(out/'a.json').write_text('a')
elif name=='curl':
 proxy=args[args.index('-x')+1];p=os.environ.get('PULT_DIAGNOSTIC_PROVIDER','claude');net=scenario.get('network',{}).get(p,{})
 if proxy and net.get('proxyExit'):sys.exit(net['proxyExit'])
 print('loc='+net.get('loc','FI'));sys.exit(net.get('exit',0))
elif name=='loginctl':print('Linger='+scenario.get('linger','yes'))
elif name=='launchctl':print('gui/501/fixture = {\n state = running\n pid = 123\n last exit code = (never exited)\n}')
elif name=='systemctl':print('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0')
else:raise SystemExit('unexpected private diagnostic call '+repr(args))
