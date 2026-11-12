# Exact-ticket Claude permission server — integration in progress

`claude_ask` supplies host-only issuance and the daemon's restricted `ask` role.
A credential belongs to one exact SessionKey/Ticket/generation; it is never
looked up as the latest turn of a public session name. This contract assumes a
process retired after its turn. Warm reuse requires additional native-input
attribution, not rebinding the same key to another Ticket.

The daemon role accepts only `perm.request`. Owner tokens cannot impersonate a
provider question; mixed-purpose credentials never fall through to owner RPC.
An existing connection rechecks its lease on every call. The bound session is
host-selected and a foreign `sessionId` is rejected. An arbitrary `client` label
cannot grant authority. Each question uses the actual Driver Running receipt,
with no invented accepted event; a pre-ack callback waits or fails closed.

Issuance reserves a bounded Control and tracked preparation Job synchronously
before the first offloaded gate. Pending keys are not usable. Revocation sees
pending issuance, and drain includes its owned blocking callback. Dropping even
an unpolled preparation waiter revokes the reservation. Publication checks the
same revocation gate after the callback; failed delivery also revokes the key.
The host must retain its Ticket through drain, including on preparation error.

Question IO is owned independently of the socket's reply future. EOF/drop
cancels just that question, and its Job retains the Ticket through exact Broker
`cancel()/drained()` proof outside the decision deadline. Blocking requested or
resolved writes deliberately keep cleanup pending. Human once-only approval
can restrict the original input. Current policy, route and receipt are checked
again after human resolution; an expired deadline after a blocking final gate
cannot deliver a late allow. No persistent tool-rule/session grant is offered
by this first server integration.

New Rust credentials use `pa_` plus 64 hex digits. Node and Rust filters remove
this explicit format in embedded text, property names and final typed journal
metadata; a capability in request arguments is rejected before Broker creation.
The Rust helper/config builder also accept legacy 64-hex Node credentials for
interop, but the Rust server issues and accepts only the new purpose format.
Email and ordinary structural identifiers retain their existing behavior.

## Evidence and limits

Tests use the actual Driver, daemon connection, Broker and journal with local
fixtures. They cover restricted/mixed roles, stale connections, exact-generation
revoke, foreign session arguments, human input restriction, current gate change,
caller drop/EOF, blocked resolved IO, pending issuance cancellation/drop and
expiry during the final gate. Counterfactual tests fail before both lifecycle
fixes. CLI fixtures separately exercise the actual Rust `mcp-ask` executable
with legacy and new purpose credentials; cross-language filtering uses Node's
actual source as its oracle.

This is not full provider acceptance. The production ClaudeRuntime/controller,
private MCP config-file factory, inherited settings wiring, full user/runtime
MCP, memory MCP for Claude, warm/background/question parity and real installed
provider smoke are not supplied by this backend alone. The per-method migration
catalog remains unported until the full provider path can issue/use the role.
No installed app, account or model is touched by these fixture tests.
