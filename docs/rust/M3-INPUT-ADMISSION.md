# M3: exact-ticket memory admission at a native input handoff

This slice adds a private resource pin for a future native input adapter. It does
not activate ZCode MCP, change a Worker/Owner/Runtime or the TurnMemory trait, send
input, grant native permission, or complete the Rust migration.

## Prepare an identity, then check the current record

`Backend::input_scope(&Ticket)` captures the exact prepared Control Arc and a
strong State Arc after full existing verification. Call this synchronous method
from owned blocking preparation, before entering Registry/Runtime admission.
Lookup failures, revoked controls, foreign Tickets and unavailable state fail
closed. The returned InputScope is identity, not authority to send later.

`InputScope::enter_current` accepts an already-current Record borrowed from the
same State's actual checked Owner/Registry frontier. The trusted caller must retain
its Consent -> Registry -> RuntimeState admission through the input handoff. The
scope does not open Registry or prove a standalone/cloned Record is current.
The explicit shared lifetime prevents dropping the supplied Record borrow before
the resulting permit. A future opaque Owner frontier supplies that reference;
model JSON, a key, native IDs or a snapshot cannot substitute for that authority.

The method acquires, in order:

1. State execution admission;
2. exact Control gate;
3. the registered MemoryLease admission gate;
4. existing Driver checks within `verify_locked`.

Final verification uses the supplied current Record and checks stop/fault,
credential-context poison, exact valid lease/fingerprint, archive/private/read
policy and live Driver snapshot identity. It does not acquire Registry, the
session-context mutex, filesystem or database, and invokes no callback. Routine
title changes stay usable; changed policy or execution authority does not.

The borrowed InputScopePermit retains the three short gates until the synchronous
handoff. It is !Send and has no Debug, Clone or serialization surface. Its fields
drop lease -> Control -> execution admission; Drop only unlocks gates. Do not await,
perform filesystem/database/context lookup, call arbitrary code, or synchronously
revoke a held resource while retaining the permit.

The future caller still needs its exact fresh Owner/Driver input seal before the
first enqueue or write poll. This pin does not retain Driver's mutex after its
check, prevent a direct Driver cancel, create a receipt, or prove input delivery.
It only keeps the checked resource revocations serialized through that handoff.

## Context revocation and key copies

Each SessionMemory registration owns a fresh Arc<Mutex<()>> admission gate. Its
issued read-only key leases share that exact Arc while retaining their existing
independent valid flags. Key rotation still revokes old keys without revoking owner
registration. Rebinding creates a new gate/generation; an old scope cannot acquire
new authority through it.

Lease invalidation now takes this gate before publishing invalidity. A scope pin
therefore holds both Control revoke and registration/key invalidation until its
handoff ends. SessionMemory bind/issue/revoke/drop may hold the contexts mutex while
waiting for a lease gate; the input path never takes that mutex in reverse. The
invalidation critical section contains only a mutex and an atomic store: no
filesystem/database access, entropy generation, callback or nested gate acquisition.
Shared registration/key revocation loops release each gate before moving to the next.

Poisoned admission is never recovered for granting access. is_valid fails closed
on a poisoned shared gate; admit rejects it. Invalidate recovers the guard only to
set valid=false and leaves poison intact, including during drop. An explicit new
registration creates a fresh gate instead of clearing poison on the old one.

## Boundary of the change

Existing read/propose/commit algorithms are unchanged. This does not claim atomic
revocation for every legacy Backend operation. The new short permit is specifically
for the upcoming native input handoff. No database IO is added under it. Narrow
non-test dead-code allowances mark the private preactivation seam and can be removed
when the real resource adapter calls it; no global warning suppression is introduced.

## Checks

Tests use actual State/Backend, Registry, Driver, SessionMemory leases and SQLite;
no provider, account or application installation is accessed. They cover:

- stale policy/private/temporary/archive/approval after precheck, using real Registry
  writes without automatic revoke, so final verification itself must deny;
- metadata edits and successful admission while another owned thread holds the
  actual context and database mutexes, with an independent release watchdog;
- foreign Ticket and real drain/reprepare of the same Ticket, retaining the old
  Control Arc and rejecting that old scope;
- direct cancellation, Driver/global fault and stop published after precheck;
- concurrent Control/context revocation against held permits, then completion
  after drop, with another session in the same State remaining usable;
- exact registration/key gate sharing, independent neighboring gate, poison and
  revoke/drop recovery; compile-time checks for absent Send/Debug/Clone/Serialize
  on borrowed permits, and static error messages after gate/context poison.

These are memory resource contracts, not real native input/Owner/Worker integration
or complete provider acceptance. Existing read/propose/readonly and cross-provider
interoperability checks remain required alongside them.

Local scoped verification used macOS / Rust 1.99.1 and a dedicated worktree target:
25 memory-turn tests, 11 registration/lease tests and 4 session-memory API tests
passed with default concurrency. Four existing daemon/MCP interoperability targets
also passed (Claude/Codex shared memory, proposals/readonly, scoped read keys and
queued memory); their scripts validate 7/13/17/10 scenarios respectively. All-target
clippy with -D warnings, fmt and diff passed. The actual current-record regression
went RED when final verify_locked was temporarily removed, then GREEN after the
source was restored byte-for-byte. Logs/manifests live in the parent Me workspace
`.agents/workspaces/pult-migration/memory-input-*`.

An initial test attempted to change cwd through Registry.update_checked and was
correctly rejected by Registry's execution-identity guard; it now changes the
permitted approval fingerprint field. No production guard or timeout was relaxed.
These scoped results do not claim a full migration-suite, CI or live-provider run.
