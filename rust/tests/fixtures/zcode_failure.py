# Controlled ordinary Route A failures. No native CLI/account/model/network.
import json, pathlib, sys, threading
home, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
args = sys.argv[3:]
(home/'provider.pid').write_text(str(__import__('os').getpid()))
with (home/'failure-launches.jsonl').open('a') as out:out.write(json.dumps({'pid':__import__('os').getpid()})+'\n')
(home/'argv.json').write_text(json.dumps(args))
(home/'reservation-observed').write_text((home/'sessions.json').read_text())
sid=args[args.index('--resume')+1] if '--resume' in args else 'sess_fixture_native'
tid='turn_fixture_native'
def emit(kind,payload=None,**extra):
    print(json.dumps(dict(type=kind,sessionId=sid,turnId=tid,payload=payload or {},**extra)),flush=True)
emit('session.titleUpdated',{'title':'ordinary failure'})
emit('turn.started',{'modelSelection':{'modelId':'fixture-model'}})
emit('turn.completed',{'resultType':'success','response':'I'})
if mode=='failure-no-result':sys.exit(0)
if mode=='failure-stderr':print('private-stderr-42',file=sys.stderr,flush=True)
if mode=='failure-whitespace':print('  ',file=sys.stderr,flush=True)
kind='mt_'+'a'*64 if mode=='failure-token' else 'error'
emit('result',response='F',resultType=kind)
if mode=='failure-duplicate':emit('result',response='duplicate',resultType='error')
if mode=='failure-conflict':emit('result',response='conflict',resultType='success')
if mode=='failure-late-frame':emit('model.streaming',{'kind':'text_delta','delta':'late'})
if mode=='failure-late-auth':print('authentication_required private-stderr-42',file=sys.stderr,flush=True)
if mode=='failure-blocked':threading.Event().wait()
