#!/usr/bin/python3
"""Test-only owned wrapper: real holder cleanup succeeds, outer status is125.

The original parent is checked. The real holder's internal owner argv[1] MUST
be rebound to this wrapper PID because it checks getppid(); that one internal
ABI field is not unchanged. Provider argv and inherited stdio data stay exact.
No provider PID/group is signalled here: only this exact unreaped Popen child.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

stop_requested = False

def remember_stop(_signal, _frame):
    global stop_requested
    stop_requested = True

# Install before the real holder can exist. A handler never signals a PID.
signal.signal(signal.SIGTERM, remember_stop)
signal.signal(signal.SIGINT, remember_stop)
owner = int(sys.argv[1])
assert owner > 0 and os.getppid() == owner
home = Path(sys.argv[0]).parent
holder = (home / 'actual-holder.path').read_text()
assert Path(holder).is_absolute()
child = subprocess.Popen([holder, str(os.getpid()), *sys.argv[2:]])

def stop_owned():
    # Only this thread waits/reaps. returncode None retains child PID ownership,
    # even if it has just exited. Never signal after poll/wait has reaped it.
    if child.returncode is None:
        try:
            os.kill(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

try:
    while True:
        status = child.poll()
        if status is not None:
            break
        if stop_requested or os.getppid() != owner:
            stop_requested = False
            stop_owned()
        time.sleep(.005)
finally:
    # No detach, no SIGKILL shortcut: keep ownership until the real holder joins.
    if child.returncode is None:
        stop_owned()
        status = child.wait()

proof = {'real_holder_exit_zero': status == 0,
         'native_close_observed': (home / 'closed.entered').is_file(),
         'internal_owner_rebound': True}
with os.fdopen(os.open(home / 'forced-holder-proof.tmp',
                       os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    f.write(json.dumps(proof))
os.replace(home / 'forced-holder-proof.tmp', home / 'forced-holder-proof.json')
# The actual holder is already reaped, including its real provider-group proof.
# Deliberately make Process.stop reject the OUTER holder acknowledgement.
sys.exit(125)
