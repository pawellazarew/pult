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
import threading
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
child = subprocess.Popen([holder, str(os.getpid()), *sys.argv[2:]], stderr=subprocess.PIPE)
stderr_tail = bytearray()
stderr_eof = False

def retain_stderr():
    global stderr_eof
    while True:
        block = child.stderr.read(1024)
        if not block:
            stderr_eof = True
            return
        stderr_tail[:] = (stderr_tail + block)[-1024:]

stderr_reader = threading.Thread(target=retain_stderr, daemon=True)
stderr_reader.start()

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

stderr_reader.join(timeout=1)
# Heuristic observer only: native stderr can imitate a marker. Missing,
# incomplete, multiple or conflicting markers never prove cleanup/authority.
phases = {'snapshot_deadline', 'snapshot_spawn', 'snapshot_pipe', 'snapshot_budget',
          'snapshot_exit', 'snapshot_parse', 'zombie_leader_missing',
          'group_member_running', 'zombie_membership_changed', 'leader_running',
          'group_term', 'group_kill', 'leader_reap', 'output_drain',
          'output_forwarding', 'other'}
observations = []
if stderr_eof:
    candidates = [line for line in bytes(stderr_tail).splitlines()
                  if line.startswith(b'PULT_HOLDER_DIAG')]
    for line in candidates if len(candidates) == 1 else []:
        fields = line.split()
        if len(fields) == 3 and fields[0] == b'PULT_HOLDER_DIAG':
            phase = fields[1].removeprefix(b'phase=').decode('ascii', 'replace')
            number = fields[2].removeprefix(b'errno=').decode('ascii', 'replace')
            if (fields[1].startswith(b'phase=') and fields[2].startswith(b'errno=')
                    and phase in phases and (number == 'none' or
                        (number.isascii() and number.isdecimal() and len(number) <= 10))
                    and line == ('PULT_HOLDER_DIAG phase='+phase+' errno='+number).encode('ascii')):
                observations.append((phase, number))
phase, number = observations[0] if len(observations) == 1 else ('unknown', 'none')
proof = {'real_holder_code': status,
         'real_holder_exit_zero': status == 0,
         'native_close_observed': (home / 'closed.entered').is_file(),
         'internal_owner_rebound': True,
         'holder_failure_phase': phase,
         'holder_failure_errno': number}
with os.fdopen(os.open(home / 'forced-holder-proof.tmp',
                       os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    f.write(json.dumps(proof))
os.replace(home / 'forced-holder-proof.tmp', home / 'forced-holder-proof.json')
# The actual holder is already reaped, including its real provider-group proof.
# Deliberately make Process.stop reject the OUTER holder acknowledgement.
sys.exit(125)
