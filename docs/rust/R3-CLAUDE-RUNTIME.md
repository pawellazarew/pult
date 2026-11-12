# Claude ordinary-turn controller

`claude_runtime::ClaudeRuntime` connects the checked Claude owner, concrete
settings resolver, immutable runtime configuration, shared network guard and
Driver. This is a host library, not a new public RPC method or completed provider
migration. The daemon router owns the central permission Broker and injects a
mandatory MCP factory; constructing ClaudeRuntime never requires CodexRuntime.

The constructor validates shapes without filesystem work and requires explicit
child HOME matching the captured allowlisted environment. One lazily initialized
ClaudeOwner retains home/cwd identity pins across turns and network generations.
Registry, attachment, settings, factory and synchronous Driver admission work run
in owned blocking tasks. Admission reserves bounded per-name capacity before
spawning those tasks. Dropping an execute waiter does not cancel authorized work.

Each explicit input creates a new ClaudeWorker/process from the current checked
native identity, fork flag and setting sources. Valid init identity is durably
persisted before wider permission evidence is rejected. Retired workers are
never reused; the next explicit input can rebuild only after Driver cleanup.
Unresolved reservations retain `start_unknown` and its duplication warning;
there is no automatic resend, unknown-send recovery or new-UUID fallback.

Route leases contain the exact Driver ticket, network generation and approved
child environment. The first private owner gate binds the actual live ticket;
no native frame or latest-by-name lookup selects authority. Fresh route checks
run again after policy/settings waits. Browser and configured native MCP server
lists currently reject before the user receipt; they are not silently omitted.
The injected scoped factory supplies the daemon's ordinary approval transport.
Protect directories default to Pult home; additional directories/roots are empty.

`execute_queued` is for the trusted durable queue owner and preserves its frozen
item identity and delayed receipt. Ordinary execute rejects queue/question
metadata. Attachments are frozen per input, including attachments-only input;
provider context does not modify the durable user text.

Stop targets this controller's exact ticket/public turn identity. Stale IDs are
no-ops. Closing or dropping the controller closes its admission and cancels its
preparing/active tickets, without closing the shared Driver, Broker or network
guard. Preparation remains owned until blocking IO joins. Entries remain through
Driver quarantine; shutdown returns `cleanup_unconfirmed` rather than releasing
those slots. Repeating shutdown retries those exact tickets. The outer daemon
must retain its lease and drain its shared Broker/network probe owners separately.
No claim is made that dropping a shared probe future proves its OS cleanup.

Tests use real Registry/Consent/Journal and supervised synthetic Python children,
with barriers for blocked factory IO, cancellation, reentry, generation changes
and dropped callers. There are no real model, account or network calls.

Full warm-process reuse, background/subagent lifecycle, question answering,
ZCode, dynamic user MCP configuration and same-chat unknown-send recovery remain
required later work. State/router integration is documented separately in
[R3-NATIVE-PROVIDERS](R3-NATIVE-PROVIDERS.md).
