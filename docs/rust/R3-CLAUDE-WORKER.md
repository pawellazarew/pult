# Owned ordinary Claude worker: implementation in progress

`claude_worker` connects the Driver to a real supervised process using native
stream-json stdin/stdout. Tests launch a synthetic Python provider; they do not
call Claude, a model, an account or a private API.

The worker reserves exact Ticket/generation ownership synchronously, retains its
run task if the caller disappears, persists session identity through sealed
host-store receipts and accepts native input only after matching UUID evidence
and an owned init. Public mapped output waits for the Driver's actual accepted
user-event receipt. Cancellation stops the registered process, and terminal
release follows process and scoped MCP cleanup proof. Failed cleanup retains the
slot for retry rather than claiming completion.

Input is encoded outside the final gate. A private process vault survives gate
callback failures, first-poll panics and subsequent write-task panics. The final
blocking step checks current access, seals cancellation, obtains an uncontended
owned guard synchronously and first-polls the stdin write without an intervening
await. A pending write is joined in an isolated task. Every branch retrieves the
still-owned Process for cleanup; cancellation uses StopSignal without taking the
vault lock. This does not claim atomic revocation against every OS-level race.

The transport separately bounds Claude's base64-expanded input and native
output. Prepared frames cannot widen the destination process profile. A stopped
or reaped process invalidates retained signals before PID reuse.

Seven real-process cases currently exercise ordinary ACK/result, cancelled held
turn, wider init mode rejection, lifecycle completion without a matching result,
a panicking final gate (no input delivered and process cleaned), and preservation
of assistant/usage evidence before a provider-block terminal. Process
transport tests also exercise blocked writes and retained signal invalidation.
These are initial tests, not full provider acceptance.

## Remaining before full provider parity

- Implement the daemon Owner/Registry bridge and actual Rust `mcp-ask`, including
  immutable callback attribution, permission evidence and broker integration.
  Injected traits/config generation alone do not supply those capabilities.
- Resume/fork durability races, dropped caller, blocking/uncertain store writes,
  foreign/late native IDs, event ordering and attachment turn integration need
  additional actual Driver/provider fixture tests.
- Native init rejects unknown or wider reported modes; omitted diagnostic mode
  remains compatible with old streams. Real CLI compatibility is not established
  by the synthetic tests.
- A matching command completion without a matching result fails rather than
  hanging. Node's evidence-based last-foreign-result fallback and command catalog
  host bridge still need implementation and recorded native oracle tests.
- Warm reuse, background/subagents, shared memory, ZCode, daemon RPC and full CLI
  wiring remain required. This first worker deliberately retires each process;
  it is not the final warm-session architecture.

No PR, production switch or installation is implied by this local module.

## Previously verified launch/transport layer

The worker branch starts with the trusted launch-policy layer. `claude_launch`
ports the measured Node argv contract: explicit approval modes, read-only tool
exclusions and Bash ask, protected-directory rule escaping, bounded add-dir roots,
resume/fork switches and host prompts only with an MCP configuration. The Rust
helper is selected explicitly; its private MCP payload contains the question
credential, never the owner token, and reserves the `pult` server name.

User input is serialized separately as native stdin blocks with an input UUID,
images and optional runtime data. Slash-command recognition preserves JavaScript
whitespace and path boundaries, so an absolute path is not treated as a command.
The input budget accounts for base64 expansion of the existing 25 MiB attachment
budget. `Framing::claude()` accepts that input budget independently from its 16 MiB
output recovery bound. Supervised local Python fixtures receive an 18 MiB stdin
payload, preserve the strict profile's smaller input bound, and discard a 17 MiB
output frame while delivering its valid tail. These are transport checks, not
Claude execution acceptance.

Seven local tests include 53 cases compared with the actual built Node24 helpers
(argv, slash commands, directory boundaries and native user input), plus private
configuration and invalid-input checks. The first Rust slash implementation
incorrectly treated a path as a command; the independent oracle failed and the
corrected implementation passes. All-targets clippy and formatting also pass.
No installed Claude process, account or model is used.

Remaining in this branch: supervised process ownership, warm/resume lifecycle,
exact-ticket cancellation and cleanup, durable session/init handling, the real
Rust `mcp-ask` command and scoped permission bridge, current-policy checks,
provider-event integration, and the daemon/CLI execution path. The configuration
builder does not make its referenced command operational. Existing sessions and
RPC support are not changed by this layer alone. Publish the worker step after
its end-to-end acceptance; this document does not close provider issue #105.
