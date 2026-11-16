# Synthetic native Claude protocol; no model or account access.
sys = __import__('sys')
sys.stderr.write('PULT_CLAUDE_FIXTURE_PRE_IMPORT\n')
sys.stderr.flush()

def phase(value):
    # Fixed synthetic phases only. Rust retains bounded bits after failure,
    # never the provider's private stderr, paths or input contents.
    sys.stderr.write(value + '\n')
    sys.stderr.flush()

phase('PULT_CLAUDE_FIXTURE_IMPORT_BEFORE_JSON')
import json
phase('PULT_CLAUDE_FIXTURE_IMPORT_AFTER_JSON')
phase('PULT_CLAUDE_FIXTURE_IMPORT_BEFORE_OS')
import os
phase('PULT_CLAUDE_FIXTURE_IMPORT_AFTER_OS')
phase('PULT_CLAUDE_FIXTURE_IMPORT_BEFORE_SYS')
import sys
phase('PULT_CLAUDE_FIXTURE_IMPORT_AFTER_SYS')
phase('PULT_CLAUDE_FIXTURE_POST_IMPORT')
home = sys.argv[1]
mode = sys.argv[2]
args = sys.argv[3:]
sid = args[args.index('--session-id') + 1] if '--session-id' in args else args[args.index('--resume') + 1]
def save(name, value):
    with open(os.path.join(home, name), 'w') as stream:
        stream.write(value)
save('provider.pid', str(os.getpid()))

def hold():
    # Only hold modes need threading, after decoded input, init and the existing
    # command_lifecycle ACK. Ordinary content tests do not depend on its import.
    phase('PULT_CLAUDE_FIXTURE_IMPORT_BEFORE_THREADING')
    import threading
    phase('PULT_CLAUDE_FIXTURE_IMPORT_AFTER_THREADING')
    threading.Event().wait()
def step(value):
    # Static test phases only: never native contents, paths or credentials.
    if mode == 'memory-observe':
        save('fixture-step', value)
step('started')
for line in sys.stdin:
    step('input-read')
    item = json.loads(line)
    step('input-decoded')
    save('input.json', json.dumps(item))
    step('input-saved')
    def emit(value):
        value['session_id'] = sid
        print(json.dumps(value), flush=True)
    reported_mode = 'acceptEdits' if mode == 'wide-mode' else 'manual'
    if mode == 'malformed-mode': reported_mode = {'mode':'manual'}
    if mode == 'control-mode': reported_mode = 'manual\x00'
    if mode == 'null-mode': reported_mode = None
    emit({'type':'system', 'subtype':'init', 'permissionMode': reported_mode})
    step('init-written')
    emit({'type':'command_lifecycle', 'command_uuid':item['uuid'], 'state':'started'})
    step('ack-written')
    if mode == 'assistant-block':
        emit({'type':'assistant', 'is_api_error_message':True, 'message':{'content':[{'type':'text','text':'Disabled Claude subscription access'}]}})
        hold()
    if mode == 'result-block':
        emit({'type':'result', 'is_error':True, 'terminal_reason':'api_error', 'result':'Disabled Claude subscription access', 'user_message_uuids':[item['uuid']], 'usage':{'output_tokens':17}})
        hold()
    if mode == 'hold':
        hold()
    if mode == 'completed-only':
        emit({'type':'command_lifecycle', 'command_uuid':item['uuid'], 'state':'completed'})
    else:
        emit({'type':'result', 'is_error':False, 'terminal_reason':'completed', 'result':'fixture result', 'num_turns':1, 'user_message_uuids':[item['uuid']]})
        step('result-written')
