#!/usr/bin/python3
"""Synthetic argv Route A; scratch files only, never a provider/account."""
import json
import os
import pathlib
import sys
import threading

for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PULT_MEMORY_KEY", "PULT_MEMORY_TURN_KEY", "PULT_ASK_KEY", "PULT_OWNER_TOKEN", "PULT_TEST", "PULT_ZCODE_BIN", "HTTPS_PROXY", "ALL_PROXY"):
    assert key not in os.environ, "ambient authority reached synthetic ZCode"
args = sys.argv[1:]
assert "--mcp-config" not in args and "--session-id" not in args
account = pathlib.Path(os.environ["HOME"])
native = account / "native"
home = account.parent / "home"
cwd = pathlib.Path(args[args.index("--cwd") + 1])
name = cwd.name
prompt = args[args.index("-p") + 1]
record = next(row for row in json.loads((home / "sessions.json").read_text())["sessions"] if row["name"] == name)
assert "zcodePendingInput" in record, "argv input preceded durable reservation"
sid = args[args.index("--resume") + 1] if "--resume" in args else "sess_fixture_" + name
tid = "turn_fixture_" + str(os.getpid())
with (native / "launches.jsonl").open("a") as out:
    out.write(json.dumps({"name": name, "pid": os.getpid(), "args": args, "session": sid}) + "\n")
if "auth-provider" in prompt:
    print("authentication_required", file=sys.stderr, flush=True)
    sys.exit(1)

def emit(kind, payload=None, **extra):
    print(json.dumps(dict(type=kind, sessionId=sid, turnId=tid, payload=payload or {}, **extra)), flush=True)

emit("session.titleUpdated", {"title": "synthetic " + name})
if "session-only-provider" in prompt:
    sys.exit(0)
emit("turn.started", {"modelSelection": {"modelId": "fixture-model"}})
if "hold-provider" in prompt:
    release = native / ("release-" + name)
    while not release.exists():
        threading.Event().wait(0.01)
    release.unlink()
emit("model.streaming", {"kind": "text_delta", "delta": "Synthetic ZCode 🌊"})
emit("turn.completed", {"resultType": "success", "response": "Synthetic ZCode 🌊"})
print(json.dumps({"type": "result", "sessionId": sid, "turnId": tid, "success": True, "response": "Synthetic ZCode 🌊"}), flush=True)
