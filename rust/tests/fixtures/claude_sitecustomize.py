# Deliberate ambient site hook for the controlled pre-user-code regression.
import os, sys
with open(os.path.join(os.path.dirname(__file__), 'entered'), 'w') as mark:
    mark.write('entered')
sys.stderr.write('PULT_CLAUDE_SITE_STARTUP_BLOCKED\n')
sys.stderr.flush()
# Never read native input or forge an ACK. Existing timeout/owned cleanup stops
# this child on the unisolated baseline; isolated startup must never import us.
read, write = os.pipe()
os.read(read, 1)
