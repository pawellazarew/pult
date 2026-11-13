# Route B Owner contracts

This library slice extends the existing ZCode Owner; it does not implement a
native app-server Worker, wire decoder, Runtime admission, MCP, or live provider
qualification. Route A and its missing-session recovery remain separate.

`reserve_app_server(ReserveRequest, HostInputIds)` reuses the exact shared Attempt,
Owner lifetime brand, bounded map, immutable snapshot, Ticket/incarnation, fresh
process generation and absolute deadline. It writes `zcodePendingInput` version 2
with `route:"app-server"` and host input/query IDs. No user text, native input,
MCP configuration, credentials, argv or environment enters the marker. The
existing Route A reservation continues writing version 1.

Host input/query and send RPC IDs are bounded to 256 UTF-8 bytes and reject
leading/trailing JavaScript whitespace (including BOM), matching the bounded
codec profile before any reservation is written. Shared Route A native SID
validation remains unchanged at its existing 512-byte bound.

`record_app_server_session` durably stores actual native SID and returns an opaque
exact-Attempt identity receipt, retaining the marker. A captured resume SID cannot
be replaced by a new SID; repeated identical identity is idempotent. SID identity
and create/resume snapshots never imply input acceptance or Driver Started.

## Scoped first-input frontier

`prepare_app_server_input` rejects a foreign Owner/Attempt/identity before FS or
injected callbacks. It completes Owner policy/route callbacks first, then acquires
**Consent -> Registry** and refreshes consent, authority, home/cwd/incarnation,
exact raw marker, current SID and live Driver snapshot after the waits. Metadata
and consent guards stay inside `AppServerInputFrontier`, which is not Send.

The future Worker must acquire/consume this guard on one owned blocking thread,
without await, before entering Runtime State admission. The required ordering is:

`Consent -> Registry -> RuntimeState -> Attempts -> Driver`.

After entering Runtime State, only bounded memory checks, the frozen
`Driver::seal_input` CAS and the first bounded synchronous writer handoff may run.
No new store lock, FS call or external policy callback belongs there. The host
retains fresh route/Runtime admission through handoff. Owner does not itself
reserve that Runtime admission or validate a future writer implementation.

`frontier.seal()` yields a borrowed, non-cloneable, non-Send
`AppServerInputSeal`. Its lifetime cannot escape the frontier. Registry is held
through the first enqueue/poll, not merely through the CAS; there is no detached
receipt with a read/drop/mutate/send gap. Compile-fail checks cover guard Send and
detached seal escape. The guard blocks cooperating metadata/consent writers; it
does not claim a sandbox against malicious same-UID filesystem modifications.

### Qualification against the current Route A Runtime

Read-only audit at the base InputAction commit `b6c7002`:

- `RuntimeSpawn::enter` (`zcode_runtime.rs`, around line 1308) holds RuntimeState,
  performs in-memory source/route checks, then calls Owner `seal_spawn` (Attempts
  -> Driver). It does not acquire Registry/Consent or invoke Owner preflight.
- `Shared::route` (around line 238), used by Owner callbacks, acquires/releases
  RuntimeState and performs network-route checks outside that State guard.
  Therefore `prepare_app_server_input` executes these callbacks before it holds
  Consent/Registry, and `frontier.seal` never calls them again.
- Runtime `prepare` (around line 869) performs Registry/Owner metadata work in
  its owned blocking preparation before later State entry/Worker construction.
  Construction of `owner.store()`/a gate closure is pure, not Store IO.
- `recovery_core` (around line 1530) reserves/rechecks recovery state separately
  and runs Owner confirmation in owned blocking work after State guards drop.

This establishes compatibility with these existing paths, not completed Route B
Runtime wiring. The future Route B adapter must retain this order and re-audit
all new call paths. Calling `prepare_app_server_input` from inside an existing
RuntimeState guard is invalid: it would add State -> Registry. Reusing
`RuntimeSpawn::enter` as the whole Route B send gate is also insufficient because
its seal governs OS spawn, not native send. Driver/owner_trust are unchanged in
this slice. Tests use an explicit in-memory admission guard after the real
Consent/Registry frontier; they do not claim to execute a new Runtime adapter.

