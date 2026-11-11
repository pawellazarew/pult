"""Shared app-server fixture. All model work is local, deterministic JSON."""
import json
import os
import sys
import threading
from pathlib import Path

home = Path(sys.argv[1])
(home / 'pids.json').write_text(json.dumps([os.getppid(), os.getpid()]))
output = threading.Lock()
state = threading.RLock()
threads = {}
active = {}
permissions = {}
deferred_rejections = {}
sequence = 0
last_turns = {}
wide = len(sys.argv) > 2 and sys.argv[2] == 'wide'
thread_timeout = len(sys.argv) > 2 and sys.argv[2] == 'thread-timeout'

def send(frame):
    with output:
        print(json.dumps(frame), flush=True)

def notification(method, thread, turn_id, **extra):
    send({'method': method, 'params': {'threadId': thread, 'turnId': turn_id, **extra}})

def finish(thread, status='completed', text='done'):
    with state:
        item = active.pop(thread, None)
        if item is None:
            return
        turn = item['turn']
        last_turns[thread] = turn
        if status == 'completed':
            notification('item/completed', thread, turn,
                item={'type': 'agentMessage', 'id': 'message-' + turn, 'text': text, 'phase': 'final_answer'})
            notification('thread/tokenUsage/updated', thread, turn,
                tokenUsage={'last': {'inputTokens': 10, 'outputTokens': 2, 'cachedInputTokens': 1, 'totalTokens': 12}, 'modelContextWindow': 1000})
        notification('turn/completed', thread, turn, turn={'id': turn, 'status': status, 'error': None})

# File-controlled release lets another session finish naturally while the host
# is retiring. No new turn/API call is needed to release an already-running one.
def release():
    wait = threading.Event()
    auto_sent = False
    while not wait.wait(0.01):
        if (home / 'reject-ack').exists():
            with state:
                rejected = list(deferred_rejections.values())
                deferred_rejections.clear()
            for ident in rejected:
                send({'id': ident, 'error': {'code': -32600, 'message': 'turn start rejected'}})
        if not auto_sent and (home / 'autoturn').exists():
            thread = (home / 'autoturn').read_text()
            auto_sent = True
            with state:
                active[thread] = {'turn': 'server-auto-turn', 'text': 'auto', 'mode': 'auto'}
            notification('turn/started', thread, 'server-auto-turn', turn={'id': 'server-auto-turn', 'status': 'inProgress'})
        if (home / 'terminal').exists():
            with state:
                terminal = [thread for thread, item in active.items() if item['mode'] == 'permit-terminal']
            for thread in terminal:
                finish(thread, text='terminal before permission')
        if (home / 'release').exists():
            with state:
                held = [thread for thread, item in active.items() if item['mode'] == 'hold']
            for thread in held:
                finish(thread, text='released')
            return
threading.Thread(target=release, daemon=True).start()

for line in sys.stdin:
    frame = json.loads(line)
    with (home / 'messages.jsonl').open('a') as stream:
        stream.write(json.dumps(frame) + '\n')
    method = frame.get('method')
    params = frame.get('params', {})
    if method == 'initialize':
        send({'id': frame['id'], 'result': {'userAgent': 'fixture'}})
    elif method == 'initialized':
        continue
    elif method in ('thread/start', 'thread/resume'):
        if thread_timeout:
            continue
        if method == 'thread/resume' and params['threadId'] == 'missing-resume':
            send({'id': frame['id'], 'error': {'code': -32600, 'message': 'no rollout found for thread id missing-resume'}})
            continue
        sequence += 1
        thread = params.get('threadId', 'native-thread-' + str(sequence))
        kind = {'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess'}[params['sandbox']]
        if wide:
            kind = 'dangerFullAccess'
        sandbox = {'type': kind}
        if kind == 'workspaceWrite':
            sandbox.update(networkAccess=True, writableRoots=[str(home / 'owner-root')])
        threads[thread] = params
        cwd = str(home / 'foreign') if len(sys.argv) > 2 and sys.argv[2] == 'wrong-cwd' else params['cwd']
        send({'id': frame['id'], 'result': {'thread': {'id': thread}, 'cwd': cwd, 'model': params.get('model', 'fixture-model'), 'sandbox': sandbox, 'approvalPolicy': params['approvalPolicy']}})
    elif method == 'config/read':
        send({'id': frame['id'], 'result': {'config': {'sandbox_workspace_write': {'network_access': True, 'writable_roots': [str(home / 'owner-root')], 'exclude_slash_tmp': True}}}})
    elif method == 'turn/start':
        sequence += 1
        thread = params['threadId']
        turn = 'native-turn-' + str(sequence)
        text = next((item['text'] for item in params['input'] if item['type'] == 'text'), '')
        behavior = text.split(' ', 1)[0]
        if behavior == 'late' and thread in last_turns:
            old = last_turns[thread]
            notification('turn/started', thread, old, turn={'id': old, 'status': 'inProgress'})
            notification('item/completed', thread, old, item={'type': 'agentMessage', 'id': 'old-' + old, 'text': 'STALE_SECRET'})
            notification('turn/completed', thread, old, turn={'id': old, 'status': 'completed'})
            notification('brand/new/unknown', thread, turn, text='UNKNOWN_SECRET')
        with state:
            active[thread] = {'turn': turn, 'text': text, 'mode': behavior}
        if behavior == 'unknown':
            continue
        notification('turn/started', thread, turn, turn={'id': turn, 'status': 'inProgress'})
        if behavior == 'early':
            finish(thread, text='early text')
        if behavior == 'early-permit-reject':
            ident = 'early-permit-' + turn
            permissions[ident] = thread
            with state:
                deferred_rejections[thread] = frame['id']
            send({'id': ident, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'tool-' + turn, 'command': 'true'}})
            (home / 'early-permit').write_text('sent')
            continue
        if behavior != 'cancel-start':
            send({'id': frame['id'], 'result': {'turn': {'id': turn + '-conflict' if behavior == 'conflict' else turn, 'status': 'inProgress'}}})
        if behavior == 'storm':
            for retry in range(1, 4):
                notification('error', thread, turn, error={'message': 'Reconnecting ' + str(retry), 'codexErrorInfo': {'responseStreamDisconnected': {}}}, willRetry=True)
            continue
        if behavior in ('hold', 'never-interrupt', 'cancel-start', 'early'):
            continue
        if behavior in ('permit', 'permit-terminal'):
            ident = 'permit-' + turn
            permissions[ident] = thread
            send({'id': ident, 'method': 'item/commandExecution/requestApproval', 'params': {'threadId': thread, 'turnId': turn, 'itemId': 'tool-' + turn, 'command': 'true'}})
        elif behavior == 'background':
            notification('item/started', thread, turn, item={'type': 'commandExecution', 'id': 'background-' + turn, 'command': 'background', 'cwd': str(home)})
            finish(thread, text='unsupported background')
        else:
            finish(thread)
    elif method == 'turn/interrupt':
        thread = params['threadId']
        send({'id': frame['id'], 'result': {}})
        with state:
            item = active.get(thread)
        if item and item['turn'] == params['turnId'] and item['mode'] != 'never-interrupt':
            finish(thread, status='interrupted')
    elif method is None:
        thread = permissions.pop(frame['id'], None)
        if thread is None:
            continue
        finish(thread, text='denied' if 'error' in frame else 'answered')
