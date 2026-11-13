# Claude: optional shared-memory MCP factory

This slice supplies only the host-owned factory. Worker data-block delivery and
State wiring, plus fake-Claude save to next-Codex read acceptance, are separate
required integration. No real account, provider or network is used here.

`Factory::new` keeps its existing ask-only constructor and host extras behavior.
Crate-private `new_with_memory` adds the daemon's existing `memory_turn::Backend`,
reserving `pult-memory` independently from the `pult` ask server. The same immutable
private config contains distinct purpose-scoped pa_/mt_ keys. The memory helper is
`pult-memory-mcp`, not Codex CLI; its native server map omits Codex-only tool policy.
Keys never appear in argv, catalog or public errors. Existing global filters apply.

Policy off/private means no memory control/server/catalog; an unavailable memory
DB does not break that ordinary path. Enabled policy errors are explicit, with no
silent downgrade or retry. `prepare_current` selects the trusted snapshot only
through exact Ticket, checks Claude provider and narrowing effective approval,
and retains the captured actual public Pult turn. Existing Backend read catalog,
lease validation, receipt wait, common Broker approval and mutation seal are reused.
Filesystem Full does not approve memory writes. ReadOnly never gets write tools. The immutable captured writable bit is also
checked by backend write authorization: direct scoped RPC cannot bypass it or
widen an already issued read-only capability after policy changes. Inherit uses
the existing Claude Owner approval order; equal and narrowed modes are supported.

Preparation is an owned entry before any asynchronous work. Cancellation revokes
both scopes synchronously; a pending memory begin may finish after the first revoke,
but entry cancellation prevents path publication. Cleanup waits for preparation to
finish, revokes/drains both exact scopes, then removes only its FD-bound private
config. Unknown IO/file cleanup remains unconfirmed and keeps Worker ownership.
No global Broker drain or neighboring-session cancellation is introduced.

ScopedMcp catalog/check hooks use exact Ticket plus generation. Catalog is bounded
shared-memory data and must enter a separate native content block, never user
journal text or system/runtime instructions. The Worker skips extra catalog for
single-block slash commands, preserving native slash interpretation, while still
checking authority. The factory does not choose that input policy itself.

Focused tests use real State/Driver/Registry/MemoryStore and controlled fixture
Worker: two-purpose keys, bounded catalog, disabled DB path, write-off, policy
revocation, reserved namespace compatibility, blocked file cancellation and late
memory issuance drain. These tests are not fake-provider end-to-end acceptance.

## Focused verification

22 Factory tests and 17 existing memory-turn tests pass. Removing only the new
captured-writable backend guard reproduced an actual durable permission request
from captured ReadOnly under Driver/record Full; the restored source denies it
before any permission card. Owned formatting and leakguard are clean. Standalone
all-target clippy stops solely at unused crate-private `new_with_memory`: State
wiring is in the separate integration worktree, so that final clippy remains
required there. No warning suppression or synthetic production caller is added.
