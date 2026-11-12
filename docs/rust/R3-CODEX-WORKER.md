# Rust Codex worker

`codex_worker` connects the supervised app-server connection, RPC actor, event
normalizer and turn driver. One host has a fixed trusted launch environment and
route fingerprint. Per-turn worker facades freeze their own session scope and
attachments; separate native threads share the connection.

The ordinary-turn path prepares or resumes a thread, reads workspace policy,
revalidates attachments and rechecks current host authority before `turn/start`.
The final check can narrow access. Unknown start outcomes are never replayed.
Early native turn identities are cleanup candidates only: content and permission
handlers wait for a matching successful start acknowledgement.

Driver receives a separate opaque public turn ID. Native thread/turn IDs stay in
trusted routing state. Interrupt targets one exact native turn. A successful
normal close preserves the warm thread. Unknown ownership retires the host,
blocks new starts and preserves other active turns until they finish; cleanup
remains unconfirmed until process supervision proves it stopped.

Filesystem attachment checks and the final authority check run in owned blocking
tasks. The final check and first native request enqueue occur in one synchronous
step, with cancellation rechecked before enqueue. Job guards retain blocked
checks even if their async preparation or approval waiter is aborted. Revocation,
interrupt and process stop happen before the final wait for these checks; an OS
stop alone does not prove that host policy IO has finished. Blocking threads are
not retained while waiting for network responses or human permission decisions.
Regressions cover two blocked gates with a responsive two-worker Tokio runtime,
revoked late dispatch, cleanup after OS stop while a check remains blocked, and
an aborted approval waiter retaining its policy IO. A channel test verifies that
Client request/response first polls really enqueue before their async wait.

Permission handlers receive a single-use scoped responder. Cancellation and
native terminal notifications revoke it; its private client and response permit
cannot escape. Retained raw parameters retain their byte reservation. Default
unhandled requests are denied. The host rejects process-wide `PULT_MEMORY_KEY`
because a shared process must not inherit one session's memory authority.

Validation uses supervised local Python fixtures without provider credentials or
paid model turns. Tests cover independent sessions, exact interruption, early
start events/rejected acknowledgements, sandbox settings, fresh access checks,
warm attachment replacement, no-rollout recovery, uncertain starts, retention,
storage faults, retry storms, scoped approvals and journal terminal ownership.
Public IDs survive the production token redaction rule. Text validation follows
ECMAScript whitespace rather than Rust's default `trim`.

## Required before enabling execution RPC

- Implement the mandatory typed `ThreadStore` using the owner's checked registry
  transactions. The worker now waits for its bound durable receipt before model
  dispatch, including warm reuse; later `session.started` JSON is not authority.
- Connect the owner registry, current consent/configuration and network-route
  selection to the host; wire the broker and real redactor.
- Implement queue/steer/questions/background work and browser/MCP parity, model
  capacity retry policy and ephemeral UI delivery. This worker deliberately
  retires unsupported server-initiated work instead of claiming it is supported.
- Exercise full protocol, provider and operating-system acceptance before
  switching the installed daemon.

This library slice does not enable `agent.prompt` or switch the running Pult.
The trusted host reports uncertain shared journal IO through
`Driver::report_storage_failure`; this reuses the existing global failure latch.
