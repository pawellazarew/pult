# ZCode Route A worker

`zcode_worker::ZcodeWorker` implements `turn_driver::Worker` for one explicit
input and one owned native process. It is a library component, not daemon RPC
wiring or complete ZCode provider parity. The trusted controller supplies a
checked immutable snapshot, frozen attachments, a mandatory Owner store and
redactor, and a host spawn-gate factory. A used facade is retired; the next
explicit input needs a new facade built from fresh Owner state. There is no
input replay, automatic missing-session reset, UUID invention, MCP, Ask role,
memory credential, or Claude settings inheritance.

## Spawn and acceptance

The original user input remains the Driver journal input. Provider argv adds
attachment references and the existing ZCode approval context, in that order.
Route A uses the existing `-p` argv contract; prompt exposure in process argv is
an existing platform limitation, not secret-free transport. Native IDs only come
from the exact new process. `session.titleUpdated` or `session.resumed` can
persist diagnostic identity but cannot acknowledge the input. Only native
`turn.started` with valid matching `sessionId` and `turnId` supplies typed Owner
acceptance. The returned receipt must match the exact Attempt capability and
both native IDs. The Worker then returns a separate opaque public turn ID and
waits for Driver's durable accepted user receipt before publishing buffered
native content. Early frames are bounded to 128 frames / 2 MiB; overflow fails
closed rather than silently losing content.

Reservation is durable before spawn. The host SpawnGate must hold its admission
permit across actual `Command::spawn` and call `ZcodeOwner::seal_spawn` for this
Attempt. That Driver-atomic seal checks cancellation, fault, exact snapshot,
deadline and single-use action. No OS operation runs under the global Driver
mutex. Cancellation before seal cannot grant spawn; cancellation after seal may
produce a PID which stays owned and must be stopped/joined. A fresh gate that
narrows approval after argv preparation causes rejection; prepared argv is
never silently rewritten after sealing. No fallback starts another input.

`StartingProcess` is installed in a private vault before polling holder ACK.
ACK borrows the reader from the retained Process; task panic, ACK failure and
spawn-permit release panic retain a recoverable PID owner. StopSignal permits
cancellation without waiting for that vault lock. Blocking preparation and
Store/Sink IO stay owned even if the start waiter is dropped. Cleanup never
fabricates a JoinedCleanup capability while a process or external IO is unknown.
Only joined never-sent attempts clear their exact reservation. Unknown sealed
input remains visibly blocked by Owner's persisted recovery marker.

## Events and failures

Normalization uses the existing pure ZCode adapter and mandatory redaction
boundary. Driver alone writes terminal status. Native session/turn identity is
monotonic for this one-process/one-input component: malformed or conflicting IDs
are a static protocol error. This deliberately rejects contradictory input
rather than attributing it to another turn. Unknown event kinds remain ignored.

A compact `result` is authoritative. If it is absent, successful
`turn.completed` with nonempty response is accepted only after stdout EOF;
cancelled completion maps to interrupted. A result can trigger bounded process
retirement; failure classification is allowed only after observed stdout EOF
and joined, complete private stderr. The Node-compatible heuristic uses the last
three stderr lines and at most 500 UTF-16 units. It emits static evidence and a
typed provider signal, never raw stderr. An observed native authentication
failure is not proof that the user's account logged out; no relogin or account
action occurs and the global Driver/Broker is not closed for that signal.
Storage uncertainty does latch the shared Driver fault before the external host
callback. Future controller/provider latches and doctor verification remain
separate work.

## Qualification

Tests use the actual Rust holder and a synthetic Python Route A process with a
real Registry, ConsentStore, Owner, Driver and durable JournalSink. No installed
ZCode executable, model, account or provider network is used. Native compatibility
beyond the checked-in sanitized Node fixture contract remains unverified.
Warm/background processes, native missing-session recovery, real CLI discovery,
controller integration, question protocol and full provider parity remain
required later work.
