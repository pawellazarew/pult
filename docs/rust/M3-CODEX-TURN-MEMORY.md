# Ordinary Codex turn memory — integration slice

This step connects explicit session memory policy to an ordinary Rust Codex
turn, its own stdio MCP server, human-approved durable proposals, and the next
turn's catalog. It does not complete memory delivery for Claude/ZCode, queue or
steer integration, UI policy controls, private conversation execution, or purge.
The separate queue branch must retain the lazy receipt and exact-host seams
when these branches are combined. No live provider/account is used by the tests.

## Owner policy and compatibility

`memory.configure {session,memory?}` reads or atomically updates an existing
session's policy. `agent.start` accepts the same optional `memory` object:

```json
{"read":true,"write":"ask"}
```

Default is `{"read":false,"write":"off"}`. `ask` requires `read:true`.
Malformed/future policies never enable execution; an explicit valid configure
can repair one. Private/temporary markers disable turn memory, including
recovered unknown markers. Enabling memory on such a session is rejected.
Disabling policy or revoking a context immediately revokes active capabilities.
Re-enabling policy does not silently replace an explicitly revoked binding;
owner context registration is needed to repair that context.

The policy is persisted in Registry metadata without changing consent. Node's
Registry preserves `memory`, `private` and `temporary` as opaque JSON on its
normalization/rewrite path. This is rollback preservation, not Node memory
execution. Owner CRUD/history and repair/revoke remain separate authorities.
`agent.list` keeps recovered policy as opaque metadata; only configure/start
results promise a normalized policy. The catalog now has 28 fully implemented
Rust methods and six partial methods;
`memory.configure` is a storage/configuration method, not a claim that all
provider memory delivery is finished.

## Turn ownership and lifecycle

A trusted persisted policy lookup selects the memory path. Memory-off turns
retain the existing shared app-server pool. Each memory-on turn acquires one of
two cancellable dedicated slots and starts a fresh owned Codex host. A slot is
held until process cleanup is confirmed. Waiting never holds the controller or
pool mutex; shutdown, stop and global storage fault cancel a waiter.

The new process resumes the existing provider thread when one is available.
`thread/start` and `thread/resume` carry the new immutable `config.mcp_servers`
entry. The server status is checked for connected state and the required tools
before `turn/start`. Fresh configuration therefore does not retarget or retire
another session's shared host. A dedicated host is never reused for another
turn. Terminal/cancel revokes the exact Ticket's key, drains admitted memory IO,
and permanently retires that host. Unconfirmed cleanup retains ownership and
its slot for shutdown retry.

This deliberately loses warm app-server reuse for memory-on turns. The fake
integration test reports local acceptance latency as fixture-only measurements;
it does not establish production latency or a performance improvement. One local
run measured 98–514 ms acceptance for 16 memory-on fake turns (median 139 ms),
versus 5627 ms for the cold shared neighbor including initial preparation. These
are different startup conditions, not an A/B estimate of memory overhead.

## Scoped transport and untrusted data

`pult-memory-mcp --home ...` takes its ephemeral `mt_…` capability only through
its own child environment. It never reads an owner token or display config.
The key is not put in the common app-server environment, argv, user journal,
public list, error text or Debug. The immutable private MCP configuration is
sent over the supervised app-server pipe.

`hello.memoryTurn` is a distinct purpose. Mixed owner/read-memory/turn-memory
credentials are rejected without fallback. Legacy `mem_…` keys remain limited
to the original four read operations. A turn key can call catalog/list/search/
get and request add/update/forget; it cannot access owner APIs or history.
Filesystem ReadOnly additionally hides and rejects proposals.

The generic stdio engine has a 256 KiB input frame, 512 KiB output frame,
16 in-flight request limit, bounded serialization and a three-second output
watchdog. EOF/panic closes and joins its request tasks. The daemon separately
owns admitted database operations through cleanup, even if the socket/client
future disappears. Reflected backend errors are replaced with static errors.

A fresh summary catalog is inserted as a separate data text block after async
provider preparation and before the final dispatch check. Saved text is not
permission or an instruction. The original user text/journal is unchanged.
Catalogs omit details, and foreign project rows are filtered before decoding.
Structural IDs/provenance survive redaction; secret patterns in text are hidden,
while email remains visible as required by the product policy.

## Human decisions and durable provenance

