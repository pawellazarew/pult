#!/usr/bin/python3
"""Offline app-server fixture; all memory tools execute the real Rust MCP child."""
import atexit
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import threading

for name in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_TEST', 'PULT_CODEX_BIN', 'PULT_CURL_BIN', 'HTTPS_PROXY'):
    assert name not in os.environ, 'ambient authority reached fixture'
assert not any('mt_' in arg for arg in sys.argv), 'credential in app-server argv'
native = Path(os.environ['HOME']) / 'native'
native.mkdir(exist_ok=True)
pult = native.parent.parent / 'home'
output = threading.Lock()
threads = {}
active = {}
sequence = 0


def record(kind, **data):
    with (native / 'memory-fixture.jsonl').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps({'kind': kind, 'pid': os.getpid(), **data}) + '\n')


def send(frame):
    with output:
        print(json.dumps(frame), flush=True)


def notice(method, thread, turn_id, **extra):
    send({'method': method, 'params': {'threadId': thread, 'turnId': turn_id, **extra}})


class MCP:
    def __init__(self, config):
        assert Path(config['command']).name == 'pult-memory-mcp'
        assert len(config['args']) == 2 and config['args'][0] == '--home'
        assert Path(config['args'][1]).resolve() == pult.resolve()
        assert config['default_tools_approval_mode'] == 'approve'
        assert list(config['env']) == ['PULT_MEMORY_TURN_KEY']
        key = config['env']['PULT_MEMORY_TURN_KEY']
        assert key.startswith('mt_') and len(key) == 67
        self.key = key
        # Deliberately private test-control evidence, never emitted to the app-server.
        with (native / 'private-keys.jsonl').open('a') as stream:
            os.chmod(stream.name, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX)
            stream.write(json.dumps({'pid': os.getpid(), 'key': key}) + '\n')
        self.process = subprocess.Popen([config['command'], *config['args']], env={**os.environ, **config['env']}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.lock = threading.Lock()
        self.sequence = 0
        initialized = self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'local-fixture', 'version': '1'}})
        self.server = initialized['result']['serverInfo']
        assert self.server['name'] == 'pult-memory'
        self.tools = self.rpc('tools/list', {})['result']['tools']
        assert len(self.tools) in (4, 5)
        record('mcp-started', mcpPid=self.process.pid, argv=[config['command'], *config['args']], tools=[tool['name'] for tool in self.tools])

    def rpc(self, method, params):
        with self.lock:
            self.sequence += 1
            self.process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': self.sequence, 'method': method, 'params': params}) + '\n').encode())
            self.process.stdin.flush()
            assert select.select([self.process.stdout], [], [], 35)[0], 'MCP fixture deadline'
            response = json.loads(self.process.stdout.readline())
            assert response['id'] == self.sequence
            return response

    def call(self, name, arguments):
        response = self.rpc('tools/call', {'name': name, 'arguments': arguments})
        result = response.get('result', {})
        if 'error' in response or result.get('isError'):
            return {'isError': True, 'error': result.get('content', [{}])[0].get('text', response.get('error', {}).get('message', 'MCP rejected'))}
        return json.loads(result['content'][0]['text'])

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def cleanup():
    for value in threads.values():
        if value.get('mcp'):
            value['mcp'].close()


atexit.register(cleanup)
record('host-started', argv=sys.argv, credentialInEnvironment=False)

def fixture_exception(kind, error, traceback):
    frames = []
    while traceback:
        frames.append({'line': traceback.tb_lineno, 'function': traceback.tb_frame.f_code.co_name})
        traceback = traceback.tb_next
    record('fixture-error', error=kind.__name__, frames=frames)

sys.excepthook = fixture_exception


def finish(thread, turn, text='local fixture completed', status='completed'):
    active.pop(thread, None)
    if status == 'completed':
        notice('item/completed', thread, turn, item={'type': 'agentMessage', 'id': 'message-' + turn, 'text': text, 'phase': 'final_answer'})
    notice('turn/completed', thread, turn, turn={'id': turn, 'status': status, 'error': None})


