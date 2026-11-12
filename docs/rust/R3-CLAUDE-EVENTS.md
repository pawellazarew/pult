# Pure Claude event adapter

`claude_events` converts ordinary Claude stream-json frames into typed journal
drafts, transient activity and host-policy signals. The host supplies the trusted
session incarnation, Ticket, generation, provider session ID and input UUID.
Foreign/stale callbacks are rejected before invoking the injected redactor.

The bounded normalizer covers initialization, streamed/final text, ordinary tool
events, usage/context and a matching result's exactly-once terminal outcome.
Redaction failure, callback panic and capacity overflow discard the batch and
return a static terminal failure. Raw input is not promised secret-free; the
mandatory redaction boundary precedes persistence. Driver owns final status and
cleanup; the adapter does not spawn, stop, authenticate or invoke a provider.

Subagent trees, background lifetime, command catalogs/completion fallback and
image capture remain explicit deferred signals for the future host. Retry,
account and rate-limit signals need host policy. Cross-turn context carry and
raw object insertion-order parity are not implemented; ambiguous model-prefix
windows yield no window rather than choosing a sorted JSON entry.

Validation: 18 tests, including the actual built Node24 mapper oracle over six
recorded ordinary-turn fixtures and synthetic text/tool/context cases. Tests
also cover scope rejection, late results, UUID acknowledgement, redaction/panic,
UTF-16 limits and bounded tool/state/output buffers. They launch no Claude
process and make no account, model or network calls.

This is a library prerequisite for a future Claude worker. It adds no State/RPC
wiring and does not enable Claude execution. The method catalogue remains 27/98.
