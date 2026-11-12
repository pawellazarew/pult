# ZCode Route A owner and unknown-input metadata

This library slice adds checked durable native identity and unknown-input state.
It does not execute a ZCode process or wire a daemon provider. Route A is a separate
native protocol, not a Claude alias: no inherited Claude settings, reserved UUID,
Ask/MCP setup, scoped memory delivery, account discovery or new CLI flags are added.
Full ZCode execution and M3 memory remain open.

`ZcodeOwner` reuses `OwnerTrust(Provider::Zcode, None)` for same-home stores,
incarnation/provider/path/dev+inode, consent and captured host route checks. Public
methods are trusted-host APIs, not JSON dispatch. A preflight `gate` is explicitly
not an actual-spawn seal. Unknown storage writes fault the Driver and host; fault
callbacks run after transaction guards are released. Errors contain static codes
and a separate ZCode uncertainty message. A present raw native ID which cannot be represented as a valid string (including
a lone UTF-16 surrogate) is rejected, never treated as an absent/new conversation.
Native IDs are opaque, bounded to 512
UTF-8 bytes, nonempty, not leading-dash, and contain no control characters.

## Durable input and evidence

`reserve` captures the exact Driver Ticket, immutable snapshot, fresh dedicated
process generation and host-generated public turn ID. Driver may still be
Starting, so the public ID need not yet be published by Driver. If published,
subsequent evidence must agree with it. The host ID is never invented from native
JSON. The private marker is persisted **before** argv-bearing actual spawn.
`zcodePendingInput` contains only version/nonce/IDs/generation/expected resume SID,
never the user's text, argv or environment.

