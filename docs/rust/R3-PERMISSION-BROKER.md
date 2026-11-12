# R3 — durable bounded permission Inbox

`permission_broker` owns pending ordinary permissions and structured
requestUserInput/AskUserQuestion answers. It supports only provider-offered
once/session/rule scopes. Invalid scopes or answers leave the question open.
Raw input returns only to the approved requester; public cards and events
cross mandatory value/string redactors. Changed input sets concealed, and a
rule label containing redacted material is not offered as an opaque grant.

A random per-broker generation plus nonreused JavaScript-safe sequence IDs
prevents stale cards from resolving new requests. At most 128 reservations
and 256 KiB input/decision payloads are admitted. Owned append jobs and actor
stages Requesting/Visible/Resolving preserve ordering without blocking timers
or other questions on a slow journal. Cards publish after durable requested;
Allow returns only after durable resolved.

Timeout defaults to ten minutes and denies. Shutdown, provider disappearance
or a dropped request/decision waiter deny without waiting for a hung append.
The reservation and owned IO remain until the journal outcome is known, and
a known requested commit is followed by one resolved denial. Dropping a
Resolution waiter does not cancel its already-owned journal operation.

Final settlement is serialized against storage-fault/shutdown publication.
A per-question CAS competes with provider cancellation before granting.
There is no await, callback or IO inside the settlement section.

Unlike Node finally-settle, a failed/uncertain journal result latches storage
failure, denies all askers and refuses further grants. No unknown write is
automatically resent. The host must connect this latch to Driver storage
failure and retain bounded quarantines. A cancellation during an already
started resolved-allow append may leave an allow record while the requester
receives denial; the record is not proof that the operation was executed.

An observer of the durable requested event can answer before the actor receives
its append receipt. The broker retains at most one validated early choice per
entry and waits for the known requested receipt before starting resolved IO.
Duplicate choices return false. Requested-write failure rejects the waiting
resolution explicitly; cancellation, shutdown and deadlines deny immediately
while retaining ownership of the outstanding write.

23 tests cover real EventStore durability/redaction, blocked append deadlines,
shutdown/cancellation, scopes/answers, original versus public inputs, secret
rule offers, owned resolutions, sink failure/panic/invalid receipts, cross-job
storage failure and exactly-one resolution. No real provider is used.

RPC permissions/control lease, adapter ownership and persistent rule files
are not connected yet. updated_input is a trusted host override; RPC callers
must not be allowed to replace a tool command through this library field.
Hosts install the silent panic policy before callbacks.
The public catalogue remains 27 implemented methods out of 98; this change
adds no RPC handlers or provider calls.
