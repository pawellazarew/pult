# Owned ordinary Codex runtime

`CodexRuntime` composes checked network routing, a bounded shared app-server
pool, one incarnation-pinning CodexOwner, the durable permission broker and turn
driver. Executables and the base environment are supplied by the trusted host;
RPC JSON cannot select a command or supply child environment variables.

Preparation reserves the session before its first await. Network approval
precedes spawning or recording an accepted user turn. Hosts are reused by exact
route generation/configuration/environment equality, not a hash. Per-session
leases are privately nonce-bound and rechecked before native-ID persistence and
model dispatch. Fresh worker facades freeze each turn's validated attachments.

Snapshot/consent reads, attachment validation and resume-ID registry reads run
in owned blocking tasks. The preparation reservation remains until those tasks
finish even when stop or shutdown arrives. Driver admission stays synchronous
as a public API; the runtime invokes it on the blocking pool. Fresh authority
checks and their dispatch/enqueue seals are a single blocking step, preserving
the no-await authorization boundary without occupying Tokio workers during IO.

Native permission requests cross the typed mapper and real broker. Durable
resolution and a current owner/ScopedResponder check precede permission replies.
Late journal failures remain observed after handler cancellation and close all
execution admission. Dropping a caller does not abandon an ordinary task or
probe; dropping the runtime wrapper starts owned shutdown.

Shutdown closes preparation and Driver admission, stops all warm hosts, awaits
process and Job/IO proofs, drains broker receipts and owned curl operations.
Successful terminal publication is monotonic even during concurrent repeated
shutdown. Stale public turn IDs return false and cannot interrupt a reused turn.

Validation: 14 runtime and 35 Driver tests use real private registry/journal
files, supervised Python fixtures and scripted probes. Tests cover shared hosts,
blocked routes, image replacement, durable grants, late cancellation/faults,
lease generations, folder pins, dropped callers, concurrent shutdown and IO.
No account, paid model or live network is used.

Current limits are explicit: ordinary turns only, immutable daemon-lifetime
configuration, no queue/question provenance, no MCP setup/legacy approvals or
background/subagent parity, and no persistent rules. Obsolete route generations
retain bounded pool slots until shutdown; idle eviction is a later step. A
Shared probe remains its caller's lifecycle responsibility; OwnedCurl is drained
here. Replacing/dropping this runtime also closes its supplied Driver, so it
must not be used as a hot-reloadable profile wrapper.

RPC/CLI wiring and full compatibility acceptance remain separate work.