Each Attempt retains the exact `Arc<turn_driver::SpawnAction>`, created with the
Worker's absolute `std::time::Instant` deadline captured before owned preparation.
The deadline is never reset after waiting and is not persisted across restarts.
`ZcodeOwner::seal_spawn` performs only bounded in-memory ownership lookup and
`Driver::seal_spawn` (exact Ticket/snapshot + cancellation/fault/closed/deadline
checks and one-spawn-per-Control CAS under Driver's state mutex). No IO/callback
runs under that mutex. The host still performs fresh policy/route preflight and
holds its Process SpawnPermit through actual Command.spawn. Driver cancellation
before this atomic seal denies; after the seal a PID may be created and must be
stopped/joined. A normal preflight callback cannot replace this atomic action.

The bounded owner map retains up to 256 attempts; dropping a caller's Attempt
cannot silently release bookkeeping or clear durable uncertainty. Hot reservation
does not change `lastStatus` or `queuePaused`. All updates read current metadata
under Registry serialization and change only owned fields. Concurrent titles,
model changes, user pauses and queue epochs survive acceptance.

A SID seen on a fresh process (including session.titleUpdated/session.resumed) is
native identity only. `record_native_session` persists it but keeps unknown-input
state. Resumed conversations must report the captured SID; an unexpected new SID
is uncertainty, not silent replacement or a fabricated UUID. Only typed
`TurnStartedEvidence` from the future trusted Worker's exact fresh HostBinding,
with native SID/TID, can acknowledge actual input acceptance. `session.created`
or a SessionId signal alone cannot do this. Evidence constructors are crate-private;
these library tests exercise contracts and do not claim real provider IO proof.

Acceptance atomically stores the known SID and clears only the exact marker.
The opaque acceptance receipt retains its exact Attempt; Worker must check its
private matches method and native IDs before Started, not merely compare strings. It
is metadata, not dispatch authority. Cancellation/fault observed by the fresh
checks rejects acceptance, as do stale/foreign incarnation, generation/Attempt
and marker replacement. Driver remains the final authority for Started; an
acceptance receipt never proves process cleanup or grants another dispatch.

`JoinedCleanup` is constructed only after the exact Worker joins process, readers
and owned store IO. Never-sent clearing additionally requires cancellation to have
won the pre-spawn state. A sealed unknown attempt may retire bounded bookkeeping
after joined cleanup, but its durable marker remains. Neither Drop, timeout,
absent PID nor EOF by itself clears input uncertainty. Owned SessionStore Tasks
must be awaited through external cancellation; a dropped waiter is not IO proof.

## Recovery and Node rollback

Presence of `zcodePendingInput`, including null, malformed/future objects and
opaque UTF-16, blocks execution. Rust preserves raw payloads with `compact_raw`
(outside-string whitespace only); parse stays hot-neutral while cold recovery
marks failed and pauses the queue. The paired Node registry preserves the field
opaquely. Node Manager rejects prompt/say/interrupt/steer/enqueue/resume/selected
send before dispatch and reports visible start_unknown state. Existing Claude
reservation guards remain in place. A Node version from before this paired
compatibility change cannot be promised to understand the new marker.

Confirmed native IDs with no pending-input marker remain known resumable metadata.
Unknown input requires manual history inspection. The Owner-only primitive below
supports explicit **next-turn** metadata recovery; actual Worker proof delivery,
Runtime cache/admission and authenticated owner UI/RPC consumption remain separate
required integration. There is no regex-based auto-clear, current-input retry,
queue consumption on uncertain delivery, or new-ID fallback.

## Checks

Tests use real private Registry/ConsentStore/journal and Driver with a controlled
fake Worker, plus actual built Node Registry/Manager rollback. They cover Starting
reservation, separate identity/acceptance, hot queue neutrality and preserved user
pause, cold failed/paused recovery, null/future/UTF-16 raw framing, known IDs,
foreign/stale/cancelled evidence, invalid resume IDs, metadata preservation and
shared policy faults. No provider, account, login, model or network is invoked.


## Explicit owner-confirmed next-turn recovery primitive

`MissingAfterJoin` is opaque and has no JSON/Debug/Clone implementation. The
crate-private Worker constructor requires an exact joined Attempt, known retired
Owner IO, a sealed prior spawn and a captured valid resume SID. Its actual
`saw_matching_native_turn_started` predicate must be false; this must not mean
merely "no Published Started" (a late native acceptance can precede a denied
publication). Only the Worker can supply the observed missing-session diagnostic
and confirm real stdout EOF/process/stderr reader joins plus all Store/Sink IO
known. The type constructor checks the host binding; it cannot inspect an OS
process. A stderr regex is diagnostic evidence, never proof of non-execution.

The future Worker one-shot getter transfers this proof only after known cleanup.
The future Runtime caches it with a bounded exact recovery handle and takes it
only after this Ticket's real `Progress::Finished` receipt. Cold marker JSON cannot
reconstruct an Attempt or proof: restart without an in-memory proof stays in the
explicit history-inspection/import boundary.

`IdleRecoveryPermit::from_finished_idle` is crate-private and checks the exact
captured Terminal Ticket, a durable terminal event ID, no published start and the
original recovery deadline. It does **not** reserve a Runtime slot itself. Its
trusted caller must already reserve the same session/name (including all active,
preparing and quarantined work), prevent new own starts and retain that reservation
until every recovery IO outcome is known. Neighboring sessions stay independent.
Direct uncoordinated trusted Driver starts are outside this sole-controller
boundary; this is not a same-UID sandbox.

`OwnerConfirmedRecovery` is minted only after an explicit authenticated owner
confirmation of possible prior execution. It is authorization by the owner caller,
not a universal proof that a human clicked. Scoped MCP/model JSON, filesystem Full
and tool rules cannot construct it. `RecoveryWarningReceipt` is bound to the exact
permit and a real durable **requested** warning appended after the old terminal.
Its internal constructor must be called only for that exact owned append. A
requested warning must not claim that reset already succeeded or contain a
`changes` payload describing a completed reset. The later consumer must distinguish
committed metadata from failure/unconfirmed outcome with separate notices.

`ZcodeOwner::confirm_missing_for_next_turn` runs in owned blocking work, after that
requested-warning receipt. The issuing Owner and every issued Attempt share a
private in-memory Arc brand. Confirm rejects a foreign brand before any FS read or
callback: copied SessionKey/SID/marker/cwd metadata cannot transfer this capability
to another home/Owner, and a recreated Owner on the same stores cannot inherit it.
This is trusted-host API correctness, not an external-model exploit claim.
It rechecks policy, home/cwd/incarnation, current native SID and private marker after lock waits, and rejects a visible active Driver ticket
for that name or a Driver storage fault. The private Ready/Sealed/Revoked CAS is
bounded memory work, without callbacks/IO under Driver or Runtime locks. Cancel
before seal wins; once sealed the owned metadata write may finish after cancellation
and makes no rollback promise. No input is executed.

The exact Registry transaction removes only `providerSessionId` and
`zcodePendingInput`, sets `queuePaused=true`, and preserves queueDispatch/items,
concurrent title/model/settings and other metadata. A `RecoveryReceipt` is metadata
only; it never grants a dispatch or resumes a queue. The next explicit input still
needs fresh Driver/policy/network checks. A failed/unknown atomic write faults
execution after all transaction guards drop; an error must not be reported as
proof that the file was unchanged. The Runtime must retain owned work through the
known IO outcome, not abandon it when the owner caller stops waiting.

Owner-focused tests use actual Driver/journal/Registry/ConsentStore and controlled
fake Worker close receipts. They exercise opaque proof/terminal/confirmation and
warning bindings, cancel/deadline, stale CAS after waits, metadata/queue preservation,
visible active tickets, cold uncertainty and injected precommit/directory-sync
failure. These are Owner contract tests, not real ZCode diagnostic/OS-join proof;
actual Worker/Runtime/UI acceptance remains required separately.
