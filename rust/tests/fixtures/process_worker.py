"""Deterministic process-group fixtures; never starts a model or reads credentials."""
import json
import os
import signal
import subprocess
import sys
import time

MODE = sys.argv[1]
MARKER = sys.argv[2]
SECRET = "PULT_PRIVATE_STDERR_8d413f"


def emit(value):
    print(json.dumps(value), flush=True)


if MODE == "idle":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.alarm(60)
    while True:
        signal.pause()
elif MODE == "tree":
    stubborn = len(sys.argv) > 3 and sys.argv[3] == "stubborn"
    if stubborn:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    descendant = subprocess.Popen([sys.executable, "-B", __file__, "idle", MARKER])
    signal.alarm(60)
    emit({"provider": os.getpid(), "descendant": descendant.pid})
    # Do not let EOF on holder stdin act as the cleanup proof.
    while True:
        time.sleep(0.1)
elif MODE == "blocked-input":
    if sys.platform.startswith("linux"):
        import fcntl
        fcntl.fcntl(sys.stdin.fileno(), fcntl.F_SETPIPE_SZ, 4096)
    signal.alarm(60)
    emit({"provider": os.getpid()})
    # Keep input unread: a near-frame-sized send cannot complete into pipes.
    while True:
        signal.pause()
elif MODE == "many":
    for number in range(100):
        emit({"number": number})
    sys.exit(7)
elif MODE == "bad-json":
    emit({"provider": os.getpid()})
    print('{"private":"' + SECRET + '", broken', flush=True)
    for _ in sys.stdin:
        pass
elif MODE == "oversize":
    emit({"provider": os.getpid()})
    print("x" * (1024 * 1024 + 1), flush=True)
    for _ in sys.stdin:
        pass
elif MODE == "stderr":
    sys.stderr.write((SECRET + "\n") * 8192)
    sys.stderr.flush()
    emit({"ready": True})
    for _ in sys.stdin:
        pass
elif MODE == "touch":
    with open(MARKER, "w", encoding="utf-8") as output:
        output.write("unexpected launch")
else:
    emit({"ready": True, "memory": os.environ.get("PULT_MEMORY_KEY"),
          "owner_secret": os.environ.get("ANTHROPIC_API_KEY")})
    for line in sys.stdin:
        request = json.loads(line)
        if request.get("exit"):
            emit({"last": True})
            break
        emit({"echo": request})
