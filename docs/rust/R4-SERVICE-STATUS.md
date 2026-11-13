# R4: service-aware local daemon status

The Rust preview now implements the local `daemon status` wrapper, including a
complete service report when the daemon is offline. It does not start a daemon,
install/load/unload a service, change configuration, inspect provider accounts,
run provider CLIs, or perform a network probe. This is not a doctor port or an
installed-service cutover.

```sh
pultd-rust --home /absolute/private/scratch daemon status
pultd-rust --home /absolute/private/scratch daemon status --json
```

The existing private scratch/production-home guards remain in force. All four
scoped credential purposes (`PULT_ASK_KEY`, `PULT_RUNTIME_KEY`, `PULT_MEMORY_KEY`,
`PULT_MEMORY_TURN_KEY`), including empty and mixed values, fail before home,
display-config, owner-token, socket, service-file or manager access.

The default command prints the localized Node-compatible daemon summary and a
service line. `--json` prints `{running:true,...daemonStatus,service}` or, when
the daemon does not answer, `{running:false,home,service}`. Exit is 0 for an
answering daemon and 1 otherwise; a service/manager error does not change an
answering daemon's exit to 1. `running:false` is an RPC observation, not proof
that no daemon process exists. Local purpose/home validation failures remain
fatal and are not converted to an offline report. Ordinary RPC response timeout
remains 3 seconds; handshake/write bounds remain shared with the owner client.

The existing no-verb Rust command still means status, now in text format. Use
explicit `daemon status --json` in scripts that parse JSON. The explicit
`daemon status --initialize-runtime` preview keeps its previous **raw RPC JSON**
output, including when combined with `--json`; it performs no service query.
Its credential preflight also rejects all four scoped purposes. Runtime
initialization remains opt-in and is separate from ordinary status.

## Observations and compatibility profile

The source oracle is Node `src/cli/main.ts:291–307`, `src/service/{context,
status,manager,render}.ts` at base
`fa2eb6793c865ed8a6b3dcebae9cdcf8d5e1dc10`. The prior inventory is preserved in
the migration workspace as `STATE/R4-DOCTOR-SERVICE-PORT.md`.

- ServiceReport retains platform/name/file/installed/fileHome/ours/launcher/
  stale/launcherOk/manager/error. ManagerState retains loaded/running/pid/
  lastExitCode/lastSignal/runs/state/error. Darwin platform is `darwin`.
- Only an installed service whose PULT_HOME matches this scratch home is
  queried. Foreign/absent service files cause no manager execution. Realpath
  aliases count as the same home; reading a service file does not execute its
  launcher. Stale Darwin `ProcessType Background` is reported.
- Production queries use absolute `/bin/launchctl print gui/<uid>/<label>` or
  `/usr/bin/systemctl --user show <unit> -p
  LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus`.
  No lifecycle verbs are available in this module. Child env is constructed
  from the existing base allowlist plus XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS.
- `PULT_TEST=1` permits only explicit fake manager paths. A missing fake cannot
  fall back to an actual OS manager. Test-only FAKE_* variables are passed only
  in this mode. Production ignores those variables and fake path overrides.
- The legacy service line remains **Russian even with English daemon text**.
  This intentionally preserves the pinned Node behavior; it is not a new claim
  of complete English service UX.
- launchctl missing status 113/3 and known bounded missing-process text are
  recognized. Darwin `(never exited)`, signal exits, top-level fields and nested
  coalitions remain distinct. Linux CLD code/signal distinction and the legacy
  `runs = ExecMainPID` projection are preserved.

Explicit host-profile differences:

- Service files and each manager output stream are limited to **1 MiB**.
  Non-regular files, final/parent symlinks, unreadable/oversized files and unsafe
  paths produce a static error, not silent truncation or a false uninstalled
  report. Known actual-host macOS `/tmp`, `/var`, `/etc` aliases are normalized
  only internally; reported paths retain their user-visible alias. Arbitrary
  directory symlinks remain denied. Relative service-context paths resolve
  lexically before open; raw relative/ParentDir read paths are rejected.
- Manager nonzero errors retain a safe operation/name/exit code but replace the
  original stderr first line with `service manager query failed`. Raw manager
  stderr is never printed. The oracle separately checks the exact original
  Node error and the exact intended Rust replacement; common comparisons are
  not relaxed. Local bounds/cleanup errors are static. These strings are not a
  general secret-recognition guarantee.
- Manager numeric observations fit signed 64-bit host fields; malformed or
  overflowing numeric strings do not become valid process IDs. Incidental
  JavaScript coercion of malformed daemon results is not a success oracle.

## Query and output lifetime

A query owns a fresh process group and bounded stdout/stderr readers. The leader
is inspected with WNOWAIT and remains unreaped until the final group signal;
the group is never signalled after reap. Success, overflow, cancellation and the
20-second query deadline all run cleanup before returning. Darwin EPERM is not
accepted blindly: it requires two bounded stable all-zombie membership snapshots
with the still-owned leader present. `/bin/ps` is used only for this cleanup
confirmation on that edge. Same-group descendants are stopped; this does not
claim containment of deliberately detached setsid children or hostile same-UID
code. This lifetime belongs to a diagnostic manager query, not to intentional
background services launched by a provider.

One SIGINT listener spans RPC, query and output. Query cancellation is observed
inside its owner and cannot drop cleanup. Ctrl-C exits 130; output cancellation
occurs only after query cleanup. The shared cloned-FD writer preserves its
2-second output bound. The status-only CLI exits explicitly after output/error
handling so Runtime drop cannot wait indefinitely for a blocked output thread.
A query ownership/group/leader/reader-join cleanup failure has a separate host
failure profile: bounded static stderr and exit 1, before either normal daemon
availability rendering or Ctrl-C exit 130. Its host-only flags are skipped by
serialization; native/RPC JSON cannot authorize cleanup confirmation.
A pipe that has already received bytes can contain partial output on failure;
nonzero exit does not claim that JSON was completely delivered.

## Qualification

Controlled actual Node CLI oracle ran before Rust formatter expectations were
changed. It covers 36 exact Node/Rust text/JSON RU/EN cases and four explicitly
profiled manager-error cases using private fake sockets and manager executables.
Its preload permits only those fake manager executables and forbids fallback
subprocesses; this is a test guard, not a security sandbox.

Pure tests use recorded Darwin running/after-kill/missing fixtures; exited-78 is
explicitly **derived**, not a recorded real launcher failure. Actual executable
cases cover offline/online observations, purpose priority, FIFO/symlink/bounds,
fake-only dispatch, wrong-id/EOF/oversize/deadline, explicit initialization,
query descendants, overflow, 20-second timeout, Ctrl-C, broken and unread stdout
pipes. Existing wait/prompt/events/local/scoped CLI regressions remain required.

Oracle prerequisites are Node 24, `npm ci --ignore-scripts` and
`node node_modules/typescript/bin/tsc -p tsconfig.json` in the isolated worktree.
The recorded run used Node 24.21.0 and task-only empty npm config files.
Dependency registry fetches are separate from the service qualification.
All qualification uses scratch homes, synthetic credentials and controlled
peers. No actual service manager, provider CLI/account or diagnostic/provider
network probe was exercised.
No doctor command, capability/catalog activation, service installer or cutover
is included.
