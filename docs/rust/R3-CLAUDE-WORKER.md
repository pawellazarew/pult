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

## Inherited settings resolver

`claude_settings::Settings` captures the child HOME and trusted managed directory.
It selects allowed user/project/local files, then applies managed base and sorted
managed fragments regardless of setting-sources. Fragment ordering uses UTF-16,
as JavaScript does. Reads follow dotfile symlinks, check the opened descriptor,
use nonblocking open and stop at 1 MiB. Unsafe existing files contribute bypass;
missing/malformed files match Node's no-contribution behavior. The raw parser
retains lone UTF-16 surrogates even in unrelated JSON fields and duplicate keys
use last-value semantics.

No mode cache is used. Over 4096 managed-directory entries returns a capacity
error instead of silently ignoring possibly stronger policy. A final mode with
unpaired UTF-16 cannot cross the typed Rust String callback and returns an
explicit error (the owner must deny), rather than falling back to an earlier or
less privileged mode. Settings are read in owned blocking work; regular filesystem
IO is not promised to finish within a hard deadline. This resolver does not read
macOS MDM profiles; native init evidence and sticky inheritSeen remain necessary.

Tests compare 17 filesystem/JSON combinations with the actual built Node helper,
including FIFO, oversized file, symlink, malformed UTF-8, duplicate/escaped keys
and lone surrogates. Additional tests cover source filtering, managed precedence,
UTF-16 fragment order and refusal at the managed-directory resource limit.
The concrete resolver is available for the in-progress ClaudeOwner bridge;
that bridge and final daemon integration still require separate acceptance.

## Known never-sent cleanup

After process/MCP retirement, a joined worker with dispatch CAS still 0/2 sends
AbortedBeforeInput to the trusted store. That typed request can clear only its
exact reservation; CAS=1 retains uncertainty even if the first write failed.
This prevents a preflight or missing-program failure from permanently blocking a
chat despite proof that its new input was never dispatched. The owner must also
accept an idempotent abort if no reservation was created, without clearing any
foreign or initialized marker. Worker fixtures cover final-gate denial and
missing-program abort, no abort after actual dispatch, and caller-handle drop
before acceptance without abandoning durable completion.

Malformed native permission-mode presence is rejected. Only an omitted field
uses legacy absence; object/null/control-containing values no longer silently
become None. Three real-process regressions fail against the former filtering
parser and pass with the explicit shape check; all 12 worker cases pass. This is
protocol validation, not proof of real installed Claude-version compatibility.
