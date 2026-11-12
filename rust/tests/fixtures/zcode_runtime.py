# Synthetic Route A only; installed into a private executable by the test.
import json, os, pathlib, sys, threading
home=pathlib.Path(os.environ['HOME']); args=sys.argv[1:]
cwd=pathlib.Path(args[args.index('--cwd')+1]); name=cwd.name
prompt=args[args.index('-p')+1]
with (home/'launches.jsonl').open('a') as f: f.write(json.dumps({'pid':os.getpid(),'args':args,'env':dict(os.environ),'name':name})+'\n')
records=json.loads((home/'sessions.json').read_text())['sessions']
assert any(r.get('name')==name and 'zcodePendingInput' in r for r in records), 'reservation absent'
if prompt.startswith('auth'):
    print('authentication_required',file=sys.stderr,flush=True);sys.exit(1)
if prompt.startswith('quota'):
    print('quota_exceeded',file=sys.stderr,flush=True);sys.exit(1)
if prompt.startswith('missing'):
    print('session native not found',file=sys.stderr,flush=True);sys.exit(1)
sid=args[args.index('--resume')+1] if '--resume' in args else 'sess_fixture_'+name
tid='turn_fixture_'+name+'_'+str(os.getpid())
def emit(kind,payload=None,**extra): print(json.dumps(dict(type=kind,sessionId=sid,turnId=tid,payload=payload or {},**extra)),flush=True)
emit('session.titleUpdated',{'title':'fixture'})
emit('turn.started',{'modelSelection':{'modelId':'native-model'}})
if prompt.startswith('hold-turn'): threading.Event().wait()
emit('model.streaming',{'kind':'text_delta','delta':'fixture 🌊'})
emit('turn.completed',{'resultType':'success','response':'fixture 🌊'})
print(json.dumps({'type':'result','sessionId':sid,'turnId':tid,'resultType':'success','response':'fixture 🌊'}),flush=True)
