# Pure ZCode Route A surface

This is the pure argv/context/env and native-event slice. It discovers/spawns
nothing, reads no account/config files, grants no permission, and adds no RPC
implementation count. Process/Owner/Worker/controller integration remains open.

Sources: src/adapters/zcode/argv.ts:22/41, adapter.ts:68/84/95,
mapper.ts:113–260, adapters/approvalContext.ts:16, sessions/settings.ts:42.
Node source at kernel base62704f4 and the actual built Node24 modules are the
compatibility oracle; no live ZCode process/model/account is used in checks.

## Launch

`zcode_launch::argv(Options)` produces -p PROMPT, --cwd, --surface terminal,
--mode and --output-format stream-json, with optional --resume. Model/effort
metadata remains accepted without nonexistent CLI flags. No --session-id,
stdin JSON, MCP config, permission helper or scoped-key injection is added.
Full/yolo here is only a pure mapping, never authorization to dispatch.

Mode mapping is plan/guarded/edit/yolo. Pure legacy Inherit→guarded matches Node;
the real host must still reject Inherit for ZCode through TurnSettings before
launch. approval_context defaults to RU, with an explicit RU/EN label variant
matching Node's translated APPROVAL_WORDS (the surrounding current Node context
literals remain Russian). No Inbox/human-permission promise for Route A.

extra_env extracts exactly the seven host-selected ZCODE config keys. It must
run before BASE filtering; it does not inherit BASE, ambient proxy, tokens or
PULT capability variables. NetworkGuard remains responsible for route overrides.
Do not log/debug the raw returned environment; it is trusted private launch data.

Validation extensions versus the unvalidated Node pure builder: absolute cwd,
no NUL, maximum65536 bytes for prompt/cwd and512 UTF16 units for resume; explicit
config env maximum65536 aggregate bytes. Values are rejected, never truncated.
Actual process argument limits/fresh spawn gate remain the next owned IO slice.
Route A puts user prompt in argv (visible to local process listing); this module
cannot describe it as Claude-style stdin privacy. It injects no hidden key.

## Events and trusted scope

HostBinding keeps Pult SessionKey/Ticket/generation/public turn private and has
no Debug/Serialize. TrustedCallback must match exact Ticket/generation. Native
sessionId/turnId are separate evidence candidates, never logical Pult authority.
Early frames are retained before native IDs are known. Host pin_native performs
an explicit monotonic pin after fresh-process evidence validation; JSON push
never changes the binding. Present foreign IDs are ignored after pin, and
missing fields are not synthesized from expected IDs.

Signals mirror Node camelCase envelopes: session_id, turn_started, turn_ended,
result. The latter two are candidates for the host's EOF/exit classifier, not
Driver terminal receipts. Payload is redacted only for message/input/content;
structural opaque IDs/model and typed finite usage counters remain intact.
Float/null/negative/zero/JS rounding semantics are preserved; no integer token
coercion. Result projection supplies context; session.updated is not authoritative.

No output status.changed is possible. In particular this module does not copy
Node adapter's quota limited→failed status sequence or early result completion
before process cleanup. Final status/Finished belongs to Driver after owned IO.
Auth/quota/missing-session stderr classification, cancelled/no-result EOF
fallback, provider-wide reset state, native identity persistence and actual
acceptance/queue recovery are not implemented here.

Resource/privacy deviations are explicit: unknown-type logging/dedupe Set is
not retained (no raw native type diagnostics); native candidates on unknown
safe envelopes still survive. Live reasoning text is filtered here, whereas
Node mapper emits raw reasoning live signals. Host-bound metadata IDs/type
limits are512 UTF16 units. Input16MiB, text512Ki UTF16 units, event768KiB,
batch2MiB defaults; limits have fixed maximums. Recursive work is guarded by
128 depth/131072 semantic nodes. Tool input is bounded before clone/callback.
These bounds can reject shapes the unbounded Node mapper accepts.

Any capacity/invalid redactor/root-type/panic fault discards the entire batch
(including earlier identity signals) and produces one static failure, then
ignores further input. Expanding callbacks cannot accumulate one large output
per attacker-controlled collection element. Host must retire the turn on fault.
Install panic_guard before callbacks; catch_unwind does not silence a default
panic hook. As with existing mappers, the host's final journal purpose-key
filter is still required for hostile secrets forged into structural metadata.

Actual oracles cover four captured native fixtures, synthetic malformed/null
shapes and usage float boundaries, argv/context in RU+EN and every approval,
resume omission, explicit env Unicode/empty/foreign-key cases. Focused fixtures
cover foreign/stale pins/Tickets, opaque-ID distinction, production content
redaction/email visibility, panic/wrong-root/expanding callbacks and bounded
whole-batch failures. No Claude API or shared lifecycle code changes.

Route A has no MCP/permission bridge. M3 ZCode automatic read/write memory is
still open; this slice does not provide a memory delivery or approval channel.
