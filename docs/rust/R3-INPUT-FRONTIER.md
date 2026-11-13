# First native input after process spawn

This slice adds a generic Driver admission seam for a future dedicated ZCode
app-server Worker. No Owner, Worker, transport, MCP, provider, account or live
Route B integration is added. Existing Route A still uses `SpawnAction` and
`Driver::seal_spawn` at its argv-bearing OS spawn.

`InputAction::new(Arc<SpawnAction>)` is pure construction. It retains the exact
parent action, including its Ticket and original absolute `std::time::Instant`
deadline. It does not reset that deadline, enqueue input, poll a writer, perform
IO or imply native acceptance. Public visibility follows the existing trusted
host `SpawnAction`/integration-test convention; there is no JSON constructor,
Debug, Serialize or Clone implementation.

The host must finish source policy/route/metadata checks and retain its own
admission permit through `Driver::seal_input` and the first possible enqueue or
writer poll. Sealing after native input is queued or written is too late. Driver
does not run callbacks or IO and does not replace the host's admission gate.

Under the Driver state mutex, `seal_input` checks exact Ticket/incarnation,
Dispatching phase and full immutable snapshot, closed/storage-fault/cancellation,
the parent's sealed state and private identity registered by this Control, the
inherited deadline, and the per-Control one-input budget. A separately created
InputAction cannot grant a second input for the same Ticket. The private spawn
identity does not change Route A's existing admission predicates or lifecycle.

Input state is `Ready -> Sealed | Revoked`. Local `InputAction::cancel` wins only
before seal; it does not cancel Driver or consume the Control's input budget.
Driver cancellation/fault/shutdown synchronously prevent later input seals.
After a successful seal, cancellation cannot erase possible input delivery.
`never_enqueued()` means local cancellation won before this action's successful
seal under the trusted writer contract. It does not exclude another action for
the same Ticket. It is not a process/IO cleanup receipt and does not establish
absence of native startup/automation/plugin execution.

A successful input seal does not publish `Started`, `Progress::Running`, native
SID/TID or an accepted user event. A future Route B adapter still needs durable
unknown-input metadata, durable actual SID before send, exact send ACK plus
matching native start evidence, cancellation-safe Store/Sink work, and real
holder/readers/MCP IO joins. Unknown send errors cannot be automatically retried
or fall back to Route A. No cleanup or marker-clearing capability is minted here.

`rust/tests/driver_input_seal.rs` uses a real Driver with controlled in-memory
Worker start/close barriers. It covers starting/pre-spawn denial, full snapshot
and Ticket binding, local versus direct Driver cancellation, inherited expiry,
distinct concurrent actions, cancel/seal races, fault/shutdown, running/retired
Tickets, and irreversible post-seal uncertainty while close remains blocked.
Existing `driver_spawn_seal` tests separately retain the Route A regression
contract. These tests do not claim real OS process, native ACK or Route B proof.