def work(thread, turn, instruction):
    try:
        mcp = threads[thread].get('mcp')
        outcome = {'run': instruction['run'], 'thread': thread, 'turn': turn}
        if mcp:
            outcome['catalog'] = mcp.call('memory_catalog', {})
            outcome['list'] = mcp.call('memory_list', {})
            if instruction.get('id'):
                outcome['get'] = mcp.call('memory_get', {'id': instruction['id']})
            if instruction.get('foreignId'):
                outcome['foreign'] = mcp.call('memory_get', {'id': instruction['foreignId']})
            if instruction.get('proposal'):
                outcome['proposal'] = mcp.call('memory_propose', instruction['proposal'])
            if instruction.get('echoKey'):
                unknown = 'mt_' + ('f' if mcp.key != 'mt_' + 'f' * 64 else 'e') * 64
                ordinary = '0123456789abcdef0123456789abcdef'
                arguments = {'echo': mcp.key, mcp.key: 'property-name echo'}
                for item_id in (unknown, ordinary):
                    notice('item/started', thread, turn, item={'type': 'mcpToolCall', 'id': item_id, 'server': 'pult_memory', 'tool': 'memory_get', 'arguments': arguments, 'status': 'inProgress'})
                    notice('item/completed', thread, turn, item={'type': 'mcpToolCall', 'id': item_id, 'server': 'pult_memory', 'tool': 'memory_get', 'arguments': arguments, 'status': 'completed', 'result': {'content': [{'type': 'text', 'text': mcp.key}]}})
                outcome['proposal'] = mcp.call('memory_propose', {'operation': 'update', 'id': instruction['id'], 'expectedVersion': instruction['expectedVersion'], 'commandId': mcp.key, 'summary': 'MUST_NOT_COMMIT', 'reason': 'Credential-shaped command IDs must fail before approval'})
                outcome['echoedKey'] = True
                outcome['unknownStructuralId'] = unknown
                outcome['ordinaryStructuralId'] = ordinary
        record('result', **outcome)
        finish(thread, turn, text='fixture key echo ' + mcp.key if instruction.get('echoKey') and mcp else 'local fixture completed')
    except Exception as error:
        # Type only; never reflect untrusted tool/config payloads into public IO.
        record('fixture-error', error=type(error).__name__, run=instruction.get('run'))
        finish(thread, turn, status='failed')


for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get('method')
    params = frame.get('params', {})
    if method == 'initialize':
        send({'id': frame['id'], 'result': {'userAgent': 'memory-fixture'}})
    elif method == 'initialized':
        continue
    elif method in ('thread/start', 'thread/resume'):
        sequence += 1
        thread = params.get('threadId', 'native-memory-%s-%s' % (os.getpid(), sequence))
        with (native / 'conversations.jsonl').open('a+') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            stream.seek(0)
            known = [json.loads(value) for value in stream if value.strip()]
            if method == 'thread/resume':
                assert thread in known, 'resumed unknown native conversation'
            else:
                stream.write(json.dumps(thread) + '\n')
        config = params.get('config', {}).get('mcp_servers', {}).get('pult_memory')
        if config:
            assert not threads, 'memory-enabled host must be dedicated'
        threads[thread] = {'params': params, 'mcp': MCP(config) if config else None}
        record('thread', thread=thread, method=method, memory=bool(config))
        sandbox = {'type': {'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess'}[params['sandbox']]}
        send({'id': frame['id'], 'result': {'thread': {'id': thread}, 'cwd': params['cwd'], 'model': params.get('model', 'local-memory-fixture'), 'sandbox': sandbox, 'approvalPolicy': params['approvalPolicy']}})
    elif method == 'config/read':
        send({'id': frame['id'], 'result': {'config': {'sandbox_workspace_write': {'network_access': False, 'writable_roots': []}}}})
    elif method == 'mcpServerStatus/list':
        assert params['serverName'] == 'pult_memory' and params['limit'] == 1
        thread = params['threadId']
        mcp = threads[thread]['mcp']
        assert mcp
        # Intentional protocol-negative evidence, not a fixture exception: the
        # real MCP is running, but app-server reports an unusable tool catalog.
        rejected = threads[thread]['params'].get('model') == 'bad-mcp-fixture'
        record('mcp-status', thread=thread, rejected=rejected)
        send({'id': frame['id'], 'result': {'data': [{'name': 'pult_memory', 'runtimeStatus': 'connected', 'serverInfo': mcp.server, 'toolsError': 'fixture MCP readiness rejected' if rejected else None, 'tools': {} if rejected else {tool['name']: tool for tool in mcp.tools}}], 'nextCursor': None}})
    elif method == 'turn/start':
        sequence += 1
        thread = params['threadId']
        turn = 'native-turn-%s-%s' % (os.getpid(), sequence)
        texts = [item['text'] for item in params['input'] if item['type'] == 'text']
        instruction = json.loads(texts[0])
        records = json.loads((pult / 'sessions.json').read_text())['sessions']
        session = next(value for value in records if value.get('providerSessionId') == thread)
        journal = [json.loads(value) for value in (pult / 'events/journal.jsonl').read_text().splitlines()]
        statuses = [value for value in journal if value['sessionId'] == session['name'] and value['kind'] == 'status.changed']
        assert statuses[-1]['data']['status'] == 'working'
        assert len(texts) == (3 if threads[thread]['mcp'] else 2)
        assert texts[-1].startswith('<pult_runtime_context>')
        if threads[thread]['mcp']:
            assert texts[1].startswith('Project memory:') and len(texts[1]) <= 4000 and len(texts[1].encode()) <= 16000
        record('dispatch', run=instruction['run'], session=session['name'], thread=thread, turn=turn, texts=texts)
        active[thread] = turn
        notice('turn/started', thread, turn, turn={'id': turn, 'status': 'inProgress'})
        # Critical ordering: ACK before a separate thread waits for human approval.
        send({'id': frame['id'], 'result': {'turn': {'id': turn, 'status': 'inProgress'}}})
        if instruction.get('mode') != 'hold':
            threading.Thread(target=work, args=(thread, turn, instruction), daemon=True).start()
    elif method == 'turn/interrupt':
        send({'id': frame['id'], 'result': {}})
        if active.get(params['threadId']) == params['turnId']:
            finish(params['threadId'], params['turnId'], status='interrupted')
