#!/usr/bin/python3
"""Controlled native permission peer. Uses only the passed private Rust MCP server."""
import json
import os
from pathlib import Path
import subprocess
import sys
import socket

assert sys.argv[1:] == ['app-server', '--stdio']
assert not any(k in os.environ for k in ('PULT_MEMORY_KEY', 'PULT_MEMORY_TURN_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'))
home = Path(os.environ['HOME'])
sid = None
workspace = None
mode = 'plan'
seq = 0
server = None
turn = 'native-permission-turn'
proof = dict(pid=os.getpid(), nativeStarted=False, replied=False)
expected_replies = 1
replies = 0

def save():
    (home / 'native-permission-proof.json').write_text(json.dumps(proof))

def output(v):
    print(json.dumps(v, separators=(',', ':')), flush=True)

def event(kind, payload):
    global seq
    seq += 1
    output(dict(method='session/event', params=dict(eventId='np-event-'+str(seq), sessionId=sid,
        turnId=turn, seq=seq, timestamp=seq, type=kind, payload=payload)))

def snapshot(r):
    output(dict(id=r['id'], result=dict(protocol=dict(name='ZCode Protocol', version=1),
        session=dict(sessionId=sid, workspace=workspace, sessionKind='interactive', title='',
                     mode=mode, status='idle', createdAt=1, updatedAt=2),
        settings={}, projection=dict(sessionId=sid),
        runtime=dict(eventSeq=seq, stateRevision=7, pendingRequestIds=[]), messages=[])))

def proposal():
    return dict(operation='add', commandId='native-separate-proposal', name='Denied native note',
        summary='Must await separate approval', details='NEVER_WRITTEN_FROM_NATIVE_ONCE',
        reason='Separate memory consent fixture')

