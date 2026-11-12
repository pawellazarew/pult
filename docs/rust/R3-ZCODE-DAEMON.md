# R3: ZCode in the daemon

This slice connects the ordinary per-input ZCode controller to the experimental
Rust daemon. It does not close full R3, migrate the installed application, or
claim complete shared memory, questions/background tasks or native-session recovery.

## Selected provider and ownership

`runtime_state::for_key` reads the current incarnation/provider in owned blocking
work. ZCode initialization uses only `load_zcode`; missing Claude/Codex binaries
do not prevent it. The shared Driver/Inbox initialize independently of a provider.
State retains the selected CurlProbe until the controller has joined all owned
preparations, processes and IO. The controller never closes the shared Driver,
Broker or a different provider. No CLI login, account file or model call occurs
in the synthetic acceptance tests.

Daemon stop first seals admission and cancels all initialized controllers
synchronously. The initialization barrier catches a controller published during
stop. Draining waits for the controller and its selected probe before releasing
the daemon lease; quarantine/drop/timeout do not stand in for cleanup.

## Public behavior

Ordinary prompt, durable FIFO, interrupt, stop and current status use the same
provider facade as Claude/Codex. Live steering remains Codex-only and rejects
ZCode before creating a selected queue dispatch. Presence of an opaque Claude or
ZCode delivery marker holds automatic queue drain, even when the raw value is
null or a future shape. Owner checks repeat the full current policy.

A native session header alone is not acceptance. Ordinary user text remains in
the journal when start fails, matching Driver's existing contract; it is not
proof of native acceptance. Queued user receipts remain deferred until actual
`turn.started` and the Driver receipt. Unknown delivery retains its marker and
prevents automatic retry. The public uncertainty message names ZCode.

`daemon.status.nativeRuntime.providers.zcode` exposes initialized and observed
auth-blocked state. This is not proof of account logout. A trusted owner can reset
the controller latch only after all own work has confirmed cleanup; this library
method is not yet a public RPC command or an automatic login/session reset.

## Scope and acceptance

`zcode_daemon_compatibility` runs the actual Rust daemon, built Node client and
synthetic argv provider in a private scratch home, with both other provider paths
deliberately missing. It checks literal input, confirmed native resume with a
fresh process, FIFO/deferred receipts, interrupt preserving paused backlog,
unknown delivery without replay, observed auth admission and joined shutdown PIDs.
A controlled 11.5s queued acceptance delay remains inside the existing 30s start
deadline. Queue-drain watchdogs include admission; post-acceptance terminal
watchdogs stay 10s. Production deadlines are unchanged.

The per-provider controller tests additionally cover stale authentication source
binding, quarantine/reset, frozen attachments, shared guard lifetime and foreign
Driver tickets. A separate Claude regression reaps real Driver Finished evidence
before consulting cached quarantine, without interpreting absence as cleanup.

Still required: explicit missing-native recovery with joined evidence/owner
confirmation, all-provider memory and purge, complete provider parity, R4 CLI and
integrations, actual installed rollback/observation R5 and Rust UI R6.
