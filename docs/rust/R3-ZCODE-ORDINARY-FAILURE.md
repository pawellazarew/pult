# Ordinary ZCode raw-Result failure parity

This slice qualifies only one accepted ordinary Route A failed raw Result with exact joined-empty stderr, clean natural stdout EOF, known owned cleanup, no host cancellation and no later raw frame. It does not activate public wait, expand background support, change native permission policy, or qualify an installed provider/account/model.

The reference is the actual public Node ZCode adapter/mapper from migration baseline `84122675f128891b1ca3d32a7bc8df37f9c621f6` (adapter blob `90ea2724e6e8649aefa98b4a38381947331c0f85`, mapper `192e35dd25f8cd58cc802ad05e350f48cba50663`), identical in carrier `40fab054d4dbc1ebe34951944fd1b66b6de601c8`. Native schema remains the separate pinned upstream `c5904686ea8341826b3affe5d993d06a134fa779` / CLI 0.17.1 reference; no installed native execution is implied by source or fake-peer evidence.

## Qualified behavior

For a single failed Result, Node returns `internal`, message `ход завершился неуспехом (<original resultType>)`, and ordered nonempty TurnEnded texts followed by nonempty Result text, joined with exactly one added newline between parts. If no part exists, text is absent. Unknown and empty string resultType are preserved in the formatted message rather than mapped to invented error enums. A raw cancelled Result without host cancellation is this same internal failure; it is not a host Interrupted disposition.

| Controlled input | Qualified result |
|---|---|
| I then error Result F | internal, `(error)`, `I\nF` |
| I then empty error Result text | internal, `(error)`, I |
| Empty I and F | internal, `(error)`, absent text |
| I1/I2 then error Result F | internal, `(error)`, `I1\nI2\nF` |
| Cancelled raw Result, no host cancel | internal, `(cancelled)`, ordered text |
| Cancelled TurnEnded then error Result | raw Result failure wins; no Interrupted substitution |
| Unknown / empty resultType string | internal, exact original string / empty parentheses |
| Missing resultType | existing success default preserved |

The assembled error message passes the existing scoped redactor factory contract, including panic, shape, original UTF-16 and escaped-wire checks. Exactly the same safe `internal` code/message is supplied to coordinator Outcome and typed TurnOutcome. Text accumulation uses existing bounded storage; overflow produces explicit completion unavailable:capacity with no partial text. A redactor failure or shape change cannot publish a qualified native answer. ResultType itself is structural upstream text, so formatting it without this final content boundary would expose unredacted text.

## Conservative exclusions

The private classifier now returns only an empty/nonempty joined-stderr fact in addition to its existing error/sideeffect behavior. Empty means exact zero bytes after owned stderr completion; nonempty whitespace is deliberately excluded. Authentication/quota/missing-session classification, private stderr diagnostics, provider signals and native SID persistence remain unchanged. No raw stderr is published.

Any second Result, contradictory Result or later raw frame excludes the new failure qualification. Existing execution behavior for those schedules is preserved; they do not gain a fabricated exact wait answer. No Result, nonempty/classified stderr, terminal-grace/IO uncertainty, missing acceptance or host cancellation remain unqualified. There is no retry, replay or Route A fallback change.

Cancellation checks and process/descendant/stdio cleanup remain in their original positions. New failure mapping occurs only after those checks and after native IO was observed clean. A blocked owned event append plus host cancellation retains the exact Driver slot until its IO and cleanup finish; it cannot publish the native failure answer early.

The carrier's separate conservative long-failure-message clipping/redaction rule remains: if Driver normalization changes a qualified failure disposition's message, the answer becomes unavailable:disposition even if its payload could fit. Late-cancel Outcome semantics are also unchanged. Neither behavior is claimed as full error/cancellation parity here.

## Reproducible proof

`final-completion-interop.mjs` uses actual public Node adapters and a Rust daemon/real holder over explicit repository fake peers, with synthetic HOME, injected network/schema checks and no actual provider binary. It checks exact code/message/text/absence, actual accepted turn/user receipt binding and durable completion. Actual Node EventStore and status/attention reducers then reopen the journal, append a known event, and Rust reopens it without provider spawn or replay. Test-only `final_completion_peer.mjs` enforces a per-frame source bound and drains stdout naturally on child exit.

Focused `zcode_worker.rs` tests retain prior Worker regressions, add real-holder ordinary failure and assembled-message secret redaction, reject duplicate/late/nonempty stderr schedules, exercise redactor error/shape/panic/capacity, and hold owned IO during host cancellation. Source or protocol tests alone do not establish native/provider qualification.
