# M3: private ZCode app-server shared-memory resources

This adapter implements the native Worker's ScopedResources contract using the
same concrete memory Backend as Claude/Codex. It is private and is not activated
in Runtime/provider selection. It does not qualify installed ZCode, native MCP
permission behavior or the complete Rust migration.

## One factory, one immutable Worker context

The trusted Runtime creates one Factory for a Worker/Ticket and a SessionKey.
The first prepare synchronously reserves a direct OnceLock Entry containing the
exact Ticket, generation, public turn and immutable ZCode snapshot. Duplicate
prepare, even for the same Ticket, is rejected before Backend issuance. Foreign
session/provider, invalid snapshot/turn and zero generation are rejected first.
Competing different factories for the same Ticket are outside this single-Worker
contract: Backend scopes are Ticket-keyed, not a second provider-specific store.

Preparation runs in one retained owned task. A short installation mutex and private
start oneshot ensure its JoinHandle is in the Entry before either a drain can
observe it or the task can issue a capability. Dropping an unpolled/pending result
waiter revokes that exact Entry; a failed result delivery revokes it as well. No
caller cancellation aborts the owned preparation.

The concrete shared Backend checks persisted enabled policy, prepares its memory
scope, loads the bounded catalog and constructs a fully preverified InputScope
in owned blocking work. All of this precedes the Owner input frontier. Catalog
is a cached snapshot loaded in that retained preparation, at most 16,000 UTF-8
bytes / 4,000 characters. Later catalog calls clone that bounded snapshot after
exact local context/validity checks and perform no new slow lookup. Cached data
is not permission to send input: the fresh handoff check remains mandatory.

Memory-off returns unavailable before Worker OS spawn. No dummy/no-op server,
HOME override, global/workspace config mutation or textual tool emulation is used.
There is no automatic fallback or input replay in this adapter.

## Private native MCP configuration

Only Backend's fixed command, args and env profile is converted to typed native
StdioMcpServer: name `pult-memory`, the actual snapshot cwd, explicit stdio args,
`env: [{name,value}]`, and `isolation: "session"`. The only environment entry is
PULT_MEMORY_TURN_KEY with a valid purpose-specific mt credential. Owner, ask,
read-key and other environment authority is refused. Backend's
`default_tools_approval_mode` is deliberately not transmitted to ZCode.

This configuration stays in private protocol data; keys are not argv, journal,
public errors, Debug output or the app-server launch environment. The adapter
does not create another Backend, read an owner token or discover provider binaries.
Native ZCode may merge global/plugin/builtin servers with custom MCP definitions;
this profile does not claim to disable those native features.

## Borrowed final admission

The immutable Entry stores InputScope directly, so check can legally borrow its
Core permit without self-referential owned guards or unsafe code. check receives
the already-current Record from the opaque AppServerInputFrontier and retains the
Core State execution / Control / lease gates until handoff. It takes no Registry,
context or database mutex and performs no filesystem work or callback. Entry
identity/generation/validity is checked around this pin. The actual Owner/Driver
input seal and synchronous first enqueue still belong to Worker.

Revoke marks only the matching Entry invalid, then invokes Backend revoke outside
the installation mutex. Wrong generation/Ticket cleanup cannot revoke an existing
Entry. Before any Entry exists, a fixed set of up to eight exact early selectors
prevents late preparation after that selector's already-confirmed empty drain.
A wrong generation tombstone does not block another generation. Overflow fails
closed for this still-unused factory; the set never grows without a bound.

## Drain and uncertainty

Drain is owned and starts once; repeated waiters share its completion watch.
It revokes promptly, joins the retained preparation, then repeats Backend revoke
and awaits Backend drain. The post-join revoke is essential: an earlier revoke
can happen before actual Control issuance. Absence of a Control alone is never
used as proof that an unknown preparation cannot issue one later.

A normal Backend Result Err can clean up successfully. This relies on the actual
concrete Backend contract: begin installs its Control synchronously before its
first asynchronous IO, and admitted nested initialization/read IO is counted on
that Control. Its completed outer result cannot start a later outer preparation;
Backend drain waits its real admitted jobs. A generic unavailable error is not
turned into permanent quarantine solely by its name.

A panic/JoinError of Factory's own retained preparation is different: it can drop
a Backend result receiver while Backend's already-owned inner preparation is still
pending. Such an outcome is sticky cleanup_unconfirmed even if a best-effort
Backend drain currently sees no Control. A scope-precheck blocking JoinError and
an interrupted drain likewise do not publish confirmed cleanup. Worker must keep
its quarantine; this adapter never clears that uncertainty using a PID lookup,
timeout, dropped waiter or empty map. Revocation recovers a poisoned local gate
only to deny access; poison does not authorize preparation/check or clean drain.

## Verification boundary

Contract tests use real State/Registry/Driver/Backend, SQLite and permission Broker,
with a controlled holding Worker. They do not claim a native process was launched
when exercising Owner reservation/spawn-seal/frontier contracts. A separate composed
test runs the real Rust memory MCP binary against the same State's private Unix
connection: readonly get succeeds, revocation denies the old still-running helper,
and no owner fallback is available. Full proposals still wait for separate human
approval; readonly cannot request a write.

Other cases cover private config shape/catalog, memory-off, duplicate/invalid
context, wrong-generation cleanup, bounded early tombstones, dropped prepare
waiter with late issuance, a catalog blocked on the real database mutex, normal
Backend error versus owned preparation panic/quarantine, and fresh policy/context/
Driver cancellation checks under the held actual Owner frontier. Native Worker
acceptance, all IO/descendant joins and real installed CLI qualification remain
separate required integration evidence.

Local verification on macOS arm64 / Rust 1.99.1: real binaries built, 13 adapter
cases passed, and 111 related cases passed (24 native Worker, 25 memory turn,
15 session-memory/API and 47 Owner). The executable-helper fixture explicitly
initializes the normal private scratch marker before invoking checked_home;
production scratch validation is unchanged. The unpolled-waiter case asserts
revocation before invoking drain, so drain cannot mask a missing Drop guard.
All-target clippy with warnings denied, formatting and diff-whitespace checks
are required alongside those test results; the exact tested commit and logs are
recorded in the external migration handoff.