## Joint native evidence

`AppServerNativeObserver::from_owned_process` is a crate-private explicitly
trusted seam for the future Worker which owns the exact fresh process/generation.
The slice contains no actual native observer. Ordinary JSON/scoped MCP cannot
construct this observer or `AppServerStartedEvidence`.

The observer registers the first **session/send** RPC ID and SID under a borrowed
seal, before first handoff. `observe_send_ack` accepts only that request and SID,
`accepted:true`, and bounded nonnegative `stateRevision`. This method must be
called from the trusted pending-request decoder path, not for create/resume ACKs.
This Owner profile issues string RPC IDs: the future codec adapter must use the
string RequestId variant and verify the exact response variant before observing
an ACK. Coercing an arbitrary numeric JSON ID to a matching string is invalid.
`observe_turn_started` is called only for a real typed native `session/event`
`turn.started` notification. It marks sticky observation before validation or any
possible Store/Sink IO, then requires the bound SID, actual nonempty TID and both
captured host inputId/queryId before retaining an acceptance candidate.

ACK-only and event-only produce no evidence. Early matching event before ACK is
allowed; a bootstrap event before input binding is sticky but never becomes the
current input's candidate. Foreign SID, conflicting TID or incorrect ACK poisons
that observer. Missing TID/host IDs remain insufficient, even when the upstream
schema permits them. A successful combination produces one-shot exact-Attempt
evidence; `accept_app_server_started` refreshes Owner/metadata checks and clears
only that marker. It returns metadata Acceptance, never Driver Started/Running.
The future Worker must separately check the exact receipt and let the real
Driver publish the durable accepted user event.

Sticky observation is not a proof of no execution when false. Native bootstrap,
startup, automation or plugins may have side effects without Pult sending the
current input. The pinned runtime-preferences schema does not supply a general
no-execution capability.

## Cancellation, cleanup and recovery boundaries

Cancellation before the exact input CAS prevents sealing. After seal, possible
input delivery cannot be erased; no automatic retry or Route A fallback exists.
`clear_app_server_before_bootstrap` additionally requires the exact joined proof,
cancelled process SpawnAction and cancelled input action. After process bootstrap
has sealed, even known absence of current send only permits retirement of bounded
bookkeeping: durable uncertainty remains. Native close ACK/EOF is not OS/IO join.

The separate `AppServerSessionStore` uses existing owned blocking Task plumbing;
frontier/borrowed seals are deliberately absent from its async interface. Caller
owns Store/Sink tasks through known completion after cancellation. Dropping a
waiter cannot prove IO completion. A storage error latches existing shared faults
after transaction guards drop. No provisional IPC/config switch is introduced.

Legacy identity/evidence/never-sent APIs reject Route B, including before an
existing `MissingAfterJoin` capability can be minted. That Route A proof retains
its natural stdout EOF and joined/no-native-start contract. RPC `-32004` is not
reinterpreted as such a proof; this slice adds no new recovery capability or UI.
Cold version-2/raw markers remain presence-based blockers under the existing
Rust/paired Node guards, with no proof reconstructed from JSON and no replay.
Actual native shutdown, owner recovery integration and Node execution remain
outside this library contract.

## Verification scope

The nested tests use real Registry, ConsentStore, Driver and Journal with a
controlled in-process Worker. They verify both ACK/event orders, missing/foreign
IDs, exact Owner/Attempt bindings, two native sessions, cancellation/fault, marker
and authority refresh after waits, Registry serialization through first handoff,
concurrent metadata/raw queue preservation, owned Store adapters and unchanged
Route A recovery tests. They do not prove a real SDK stream, process holder,
runtime memory/MCP delivery or live R3 acceptance.
