# Typed final completion transport

This step carries a qualified final answer through the existing owned Worker/Driver lifecycle and stores it with the durable terminal status. It does not implement `agent.wait`, a WaitHub, CLI waiting, background lifecycle support, or installed-provider qualification.

## Why message history is insufficient

Qualification uses actual public Node adapters over repository fake peers, and the Rust daemon over the same controlled frames. No account, external network, provider binary or model is involved. Reference Node/Rust production source is the migration baseline `84122675f128891b1ca3d32a7bc8df37f9c621f6`; the independent success→idle change is `ae72f05461d06ebfcec3020a4acb68f3ca5e015d`. Native ZCode event profile remains pinned to upstream `c5904686ea8341826b3affe5d993d06a134fa779` / CLI 0.17.1.

| Stream | Node final outcome text | Durable message.done alone |
|---|---|---|
| Claude assistant I, result F | F | I |
| Claude assistant I, empty result | absent | I |
| Codex root completed items I1/I2, terminal summary F | I1 + newline + I2, regardless of commentary/final_answer phase | I1/I2, if exact root/turn identity retained |
| Codex empty root item, nonempty terminal summary | absent | empty message |
| ZCode turn.completed I, raw result F | F | I |
| ZCode turn.completed I, empty raw result | I | I |
| ZCode failed result F after completed I | I + newline + F | I |

Claude/Codex subagent corpus also contains child messages under the same public sessionId, distinguished by parentId. Node excludes child text from the owned outcome. Rust's explicit unsupported background/lifecycle failure remains unchanged. No history concatenation or new background support follows from this transport.

Claude and Codex normalizers already produce bounded redacted terminal fields; their Workers previously reduced them to a bare coordinator Outcome. ZCode's existing redacted TurnEnded/Result signals distinguish fallback text from final CLI result. Route B has typed session/event terminals, not a raw CLI result; it must not fabricate one.

## Host authority and wire shape

WorkerCompletion is opaque; the public host/fixture conversion from Outcome carries no native answer. Only crate-private normalizer integration attaches qualified fields. The original Outcome enum is unchanged. Source text remains subject to original UTF-16/UTF-8 limits and a checked escaped-wire bound; no silent truncation.

The existing status.changed terminal may contain this additive versioned data:

```json
{"completion":{"version":1,"incarnation":"<host session createdAt>","userEventId":1,
 "outcome":{"turnId":"<accepted public turn>","ok":true,"text":"<redacted final answer>"}}}
```

No new event kind or Registry recovery field is introduced. Text is stored once in the authoritative global journal. Latest holds a small opaque CompletionRef bound to actual Ticket, exact SessionKey incarnation, accepted public turn, and durable user/terminal event receipts. Provider/public JSON is never authority to mint a ref. The loader validates the actual global journal event and matching user receipt; a per-session projection or arbitrary path cannot authorize an answer.

Required order is owned done → owned close/revoke/descendant/stdio/IO join → durable terminal append → before_release → existing slot retirement and owned Finished publication. Cleanup uncertainty, cancellation/fault winners, blocked/panicking storage and unknown delivery must not publish a native success. No automatic retry/fallback is added.

Latest eligibility is ephemeral to the daemon epoch and exact session incarnation. It does not resurrect Node's remembered inflight outcome after restart or rollback. Per-name replacement avoids an unbounded chain of recreated incarnations, and it is independent of the coordinator's global finished-turn cache. A prior A completion is not evidence that a newer pending B has completed; future WaitHub must register current pending identity separately.

## Compatibility and remaining gaps

R5 acceptance must use actual Node EventStore/reducers/history and Rust→Node→Rust round-trip for the additive nested status data, including escaped byte limits. TypeScript's permissive Record type alone is insufficient proof. Existing data without completion means no qualified remembered answer. No silent new kind/migration marker or rehydrated replay is permitted.

