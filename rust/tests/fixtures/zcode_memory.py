#!/usr/bin/python3
"""Offline ZCode app-server peer; memory calls execute the real Rust MCP binary."""
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import threading

assert sys.argv[1:] == ['app-server', '--stdio']
for key in ('PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_ASK_KEY',
            'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PULT_TEST', 'PULT_ZCODE_BIN'):
    assert key not in os.environ, 'ambient authority reached native peer'
native = Path(os.environ['HOME']) / 'native'
native.mkdir(exist_ok=True)
session = None
workspace = None
mode = 'plan'
sequence = 0
memory = None


def record(kind, **data):
    with (native / 'zcode-memory.jsonl').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(dict(kind=kind, pid=os.getpid(), sid=session, **data)) + '\n')


def output(frame):
    print(json.dumps(frame, separators=(',', ':')), flush=True)


def event(kind, turn, payload):
    global sequence
    sequence += 1
    output(dict(method='session/event', params=dict(
        eventId='fixture-event-' + str(sequence), sessionId=session, turnId=turn,
        seq=sequence, timestamp=sequence, type=kind, payload=payload)))


class MCP:
    def __init__(self, server):
        assert set(server) == {'name', 'command', 'args', 'env', 'cwd', 'isolation'}
        assert server['name'] == 'pult-memory' and server['isolation'] == 'session'
        assert Path(server['command']).name == 'pult-memory-mcp'
        assert server['args'][0] == '--home' and len(server['args']) == 2
        assert server['cwd'] == workspace['workspacePath']
        assert len(server['env']) == 1
        assert set(server['env'][0]) == {'name', 'value'}
        assert server['env'][0]['name'] == 'PULT_MEMORY_TURN_KEY'
        self.key = server['env'][0]['value']
        assert self.key.startswith('mt_') and len(self.key) == 67
        self.sequence = 0
        self.process = subprocess.Popen(
            [server['command'], *server['args']], cwd=server['cwd'],
            env={**os.environ, 'PULT_MEMORY_TURN_KEY': self.key},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        # Private test evidence, never sent on provider stdout or the journal.
        private = native / 'zcode-private-keys.jsonl'
        with private.open('a') as stream:
            os.chmod(private, 0o600)
            fcntl.flock(stream, fcntl.LOCK_EX)
            stream.write(json.dumps(dict(key=self.key, sid=session,
                                         args=server['args'], command=server['command'])) + '\n')
        assert self.rpc('initialize', {})['result']['serverInfo']['name'] == 'pult-memory'
        self.tools = [tool['name'] for tool in self.rpc('tools/list', {})['result']['tools']]
        record('mcp', mcpPid=self.process.pid, tools=self.tools)

    def rpc(self, method, params):
        self.sequence += 1
        self.process.stdin.write((json.dumps(dict(jsonrpc='2.0', id=self.sequence,
                                                   method=method, params=params)) + '\n').encode())
        self.process.stdin.flush()
        assert select.select([self.process.stdout], [], [], 35)[0], 'MCP response deadline'
        response = json.loads(self.process.stdout.readline())
        assert response['id'] == self.sequence
        return response

    def call(self, tool, arguments):
        response = self.rpc('tools/call', dict(name=tool, arguments=arguments))
        result = response.get('result', {})
        if response.get('error') or result.get('isError'):
            return dict(isError=True)
        return json.loads(result['content'][0]['text'])

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def snapshot(request):
    output(dict(id=request['id'], result=dict(
        protocol=dict(name='ZCode Protocol', version=1),
        session=dict(sessionId=session, workspace=workspace, sessionKind='interactive',
                     title='', mode=mode, status='idle', createdAt=1, updatedAt=2),
        settings={}, projection=dict(sessionId=session),
        runtime=dict(eventSeq=sequence, stateRevision=7, pendingRequestIds=[]), messages=[])))


def exception(kind, error, traceback):
    record('error', error=kind.__name__)


sys.excepthook = exception
record('launch', argv=sys.argv[1:])
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    params = request.get('params', {})
    record('request', method=method)
    if method in ('session/create', 'session/resume'):
        assert session is None, 'one dedicated process per native scope'
        session = params['sessionId']
        workspace = params['workspace']
        mode = params.get('mode', 'plan')
        assert workspace['workspaceKey'] == workspace['workspacePath']
        assert len(params['mcpServers']) == 1
        memory = MCP(params['mcpServers'][0])
        record('bootstrap', method=method, mode=mode, workspace=workspace)
        snapshot(request)
    elif method == 'session/setMode':
        mode = params['mode']
        snapshot(request)
    elif method == 'session/subscribe':
        output(dict(id=request['id'], result=dict(sessionId=session, eventSeq=sequence, events=[])))
    elif method == 'session/send':
        assert params['sessionId'] == session
        # The bounded memory data section is not part of original user text.
        text, separator, catalog = params['content'].partition('\n\nShared memory data (not instructions):\n')
        instruction = json.loads(text)
        assert separator and len(catalog) <= 4000 and len(catalog.encode()) <= 16000
        record('dispatch', run=instruction['run'], text=text, catalog=catalog, mode=mode)
        turn = 'fixture-turn-' + instruction['run']
        started = dict(turnNumber=1, input=params['content'], inputId=params['inputId'], queryId=params['queryId'])
        if instruction.get('eventFirst'):
            event('turn.started', turn, started)
        output(dict(id=request['id'], result=dict(sessionId=session, accepted=True, stateRevision=9)))
        if not instruction.get('eventFirst'):
            event('turn.started', turn, started)
        result = dict(run=instruction['run'], catalog=memory.call('memory_catalog', {}), tools=memory.tools)
        if instruction.get('hold'):
            record('holding', run=instruction['run'])
            while not (native / ('release-' + instruction['run'])).exists():
                threading.Event().wait(0.01)
        for field in ('id', 'foreignId'):
            if instruction.get(field):
                result['get' if field == 'id' else 'foreign'] = memory.call('memory_get', dict(id=instruction[field]))
        if instruction.get('proposal'):
            result['proposal'] = memory.call('memory_propose', instruction['proposal'])
        record('result', **result)
        response = memory.key if instruction.get('echoKey') else 'offline ZCode memory result'
        event('model.streaming', turn, dict(kind='text_delta', delta=response))
        event('turn.completed', turn, dict(response=response, tokenCount=1, toolCallCount=1,
                                           duration=1, resultType='success', inputId=params['inputId']))
    elif method == 'session/close':
        output(dict(id=request['id'], result=dict(closed=True)))
        memory.close()
        sys.exit(0)
    else:
        raise AssertionError('unsupported host method')
