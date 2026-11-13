# R4-A: Rust CLI events tail

Status: TESTED_READ_ONLY_CLI_SLICE; seven focused actual CLI/wire tests, both existing R2 interoperability runners (13 journal + 14 subscription scenarios), all-targets clippy, fmt/diff and catalog checks pass locally. This is a read-only CLI production-code slice, not installed-app cutover or full R4 completion. No provider/account/model/config probes or Node CLI fallback are introduced.

## Existing contract and scope

Reference: `src/cli/main.ts:359–405` and `src/cli/client.ts` at base `2b0d1a4d8a965ccff1574a5a991ab5d6cb365344`. `events tail` in TS is a subscription, not the one-shot `events.tail` RPC. Rust now uses existing `events.subscribe`, preserving its `{sub,cursor}` response and subsequent `{sub,event}` / `{sub,end}` frames. Server/catalog/worker/Owner code and RPC contracts are unchanged.

Supported existing flags: `--since N`, `--session ID`, `--json`, `--no-follow`, `--limit N`. Numeric strings use the existing Node-compatible parseInt helper. Default follows; zero limit is unlimited. `--no-follow` waits for the subscribe cursor instead of exiting on ACK, retaining the existing TS three-second replay fallback for filtered/no-matching tails. This does not invent a new filtered-replay completion API. `--limit` counts printed events.

JSON stdout is one original event per line, not a subscription frame or `{events,cursor}` envelope. RawValue preserves unknown event extensions and JS lone UTF-16 escapes rather than normalizing through a scalar-only Value. Human output follows TS `#ID TS provider/kind sessionId [JSON data]`; empty `{}` data is omitted. Existing Rust server subscription events are normalized before serialization.

ACK and first events may arrive in one read; one persistent bounded BufReader retains the remainder. There is no reconnect/restart/replay after disconnect. An accepted subscription's end/EOF/read disconnect ends the command normally, as TS onEnd/onClose do; SIGINT ends it normally. Malformed/oversized frames fail with static diagnostics. SIGTERM retains ordinary OS termination behavior, rather than inventing a different user contract.

The explicit `pultd-rust --home SCRATCH` staging boundary remains. The CLI connects only to an already-running daemon; TS ensureDaemon/service arbitration, PULT_HOME/installed launcher, other CLI verbs and production checked_home denial remain separate work. No lib/catalog exports were added. Streaming client is a private binary module, `rust/src/cli_client.rs`.

## Authentication and capacity

Memory read/turn credentials are refused before owner home/config/token reads. Owner checked_home and locale lookup use existing public helpers. Token reading is bounded to 65 bytes and requires the existing 64-hex owner-token shape. Token, server frames and native errors never enter public diagnostics. Connect/handshake/subscribe ACK waits are bounded at ten seconds; frame accumulation is bounded at the existing 1 MiB body limit. After ACK, follow has no idle timeout.

Socket/client state is dropped on every return. Closing the connection releases the actual server subscription; tests observe subscriptions returning to zero instead of assuming a dropped future equals server cleanup. The command neither owns journal writes nor provider processes.

## Bounded stdout without unsafe code

A Tokio blocking stdout writer can outlive cancellation. Holding Rust's global stdout lock would also risk blocking std::process::exit's own global stdio cleanup. Tail therefore duplicates stdout via safe `AsFd::try_clone_to_owned`, writes/flushes only a separate `File`, and never uses global print/StdoutLock on this path. It does not set O_NONBLOCK or alter shared parent TTY/file status flags. Each successful output write and flush is awaited. A per-write two-second timeout yields a static nonzero error, honestly leaving any partial output unconfirmed.

The tail-only caller explicitly exits after the subscription future/socket has been dropped, before Tokio RuntimeDrop can wait forever for a detached blocked File writer. The separate File writer holds no global stdio lock. This pattern is not applied to daemon, mutation or other CLI paths. Existing forbid(unsafe_code) stays in place.

Actual OS-pipe probes retain stdout's read end without reading enough seeded output to fit it. One test requires the exact static write-timeout diagnostic plus bounded nonzero child exit; another sends SIGINT and requires bounded child exit. Both observe subscriber cleanup on the real daemon. A broken-pipe case exits nonzero without retaining a subscriber. A hermetic actual TS CLI baseline against the same Rust scratch daemon confirms Node EPIPE exits with code 1; the Rust path preserves that status with a static diagnostic (STATE/r4-broken-pipe-baseline.log). These are process/pipe tests, not mocked future timeouts.

## Existing R2 fixture adjustment

Root approved only two CLI calls in `rust/tests/journal-interop.mjs`: they now explicitly request `--json --no-follow`, parse NDJSON lines, and compare the exact old event arrays including legacy UTF-16/extensions. The prior complete RPC `{events,cursor:8}` assertion remains. The filtered cursor is independently checked against actual Node createStore.lastId, not inferred from the last printed filtered event or checked against the same RPC twice. Only the filtered call watchdog changes from 3s to 6s to permit the existing TS 3s fallback plus startup/cleanup; its event/cursor assertions stay intact. The first filled replay call retains its 3s watchdog. Other R2 content/failure assertions are unchanged. This is an intentional migration from the old experimental Rust CLI envelope to the existing TS user format; RPC events.tail remains unchanged.

## Verification

Dedicated target: parent Me `.agents/workspaces/pult-migration/STATE/target-cli-events`; persistent logs also live in STATE. Seven focused cases cover actual Rust daemon backlog/format/filter/cursor/empty tail, live append/limit once, SIGINT and daemon stop without reconnect, blocked OS pipe timeout/SIGINT, broken pipe and memory-purpose denial. A small independent wire fixture additionally coalesces ACK+event and sends an oversized private-marker frame to verify retention/bounds/static errors.

Final checks used Rust 1.99.1, managed Node 24.21.0, one Cargo job, no incremental/debug info and RUST_TEST_THREADS=2:

- `cargo test --locked --test cli_events_tail`: EXIT 0, 7 passed, final 3.39s. The actual unread-pipe timeout requires the static output diagnostic; process exit/real subscriber count are observed.
- `cargo test --locked --test journal_compatibility --test subscription_compatibility`: EXIT 0, 2 runners passed (13 + 14 underlying existing scenarios), final 5.37s + 35.19s.
- `cargo clippy --locked --all-targets -- -D warnings`: EXIT 0; standalone owned Rust fmt check, git diff check and generated RPC catalog check EXIT 0.
- `npm ci` and `npm run build`: EXIT 0 for the existing TypeScript interoperability fixtures; CLI implementation never passes user commands to Node.

Final logs: STATE/r4-cli-focused-final.log, STATE/r4-cli-r2-final.log, STATE/r4-cli-clippy-final.log and STATE/r4-cli-catalog-final.log in the parent Me migration workspace. Earlier logs retain fixture-private-directory setup failure, a transient local function-signature edit compile failure, initial test-only clippy style finding, and the old R2 filtered-call watchdog's collision with the exact TS three-second fallback. These were fixed in owned source/approved test scope; no daemon policy or content assertion was weakened.

Exact SHA/binary/source hashes are recorded in the parent handoff manifest after all checks. No installed launcher, actual service, user home, live model or provider account is touched. Full production CLI/system integration and R5 cutover remain open.
