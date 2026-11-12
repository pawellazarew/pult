#!/usr/bin/python3
"""Executable daemon fixture. All work stays in the isolated test account."""
import os
import pathlib
import sys

for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PULT_MEMORY_KEY", "PULT_TEST", "PULT_CODEX_BIN", "PULT_CURL_BIN", "HTTPS_PROXY"):
    assert name not in os.environ, "ambient authority reached provider fixture"
home = pathlib.Path(os.environ["HOME"]) / "native"
pult = home.parent.parent / "home"
source = pathlib.Path(__file__).with_name("codex_worker.py").read_text()
source = source.replace("elif method == 'turn/start':\n", "elif method == 'turn/start':\n        records = json.loads((pult / 'sessions.json').read_text())['sessions']\n        record = next(row for row in records if row.get('providerSessionId') == params['threadId'])\n        statuses = [json.loads(row) for row in (pult / 'events/journal.jsonl').read_text().splitlines()]\n        statuses = [row for row in statuses if row['sessionId'] == record['name'] and row['kind'] == 'status.changed']\n        assert statuses[-1]['data']['status'] == 'working', 'working status not durable before dispatch'\n")
source = source.replace("'command': 'true'", "'command': 'true', 'availableDecisions': ['accept', 'decline', 'cancel']")
source = source.replace("elif method is None:\n", "elif method is None:\n        if frame.get('result', {}).get('decision') == 'accept':\n            journal = [json.loads(row) for row in (pult / 'events/journal.jsonl').read_text().splitlines()]\n            assert any(row['kind'] == 'permission.resolved' and row['data'].get('decision') == 'allow' for row in journal), 'permission not durable'\n")
sys.argv = [sys.argv[0], str(home)]
exec(compile(source, "codex_worker.py", "exec"), {"pult": pult})
