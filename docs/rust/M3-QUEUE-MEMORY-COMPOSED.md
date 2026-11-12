# Queue + ordinary Codex memory composition

This branch composes the queue/steer checkpoint `58abfc658406c1be029bc2263dbc6c3b373a57bf`
and memory checkpoint `8597e4e9b8ef065556e5767b0e0711bdcf0f1567` on runtime
`bf6413e6ef6044dc4628bb96190ec1cbe2ca85b8`. Both share `d42a737` ancestry;
ordinary merges retain their full implementations. No provider/account is used.

The composed catalog has 99 entries, 85 implemented Node methods, 28 fully
implemented Rust methods and 10 partial Rust methods. The metadata configuration
method does not imply completed memory delivery for every provider.

## Retained integration boundaries

- Driver keeps deferred queue receipts, exact-ticket progress observation,
  one-shot memory commit admission/deadline, and the owned typed `before_release`
  hook. Failure/interrupt pause is durable before the Ticket becomes reusable.
- Runtime steering upgrades the exact `Lease.host` Weak pointer. A dedicated
  memory host must not be replaced with a same-route shared pool neighbor.
- Binding/catalog/read may precede accepted input. Memory proposals wait for the
  real Running/Accepted user receipt. A queued turn's provenance is its actual
  accepted queue event, not the preceding ordinary turn. Steering honestly keeps
  the active base turn's source receipt; it does not claim the steering event.
- State includes the queue controller, memory backend and execution admission gate.
  Queue journal/registry IO and memory IO remain owned until their cleanup proof.
- CLI help/flags, protocol schemas and generated aliases retain queue and memory
  additions together. Node rollback retains queueDispatch and opaque memory/privacy.

## Restart bugs found by composition

Rust's registry normalization originally reconstructed a whitelist without the
new `memory`, `private` and `temporary` fields. A real Node rollback preserved the
policy, but the next Rust restart dropped it and delivered the queued turn with
memory disabled. The new parser keeps all three present values, including null,
malformed/future policy values and legacy lone UTF-16. Absence remains absence. This is
preservation, not interpretation or a grant; invalid policy stays unavailable and
private/temporary markers stay memory-off.

Simply copying RawValue was insufficient: Node writes pretty JSON. Literal line
breaks inside a copied object escaped into an NDJSON RPC frame, so the Node SDK
ignored the split `agent.list` response. The shared `history::compact_raw` removes
only whitespace outside strings. It preserves UTF-16 escapes, number lexemes,
object order/duplicates and opaque future shape, using an iterative byte scan.
It deliberately differs from semantic `history::normalize`.

Existing queueDispatch is already rebuilt from validated string id/at fields;
queue items/attachments and worktree/context/applied/browser are reconstructed
from validated scalars. They do not retain pretty object whitespace. Future
opaque fields, including the separate Claude reserved-session marker, must use
`compact_raw` on raw preservation. No broad stream rewrite was made.

## Real composed acceptance

`queue_memory_compatibility.rs` runs the built Node client against the real Rust
daemon, a local fake Codex app-server and the actual Rust memory MCP executable.
Nine cases establish:

1. A shared ordinary neighbor and a separate real memory MCP host.
2. Queued read/write with human approval, exact accepted queue receipt/provenance,
   attachments/id/at/title/policy preservation, then a fresh next-turn catalog.
3. Steering into the exact dedicated host while the shared neighbor stays alive;
   the memory revision keeps the active base turn's honest source event.
4. Failed queued memory work durably pauses the remaining FIFO before release;
   explicit Resume reads the current committed version.
5. Interrupt replacement uses a new MCP generation while the old backlog stays
   paused and unchanged, then explicit Resume preserves its attachment receipt.
6. Lost native acknowledgement retains the unknown marker/item, creates no fake
   user receipt or write permission, and never automatically resends.
7. Node canonical rewrite and Rust restart preserve both memory and unknown queue
   metadata; stale capabilities fail and Resume still refuses unknown delivery.
8. An explicit edit makes retry intentional; its new accepted receipt can approve
   a memory revision, which the following fresh turn observes.
9. All dedicated/MCP children retire and ephemeral keys stay out of public data.

The fixture's lost-ACK process exits without an acknowledgement. This is not an
assertion that real unknown delivery never ran; the persisted warning and explicit
retry contract remain necessary. Steering and test-completion hooks exist only in
the local fake provider, not in daemon production branches.

The Registry interoperability oracle now has 21 cases. Its added case compares
actual Node preservation, Rust canonical mutations, Node rewrites and Rust reopen,
including future/lone-surrogate policy/privacy and explicit valid owner repair.
Library regressions prove policy-field retention and single-frame pretty raw JSON;
shared-helper coverage includes preserved numeric literals/duplicates and depth5000.
The original 13 memory cases and 18 queue/session cases run unchanged in composition.

This closes the tested ordinary queue+memory delivery gap. Claude/ZCode memory,
full private execution, UI controls, hot configuration reload, purge and complete
M3/Rust migration remain separate. PR122/main must be incorporated before publication.
