#!/usr/bin/python3 -ISB
"""Executable daemon fixture. All work stays in the isolated test account."""
import os
import pathlib
import sys
import json

for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PULT_MEMORY_KEY", "PULT_TEST", "PULT_CODEX_BIN", "PULT_CURL_BIN", "HTTPS_PROXY"):
    assert name not in os.environ, "ambient authority reached provider fixture"
home = pathlib.Path(os.environ["HOME"]) / "native"
pult = home.parent.parent / "home"
source = pathlib.Path(__file__).with_name("codex_worker.py").read_text()
fixture_phase = "bootstrap"


def fixture_rows(phase):
    global fixture_phase
    fixture_phase = phase
    path = pult / "events/journal.jsonl"
    control = home / "journal-snapshot-mode"
    if control.exists() and phase == "turn_start_journal":
        mode = control.read_text()
        assert mode in ("unfinished_utf8", "corrupt_complete"), "unknown snapshot profile"
        data = path.read_bytes()
        # Qualify the copied source from the real daemon's complete durable
        # working receipt. Only the private consumer copy receives the stimulus.
        end = data.rfind(b"\n")
        complete = [json.loads(row) for row in data[:end + 1].decode("utf8").splitlines()]
        records = json.loads((pult / "sessions.json").read_text())["sessions"]
        record = next(row for row in records if row.get("providerSessionId") == fixture_namespace["params"]["threadId"])
        statuses = [row for row in complete if row["sessionId"] == record["name"] and row["kind"] == "status.changed"]
        assert data.endswith(b"\n") and statuses[-1]["data"]["status"] == "working", "snapshot source lacks durable working receipt"
        path = home / "journal-consumer-snapshot.jsonl"
        suffix = b'{"unfinished":"\xf0\x9f' if mode == "unfinished_utf8" else b'{"corrupt":\n'
        path.write_bytes(data + suffix)
        path.chmod(0o400)
        (home / "journal-snapshot-evidence.json").write_text(json.dumps({"copiedWorkingReceipt": True, "mode": mode, "sourceUnchanged": (pult / "events/journal.jsonl").read_bytes() == data}))
    data = path.read_bytes()
    end = data.rfind(b"\n")
    return [json.loads(row) for row in data[:end + 1].decode("utf8").split("\n") if row]


source = source.replace("elif method == 'turn/start':\n", "elif method == 'turn/start':\n        records = json.loads((pult / 'sessions.json').read_text())['sessions']\n        record = next(row for row in records if row.get('providerSessionId') == params['threadId'])\n        statuses = [json.loads(row) for row in (pult / 'events/journal.jsonl').read_text().splitlines()]\n        statuses = [row for row in statuses if row['sessionId'] == record['name'] and row['kind'] == 'status.changed']\n        assert statuses[-1]['data']['status'] == 'working', 'working status not durable before dispatch'\n")
source = source.replace("[json.loads(row) for row in (pult / 'events/journal.jsonl').read_text().splitlines()]", "fixture_rows('turn_start_journal')", 1)
source = source.replace("'command': 'true'", "'command': 'true', 'availableDecisions': ['accept', 'decline', 'cancel']")
source = source.replace("elif method is None:\n", "elif method is None:\n        if frame.get('result', {}).get('decision') == 'accept':\n            journal = [json.loads(row) for row in (pult / 'events/journal.jsonl').read_text().splitlines()]\n            assert any(row['kind'] == 'permission.resolved' and row['data'].get('decision') == 'allow' for row in journal), 'permission not durable'\n")
source = source.replace("[json.loads(row) for row in (pult / 'events/journal.jsonl').read_text().splitlines()]", "fixture_rows('permission_journal')", 1)
sys.argv = [sys.argv[0], str(home)]
fixture_namespace = {"pult": pult, "fixture_rows": fixture_rows}
try:
    exec(compile(source, "codex_worker.py", "exec"), fixture_namespace)
except BaseException as error:
    classes = ("UnicodeDecodeError", "JSONDecodeError", "AssertionError", "KeyError")
    kind = type(error).__name__
    (home / "fixture-read-error.json").write_text(json.dumps({"phase": fixture_phase, "errorClass": kind if kind in classes else "other"}))
    raise
