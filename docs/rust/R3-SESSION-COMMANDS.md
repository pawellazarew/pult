# R3 session commands — partial ordinary Codex staging

The owner daemon exposes six experimental partial methods alongside the 27 fully
implemented Rust foundation methods. `protocol.catalog` marks these six entries
`rust: "partial"` and includes their parameter/result schemas. Owner hello and
`daemon.status` advertise them in `capabilities.partialMethods`. They stay separate
from `supportedMethods`. Memory-scoped connections advertise an empty partial list.
The catalog retains 98 entries, including the existing 85 Node routes and 13
extensions. This stage advances ordinary Codex execution while the broader R3
migration continues.

| Method | Current slice |
| --- | --- |
| `agent.start` | Create cold metadata with explicit settings and fresh consent/cwd checks. Returns a public record. |
| `agent.list` | Return `{sessions}` with public records, reduced `status`, integer `pendingPermissions` and nullable `liveApproval`. |
| `agent.prompt` | Send `{name,text,attachments?}` to an ordinary Codex turn and return `{turnId}`. |
| `agent.stop` | Stop `{name,turnId?}` and return `{stopped}`. A cold stop records interruption. |
| `perm.list` | Return redacted `{pending}` cards, optionally filtered by `{name}`. |
| `perm.resolve` | Durably resolve an offered decision and return `{resolved:true,id,decision,scope?}`. Scope appears for allow. |

`liveApproval` is the frozen Driver snapshot for diagnostics, including cancelling
jobs. Dispatch authority comes from fresh host policy, consent, route and folder
checks. The host retains ownership of preparation, journal writes and cleanup
when the RPC caller disconnects.

`agent.start` accepts explicit kind/name/cwd/scope/title/model/effort/serviceTier/
approval/confirm/consentRev/grant settings. `mode` saves `turn` or `warm` metadata.
`browser` accepts `false` or `null` for disabled browsing. The metadata helper
generates an omitted name and creates a private workspace for general scope. Full access follows the
existing confirmation/consent policy. Shell clients cannot request `cli-once`.
Inherited defaults, active browsers, worktrees, request IDs, drafts and start prompts
require later stages. Unsupported feature parameters fail before creation.

Ordinary prompting currently requires Codex. Queue, interrupt and steer requests
with `true` require later stages and fail before a user journal receipt. Explicit
`false` flags preserve ordinary prompting. Full Claude/ZCode,
background/subagent, attention, context, phase and detailed access projections are
still in progress. Persistent permission-rule management also requires later work.
The permission bridge accepts offered once/session/rule scope and structured
answer objects, rejects any `updatedInput` key before contacting the broker, and
derives the actor from the authenticated hello connection. Email remains visible
while token, secret-field and URL credential filters protect public cards/events.

## CLI

The Rust CLI adds these commands. JSON arguments are passed directly to the
backend after structural parsing. `--params` and `--answers` require JSON objects,
and `--attachments` requires a JSON array.

```text
pultd-rust --home /private/pult-scratch agent start --params JSON
pultd-rust --home /private/pult-scratch agent list
pultd-rust --home /private/pult-scratch agent prompt NAME TEXT [--attachments JSON]
pultd-rust --home /private/pult-scratch agent stop NAME [--turn-id ID]
pultd-rust --home /private/pult-scratch perm list [--name NAME]
pultd-rust --home /private/pult-scratch perm resolve ID allow|deny [--scope once|session|rule] [--answers JSON] [--message TEXT]
```

Prompt text and JSON may contain sensitive user input. These commands use the
existing RPC transport and runtime secret filtering.

## Verification

Catalog tests exercise partial schemas, unknown states, source drift and separate
foundation/partial generated aliases. CLI parser tests validate the new commands
and reject malformed JSON object arguments. The baseline interoperability test
checks owner hello/status partial advertisements and a malformed start name, then
uses the still-unported `agent.retry` to verify the unsupported-method response.
Its checks avoid provider execution. Fake-provider controller tests cover the
actual execution boundary separately.

The controller admits a prompt/stop synchronously in socket-frame order before
spawning its owned task. A stop revokes an earlier admitted prompt even if neither
task has been polled yet. A global limit of 128 owned controllers remains held
through completion, including when clients disconnect; per-socket pending replies
are limited to 16. Blocking IO and whole subscription replay tasks remain tracked
until daemon shutdown can safely release its owner lock.

The actual built TypeScript client and Rust daemon pass seven fake-provider cases:
cold metadata/list without model or receipt; rejected advanced forms without side
effects; an ordinary Codex turn with a durable thread record and working status
before native dispatch; durable permission resolution with input-rewrite rejection;
stale versus current turn-ID stop; read-only memory credential isolation; and
same-socket stop during a deliberately blocked network probe without model dispatch
or user receipt. The fixtures use an isolated private account and local programs,
not installed providers or real network requests. A pending permission remains
`blocked_permission`, rather than being overwritten by a late working status.

The full local all-targets run passed 579 tests across 40 binaries; the explicitly
opt-in installed-Codex smoke test remains ignored in the default run. A separate
installed-binary initialize/shutdown smoke also passed with an isolated HOME; it
performed no model turn or authentication operation. Clippy all-targets with warnings
as errors and the repository's 13-rule leak guard also pass. These checks establish
this experimental slice; they do not prove real-account compatibility, production
cutover, queue/steering parity, or the completed Rust migration.

## Blocking IO and uncertain storage

Fresh policy/registry/filesystem checks run in owned blocking steps. The final
check and dispatch seal (or native enqueue) share one step; moving IO off Tokio
must not add an authorization gap. Stop revokes dispatch and requests process
shutdown before waiting for outstanding host IO. Cleanup retains the turn/daemon
owner until those checks finish, including an aborted approval waiter.

An uncertain Registry commit latches global execution failure, even when a later
mutation would be a no-op. Foundation metadata mutations propagate the same
fault. Scoped agent memory reads and credential issuance deny poisoned or failed
execution contexts; reads revalidate their session and lease after database IO.
Unscoped owner repair reads and credential revocation remain available.

The daemon explicitly unlocks its private owner guard only after metadata cleanup.
A duplicated open-file description must not extend ownership after that cleanup;
a separate regression covers replacement ownership while the duplicate remains
open.
