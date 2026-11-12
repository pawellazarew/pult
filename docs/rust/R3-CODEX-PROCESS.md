# R3 — owned native Codex connection

`codex_process::start` synchronously creates an owned connection supervisor.
`Connection::ready` waits for initialize and for initialized to be written to
the process, not merely queued in memory. A client cannot be obtained before
Ready; cloned clients are invalidated when Connection is dropped or stopped.
The fixed client identity is pult/package version with experimentalApi enabled.

Synchronous admission checks only bounded argument/environment structure. File
metadata checks run in an owned blocking startup task, outside both Tokio workers
and the runtime pool mutex. The supervisor waits for that task before declaring
cleanup, including after caller cancellation. Missing files therefore fail
`ready()` with Launch and Stopped without a child; malformed shape/options still
fail synchronous admission. Native spawning and initialization retain the existing
supervised cleanup contract.

A dedicated reader and the owning writer connect Process to the RPC actor.
Writes are cancellation-safe and serialized against shutdown publication.
EOF is ordered after queued replies and notifications; it does not overtake
the last frames. Invalid framing follows the bounded Codex recovery profile.
No raw stderr, bad lines, remote payloads or OS error details are published.

`Process::spawn_owned` returns a retained Process on errors after OS spawn,
even if the holder never acknowledged startup. Validation/spawn failures
without a child are distinguishable. Owned supervisors use this entry point;
the older convenience spawn API retains its best-effort cleanup behavior.

Startup failure, handshake timeout, shutdown and failed writes lead to stop.
Confirmed stop becomes Stopped; any uncertain stop retains Process in a
quarantined owned task. A bounded nonblocking retry handle can retry cleanup.
Dropping the last retry handle does not turn uncertainty into proof. Hosts
must retain/quota these connections and quarantine corresponding session slots.
The bridge does not provide thread ownership, approvals, model execution,
provider pooling, network routing or production execution RPC.

## Verification

15 connection scenarios, including real Python processes, cover handshake order, out-of-order replies,
server-request denial, malformed framing, EOF tail preservation, hanging
initialize cancellation, writer timeout/cancellation, owner Drop, unavailable
launches, no-runtime calls, startup ownership and cleanup quarantine/retry.
An additional Process test preserves ownership after bad holder acknowledgement
and unconfirmed exit 125; validation failures retain no process. A controlled
blocking validation on a current-thread runtime reproduces a lost heartbeat in
the old synchronous path and passes after the blocking-pool move.

On macOS, installed Codex 0.167.0-alpha.3.2 passed the opt-in handshake and
confirmed cleanup on 11 November 2026. No model turn, login or account mutation
was requested. To repeat with an explicitly selected installed executable:

```sh
PULT_REAL_CODEX_BIN=/absolute/path/to/codex cargo test --manifest-path rust/Cargo.toml --test codex_live -- --ignored
```

The test is intentionally ignored in ordinary CI: provider installation is
not assumed. It proves transport interoperability; full provider parity and
production cutover require separate acceptance.
