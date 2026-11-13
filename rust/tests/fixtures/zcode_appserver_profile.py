"""Constructed ZCode wire profile only: no provider, account, helper or user config IO."""
import json
import os
import signal
import sys

with open("zcode-wire-case", encoding="utf-8") as scenario:
    CASE = scenario.read()
AUDIT = "zcode-wire-audit.json"
KEY_NAME = "PULT_MEMORY_KEY"
PRIVATE_FIXTURE_KEY = "private-zcode-wire-key-fixture"
PRIVATE_FIXTURE_PROMPT = "private-zcode-wire-prompt-fixture"
signal.alarm(60)


def require(condition):
    if not condition:
        raise RuntimeError("invalid constructed wire exchange")


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read():
    line = sys.stdin.readline()
    require(bool(line))
    return json.loads(line)


def audit():
    # Scratch-only counters/booleans. Never retain prompts, helper keys or full frames.
    with open(AUDIT, "w", encoding="utf-8") as output:
        json.dump(state, output)


def snapshot(sid, workspace):
    return {
        "protocol": {"name": "ZCode Protocol", "version": 1},
        "session": {
            "sessionId": sid,
            "workspace": workspace,
            "sessionKind": "interactive",
            "title": "",
            "mode": "guarded",
            "status": "idle",
            "createdAt": 1,
            "updatedAt": 1,
        },
        "settings": {
            "model": {"available": []},
            "thoughtLevel": {"enabled": False, "available": []},
            "mode": {"current": "guarded"},
        },
        "projection": {
            "sessionId": sid,
            "status": "idle",
            "mode": "guarded",
            "turnCount": 0,
            "totalTokenCount": 0,
            "contextUsed": 0,
            "contextWindow": 128000,
            "pendingPermissions": [],
            "activeToolCalls": [],
            "backgroundJobs": [],
        },
        "runtime": {"eventSeq": 0, "stateRevision": 1, "pendingRequestIds": []},
        "messages": [],
    }


require(sys.argv[1:] == ["app-server", "--stdio"])
require(KEY_NAME not in os.environ)
require(all(PRIVATE_FIXTURE_KEY not in item for item in sys.argv))
require(all(PRIVATE_FIXTURE_PROMPT not in item for item in sys.argv))
require(all(PRIVATE_FIXTURE_KEY not in value for value in os.environ.values()))
state = {
    "argv_profile_exact": True,
    "private_launch_env_absent": True,
    "create_count": 0,
    "subscribe_count": 0,
    "send_count": 0,
    "close_count": 0,
    "private_mcp_on_stdin": False,
    "runtime_preferences_replied": False,
    "native_close_ack_sent": False,
    "pid": os.getpid(),
}
create = read()
require(create["method"] == "session/create" and "jsonrpc" not in create)
params = create["params"]
require(params["mode"] == "guarded" and params["titleGenerationEnabled"] is False)
require("content" not in params)
sid = params["sessionId"]
workspace = params["workspace"]
require(os.path.realpath(workspace["workspacePath"]) == os.getcwd())
servers = params["mcpServers"]
require(len(servers) == 1)
server = servers[0]
require(server["name"] == "pult-memory-fixture")
require(server["command"] == "/fixture/never-executed-memory-helper")
require(os.path.realpath(server["cwd"]) == os.getcwd() and server["isolation"] == "session")
require(server["args"] == ["--stdio"])
require(server["env"] == [{"name": KEY_NAME, "value": PRIVATE_FIXTURE_KEY}])
state["private_mcp_on_stdin"] = True
state["create_count"] += 1
audit()
prefs = {
    "id": "server-runtime-prefs-1",
    "method": "session/requestRuntimePreferences",
    "params": {"sessionId": sid, "scope": "runtime-materialization", "workspace": workspace},
    "trace": {"traceId": "trace-fixture", "parentId": "span-fixture"},
}
if CASE == "malformed-trace":
    prefs["trace"]["ownerAuthority"] = True
emit(prefs)
reply = read()
require(reply["id"] == prefs["id"] and "error" not in reply)
require(reply["result"] == {
    "nativeSearchEnhancementsEnabled": False,
    "toolSearchMode": "off",
    "subagentRuntimeConfigEnabled": False,
    "appControlEnabled": False,
    "memoryEnabled": False,
    "askUserQuestionAutoResolutionEnabled": False,
    "modelContextBudgetStrategy": "preflight-v1",
})
state["runtime_preferences_replied"] = True
audit()
emit({"id": create["id"], "result": snapshot(sid, workspace)})

for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    params = request["params"]
    require(params["sessionId"] == sid and "jsonrpc" not in request)
    if method == "session/subscribe":
        require(params == {"sessionId": sid, "deliveryKind": "desktop-continuous", "includeSnapshot": False})
        state["subscribe_count"] += 1
        audit()
        emit({"id": request["id"], "result": {"sessionId": sid, "eventSeq": 0, "events": []}})
    elif method == "session/send":
        require(state["subscribe_count"] == 1)
        require(params["inputId"] == "host-input-1" and params["queryId"] == "host-query-1")
        require(params["content"] == PRIVATE_FIXTURE_PROMPT)
        state["send_count"] += 1
        audit()
        if CASE == "lost-ack":
            # Native observed input. EOF is not an input non-delivery proof; remain owned/alive.
            os.close(sys.stdout.fileno())
            state["native_stdout_closed"] = True
            audit()
            continue
        if CASE == "duplicate-ack":
            # A normal Value parser would retain the final valid SID; raw codec must reject.
            raw = '{"id":' + json.dumps(request["id"]) + ',"result":{"accepted":true,"sessionId":"wrong-first-sid","sessionId":' + json.dumps(sid) + ',"stateRevision":2}}\n'
            sys.stdout.write(raw)
            sys.stdout.flush()
            continue
        ack_sid = "unrelated-native-sid" if CASE == "wrong-sid" else sid
        ack_id = "unrelated-rpc" if CASE == "wrong-rpc" else request["id"]
        ack = {"id": ack_id, "result": {"sessionId": ack_sid, "accepted": True, "stateRevision": 2}}
        if CASE in ("wrong-sid", "wrong-rpc"):
            emit(ack)
            continue
        started = {
            "method": "session/event",
            "params": {
                "eventId": "evt_fixture_1", "sessionId": sid, "turnId": "turn_fixture_1",
                "seq": 1, "timestamp": 2, "deliveryKind": "desktop-continuous",
                "type": "turn.started",
                "payload": {
                    "turnNumber": 1, "input": params["content"], "inputId": params["inputId"],
                    "queryId": params["queryId"], "messageId": "message_fixture_1",
                    "intent": {"commandId": params["inputId"], "clientId": "legacy-session-send", "sessionId": sid, "type": "sendText"},
                },
            },
        }
        emit({"method": "state.updated", "params": {"type": "state.updated", "scope": "session", "sessionId": sid, "revision": 2, "reason": "prompt_started", "patch": {"status": "running"}}})
        if CASE == "started-first":
            emit(started)
            emit(ack)
        else:
            emit(ack)
            emit(started)
    elif method == "session/close":
        state["close_count"] += 1
        state["native_close_ack_sent"] = True
        audit()
        emit({"id": request["id"], "result": {"closed": True}})
        # Intentionally keep the native process alive until holder/Process cleanup.
    else:
        require(False)
