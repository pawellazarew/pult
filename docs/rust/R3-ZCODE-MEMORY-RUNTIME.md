# ZCode shared-memory Runtime admission

ZCodeRuntime selects its Worker before Driver dispatch from a coherent trusted
Registry record. Effective memory read off selects the existing ordinary Route A;
read on selects a fresh dedicated app-server Route B. A missing shared Backend or
unsupported Route B options fail explicitly. There is no post-Attempt fallback.

The public constructor retains its no-backend API. The daemon-only constructor
accepts the exact State.memory_turns Backend shared by Claude and Codex. Each
Route B Worker receives its own private zcode_memory_resources Factory, keyed to
SessionKey; backend/database identity is shared, scoped keys/leases are not.
State initialization does not start an MCP helper or provider or change accounts.

Selection compares the existing identity/config fields plus memory, private and
temporary before and after Owner snapshot selection. Policy parsing is strict.
ReadOnly/Ask/Full map exactly to Plan/Guarded/Yolo. Workspace maps to Edit in the
existing launch contract and is explicitly unsupported by memory-on V1. It is not
silently substituted with Guarded. Unsupported model/effort/service-tier/browser
options are not ignored. A future qualified extension can add their semantics.

For local execution native workspacePath and workspaceKey both use the trusted
canonical snapshot cwd. Pinned upstream buildWorkspaceRef (workspace.ts:5–14,
c5904686ea8341826b3affe5d993d06a134fa779) uses workspaceIdentity when provided,
otherwise workspacePath. No random key, guessed remote identity or key hashing is
introduced. Existing codec bounds apply before dispatch, including its 256-byte
key bound; an unrepresentable path is explicit Unsupported. Native cold resume
still must confirm the same workspace/SID and never retries with a new SID.

One Entry owns the same reservation nonce, selected route, Source, exact Ticket,
expected native resume identity, captured network stamp/environment and Driver
progress for either Worker. The Route B absolute deadline is captured before the
reservation's RuntimeState lock and owned preparation/network/resource waits.
It passes unchanged to Worker and final input admission. Deadline expiration does
not detach owned IO or reset the timeout. Legacy Route A start_timeout semantics
remain unchanged.

## Guard order

Final Route A spawn acquires Registry before RuntimeState, checks exact current
SessionKey incarnation, unpoisoned Registry and effective read=false, then retains both through all
existing RuntimeSpawn/Owner/Driver checks and actual OS spawn. An off-to-on policy
race rejects the ordinary process; it cannot silently execute without memory.
Route B bootstrap similarly requires current read=true before OS spawn. Bootstrap
still may execute native startup/plugins and is not no-execution evidence.

Route B input admission runs under Owner's existing Consent/Registry frontier.
RuntimeInput acquires and retains RuntimeState, verifies exact Source pointer,
nonce, Worker route, Ticket/Attempt/spawn brand, expected resume identity, Driver
snapshot, network generation, deadline and open/non-quarantined state. It performs
no Registry/FS/DB/network IO or external callback. Worker then obtains the real
Factory resource permit from the frontier's CURRENT Record and performs the
existing Owner input seal and synchronous writer-queue handoff.

Full nested order is Consent -> Registry -> RuntimeState -> State execution gate
-> memory Control -> shared Lease -> Owner Attempts -> Driver. After the short
Owner CAS locks are released, the short observer/writer binding and try_send run
while outer guards remain held. The borrowed Runtime permit cannot outlive its
State guard. No State -> Registry path is added.

Daemon shutdown closes State/Driver under its execution gate, releases that gate,
then closes provider runtimes. Runtime stop releases RuntimeState before Driver
cancel. Storage-fault publication takes execution gate/Driver without acquiring
RuntimeState. These audited paths do not invert the new input nesting. Slow
resource setup/catalogue and Owner/Sink IO remain outside all admission guards.

## Recovery and verification boundary

Only the Ordinary Worker can contribute existing MissingAfterJoin recovery
capabilities. App-server -32004, bootstrap errors, unknown send/ACK and EOF do not
create that proof or select Route A. Existing explicit authenticated owner
recovery, natural EOF/join conditions and durable rollback marker semantics stay
in force. Route B bootstrap/send uncertainty remains truthful; no current-input
auto replay is introduced. Quarantined Driver progress retains Runtime capacity.

New private tests use real Driver/Owner/Registry metadata and deliberately unused
process/resource instances to test guard binding, policy races, nonce, cancellation,
fault, network generation and deadline rejection. They are not a holder/MCP or
native-provider acceptance claim. Actual daemon/holder/shared-backend memory
interop requires the separate integration proof owned by Root and is not claimed
from these gate tests. The exact unknown-write poison injection remains private
to Registry's own tests; Runtime tests independently cover mutex poison rejection.
Native
Broker, additional modes/model settings, and installed account/provider parity
remain explicit qualification gaps beyond the supported V1 behavior.
