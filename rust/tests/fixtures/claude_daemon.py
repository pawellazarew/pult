#!/usr/bin/python3
"""Synthetic native Claude; actual scoped Rust helper, never a model/account."""
import json
import os
import pathlib
import subprocess
import sys
import threading

for name in ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "PULT_MEMORY_KEY", "PULT_MEMORY_TURN_KEY", "PULT_ASK_KEY", "PULT_OWNER_TOKEN", "PULT_TEST", "PULT_CLAUDE_BIN", "PULT_CODEX_BIN", "HTTPS_PROXY", "ALL_PROXY"):
    assert name not in os.environ, "ambient authority reached synthetic provider"
account = pathlib.Path(os.environ["HOME"])
native = account / "native"
args = sys.argv[1:]
sid = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
assert "--mcp-config" in args, "missing actual scoped MCP config"
config_path = pathlib.Path(args[args.index("--mcp-config") + 1])
config = json.loads(config_path.read_text())
server = config["mcpServers"]["pult"]
pult = pathlib.Path(server["env"]["PULT_HOME"])
name = server["env"]["PULT_ASK_SESSION"]
# Synthetic capability is private scratch-only test input for post-revocation
# checks. It is never printed or put in public journal/diagnostic evidence.
scope = native / (name + "-scope.json")
fd = os.open(scope, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as out:
    json.dump({"path": str(config_path), "server": server}, out)
with (native / "launches.jsonl").open("a") as out:
    out.write(json.dumps({"name": name, "pid": os.getpid(), "args": args, "session": sid}) + "\n")

for line in sys.stdin:
    request = json.loads(line)
    record = next(r for r in json.loads((pult / "sessions.json").read_text())["sessions"] if r["name"] == name)
    assert record.get("claudeReservedSessionId") == sid, "native input preceded durable reservation"
    user = next(e for e in [json.loads(row) for row in (pult / "events/journal.jsonl").read_text().splitlines()] if e["sessionId"] == name and e["kind"] == "message.user")
    assert user["data"].get("text") not in args, "literal user input reached argv"
    with (native / "inputs.jsonl").open("a") as out:
        out.write(json.dumps({"name": name, "session": sid, "input": request}) + "\n")
    def emit(frame):
        frame["session_id"] = sid
        print(json.dumps(frame), flush=True)
    emit({"type": "system", "subtype": "init", "permissionMode": "manual"})
    emit({"type": "command_lifecycle", "command_uuid": request["uuid"], "state": "started"})
    texts = [block.get("text", "") for block in request["message"]["content"] if block.get("type") == "text"]
    literal = "\n".join(texts)
    if "hold-provider" in literal:
        release = native / ("release-" + name)
        while not release.exists():
            threading.Event().wait(0.01)
        release.unlink()
    if "ask-provider" in literal:
        env = dict(os.environ)
        env.update(server["env"])
        helper = subprocess.Popen([server["command"], *server.get("args", [])], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            def rpc(frame):
                helper.stdin.write(json.dumps(frame) + "\n")
                helper.stdin.flush()
                value = helper.stdout.readline()
                assert value, "actual MCP helper closed before response"
                return json.loads(value)
            initialize = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
            assert initialize["result"]["serverInfo"]["name"] == "pult"
            reply = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "ask", "arguments": {"tool_name": "Bash", "tool_use_id": "fixture-tool", "input": {"command": "fixture-original"}, "sessionId": "foreign-is-not-authority"}}})
            decision = json.loads(reply["result"]["content"][0]["text"])
            assert decision["behavior"] in ("allow", "deny")
            journal = [json.loads(row) for row in (pult / "events/journal.jsonl").read_text().splitlines()]
            assert any(row["sessionId"] == name and row["kind"] == "permission.resolved" and row["data"].get("decision") == decision["behavior"] for row in journal), "native decision preceded durable resolution"
            if decision["behavior"] == "allow":
                assert decision.get("updatedInput") == {"command": "fixture-original"}, "native reply rewrote immutable request"
            with (native / "decisions.jsonl").open("a") as out:
                out.write(json.dumps({"name": name, "behavior": decision["behavior"]}) + "\n")
        finally:
            helper.stdin.close()
            helper.wait(timeout=5)
    emit({"type": "result", "terminal_reason": "completed", "is_error": False, "result": "synthetic Claude result", "num_turns": 1, "user_message_uuids": [request["uuid"]]})
