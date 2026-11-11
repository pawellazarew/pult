"""Local JSONL app-server fixture; never reads credentials or calls a model."""
import json
import os
import signal
import sys
from pathlib import Path

mode, home = sys.argv[1:]
home = Path(home)
(home / 'pids.json').write_text(json.dumps([os.getppid(), os.getpid()]))

def log(frame):
    with (home / 'messages.jsonl').open('a') as stream:
        stream.write(json.dumps(frame) + '\n')

def send(frame):
    print(json.dumps(frame), flush=True)

def read():
    line = sys.stdin.readline()
    if not line:
        return None
    frame = json.loads(line)
    log(frame)
    return frame

initialize = read()
assert initialize['method'] == 'initialize'
assert initialize['params']['clientInfo']['name'] == 'pult'
assert isinstance(initialize['params']['clientInfo']['version'], str)
assert initialize['params']['capabilities']['experimentalApi'] is True
if mode == 'hang-init':
    send({'method': 'fixture/init-stalled'})
    while True:
        signal.pause()
send({'id': initialize['id'], 'result': [] if mode == 'bad-init' else {'userAgent': 'fixture'}})
initialized = read()
assert initialized['method'] == 'initialized'
if mode == 'eof':
    sys.exit(0)
if mode == 'bad-framing':
    sys.stdout.write('not-json\n[]\n' + 'x' * (16 * 1024 * 1024 + 1) + '\n')
    sys.stdout.flush()
send({'method': 'fixture/ready'})
if mode == 'stall-write':
    sys.stdin.read(1)
    send({'method': 'fixture/write-started'})
    while True:
        signal.pause()

first = None
permission = None
tail = []
while True:
    frame = read()
    if frame is None:
        break
    method = frame.get('method')
    if mode == 'tail-exit':
        tail.append(frame)
        if len(tail) == 3:
            for item in reversed(tail):
                send({'id': item['id'], 'result': item['params']})
            send({'method': 'fixture/last-notification'})
            sys.exit(7)
        continue
    if method is None:
        assert frame['id'] == 'approval'
        send({'id': permission, 'result': {'denied': 'error' in frame}})
    elif method == 'first':
        first = frame['id']
    elif method == 'second':
        send({'id': frame['id'], 'result': 'second'})
        send({'id': first, 'result': 'first'})
    elif method == 'permission':
        permission = frame['id']
        send({'id': 'approval', 'method': 'item/commandExecution/requestApproval', 'params': {}})
    elif method == 'exit':
        break
    elif method == 'kill-holder':
        os.kill(os.getppid(), signal.SIGKILL)
        os._exit(0)
    elif 'id' in frame:
        send({'id': frame['id'], 'result': frame.get('params')})
