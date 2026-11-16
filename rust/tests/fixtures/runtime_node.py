#!/usr/bin/python3
"""Version-query fake. Harness substitutes only this private fixture's SETTINGS."""
import json
import os
import sys
import time

settings = SETTINGS
assert sys.argv[1:] == ["-v"]
mode = settings["mode"]
child = None
if mode in ("fork", "fork-eof", "hang", "stdout", "stderr"):
    child = os.fork()
    if child == 0:
        if mode == "fork-eof":
            os.close(1)
            os.close(2)
        time.sleep(90)
        os._exit(0)
with open(settings["calls"], "w") as file:
    json.dump({"leader": os.getpid(), "child": child, "argv": sys.argv[1:],
               "secret": any(key in os.environ for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "PULT_TEST", "PULT_TEST_RUNTIME_EXEC", "NODE_OPTIONS"))}, file)
if mode == "hang":
    time.sleep(90)
if mode in ("stdout", "stderr"):
    stream = sys.stdout if mode == "stdout" else sys.stderr
    stream.write("x" * (1024 * 1024 + 1))
    stream.flush()
else:
    sys.stdout.write(settings["version"])
sys.exit(7 if mode == "nonzero" else 0)
