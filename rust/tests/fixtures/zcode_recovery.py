#!/usr/bin/python3
"""Synthetic recovery Route A. Only private scratch HOME files are used."""
import json
import os
import pathlib
import sys
import threading

for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PULT_MEMORY_KEY", "PULT_MEMORY_TURN_KEY", "PULT_ASK_KEY", "PULT_OWNER_TOKEN", "PULT_TEST", "PULT_ZCODE_BIN", "HTTPS_PROXY", "ALL_PROXY"):
    assert key not in os.environ, "ambient authority reached recovery fixture"
args = sys.argv[1:]
assert "--session-id" not in args and "--mcp-config" not in args
account = pathlib.Path(os.environ["HOME"])
native = account / "native"
home = account.parent / "home"
name = pathlib.Path(args[args.index("--cwd") + 1]).name
prompt = args[args.index("-p") + 1]
record = next(row for row in json.loads((home / "sessions.json").read_text())["sessions"] if row["name"] == name)
assert "zcodePendingInput" in record, "input preceded durable reservation"
sid = args[args.index("--resume") + 1] if "--resume" in args else "sess_recovery_" + name + "_" + str(os.getpid())
tid = "turn_recovery_" + str(os.getpid())
with (native / "launches.jsonl").open("a") as out:
    out.write(json.dumps({"name": name, "pid": os.getpid(), "args": args, "session": sid}) + "\n")
if prompt.startswith("missing-provider"):
    assert "--resume" in args, "missing scenario must use a confirmed native ID"
    # No native acceptance, no forged SID/turn frame. Genuine natural EOF.
    print("invalid session id", file=sys.stderr, flush=True)
    sys.exit(1)

def emit(kind, payload=None):
    print(json.dumps(dict(type=kind, sessionId=sid, turnId=tid, payload=payload or {})), flush=True)

emit("session.titleUpdated", {"title": "synthetic recovery " + name})
emit("turn.started", {"modelSelection": {"modelId": "fixture-model"}})
if prompt.startswith("hold-provider"):
    threading.Event().wait()
emit("model.streaming", {"kind": "text_delta", "delta": "Recovery fixture 🌊"})
emit("turn.completed", {"resultType": "success", "response": "Recovery fixture 🌊"})
print(json.dumps({"type": "result", "sessionId": sid, "turnId": tid, "success": True, "response": "Recovery fixture 🌊"}), flush=True)
