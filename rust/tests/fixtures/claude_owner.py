# Local protocol fixture; never calls a model or reads account state.
import json, os, pathlib, sys, threading
home = pathlib.Path(sys.argv[1]); behavior = sys.argv[2]; args = sys.argv[3:]
parent = args[args.index('--resume') + 1] if '--resume' in args else args[args.index('--session-id') + 1]
sid = '11111111-2222-4333-8444-555555555555' if '--fork-session' in args and behavior != 'same-fork' else parent
(home / 'provider.pid').write_text(str(os.getpid()))
(home / 'argv.json').write_text(json.dumps(args))
for line in sys.stdin:
    request = json.loads(line)
    record = next(r for r in json.loads((home / 'sessions.json').read_text())['sessions'] if r['name'] == 'chat')
    assert record['claudeReservedSessionId'] == parent, 'candidate was not durable before native input'
    if '--resume' not in args: assert 'providerSessionId' not in record, 'candidate falsely confirmed before init'
    (home / 'input-proof').write_text(parent)
    def emit(value):
        value['session_id'] = sid
        print(json.dumps(value), flush=True)
    emit({'type':'system','subtype':'init','permissionMode':'bypassPermissions' if behavior == 'bypass' else 'manual'})
    if behavior in ('duplicate-bypass', 'duplicate-fork'):
        emit({'type':'system','subtype':'init','permissionMode':'bypassPermissions' if behavior == 'duplicate-bypass' else 'manual'})
    emit({'type':'command_lifecycle','command_uuid':request['uuid'],'state':'started'})
    if behavior == 'hold': threading.Event().wait()
    emit({'type':'result','is_error':False,'terminal_reason':'completed','result':'fixture result','num_turns':1,'user_message_uuids':[request['uuid']]})
