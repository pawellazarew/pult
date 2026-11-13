# R4 actual CLI → daemon → completion acceptance

Fixture-only `PULT_COMPLETION_WAIT_E2E=1` mode extends the existing
`final-completion-interop.mjs` oracle. Without that flag, its 17 paired adapter /
Rust-daemon cases and 17 Node rollback roundtrips keep their existing assertions
and execution path. No production method, catalog, help or capability changes.

Composition: bare-prompt CLI `a7d3126ead3af948becd0251eb421a03d47fe4d1`, reviewed
wait / holder composition `f34573f`, then carrier / codec composition
`d34b1ea3b111d94e84d16da9a6ffdba972134bc4` (merged head `2fa8e310`).

## Controlled cases

The actual Node Claude/Codex/ZCode adapters produce the existing final-answer
oracle through explicit repository peers. The actual Rust daemon runs those same
controlled peers, with private scratch HOME, project, journal and configuration.
Installed provider CLIs, accounts, network guards with external probes, service
installation and global configuration are not used.

For each of 17 ordinary divergent/multi/empty/failed/escaped/capacity variants:

1. RPC prompt obtains the actual accepted turnId. Before any active-turn polling,
   the actual Rust executable runs `agent wait subject --json` against that daemon.
2. Exact name/status/reason/turnId/ok/errorCode/text/message are compared to the
   qualified durable terminal, whose fields still pass the independent Node
   adapter comparator. Empty optional strings stay omitted. Exit codes use the
   existing Node CLI table.
3. Capacity returns explicit capacity RPC failure; the currently unqualified
   ZCode failed disposition returns explicit unavailable. Neither case fabricates
   a successful answer or claims full failed-answer parity.
4. UNKNOWN + timeout=0 gives status-only timeout for successful outcomes,
   including successful-but-capacity-unavailable ZCode. Failed outcomes still
   take precedence and return their qualified result or explicit unavailable.
5. Node EventStore / reducer rollback remains checked. After Rust restart,
   UNKNOWN + timeout=0 returns only current name/status/reason, without a
   remembered prior answer, provider initialization or replayed input.

The three divergent success cases additionally run actual `agent prompt … --wait
--json`, require exactly one new durable user event and a new public turnId, and
compare the result to that turn's durable answer. This yields 17 wait calls,
3 prompt/wait calls, 17 UNKNOWN-zero calls and 17 restart calls (54 CLI invocations).

Wait completion requires Driver's per-turn close and durable publication. It
does not require a shared Codex host process to exit between turns. Recorded
controlled native PIDs must disappear after actual daemon shutdown; this keeps
logical turn cleanup separate from a warm host's lifetime. No intentional user
background service is launched or qualified by these fixtures.

## Harness ownership and bounds

The Node fixture samples its opt-in flag before clearing inherited provider and
PULT variables. Only this mode adds explicit 10 s RPC deadlines. Each CLI child
has a 20 s watchdog and 2 MiB combined stdout/stderr capture budget. Timeout kills
and joins that actual child (5 s join bound); a Promise.race alone is insufficient.
Output text is compared privately; failure messages print static labels, not
answer payloads. Failed fixtures retain their scratch path for diagnosis.

The new Rust wrapper copies the proven test-only process ownership harness from
`zcode_memory_compatibility.rs` at composition `2fa8e310`. It keeps Node as an
unreaped leader (WNOWAIT), pins the private PGID through the final signal, and
never signals after reap. On Darwin EPERM, two bounded snapshots must prove an
unchanged all-zombie membership including the owned leader; any live/unknown
member keeps cleanup unconfirmed. Captured output readers stay owned and joined.
The 240 s outer watchdog runs known cleanup before interpreting body failures.
Native holders have their existing separate groups and parent-FD cleanup.

Node 24 and built TS dist are required, with no skip on missing prerequisites.
Builds/tests use isolated `target-wait-e2e`, jobs=1. Actual executed results,
hashes and retained diagnostics are recorded in the persistent handoff; source
presence alone is not a PASS claim. Permission/question/background parity and
public wait activation remain separate acceptance work.
