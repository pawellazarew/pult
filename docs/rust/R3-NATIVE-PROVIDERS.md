# Selected-provider ordinary turns in the Rust daemon

The experimental daemon routes ordinary Claude and Codex turns through the
same socket API, journal, Driver, durable queue and daemon-owned permission
Broker. Provider selection comes from the exact current Registry incarnation;
client parameters never select a program, helper, settings root or authority.
The eleven partial session/permission methods remain experimental. This is a step
within R3, not full provider parity or a working-install cutover.

## Lifetime and dispatch

State lazily constructs each selected provider independently. Claude bootstrap
resolves only Claude, the process holder and curl; a missing Codex executable
does not prevent a Claude turn. Both providers use the same daemon Broker.
The Claude controller receives the concrete settings resolver for its actual
filtered child HOME and OS managed-policy directory, plus the private scoped
MCP factory. The factory issues the exact Ticket/generation/public-turn
credential and writes the configuration consumed by the actual Rust `mcp-ask`
helper. It does not expose an owner token to the provider or helper.

Provider construction and registry/settings/config IO run in owned blocking
work. The common command gate still reserves and revokes prompts in socket
frame order; stop during lazy initialization cannot admit a later stale input.
Shutdown seals global Driver admission first, joins lazy initializers, stops
provider-owned processes/preparations, drains the Broker and network probe
owners, then waits for Driver and detached host IO before dropping the daemon
lease. Provider-local shutdown cannot stop another provider's Ticket or close
its shared Broker/Driver.

`daemon.status.nativeRuntime.initialized` describes either provider. The new
`providers.codex.initialized` and `providers.claude.initialized` fields report
which controller exists. `activeTurns` remains the shared Driver count;
`hosts` retains its earlier Codex warm app-server meaning and is not a count
of transient Claude processes. Existing `initializeRuntime: true` explicitly
initializes the historical Codex runtime; it is not provider auto-discovery.

## Queue and uncertainty

Ordinary sending, FIFO drain, pause/resume, selected idle send and
interrupt-and-send can select either provider. Live steering remains Codex
only. Selecting a queued Claude message while its turn is active rejects
before the dispatch marker, leaving its item and current input unchanged.
Uncertain native delivery never becomes an automatic replay. Pre-driver
unknown-identity/path/fork/provider-policy failures pause the backlog before
releasing the direct reservation; definite unsupported queued input keeps its
item without fabricating an unknown native delivery.

Claude starts one supervised process for each explicit accepted input and
resumes only a confirmed durable native identity. Its reserved native UUID
is distinct from confirmation. Lost confirmation retains `start_unknown`
and the duplication warning; creating another UUID is not a recovery path.
The controller retains ownership through process, MCP-file and exact question
IO cleanup, including cancellation or a disconnected RPC caller.

## Verification and remaining work

The synthetic end-to-end test starts the real Rust daemon, connects the built
Node client, and launches a supervised fake Claude executable in a private
scratch HOME. That executable reads its actual generated MCP configuration
and launches the real Rust helper from it. Human permission answers pass
through the shared Broker; no fake helper reply bypasses the daemon role.
No installed account, model, network endpoint or working service is used.
Component tests separately cover blocked IO, dispatch gates, unknown delivery,
exact Ticket retirement, scoped-key privacy and shared ownership.

Warm Claude process reuse, background/subagent execution, user questions,
command/fallback parity, user/browser/runtime MCP, Claude/ZCode shared-memory
injection and the remaining provider are still required. Real installed CLI
compatibility, R4 integration work, R5 observation/rollback and R6 Rust UI have
not been accepted by these synthetic fixtures. Existing Electron/Node working
installation is untouched.
