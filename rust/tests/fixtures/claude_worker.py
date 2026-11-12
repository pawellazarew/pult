# Synthetic native Claude protocol; no model or account access.
import json, os, pathlib, sys, threading
home = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
args = sys.argv[3:]
sid = args[args.index('--session-id') + 1] if '--session-id' in args else args[args.index('--resume') + 1]
(home / 'provider.pid').write_text(str(os.getpid()))
for line in sys.stdin:
    item = json.loads(line)
    (home / 'input.json').write_text(json.dumps(item))
    def emit(value):
        value['session_id'] = sid
        print(json.dumps(value), flush=True)
    emit({'type':'system', 'subtype':'init', 'permissionMode': 'acceptEdits' if mode == 'wide-mode' else 'manual'})
    emit({'type':'command_lifecycle', 'command_uuid':item['uuid'], 'state':'started'})
    if mode == 'assistant-block':
        emit({'type':'assistant', 'is_api_error_message':True, 'message':{'content':[{'type':'text','text':'Disabled Claude subscription access'}]}})
        threading.Event().wait()
    if mode == 'result-block':
        emit({'type':'result', 'is_error':True, 'terminal_reason':'api_error', 'result':'Disabled Claude subscription access', 'user_message_uuids':[item['uuid']], 'usage':{'output_tokens':17}})
        threading.Event().wait()
    if mode == 'hold':
        threading.Event().wait()
    if mode == 'completed-only':
        emit({'type':'command_lifecycle', 'command_uuid':item['uuid'], 'state':'completed'})
    else:
        emit({'type':'result', 'is_error':False, 'terminal_reason':'completed', 'result':'fixture result', 'num_turns':1, 'user_message_uuids':[item['uuid']]})
