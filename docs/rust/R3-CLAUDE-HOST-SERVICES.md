# Claude owner authority and durable native identity

This slice supplies `ClaudeOwner` services to the ordinary Claude Worker. It does
not add a provider RPC, MCP ask transport, warm/background ownership or a ZCode
Worker. The shared private `OwnerTrust` accepts an explicit provider policy; the
existing CodexOwner API and its regression suite remain intact. ZCode can use
that checked core when its provider-specific owner/Worker contract is ported.

## Authority

The trusted host captures the sole-writer Registry/ConsentStore, Pult home and
its filesystem identity, Weak Driver, required route-stamp callback, required
inherited-mode resolver and fatal-storage hook. Run constructors/snapshots in
owned blocking work. Worker gates already run in owned blocking tasks.

No callback runs under a store or Driver mutex. Inherited policy and route
callbacks may reenter cancellation; checked metadata, consent and exact live
Ticket are refreshed afterwards, including after mutex waits. Consent -> Registry
is the store lock order. Cwd aliases canonicalize, while per-incarnation device /
inode pins reject retargeting. General workspaces and home-ancestor guards apply
at every checked boundary, including Full grants. These checks are not atomic
filesystem handles and do not defeat an external process replacing paths after
validation.

`InheritMode` receives canonical cwd plus exact settingSources; provider HOME and
managed settings roots belong to its trusted closure. The concrete
`claude_settings::Settings` resolver implements Node source ordering. Errors,
unrepresentable mode/source strings and panics fail closed. Sticky inheritSeen,
current provider consent and session CLI grant participate in host_policy; they
are refreshed rather than inferred from an old approval label.

## Durable session evidence

- Reserved stores only `claudeReservedSessionId`, before native stdin. A private,
  bounded owner seal binds the candidate/parent/fork to the exact Ticket and
  incarnation. It does not claim the conversation already exists.
- Initialized validates that seal, expected parent and actual fork child, then
  commits providerSessionId and removes the candidate/fork flag. Only these
  fields and applicable inheritSeen change; titles/settings are not restored
  from an old record. Exact duplicate init is identity-idempotent, but permission
  evidence and current consent/policy must still be checked.
- Initialized may record known native identity after cancellation while the exact
  execution Ticket is still retained. It cannot resurrect an archived, removed,
  provider-switched or recreated record. That diagnostic update grants no send
  authority. A wider native mode is rejected after retaining known evidence.
- AbortedBeforeInput can clear only the same sealed candidate after the Worker
  proves stdin was never first-polled and joins cleanup. After dispatch CAS=1,
  timeout, panic or unknown send never clears the marker automatically.

An unknown Registry commit latches Driver execution failure before the external
State callback, outside all store locks. No failed write is automatically resent.
Worker ownership retains the persistence operation through cleanup.

## Restart and Node rollback

Any marker presence, including malformed/future JSON, is uncertainty. Rust and
Node preserve it through normalization and unrelated mutations; raw objects are
compacted only outside JSON strings to remain valid single-line NDJSON without
losing UTF-16 escapes or numeric lexemes. Recovery keeps queued input paused and
shows failure. Node prompt/say/retry/steer, auto-drain and queue resume/send cannot
pop an item, append a user receipt, rotate UUID or resend while it remains.

The error explains that the previous input may have executed and a retry could
duplicate work. The available explicit recovery is to inspect native history and
import a confirmed conversation into a **new** chat/incarnation, retaining the old
uncertain history. Same-chat owner-confirmed recovery is still a required later
session-contract step; no generic JSON clear-marker capability is added here.

## Remaining Worker integration boundary

The base Worker rejects some wider/malformed init modes before calling the store.
Such a candidate remains uncertain even if a native ID was observed. The owner
supports retaining diagnostic identity before rejecting permission evidence;
reordering that Worker callback is a separate Root-owned change. This does not
claim that Full safety can erase work a provider performed before reporting init.

## Acceptance scope

The real-process owner fixtures use supervised Python protocol peers and the
actual Driver, Registry, ConsentStore and JournalSink. Node rollback tests call
the actual Registry/Manager; the cross-backend oracle mutates one metadata file
Rust -> Node -> Rust, including a pretty future marker and lone UTF-16 escape.
The explicit-import test calls the trusted `Manager.importSession` with an
already selected known ID. It does **not** test public CLI history discovery or
the server RPC's validation of that external-history selection. Those existing
history/import tests remain required in combined/full acceptance. No installed
native CLI, model call, account or live-network behavior is validated here.
