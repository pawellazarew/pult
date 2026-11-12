# Ordinary ZCode Route A controller

`zcode_runtime::ZcodeRuntime` composes the checked ZCode Owner, one fresh Worker
per explicit input, Driver and shared NetworkGuard. It does not own or shut down
the daemon Broker, shared probe, other providers, or unowned Driver tickets. This
is the ordinary library controller; State/RPC integration is a separate slice.

## Trusted construction and lifecycle

`new(Dependencies, TrustedCommand, RuntimeConfig, base_parent, extra_env,
NetworkGuard, Limits)` performs pure shape validation. The command is host
selected, absolute, with an empty prefix; RPC input never chooses a command or
environment. The child's actual HOME is captured from BASE, with no credential
or auth-file read. Extra environment is a separate exact subset of the seven
`zcode_launch::ENV_PASS` configuration keys, bounded and NUL-free. Ambient hooks,
provider credentials, owner/Ask/memory keys and proxies are not inherited.
NetworkGuard supplies the approved HTTPS_PROXY/NO_PROXY environment and its
exact generation stamp. Global guard/probe ownership stays outside this module.

`execute` and host-queue-only `execute_queued` reserve bounded capacity
synchronously, before spawning owned preparation. Dropping their waiter does not
cancel the input. Lazy Owner initialization, Registry/attachment reads and
Worker construction run in owned blocking tasks and are joined through stop.
Before a Driver receipt, preparation compares raw record fields across the
snapshot read, validates native identity/uncertainty, freezes current attachments
and checks the complete Route A prompt budget. Question metadata and unsupported
session browser/fork/inherit/Claude settings/service tier fail before dispatch.
A malformed or future `zcodePendingInput` remains authoritative uncertainty.

Each entry retains a reservation nonce, exact Driver Ticket and progress watch.
A trusted Worker Attempt binds its generation and exact SpawnAction capability
to that entry. Fresh route/policy checks precede Driver's atomic spawn seal; a
controller admission permit is held across actual OS spawn, not a global Driver
mutex. After-seal cancellation may create a PID; the Worker still owns its stop
and join. `stop`, `stop_name`, `busy`, `wait_idle` and `shutdown` retain entries
through preparing and quarantined states. Only Driver Finished is cleanup proof;
absence of a latest-ticket lookup is not. Drop revokes only this controller's
admission/tickets. Shared resources remain usable by their outer owner.

## Current Node behavior and explicit boundaries

Node `src/adapters/zcode/adapter.ts` documents Route A as inherently per-turn
(lines 1–9), builds `-p` plus approval context (around 382–395), and never wires
global MCP servers or browser. Therefore a global MCP configuration does not
block ZCode or execute those servers here. A session browser setting is rejected
explicitly instead of silently promising an unavailable browser. `mode: warm`
remains metadata; it cannot keep a headless Route A process alive. Model/effort
metadata may remain in the record, but no --model/--effort flags or claim of an
applied model is added. Actual reported model events retain their normal meaning.

An observed native authentication failure latches only this ZCode controller.
The captured nonce/Ticket/generation/action must still match the live entry;
stale callbacks cannot block a replacement. The source turn keeps its failure,
while other owned ZCode tickets are cancelled. The shared Driver/Broker is not
closed. Quota is not an authentication latch. `reset_auth` is a trusted owner
operation and refuses all preparing, active and quarantined entries; it never
logs in or changes an account. These are diagnostic heuristics, not proof that
the user's account logged out.

## Missing-session recovery remains required

Node currently clears an in-memory `started` flag after a missing-session stderr
heuristic and omits --resume on the next input. This controller deliberately does
not convert that heuristic into nonexecution proof. A sealed unknown input stays
blocked by its durable marker; the current input is never replayed, the old
native ID is not silently removed, and queue state is not resumed or consumed.
An explicit human-confirmed next-turn recovery requires a separately qualified
Attempt-bound joined diagnostic proof, exact Registry CAS and recovery admission
reservation. No such proof is reconstructed from marker JSON after restart.
This required recovery slice is not implemented by this ordinary controller.

Rollback tests target the patched source-controlled Node reader. They do not
prove an arbitrary installed 0.3.21 binary understands Rust uncertainty markers;
that installed-backend qualification remains an R5 boundary.

## Evidence

Tests use real Registry, ConsentStore, durable JournalSink, Driver, holder and a
private synthetic executable. They cover independent sessions, exact stop,
fresh resume/attachments, queue receipts, cancelled preparation, scoped shutdown,
authentication/reset and missing/unsupported state. Memory-only source tests
exercise stale callback and real Driver quarantine admission; they claim no OS
cleanup for their synthetic unconfirmed Worker. No installed ZCode CLI, model,
account or provider network is invoked. Full ZCode integration/recovery parity is
not claimed by these tests.
