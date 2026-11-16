# Ordinary Codex turn memory — integration slice

Ordinary Rust Codex turns share the daemon memory Backend with Claude and ZCode.
Each native Codex thread keeps a persistent MCP registration across Tickets;
[the persistent lifetime contract](R3-CODEX-PERSISTENT-MCP.md) defines registration,
native-call binding and bounds. This document describes the common policy,
durable proposal and provenance rules. Queue and steering composition is covered
[separately](M3-QUEUE-MEMORY-COMPOSED.md). UI policy controls, private execution,
purge, installed-provider qualification and cutover remain separate work.

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
results promise a normalized policy. The generated protocol catalog records current implementation status.
`memory.configure` is a storage/configuration method, not a claim that all
provider memory delivery is finished.

## Turn ownership and lifecycle

Memory-on and memory-off turns use the same shared app-server pool. Cold native
threads receive a private persistent `config.mcp_servers` entry and verified
five-tool inventory, including when memory is off or read-only. A memory-on
Ticket acquires one of two cancellable memory slots; the slot is retained through
actual Backend IO drain. Waiting does not hold the controller or pool mutex.

Every memory-on Ticket has a fresh captured Backend handle. Terminal/cancel closes that
Ticket's authority and drains admitted IO before Driver release. The healthy
provider, native SID and helper remain available for the next explicit Ticket.
Known pre-dispatch cancellation also retains an already healthy registration;
cold/readiness failure and uncertain dispatch fail conservatively. Registration
failure or identity-capacity exhaustion requires a cold attach. Cold legacy
resume must retain the same SID and cannot silently start a new conversation.

No production latency or memory-use improvement is claimed from controlled peers.
The persistent contract documents the bounded registration lifetime and the prompt
inventory cost tradeoff.

## Scoped transport and untrusted data

Codex launches `pult-memory-mcp --home ... --codex-bridge` with a `cm_…`
registration credential only in its child environment. It never reads an owner
token or display config. Credentials do not enter the common app-server
environment, argv, public journal/list, errors or Debug. The immutable private MCP
configuration travels over the supervised app-server pipe.

`hello.codexMemory` is a closed purpose limited to `codex.memory.call`.
Mixed credentials, including empty values, cannot fall back to owner authority.
Native item/started ledger, original arguments, native ACK/started and durable
Driver Accepted must match the exact Ticket before any tool IO. Helper metadata
alone grants no authority. Off calls and read-only proposals are rejected before
Backend IO or a Broker question; the static five-tool inventory grants no access.

Claude/ZCode retain `hello.memoryTurn` and ephemeral `mt_…` credentials. Legacy
`mem_…` keys remain limited to the original four read operations. No scoped
credential can access owner APIs or history.

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
warm next-turn reuse, same-SID cold resume, revocation, private key non-disclosure
and final child cleanup.
Exact run counts and proof log paths belong in the handoff after the final run.


Current verification includes actual warm helper reuse, off/on/off policy,
late/forged/replayed native calls, exact argument binding, held Registry locks,
owned preparation/IO cancellation, helper pipe shutdown, scoped CLI isolation,
queue continuation and cross-provider memory. Frozen proof manifests record exact
source/log hashes and counts; controlled peers do not qualify an installed CLI,
account or model. Existing overflow and cleanup adversarial cases remain active.

Rust filters both `mt_` and `cm_` credential formats, including embedded prefixes
and ASCII upper-case representations. Node rollback filtering retains the legacy
`mt_` policy; raw Codex registration credentials stay inside the Rust transport. A credential
used as an object property name conceals that value as well. The final Rust
journal boundary applies this same explicit-format policy to structural metadata
without generic filtering of normal opaque IDs. Proposal params are recursively
rejected before Broker if the format occurs anywhere, including `commandId`.
A real ephemeral MCP key echo was tested in assistant text, tool values/property
names and a structural ID; ordinary 32-hex tool identity remained intact. This
regression was RED before the format extension. Email remains visible.