`memory.write=ask` always creates a separate once-only
`pult_memory.propose` permission, including filesystem Full/CLI consent bypass.
Session/rule offers are absent. Scope and target project/global are explicit in
the approval input. Broker grants must carry the exact original approved input;
a modified input or broader scope cannot execute. Proposal args cannot select
session/project identity, author, source event or source turn. Recognized secret
text is rejected before asking instead of being stored behind a concealed card.

Binding/catalog/read attach to the exact trusted Ticket before Started.
Proposals wait asynchronously for Driver `Progress::Running` and its actual
durable accepted user event. This supports deferred input receipts without
inventing provenance or blocking the provider start ACK. Cancellation/fault or
an unknown acceptance before that receipt rejects the proposal.

The atomic SQLite transaction stores a server-derived provider author,
sourceSession, sourceCreatedAt, sourceTurnId and sourceEventId together with the
revision/history/FTS/command receipt. `expectedVersion` is checked after human
approval in that transaction; a concurrent owner edit wins over a stale proposal.
Exact retry is bound to the command, arguments, context and trusted provenance.
A different source cannot reuse the command. An owner edit clears agent-specific
provenance on the new owner revision.

## Admission, cancellation and storage uncertainty

The final commit admission order is:

`MemoryDB → Registry → State execution_admission → capability gate → Driver`.

Slow IO/locks are acquired before the State gate. Inside it are only bounded
in-memory checks and the opaque Driver action CAS; there is no external callback,
filesystem operation or await. The Driver action also checks its monotonic deadline immediately at seal, so a
late async timer poll cannot admit an expired proposal. The Driver checks exact Ticket/incarnation,
Running/accepted receipt, cancellation, closed state and its own storage latch.
State fault publication and stop-watch/Driver shutdown share this same State
gate. Direct Driver cancellation/fault serialize in the Driver mutex. Fault
callbacks are invoked after storage/capability guards have been released.

Before the seal, cancellation/revoke/timeout/fault means no write and no receipt.
After the seal, the already human-approved commit is owned until its outcome is
known. A later cancel/fault does not promise rollback; the revision may commit,
but the revoked caller receives no successful memory result and cleanup waits
for the IO. There is no automatic resend after an unknown result. Registry
uncertain writes latch execution failure; ordinary validation/precommit errors
do not pretend that a model ran or that an event was accepted.

## Verification

Tests use a controlled local fake Codex app-server, actual Rust daemon/Registry/
SQLite/journal, actual Node client, and actual `pult-memory-mcp` process. The fake
provider invokes real MCP tools and exposes only bounded private fixture evidence.
No model request, account settings or live network/provider call is made.

Deterministic unit barriers cover both sides of commit seal, global/direct Driver
fault, stop, dropped caller future, exact receipt, owned drain, policy repair,
private/default-off, forged provenance, selective redaction and version conflict.
The stdio tests cover framing, bounds, panic isolation, EOF and stalled output.
The end-to-end cases cover auto-binding, catalog/details separation, isolation,
legacy key restrictions, human deny/allow, Full/global approval, stale version,
next-turn fresh resume, revocation, private key non-disclosure and child cleanup.
Exact run counts and proof log paths belong in the handoff after the final run.


Final local verification: 160 library tests (14 turn-memory regressions), 13
real-daemon/fake-Codex/real-MCP cases in one compatibility wrapper, stdio 8,
Driver 38, Worker 35, Runtime 15, Owner 11 and existing M1/M2 compatibility 2.
Node core/catalog/preservation/session tests 130; 12 actual Node/Rust redaction
oracles; generator check, all-target Clippy
with warnings denied, format check and repository leakguard passed. The strict
deadline regression was RED with only the final deadline check removed and
GREEN after restoration. The bounded-slot case proves cancellation at ordered
controller admission while both slots are occupied, not an observed semaphore
waiter. No issue is closed for untested composed queue/steer delivery.


The new `mt_` credential format is filtered by both global Node/Rust policies,
including embedded prefixes and ASCII upper-case representations. A credential
used as an object property name conceals that value as well. The final Rust
journal boundary applies this same explicit-format policy to structural metadata
without generic filtering of normal opaque IDs. Proposal params are recursively
rejected before Broker if the format occurs anywhere, including `commandId`.
A real ephemeral MCP key echo was tested in assistant text, tool values/property
names and a structural ID; ordinary 32-hex tool identity remained intact. This
regression was RED before the format extension. Email remains visible.