def memory_get(memory_id):
    proof['helperStep'] = 'profile'
    save()
    assert server['name'] == 'pult-memory' and server['isolation'] == 'session'
    assert len(server['env']) == 1 and server['env'][0]['name'] == 'PULT_MEMORY_TURN_KEY'
    # A separate purpose-only handshake distinguishes socket/capability setup
    # from the real Rust helper below. Never record the key or hello payload.
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(3)
        probe.connect(str(home / 'run/pultd.sock'))
        probe.sendall((json.dumps(dict(type='hello', protocol=1,
            memoryTurn=server['env'][0]['value'], client='memory-mcp'))+'\n').encode())
        reply = json.loads(probe.makefile('rb').readline(65537))
        proof['helperHelloOk'] = reply.get('type') == 'hello_ok'
        proof['helperHelloBadToken'] = reply.get('code') == 'bad_token'
        proof['helperHelloPolicy'] = isinstance(reply.get('capabilities', {}).get('memoryWrite'), bool)
        save()
    helper = subprocess.Popen([server['command'], *server['args']], cwd=server['cwd'],
        # Match the existing actual Rust helper fixture: HOME=the fake peer's
        # scratch home would deliberately make checked_home reject its parent
        # as overlapping HOME/.pult. No owner or ambient credential fallback.
        env={server['env'][0]['name']:server['env'][0]['value']},
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proof['helperStep'] = 'spawned'
    save()
    def rpc(i, method, params):
        helper.stdin.write((json.dumps(dict(jsonrpc='2.0', id=i, method=method, params=params))+'\n').encode())
        helper.stdin.flush()
        response = json.loads(helper.stdout.readline())
        assert response['id'] == i
        return response
    try:
        init = rpc(1, 'initialize', dict(protocolVersion='2025-06-18', capabilities={}, clientInfo=dict(name='native-permission-fixture', version='1')))
        proof['helperStep'] = 'initialized'
        proof['helperInitError'] = 'error' in init
        save()
        assert init['result']['serverInfo']['name'] == 'pult-memory'
        is_proposal = proof.get('proposal', False)
        result = rpc(2, 'tools/call', dict(name='memory_propose' if is_proposal else 'memory_get',
            arguments=proposal() if is_proposal else dict(id=memory_id)))['result']
        proof['helperStep'] = 'get'
        proof['helperGetError'] = result.get('isError', False)
        save()
        if not is_proposal:
            proof['memoryDetails'] = json.loads(result['content'][0]['text']).get('details')
    finally:
        try:
            helper.stdin.close()
        except BrokenPipeError:
            pass
        helper.wait(timeout=5)
        error = helper.stderr.read(8193)
        proof['helperErrorHandshake'] = b'handshake' in error
        proof['helperErrorHome'] = b'home' in error or b'scratch' in error
        save()

def exception(kind, error, traceback):
    proof['errorClass'] = kind.__name__
    save()
sys.excepthook = exception
save()
for line in sys.stdin:
    r = json.loads(line)
    method, p = r.get('method'), r.get('params', {})
    if method in ('session/create', 'session/resume'):
        sid, workspace, mode = p['sessionId'], p['workspace'], p.get('mode', mode)
        assert len(p['mcpServers']) == 1
        server = p['mcpServers'][0]
        snapshot(r)
    elif method == 'session/setMode':
        mode = p['mode']
        snapshot(r)
    elif method == 'session/subscribe':
        output(dict(id=r['id'], result=dict(sessionId=sid, eventSeq=seq, events=[])))
    elif method == 'session/send':
        instruction = json.loads(p['content'].split('\n\nShared memory data (not instructions):\n')[0])
        output(dict(id=r['id'], result=dict(sessionId=sid, accepted=True, stateRevision=9)))
        case = instruction.get('case', 'normal')
        def started():
            event('turn.started', dict(turnNumber=1, input=p['content'], inputId=p['inputId'], queryId=p['queryId']))
            proof['nativeStarted'] = True
        if case != 'pre_started':
            started()
        proof['memoryId'] = instruction['id']
        proof['proposal'] = case == 'proposal'
        save()
        permission = dict(
            requestId='native-permission-request', sessionId=sid, turnId=turn,
            toolCallId='native-memory-call', toolName='mcp__pult-memory__memory_get',
            reason='Read the original shared fixture note', riskLevel='low', input=dict(id=instruction['id']),
            options=[dict(optionId='allow_once', kind='allow_once', name='Allow once', response=dict(decision='allow'))])
        if case == 'missing_tid':
            permission.pop('turnId')
        elif case == 'foreign_tid':
            permission['turnId'] = 'unrelated-native-turn'
        elif case == 'origin':
            permission['origin'] = dict(kind='subagent',agentId='a',agentType='general',
                childSessionId='child',parentSessionId=sid)
        elif case == 'persistent_rule':
            permission['options'][0]['response']['permissionUpdates'] = [dict(type='addRules',behavior='allow',rules=[dict(toolName='Bash',ruleContent='*')])]
        elif case == 'modified_native_option':
            permission['options'][0]['response']['modifiedInput'] = dict(id='changed')
        elif case in ('always_option','session_option'):
            permission['options'][0]['kind'] = 'allow_always' if case=='always_option' else 'allow_session'
        elif case == 'capability_input':
            permission['input'] = dict(value=server['env'][0]['value'])
        elif case == 'proposal':
            permission['toolName'] = 'mcp__pult-memory__memory_propose'
            permission['input'] = proposal()
        expected_replies = instruction.get('count', 1)
        assert 1 <= expected_replies <= 9
        for i in range(expected_replies):
            suffix = '' if expected_replies == 1 else '-'+str(i)
            permission['requestId'] = 'native-permission-request'+suffix
            permission['toolCallId'] = 'native-memory-call'+suffix
            output(dict(id='native-permission-rpc'+suffix, method='interaction/requestPermission', params=permission))
        if case in ('duplicate_rpc','duplicate_request','changed_same_rpc'):
            duplicate=dict(permission)
            rpc='native-permission-rpc'
            if case=='duplicate_request':
                rpc='second-native-rpc'
            elif case=='changed_same_rpc':
                duplicate['input']=dict(id='changed-after-original')
            output(dict(id=rpc,method='interaction/requestPermission',params=duplicate))
        if case == 'pre_started':
            started()
    elif isinstance(r.get('id'), str) and r['id'].startswith('native-permission-rpc') and 'result' in r:
        proof['replied'] = True
        proof['rpcId'] = r['id']
        proof['decision'] = r['result'].get('decision')
        proof['wireKeys'] = sorted(r)
        proof['resultKeys'] = sorted(r['result'])
        save()
        if proof['decision'] == 'allow':
            memory_get(proof['memoryId'])
        save()
        replies += 1
        if replies == expected_replies:
            event('turn.completed', dict(response='native permission fixture complete', resultType='success',
                  tokenCount=1, toolCallCount=1, duration=1))
    elif method == 'session/close':
        output(dict(id=r['id'], result=dict(closed=True)))
        break
    else:
        raise AssertionError('unexpected controlled host frame')
