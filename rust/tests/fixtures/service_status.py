#!/usr/bin/env python3
"""Controlled manager query: no provider, account or OS service API."""
import json
import os
import sys
import time

mode = os.environ.get("FAKE_MODE", "normal")
child = None
if mode in ("descendant", "hang", "overflow", "stderr", "timeout"):
    child = os.fork()
    if child == 0:
        time.sleep(90)
        os._exit(0)
with open(os.environ["FAKE_PIDS"], "w") as file:
    json.dump({"leader": os.getpid(), "child": child, "argv": sys.argv[1:],
               "secret": any(k in os.environ for k in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PULT_ASK_KEY", "NODE_OPTIONS"))}, file)
if mode in ("hang", "timeout"):
    time.sleep(90)
if mode in ("overflow", "stderr"):
    stream = sys.stdout if mode == "overflow" else sys.stderr
    stream.write("x" * (1024 * 1024 + 1))
    stream.flush()
elif mode == "failure":
    sys.stderr.write("private-manager-line sk-" + "abcdefghijklmnopqrstuvwxyz\n")
    sys.exit(7)
else:
    print("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=71\nExecMainPID=71\nExecMainCode=1\nExecMainStatus=0")
