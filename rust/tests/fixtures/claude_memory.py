#!/usr/bin/python3
"""Offline native Claude + real Rust memory MCP. Private scratch HOME only."""
import fcntl
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import threading

for key in ('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PULT_MEMORY_TURN_KEY', 'PULT_ASK_KEY', 'PULT_TEST', 'PULT_CODEX_BIN', 'PULT_CLAUDE_BIN', 'HTTPS_PROXY'):
    assert key not in os.environ, 'ambient authority reached fixture'
native = Path(os.environ['HOME']) / 'native'
args = sys.argv[1:]
config_path = Path(args[args.index('--mcp-config') + 1])
config = json.loads(config_path.read_text())['mcpServers']
ask = config['pult']
home = Path(ask['env']['PULT_HOME'])
name = ask['env']['PULT_ASK_SESSION']
sid = args[args.index('--resume') + 1] if '--resume' in args else args[args.index('--session-id') + 1]

def record(kind, **data):
    with (native / 'claude-memory.jsonl').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(dict(kind=kind, name=name, pid=os.getpid(), **data)) + '\n')

def emit(value):
    print(json.dumps(dict(value, session_id=sid)), flush=True)

class MCP:
    def __init__(self, server):
        assert set(server) == {'command', 'args', 'env'}
        assert list(server['env']) == ['PULT_MEMORY_TURN_KEY']
        self.key = server['env']['PULT_MEMORY_TURN_KEY']
        assert self.key.startswith('mt_') and len(self.key) == 67
        self.sequence = 0
        self.child = subprocess.Popen([server['command'], *server['args']], env={**os.environ, **server['env']}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        assert self.rpc('initialize', {})['result']['serverInfo']['name'] == 'pult-memory'
        self.tools = [tool['name'] for tool in self.rpc('tools/list', {})['result']['tools']]
        record('mcp', mcpPid=self.child.pid, tools=self.tools)

    def rpc(self, method, params):
        self.sequence += 1
        self.child.stdin.write(json.dumps(dict(jsonrpc='2.0', id=self.sequence, method=method, params=params)) + '\n')
        self.child.stdin.flush()
        assert select.select([self.child.stdout], [], [], 35)[0], 'MCP response deadline'
        response = json.loads(self.child.stdout.readline())
        assert response['id'] == self.sequence
        return response

    def call(self, tool, arguments):
        response = self.rpc('tools/call', dict(name=tool, arguments=arguments))
        result = response.get('result', {})
        if response.get('error') or result.get('isError'):
            return {'isError': True}
        return json.loads(result['content'][0]['text'])

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()

def exception(kind, error, traceback):
    record('error', error=kind.__name__)
sys.excepthook = exception
record('launch', configPath=str(config_path), memory='pult-memory' in config)
for line in sys.stdin:
    frame = json.loads(line)
    texts = [block['text'] for block in frame['message']['content'] if block.get('type') == 'text']
    instruction = json.loads(texts[0])
    memory_on = 'pult-memory' in config
    assert len(texts) == (3 if memory_on else 2)
    assert texts[-1].startswith('<pult_runtime_context>')
    if memory_on:
        assert texts[1].startswith('Project memory:')
        assert len(texts[1].encode()) <= 16000
    record('dispatch', run=instruction['run'], texts=texts)
    emit(dict(type='system', subtype='init', permissionMode='manual'))
    emit(dict(type='command_lifecycle', command_uuid=frame['uuid'], state='started'))
    mcp = None
    try:
        result = dict(run=instruction['run'])
        if memory_on:
            mcp = MCP(config['pult-memory'])
            result['catalog'] = mcp.call('memory_catalog', {})
            if instruction.get('hold'):
                record('holding', run=instruction['run'])
                release = native / ('release-' + instruction['run'])
                while not release.exists():
                    threading.Event().wait(0.01)
            if instruction.get('id'):
                result['get'] = mcp.call('memory_get', {'id': instruction['id']})
            if instruction.get('proposal'):
                result['proposal'] = mcp.call('memory_propose', instruction['proposal'])
            result['tools'] = mcp.tools
        record('result', **result)
    finally:
        if mcp:
            mcp.close()
    emit(dict(type='result', terminal_reason='completed', is_error=False, result='offline Claude memory result', num_turns=1, user_message_uuids=[frame['uuid']]))
