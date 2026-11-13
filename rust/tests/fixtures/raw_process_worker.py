"""Raw wire fixtures only. Never accesses models, accounts, or credentials."""
import json
import os
import pathlib
import signal
import subprocess
import sys

mode = sys.argv[1]
home = sys.argv[2]
secret = "PRIVATE_RAW_FRAME_FIXTURE"


def write(frame):
    sys.stdout.buffer.write(frame)
    sys.stdout.buffer.flush()


if mode == "idle":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.alarm(60)
    while True:
        signal.pause()
elif mode == "exact":
    write(b'{"id":1,"result":{},"result":{"private":"PRIVATE_RAW_FRAME_FIXTURE"}}\r\n')
    write(b'{"private":"PRIVATE_RAW_FRAME_FIXTURE", broken\n')
    write(b'{"invalidUtf8":"\xff"}\n')
    for _ in sys.stdin.buffer:
        pass
elif mode == "saturated":
    write(b'{"one":1}\n')
    write(b'{"two":2}\n')
    write(b'{"three":3}\n')
    pathlib.Path(home, 'raw-written').write_text('written')
    for _ in sys.stdin.buffer:
        pass
elif mode == "fragmented":
    frame = '{"text":"Пульт 🌊"}\r\n'.encode()
    for byte in frame:
        write(bytes([byte]))
    write(b'{}\n')
elif mode == "sized":
    size = int(sys.argv[3])
    prefix = b'{"payload":"'
    suffix = b'"}\n'
    write(prefix + b'x' * (size - len(prefix) - len(suffix)) + suffix)
    write(b'{"tail":true}\n')
    for _ in sys.stdin.buffer:
        pass
elif mode == "truncated":
    write(b'{"private":"PRIVATE_RAW_FRAME_FIXTURE"}')
elif mode == "echo":
    for line in sys.stdin.buffer:
        write(line)
elif mode == "natural":
    write(b'{"one":1}\n')
    write(b'{"two":2}\r\n')
    sys.exit(7)
elif mode == "blocked-input-tree":
    child = subprocess.Popen([sys.executable, "-B", __file__, "idle", home])
    signal.alarm(60)
    write((json.dumps({"provider": os.getpid(), "descendant": child.pid}) + "\n").encode())
    while True:
        signal.pause()
else:
    raise RuntimeError("unknown raw fixture mode")
