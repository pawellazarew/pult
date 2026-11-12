# Synthetic provider protocol only; no model, credentials or external IO.
import json, os, pathlib, sys, signal, threading
home=pathlib.Path(sys.argv[1]); args=sys.argv[2:]
sid=args[args.index('--resume')+1] if '--resume' in args else args[args.index('--session-id')+1]
if '--fork-session' in args: sid='11111111-2222-4333-8444-555555555555'
with (home/'launches.jsonl').open('a') as f: f.write(json.dumps({'pid':os.getpid(),'args':args,'env':dict(os.environ)})+'\n')
for line in sys.stdin:
    request=json.loads(line)
    records=json.loads((home/'sessions.json').read_text())['sessions']
    assert any(r.get('claudeReservedSessionId') == (args[args.index('--resume')+1] if '--resume' in args else sid) for r in records), 'no durable reserve'
    with (home/'inputs.jsonl').open('a') as f: f.write(json.dumps(request)+'\n')
    def emit(value):
        value['session_id']=sid
        print(json.dumps(value),flush=True)
    emit({'type':'system','subtype':'init','permissionMode':'manual'})
    emit({'type':'command_lifecycle','command_uuid':request['uuid'],'state':'started'})
    if 'hold-turn' in json.dumps(request): threading.Event().wait()
    emit({'type':'result','terminal_reason':'completed','is_error':False,'result':'fixture result','num_turns':1,'user_message_uuids':[request['uuid']]})
