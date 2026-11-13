# R3: composed ZCode wire integration

Status: TESTED_COMPOSED_WIRE_SLICE; 4/4 composed tests, all-targets clippy, owned-file fmt/Python syntax/diff checks pass on macOS / Rust 1.99.1. This slice connects the actual owned process holder, raw NDJSON transport and bounded ZCode codec to a constructed Python native-protocol fixture. It does not implement or qualify a production Route B Worker, Owner, Driver, real memory MCP, actual ZCode provider/account or Rust cutover. It is not an R3 completion claim.

## Composition

Base `158fad6` contains the protocol profile and input-frontier foundation. Raw transport source is the exact authorized `e30775631d7be999670b09eb873bdd85a6cb6108`, cherry-picked here as `911e701`. Integration ownership is only:

- `rust/tests/zcode_appserver_transport.rs`;
- `rust/tests/fixtures/zcode_appserver_profile.py`;
- this document.

The holder is the actual built `pult-worker-holder`; `Process::spawn_with_framing` owns the real fixture child process. `Framing::raw_ndjson` uses 16 MiB inbound and 256 KiB outbound limits. Outbound requests and reverse replies are serialized by the actual protocol module, then passed through `prepare_raw` and `send_prepared`. Native frames reach `decode_frame` directly through `RawFrame::as_bytes`, without a Value serialization round trip. The duplicate-key case also transfers the single receiver through `take_raw_output`.

The fixture executable is Python 3 with a script wrapper. Its emulated native argv after the wrapper is exactly `app-server --stdio`; the mode under test is a scratch-only fixture control file. Only approved PATH/HOME/LANG enter the actual launch; the environment allowlist is not widened for tests. The fixture never starts ZCode or the configured helper. It receives only an explicit scratch HOME/environment and reads no user config or account state.

Schemas and behavior are constructed from public `zai-org/ZCode@c5904686ea8341826b3affe5d993d06a134fa779`, including protocol create/subscribe/send/event/close schemas, the session/requestRuntimePreferences reverse schema, and ordinary send intent behavior. They are not recorded native frames or a live differential oracle. Source references and unsupported codec profiles remain documented in [R3-ZCODE-APP-SERVER-PROTOCOL.md](R3-ZCODE-APP-SERVER-PROTOCOL.md).

## Four composed tests

1. **Bootstrap and both ACK/Started orders.** Create carries a host-reserved native SID, explicit guarded mode, titleGenerationEnabled:false and a nonempty stdio MCP list whose env is an array of name/value entries. The native fixture sends a traced runtime-preferences reverse request before it replies to create. The host sends actual codec default-deny preferences; only then does the fixture return a full minimal protocol-v1 snapshot. Explicit subscribe precedes the current input. Send uses host inputId/queryId, and the fixture emits a bounded state.updated notification, an ordinary intent-bearing turn.started and the send ACK in both possible relative orders. Test checks native SID/TID/inputId/queryId as transport candidates, without issuing Driver authority.
2. **Raw duplicate ACK.** The fixture emits duplicate sessionId keys with an invalid first value and a valid final value. A separate demonstration Value parse retains the final valid SID, while the actual codec sees the original raw bytes and returns InvalidJson. The holder/raw receiver transfer must not normalize that ambiguity away.
3. **Wrong RPC, wrong SID and malformed trace.** An ACK answering an unrelated RPC or native SID yields CorrelationMismatch. An unknown privileged trace member fails before a runtime-preferences response/current send. These results establish codec refusal of acceptance evidence; a future Worker still owns its stop/frontier/Owner decisions.
4. **Lost ACK after native input observation.** The native fixture counts the send, closes stdout without sending acceptance evidence, and stays alive reading input until the host stops it. A scratch audit barrier confirms native receipt and native stdout closure. The holder retains its own stdout while the process is alive, so a bounded receive timeout gives an unknown ACK outcome rather than native-only EOF. The host keeps the same owned holder PID, performs no replay/restart, then explicitly stops/joins and drains real holder EOF; output_finished_cleanly additionally checks EOF observation plus reader join, and counters remain one create/one send. This is raw transport behavior only. It does not prove an Owner unknown marker, no native execution or a future supervisor's retry policy.

The normal exchange explicitly obtains native `{closed:true}` while both holder and fixture remain alive. Only a subsequent `Process::stop` provides holder cleanup/join; native close ACK is not OS cleanup.

## Privacy and limits

The helper command is a deliberately nonexistent fixture path; no MCP helper is executed. The transport carries its static private fixture key only in serialized create stdin. The host examines launch args/env before spawn, and the actual child separately verifies the key is absent from argv/environment. The child validates private MCP shape/content privately, then persists only counters and booleans in scratch `zcode-wire-audit.json`, never prompt/key/full frame data. Assertions and codec errors avoid printing raw native frames.

This adds no provider selection, network/account probe, configuration mutation, owner authorization, production fallback or process retry. It does not change the codec, Driver, Worker process implementation or existing fixtures. Unsupported native storage/process/v4/terminal payload profiles remain separate qualification work; passing this narrow exchange must not be reported as full native compatibility.

## Verification

Final commands used the dedicated parent Me target `.agents/workspaces/pult-migration/STATE/target-zcode-wire`, with one Cargo job, no incremental/debug info and RUST_TEST_THREADS=2:

- `cargo test --manifest-path rust/Cargo.toml --locked --test zcode_appserver_transport`: EXIT 0, 4 passed, 0 failed; 2.33s final runtime.
- `cargo clippy --manifest-path rust/Cargo.toml --locked --all-targets -- -D warnings`: EXIT 0.
- Standalone owned-file `rustfmt --edition 2024 --check`, Python fixture syntax compilation without execution, and `git diff --check`: EXIT 0.

Final logs: parent Me `.agents/workspaces/pult-migration/STATE/zcode-wire-tests-final.log` and `STATE/zcode-wire-clippy.log`. Earlier logs remain preserved: initial compile typo (fixed local helper variable call), rejected custom fixture environment key before spawn (fixed by scratch control file), and a 20s lost-ACK watchdog caused by the incorrect harness assumption that closing native stdout would also close the still-live holder stdout. The latter two exposed valid host policy/holder semantics, not production parser/transport bugs. The corrected lost-ACK test uses an observed-send scratch barrier, bounded receive timeout, explicit stop/join, then real EOF/reader-completion proof.

Exact final source/toolchain hashes and initial-log names are recorded in the parent migration handoffs manifest. Each worktree has a dedicated target, avoiding historical stale cross-worktree artifacts. No full old-base suite or live provider qualification is implied. All Cargo work for this slice is complete; no push or PR was performed.
