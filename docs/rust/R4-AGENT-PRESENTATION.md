# R4: owner CLI session presentation

Rust now formats `agent`/`session` **list, stop, rename, archive, unarchive and
seen** as Node-compatible text by default. `--json` selects whole RPC JSON for
list and metadata mutations. The existing backend methods and their current
partial provider/list profiles are unchanged. No provider, daemon autostart,
service observation, doctor or installed cutover is added.

```sh
pultd-rust --home /absolute/private/scratch agent list
pultd-rust --home /absolute/private/scratch session list --json
pultd-rust --home /absolute/private/scratch agent rename one New title
pultd-rust --home /absolute/private/scratch agent rename one --title="-important"
pultd-rust --home /absolute/private/scratch agent archive one --json
pultd-rust --home /absolute/private/scratch agent unarchive one
pultd-rust --home /absolute/private/scratch agent seen one --unread
pultd-rust --home /absolute/private/scratch agent stop one
```

No rename title clears the title; words and `--title` conflict. Missing names,
unknown flags and empty-value forms retain the existing Rust Clap parser
profile. This slice does not emulate Node's complete permissive argv parser.

## Output and identity

The source oracle is actual public Node `src/cli/main.ts:594–624,680–719` and
`src/sessions/{context,attention}.ts`, with RU/EN strings from
`src/i18n/cli.en.ts`, at base `93cacc2f5331202185e21631b5b55d806682bfe0`.
`agent` and `session` aliases call the same RPC. CLI never infers provider
execution or changes a session identity from presentation fields.

JSON retains complete bounded `RawValue`, including future extensions and lone
JS UTF-16 escapes. It does not flatten arbitrary fields through `Value`.
Opaque lexical JSON is retained rather than promising JavaScript re-encoding of
every arbitrary number/whitespace shape. Qualified exact byte pairs use normal
daemon wire shapes. Text decodes strings for the terminal; lone surrogate units
display as replacement characters.

Ordinary Node `stop --json` deliberately ignores its RPC result and prints
exactly `{"stopped":true}` after a successful call. That is a CLI acknowledgement,
not native exit/cleanup proof. The explicit Rust extension `stop --turn-id ID`
keeps the previous **raw RPC JSON** with or without `--json`, including
`stopped:false` and unknown fields. No Node text behavior is invented for it.

List prints response order without headers, filtering or sorting. Name/provider/
status padding uses UTF-16 code-unit length16/7/19, not visual or grapheme width;
long fields are not truncated. Unread derives from valid attention kind/safe id,
numeric lastSeenEventId and exact markedUnread=true. Context requires a valid
nonnegative finite measurement and nonempty timestamp, applies JS rounding,
uses percentage when window is known and rounded thousands otherwise; it does
not clamp at100%. Approval, pending permissions, worktree and title are printed
from their actual fields. The list's «title» punctuation stays literal in both
locales, while rename uses localized quotes. Missing backend fields are not
fabricated. JSON array/object coercion is presentation only; custom
prototype/valueOf/toString execution is not supported. A noncallable own
toString gives explicit invalid_response in text while JSON remains opaque.

## Text profile and process lifetime

Before any output, text is fully rendered under a **1MiB UTF-8 output bound**.
Array String coercion is iterative over borrowed RawValues, with depth64 and
4096 scheduled/visited display values **per coerced field**. Traversal reserves
node budget before queueing children and stops bounded array deserialization
before retaining excessive child references. Unknown object descendants are not
traversed merely to print `[object Object]`; these are display-work limits, not
a new strict JSON/protocol schema. Exceeding a text limit emits static capacity
error and no partial rows. JSON passthrough bypasses these text-only limits.

An actual pre-fix8192-deep array response of about16KiB passed JSON unchanged
but aborted the text CLI with stack overflow; the fixed same-frame regression
requires exact JSON success and bounded text capacity failure. Wide5000-child
arrays and output expansion exercise the node/output bounds separately.

All four scoped credential purposes, including empty/mixed values, are rejected
before home/config/token/socket access. Existing private scratch-home guards
remain. No offline-success fallback, retry, helper spawn or provider inventory
is performed. Ordinary owner RPC bounds remain shared with OwnerClient.
Protocol errors use Node's `pult agent: CODE — MESSAGE` and exits timeout2,
blocked_network4, provider_unavailable/limited5, otherwise1.

One SIGINT listener spans connect/RPC/output. Interrupted CLI closes its socket
and exits130 without claiming rollback: an already-issued stop or metadata RPC
may have committed. Client/socket drop precedes output. Main explicitly exits
after both success/error output, so Runtime drop cannot wait forever on a
blocked cloned-FD writer. Broken/unread pipes fail within the existing output
deadline; bytes already delivered cannot be retracted.

## Qualification boundary

Actual Node24 public-CLI oracle runs through only a private fake owner socket;
its preload forbids every subprocess/autostart/provider/manager attempt. It
checks96 RU/EN/text/JSON cases, aliases, exact RPC params, Unicode padding,
context/attention/approval/worktree fields, rename/seen/archive/stop and error
exits. Controlled peers supply opaque UTF-16 extensions. The baseline Rust
default-JSON versus Node text mismatch was observed before implementation.

Actual Rust executable cases cover scoped-stop raw false, all four credential
priorities over FIFO/bad home, unsupported text vs opaque JSON, deep/wide/output
bounds, RPC failure/no success/replay, Ctrl-C pending mutation and unread real
stdout/stderr pipes on both success and error. Existing shared CLI regressions
remain required. One old list JSON consumer gained explicit `--json` only after
its real parse failure; its backend/alias assertions remain unchanged.

This is CLI presentation qualification over current RPCs, not a claim of full
provider/background/native policy parity or production cutover.

Unknown UTF-16 object keys are retained in raw JSON and ignored when selecting known display fields. The shared CLI response parser reuses the existing lossless history parser, including last-duplicate-key semantics. Actual paired cases cover outer hello/result/error envelopes, list rows and nested context/attention/worktree metadata.
