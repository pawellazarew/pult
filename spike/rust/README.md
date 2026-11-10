# Rust runtime experiment (R1)

This is an isolated executable experiment, **not the Pult backend**. Its protocol and journal are
deliberately distinct from production RPC and storage. It does not read or migrate `~/.pult`.
The existing TypeScript daemon, Electron window and installer are unchanged.

Rust stable 1.99.1 is pinned in `rust-toolchain.toml`. Build from this directory:

```sh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --release --locked
```

CI runs only deterministic fixtures on Linux/macOS. It never starts a logged-in model or spends a
provider quota. Python 3 and POSIX shell utilities are required for integration fixtures.

## Control loop

Choose a fresh absolute scratch directory, not your home directory or Pult's data directory.
`--home` is required; there is no production default. Only one process can own the scratch home.

```sh
scratch=$(mktemp -d)
./target/release/pult-r1 --home "$scratch" serve
```

Send JSON lines on stdin:

```json
{"method":"hello"}
{"method":"start","program":"/bin/sh","args":["-c","printf '{\"ok\":true}\\n'; sleep 30"],"cwd":"/tmp"}
{"method":"stop"}
{"method":"quit"}
```

`start` is an explicit arbitrary subprocess launch, with the calling user's privileges. This
prototype has **no approval broker, sandbox, authentication, IPC listener or remote access**.
Do not expose its stdin to untrusted callers. Only one session is supported. Child stdout must
contain JSON lines; stderr is drained into a byte counter, not stored as potentially secret text.
EOF, Ctrl+C, SIGTERM, rejected input and normal shutdown explicitly stop and reap the child.

The stdout control replies include `acknowledged`, the sequence saved to `r1.ndjson` after
`sync_data()` succeeds. On a write failure, no success acknowledgement is printed. Complete
corrupt records or gaps fail closed. A final incomplete, unacknowledged frame is truncated on open.
Replay validates records before printing them:

```sh
./target/release/pult-r1 --home "$scratch" replay
```

On reopening `serve`, an unfinished session is marked interrupted; the prototype never replays an
external command. Process-crash durability is tested. Directory metadata durability after power
loss, disk-full behavior and arbitrary filesystem corruption are not yet qualified.

Limits: 1 MiB per frame/record, 16 buffered provider messages, 32 MiB total journal, one buffered
control request. Oversized or malformed frames terminate the session with an error. These conservative
prototype limits intentionally differ from production Codex's 16 MiB frame allowance.
Control stdin uses a dedicated bounded reader thread outside Tokio's blocking pool. The CLI
does not wait for that thread after awaited provider cleanup; callers may keep stdin open after
quit/TERM. Control stdout is synchronous:
a caller that never reads it can still block command processing; qualifying slow-viewer behavior
requires a nonblocking control transport in R2. A closed stdout returns an error through cleanup.

## Real Codex smoke (explicit, optional)

Use your existing signed-in CLI, a fresh scratch cwd and a fresh scratch home. Without `--prompt`,
the smoke only initializes app-server and creates a read-only thread. It does not start a model turn.

```sh
scratch=$(mktemp -d)
work=$(mktemp -d)
./target/release/pult-r1 --home "$scratch" codex --cwd "$work"
```

An explicit `--prompt 'Reply with the single word OK; do not use tools.'` runs one turn and spends
your existing subscription quota. The CLI's ordinary account/settings still apply. Threads request
`read-only` with `approvalPolicy: never`; unsupported server requests receive JSON-RPC errors.
There is no attempt to widen permissions or fall back to full access. A complete smoke has a 120-second
deadline, service requests a 30-second deadline, and stdin writes a five-second deadline.
The raw provider messages are written into the chosen scratch journal: keep that directory private.

## What is and is not proved

- Durable append/reopen, writer exclusion, sequence validation and torn-tail recovery.
- One hundred real subprocess start/message/stop/replay cycles with reaped direct children.
- Bounded stdout framing, stderr flood draining, stopping with a backed-up consumer.
- SIGKILL of the prototype after a confirmed start, followed by validated recovery and interruption.

**Known gate:** killing the prototype itself with SIGKILL can leave the provider process group alive.
The crash integration test explicitly cleans that group up; it does not claim automatic recovery of
orphan processes. Solving this requires a supervisor/holder design and platform-specific evidence.
`kill_on_drop` is only a direct-child fallback on ordinary Rust unwinding, not a SIGKILL guarantee.
The normal stop path kills the created process group and reaps its direct child. Descendant reaping
after reparenting, cross-platform lifecycle policy and full R1 crash acceptance remain open.

The experiment is not a security or performance superiority claim. It does not implement existing
Pult questions, resume semantics, approvals, queue/steer, authentication, network guard or UI.
Do not compare its resource usage with the full Node daemon without a matched workload. R0's
production-daemon baseline is separate. Record actual local commands and results in `RESULTS.md`.
