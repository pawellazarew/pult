# R3 — daemon owner, runtime bootstrap and stop barriers

This slice connects native runtime lifetime to the existing Rust daemon owner. It does not
connect `agent.start`/`agent.prompt` or replace the installed Node daemon. The catalogue
remains **27/98**; ordinary provider execution still needs its own RPC compatibility step.

## Explicit preparation

Normal startup and `daemon.status` do not initialize the native runtime. In an owned private
Rust scratch home, `daemon status --initialize-runtime` sends
`daemon.status {"initializeRuntime":true}`. The owner validates the startup snapshot and
opens the private consent store, then initializes one Codex runtime using the daemon's
shared Registry, Driver and journal sink. Concurrent requests share that initialization.

The optional `nativeRuntime` status contains `initialized`, `hosts` and `activeTurns`.
Initialization is **not provider/network readiness**: it starts no provider host, turn or
model request. Missing executables or an invalid bootstrap return a static error; ordinary
read-only status remains available. Node ignores this experimental Rust-only option.

## Lifetime and persistence

- Execution and owner `events.emit` append to the same journal. Status projection runs in
  append order while the store mutex is held. The live cache retains only identity/status,
  releases its guard before Registry IO, and persists only actual status changes.
- A projection or journal failure latches execution unavailable and wakes the daemon owner.
  Committed journal cursors remain monotonic; publication does not roll back a committed event.
- `daemon.stop` publishes stop and seals Driver admission synchronously before attempting
  the response. A disconnected/blocked response cannot cancel shutdown. Responsive clients
  retain the existing two-second connection-drain grace.
- Bootstrap IO owns its State even if its RPC disappears. Shutdown waits for the initializer
  mutex before inspecting/closing the runtime and before releasing daemon ownership. New
  initializers check stop under that mutex before cached returns or filesystem work.
- Runtime and Driver cleanup retain the ownership lease until shutdown is confirmed.
  Diagnostic snapshots may include a cancelling turn; dispatch snapshots revoke it immediately.

## Evidence

`runtime_journal` tests cover commit publication, cancellation, storage failure and ownership.
The initializer barrier and disconnected-stop ACK each have an observed RED before their fix
and GREEN afterwards. The latter queues stop to a paused **owned scratch** daemon, closes
its peer, then resumes it, making the failed response deterministic.

`native_runtime_status` uses the built holder executable as a non-provider stand-in. It
checks concurrent explicit preparation with zero hosts/turns, cold restart, invalid option
handling, soft bootstrap failure and disconnected ACK shutdown. It contacts no provider.
`turn_driver` and `codex_host_services` also cover synchronous admission closure, storage
fault notification and diagnostic identity retention through cancellation.

No production migration, memory credential injection, queue/background parity or Rust UI
acceptance is claimed by this slice.
