# R3 — native Codex permission response mapping

`codex_permissions` prepares typed broker metadata and a private response plan
for V2 command/file approvals, legacy exec/applyPatch approvals and structured
requestUserInput. It does not own an RPC permit, invoke a tool or grant access.
The host retains the original generation-bound, cancellation-scoped responder
and sends prepared.request() through Broker before resolving the plan.

TrustedOwner includes SessionKey, opaque Ticket and native thread/turn IDs.
V2 payloads must match thread and turn; legacy conversationId/callId aliases
are checked, with the captured ticket binding legacy messages lacking turnId.
resolve consumes the plan once and rechecks freshly supplied host identity.

Once approvals select only the schema's one-action string. File and legacy
methods use their fixed schema vocabulary; command availableDecisions is not
guessed from another method. Session/rule widths require explicit offers.
An exact proposed/available rule object is retained privately and never
reconstructed from display text. Persistent rules default to disabled until
durable rule tracking and revocation are connected. A native approval never
replaces its command using a broker updated_input value.

Public input is clipped with concealed metadata and subsequently redacted by
Broker. Errors are static and omit native payloads. Structured answers are
checked against question IDs/options and whitespace rules.

15 tests cover vocabulary, incomplete/malformed offers, stale identities,
exact rule amendments, questions, clipping, unsupported methods and a real
broker redaction crossing. Legacy schemas are checked-in 0.163 fixtures.
MCP tool-approval elicitation, generic elicitation and newer permissions
request methods are not supported by this slice yet. Current Node has a
specific MCP tool-approval subcase which must be ported before browser parity.
No production host callback or rule-file writer is wired here.
