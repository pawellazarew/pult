# R3 — native Codex JSON-RPC actor

`codex_rpc` multiplexes requests, notifications and server requests for one
app-server generation. It is a bounded in-memory actor: no process launch,
handshake, thread ownership or permission approval is supplied by this layer.
The OS bridge must bound framing and observe `shutdown_signal` for cleanup.

Client IDs are globally unique JavaScript-safe integers and are never reused.
Up to 256 pending requests have independent deadlines and cancellation.
Late/duplicate replies are ignored; unsent timed-out or cancelled requests
are removed before dispatch. Responses progress while the writer is full.
A bounded pending-write queue absorbs ordinary bursts without treating
temporary wire fullness as a broken generation. Notify/respond acknowledge
actual wire enqueue, not delivery to the external process.

Server requests carry opaque generation/nonce-bound, single-use permits.
Dropping a permit schedules generic denial. A live duplicate server ID is
fatal; an answered ID may be reused, and a stale nonce cannot deny its
replacement. The next layer must associate every permit with an owned thread
and decide its answer through the permission broker; possession is not consent.

Commands, events, retained IDs/methods and pending writes have bounded byte
budgets; each wire direction has a separate checked worst-case budget.
Payloads are at most 16 MiB, method names 256 bytes. Command/event queues have
hard caps. Actual decoded allocations can exceed serialized byte counts.
Capacity overflow closes the generation instead of dropping an approval or
reply silently. Diagnostics omit remote messages, data and payloads.

Shutdown publication is serialized against actual outbound enqueue; no
new dispatch can pass the stop guard. Every pending caller receives failure.
This is not a guarantee that a previously enqueued command was not executed.
The future provider driver must preserve uncertain-outcome semantics.

20 integration tests plus a stale-nonce unit test cover multiplexing,
server permits, errors, deadlines, cancellation, shutdown, burst handling,
writer backpressure and input fairness. Production RPC remains 27/98.
