# R3 — turn-scoped Codex notification normalization

`codex_events` maps the ordinary native notification stream to message/tool,
context, usage and limit events plus live indicators and a turn outcome.
The host supplies trusted SessionKey/Ticket/generation/thread/turn identities;
JSON payloads cannot choose ownership. Stale or unknown callbacks are ignored.
Thread-only warnings are advisory and cannot settle a turn.

The normalizer bounds input, individual public events, accumulated text,
completed IDs and active tools. Redaction is mandatory and fallible; callback
panics are caught and fail closed. Hosts install the silent panic hook before
using callbacks, because a default hook runs before catch_unwind. A fault
clears partial output and yields exactly one static terminal failure; the
host must cancel the owned turn. Later callbacks cannot revive it.

There is exactly one final status writer: Driver after confirmed cleanup and
durable append. The normalizer emits no status.changed drafts. It supplies
usage/result and TurnOutcome instead, preventing duplicate terminal events.

The source contract is current codex/mapper.ts ordinary item/context mapping
and adapter.ts applySignal/finishOuter. Tests cover text/Unicode completion,
questions, command/collab/MCP tools, blob placeholders, context/usage, retry
signals, limits, interruption, stale callbacks, redaction and bounded failures.
16 scenarios include an R0 ordinary golden envelope the panic regression and JavaScript-whitespace question validation.

Session confirmation, subagent routing, image capture, account limits and
capacity/network retry policy remain host responsibilities. This is a partial
adapter slice, not production execution RPC or proof of full Codex parity.
