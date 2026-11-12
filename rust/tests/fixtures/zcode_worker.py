# Synthetic Route A native protocol; no CLI, account, credential, or model.
import json, os, pathlib, sys, threading
home, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
args = sys.argv[3:]
(home / 'provider.pid').write_text(str(os.getpid()))
(home / 'argv.json').write_text(json.dumps(args))
# The actual provider can see the durable reservation before argv consumption.
records = json.loads((home / 'sessions.json').read_text())
(home / 'reservation-observed').write_text(json.dumps(records))
sid = args[args.index('--resume') + 1] if '--resume' in args else 'sess_fixture_native'
tid = 'turn_fixture_native'
def emit(kind, payload=None, **extra):
    print(json.dumps(dict(type=kind, sessionId=sid, turnId=tid, payload=payload or {}, **extra)), flush=True)
if mode in ('auth', 'quota', 'missing'):
    print({'auth':'authentication_required','quota':'quota_exceeded','missing':'session native not found'}[mode], file=sys.stderr, flush=True)
    sys.exit(1)
emit('session.titleUpdated', {'title':'native title'})
if mode == 'session-only': sys.exit(0)
if mode == 'hold-before-start':
    (home / 'before-start').write_text('ready')
    # Host tests release via stdin, an independent observable synchronization.
    sys.stdin.readline()
emit('turn.started', {'modelSelection': {'modelId':'fixture-model'}})
if mode == 'hold': threading.Event().wait()
if mode == 'conflict':
    print(json.dumps({'type':'session.updated','sessionId':'sess_foreign','turnId':tid}), flush=True)
    sys.exit(0)
if mode == 'malformed':
    print(json.dumps({'type':'session.updated','sessionId':None,'turnId':tid}), flush=True)
    sys.exit(0)
emit('model.streaming', {'kind':'text_delta','delta':'Привет 🌊'})
if mode in ('cancelled', 'cancelled-result-failure'):
    emit('turn.completed', {'resultType':'cancelled'})
    if mode == 'cancelled': sys.exit(130)
    print(json.dumps({'type':'result','sessionId':sid,'turnId':tid,'resultType':'error'}), flush=True)
    sys.exit(1)
emit('turn.completed', {'resultType':'success','response':'Привет 🌊'})
if mode != 'completed-only':
    print(json.dumps({'type':'result','sessionId':sid,'turnId':tid,'success':True,'response':'Привет 🌊'}), flush=True)
