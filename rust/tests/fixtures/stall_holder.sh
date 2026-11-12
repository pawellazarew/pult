#!/bin/sh
# Cancellation fixture: no provider, no ready acknowledgement, and EOF alone
# cannot finish startup. Keep this script checked in: dynamically writing an
# executable can race another test's fork on Linux (ETXTBSY).
trap 'exit 0' TERM INT
printf '%s\n' "$$" > stall-holder.pid.tmp
/bin/mv stall-holder.pid.tmp stall-holder.pid
while :; do IFS= read -r ignored || :; done
