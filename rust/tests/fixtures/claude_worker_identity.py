# Real supervised protocol fixture; no account/model/network access.
import json, os, pathlib, sys
home=pathlib.Path(sys.argv[1]); mode=sys.argv[2]; args=sys.argv[3:]
parent=args[args.index('--resume')+1] if '--resume' in args else args[args.index('--session-id')+1]
sid='11111111-2222-4333-8444-555555555555' if '--fork-session' in args else parent
(home/'provider.pid').write_text(str(os.getpid()))
with (home/'launches.jsonl').open('a') as output: output.write(json.dumps(args)+'\n')
for line in sys.stdin:
    request=json.loads(line)
    record=next(r for r in json.loads((home/'sessions.json').read_text())['sessions'] if r['name']=='chat')
    assert record['claudeReservedSessionId']==parent, 'no owned durable reservation'
    with (home/'inputs.jsonl').open('a') as output: output.write(json.dumps({'parent':parent,'child':sid})+'\n')
    def emit(value):
        value['session_id']=sid
        print(json.dumps(value),flush=True)
    emit({'type':'system','subtype':'init','permissionMode':'bypassPermissions' if mode=='bypass' else 'manual'})
    emit({'type':'command_lifecycle','command_uuid':request['uuid'],'state':'started'})
    emit({'type':'result','terminal_reason':'completed','is_error':False,'result':'fixture result','num_turns':1,'user_message_uuids':[request['uuid']]})
