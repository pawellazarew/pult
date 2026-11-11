# Persist native thread identity before model dispatch

Every Codex prepare, including warm reuse, calls the mandatory trusted
`ThreadStore`. The immutable request contains the session incarnation, driver
Ticket, validated native thread ID, cwd, actual model and bounded typed sandbox.
A consuming acknowledgement returns a private receipt bound to that exact
request. Another request's receipt cannot authorize dispatch.

The worker validates the required provider cwd before adopting thread metadata.
It sends no `turn/start` until the matching receipt is acknowledged and the final
current-access check passes. A known stale/removed/archived scope is rejected;
an unknown write outcome latches the host storage failure before external fault
callbacks. No uncertain model start or persistence outcome is automatically
replayed.

Once polled, persistence remains owned by the Job. Cancelling preparation or
dropping its waiter stops dispatch and retains the write until completion.
Cleanup and the Driver slot remain unconfirmed while the write is pending.
`Host.shutdown` proves both process cleanup and all Jobs/IO finished; process
status alone is a separate, weaker proof. A permanently stuck store intentionally
keeps ownership rather than falsely acknowledging closure.

Six new fixture tests extend the worker suite to 34 cases. They cover missing
and mismatching cwd, blocked/failed/stale receipts, warm persistence and caller
cancellation. The Driver/Host integration holds a quarantined slot and daemon
shutdown after OS cleanup until the write completes; no late model turn occurs.
No provider credentials or model calls are used.

The host still has to implement `ThreadStore` with checked registry transactions.
It must validate the current incarnation/Ticket, reject removed or archived
sessions, and never use redacted event JSON as native routing authority.