The carrier baseline deliberately left ZCode failed-result mapping unqualified. The later [ordinary failure slice](R3-ZCODE-ORDINARY-FAILURE.md) now qualifies a single accepted failed raw Result with empty joined stderr, clean native IO, no host cancel and no later frame: exact internal/result-type message with accumulated I then F. Other stderr, ambiguous, no-Result and cancellation schedules remain conservative/unqualified. This is not full ZCode error or installed-native parity.

Cancellation text parity, transport failures, terminal-grace fallback and installed native behavior require separate qualification. The transport must preserve existing source and unknown-execution contracts, not claim that all public wait outcomes are implemented.

## Current read-only host API

`Driver::latest_progress(&SessionKey)` returns the exact Ticket and a cloned existing `watch::Receiver<Progress>`. Registration is atomic with a successful reservation; a pending B replaces A immediately. Reservation/capacity failures do not replace A. Clone Progress and drop the watch borrow before calling Driver, preserving Driver→watch lock order. `closed()` and `storage_failed()` distinguish an unavailable Driver from a healthy missing entry; callers must fail closed rather than infer status-only success from None.

`Terminal.completion_ref` is observable only in the owned Finished result after cleanup, durable append and successful before_release. The typed hook may receive an internal candidate reference; `Driver::read_completion` rejects it until that exact Finished is published. Existing coordinator slot retirement and Finished publication remain in their original order after before_release. No new execution authority comes from the optional JSON payload.

`read_completion(ref)` returns getter-only CompletedAnswer (`ok`, `error_code`, `message`, `text`); identity comes from the opaque reference, not normalizer/native turnId. It validates exact current Finished/Ticket/incarnation before and after owned global-journal IO, so a new pending ticket/incarnation, shutdown or storage fault rejects a late answer. The ref also binds the expected small typed terminal disposition; mismatching stored status/code is invalid.

`Options.latest_sessions` defaults to 65536 (range 1..65536), matching supported Registry/live-cache capacity; storage is one small watch/ref entry per name, replacing reincarnations and independent of finished128. `retire_latest(&SessionKey)` is a trusted lifecycle hook. Public rm/purge is outside this slice; its later implementation must call the hook only after verified retirement. Archive/title rename must not retire the incarnation.

`Options.completion_reads` defaults to 64 (range 1..1024). Read admission uses try-acquire without a disconnected-caller queue. An owned registered reader retains its permit through actual Store completion after caller Drop; shutdown drains these readers in the same original checkpoint timeout, without abort or deadline extension. Capacity is explicit, not an inferred provider failure.

When qualified fields exceed the combined escaped-wire budget, the existing status/outcome is preserved and completion contains `{"version":1,"incarnation":"…","userEventId":1,"unavailable":"capacity"}` instead of outcome. Other finite reasons are `unqualified`, `disposition`, `cancelled`. No partial text is stored. Load errors are typed Unavailable(reason), Storage, Invalid, Version; unknown versions/reasons/fields and mismatched user/terminal receipts fail closed. Latest B still shadows prior A even when B is unqualified or unavailable.

The encoded field budget is checked by a bounded writer before constructing the large JSON value, reserving room for existing clipped status error text, host identities and envelope. Original normalizer source-unit limits remain unchanged. Versioned `final-completion-interop.mjs` runs real public Node adapters and the Rust daemon over explicit repository fake peers, then reopens the exact journal with actual Node EventStore/status+attention reducers and Rust again. Qualified large escaped text and explicit-capacity paths are included; no replay occurs on restart.

A qualified native failure candidate is conservatively changed to disposition/unqualified if existing Driver normalization clips or redacts its failure message, even when the full completion payload could otherwise fit. This slice does not normalize that mapping or claim full error parity. An already-explicit capacity/unqualified marker keeps its reason. Cancellation fencing concerns publication of a qualified answer; it does not change the pre-existing late-cancel Outcome semantics (a late request can still coexist with an already-won Success disposition). Further cancellation-text/error qualification is separate.
