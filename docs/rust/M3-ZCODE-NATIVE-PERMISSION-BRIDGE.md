# M3: scoped native ZCode permission bridge

This slice composes the actual Rust State/Driver/Owner, shared Broker, private
memory Backend, owned worker holder and controlled repository protocol peer.
It does not qualify the installed ZCode CLI, native Plan policy, arbitrary tools,
full provider parity or shipping activation of that broader behavior.

Baseline: `d34b1ea3b111d94e84d16da9a6ffdba972134bc4`. Native wire shapes follow
the existing pinned codec (official ZCode source
`c5904686ea8341826b3affe5d993d06a134fa779`). No native config/account/HOME override,
provider/model request, tool-name auto-allow or native permission rule is added.

## Authority and ordering

* A private accepted source binds the actual Owner attempt/acceptance Arcs,
  Ticket/incarnation/generation, host input/query IDs, native SID/TID and actual
  Driver Running/user receipt. Its Runtime witness pins the exact current Source
  Arc/nonce through a Weak Shared reference. Public Accepted fields alone cannot
  mint this source. Native Started and native answers are not tool consent.
* Before matching native Started, permissions are denied immediately. A missing
  or foreign TID, subagent origin, conservative-only payload or unsupported
  offered option is denied. Only the post-native-Started/pre-Driver-Running gap
  can defer. The consumed initial-input frontier/seal/start deadline is not
  revived as post-accept authorization.
* One shared State Broker owns the actual human card. Only an actual Once decision
  and exact RequestHandle cancel+drained proof permit a private approval receipt.
  Normal Broker selection normalizes absent edits to `Some(original input)`;
  the bridge accepts only absent or semantically identical deterministic original
  display input. Changed input is denied. Decision and comparison Values drop
  before the drain await. This is not native modified-input support.
* Final handoff freshly holds Consent → Registry → exact Runtime source → State
  execution admission → Memory control → context lease → pending call → Driver
  one-use action. It checks current policy/private/context, source/route and
  cancel/fault/expiry before bounded writer `try_send`. The seal linearizes an
  **enqueue only**. It does not prove pipe write, native execution or rollback.
* The only approved wire result is the original RPC ID plus
  `{"decision":"allow"}`. No modifiedInput, permissionUpdates or persistent rule
  is emitted. Default DenyInteractions still emits the prior conservative bytes.

## Clock and owned lifetime

The first trusted **host observation** of actual Driver Running is stamped once,
before potentially blocking Runtime binding. This is not advertised as the exact
Driver publication instant. A clock-only watch reaches the outer source waiter
before the binder returns; publication of the final source cannot reset expiry.

At admission a short watch borrow captures whether Running was already observed
and the admission Instant. Causality is not inferred from timestamp inequality:
equal stamps still preserve a pre-observed phase's original cutoff. An observation
at or after that cutoff cannot revive the request. Already-observed mid-turn calls
use their own admission. Human expiry is max(admission, first observation) plus
the bounded permission timeout, independent of the process start deadline after
acceptance. The daemon slice currently supplies600s; a shorter actual Broker
timeout/cancellation still denies and must drain its IO.

Reverse tasks are registered before spawn/start. A cancelled/dropped waiter never
detaches its issued Broker/journal work. Known normal question completion follows
the exact actual handle drain. A panic after issuance retains a strong pending
keeper and its slots, marks cleanup Unknown and quarantines the exact Driver
Ticket. Releasing the journal IO alone cannot invent the lost callback drain
proof. Revoke/drain target only the exact session Ticket/generation; wrong-gen
cleanup cannot close neighboring questions.

Persistent service/adapter/receipt/source objects retain Weak State/Shared;
the ephemeral strong Runtime gate exists only inside an owned blocking operation.
Blocking tasks, process/descendants, reverse callbacks and resource drains stay
owned through cancellation and cleanup joins.

## Bounds and copy accounting

Earlier proposed768KiB/call and24MiB aggregate estimates were incorrect and are
withdrawn. These are logical serialized limits, never RSS/allocator/process totals.

* The codec counts original raw params, retained metadata and correlation IDs
  before its single raw backing allocation:256KiB/candidate
  (`zcode_appserver_protocol::permission_payload`). Strict duplicate/depth/node
  validation still precedes retention; no partial input or JSON re-encoding.
* Worker admission acquires shared32 and per-worker8 permits before source
  deferral. The same immutable raw request Arc is passed throughout. Thus
  **admitted native raw plus counted metadata <=8MiB globally**. The codec and
  inbound/queued transport frames exist before admission and are separate limits.
* The display envelope is checked against256KiB and4096 logical nodes before
  Broker retains it. The whole redacted public card and owner Decision value have
  separate existing Broker256KiB checks. One call can have several such copies.

| Phase | Simultaneously possible copies and actual checks |
| --- | --- |
| Display build | Raw; decoded input/options; display envelope, node traversal and temporary serialization. Final display256KiB/4096nodes; parser/serialization temporaries are separate. |
| Requesting | Raw; original Entry.request.input; redacted Entry.card; owned requested journal draft cloned from the card. Original display256KiB; whole card256KiB. |
| Visible | Raw; original request; entry card; Control.public card clone. Public publication follows known requested IO, so that IO is not still awaiting delivery. |
| UI list | Broker public/card clones and authenticated output frames add copies outside the bridge's original pending raw allocation. |
| Resolving | Raw; original request; entry card; normalized Decision; owned resolved journal draft. Public card is hidden. Resolved draft does not contain the original updated input. |
| Decision comparison | Raw; returned normalized updated_input; freshly rebuilt deterministic display; the actor's entry may still exist until removal. Both comparison Values drop synchronously before the next await. |
| Exact drain | Original raw/pending and actual handle/control plus any owned IO. No returned Decision/comparison survives this await. |
| Handoff | Same raw; opaque receipt/pending action; small static allow frame. No modified input/rule copy is emitted. |
| Unknown | Strong QuestionJob pending keeper and any separately owned Actor IO. Slots are retained; no capacity recycling on lost cleanup proof. |

Sources: `permission_broker::request` moves the original and creates the card;
`requested` clones it; `run` publishes another Control.public clone after the
requested receipt; `finish_begin` hides that card and owns resolved IO;
`Broker::resolve` bounds `Decision::value` before enqueue; ordinary `validate`
normalizes absent edits to original input. The local normalization branch itself
does not repeat that cap, but issued owner choices went through resolve's check.
Its clone/serialize temporaries occur before that check; no no-allocation-before-
cap claim is made for generic owner ingress.

EventStore::append does not independently enforce MAX_LINE. HostSink redaction,
owned journal draft/event/serialized line, history/store, transport queues and UI
responses have separate lifetimes and limits; this document invents no journal
cap or combined memory total. The32 admitted calls and their per-value bounds are
finite; Unknown retains admission rather than creating unbounded new calls.

## Qualification and fixture boundaries

The repository fixture uses actual durable State/Registry/SQLite, Driver/Broker,
real `pult-worker-holder`, and the real private `pult-memory-mcp` stdio helper.
The peer only emits controlled pinned protocol frames; it is not a native CLI.
Its helper environment contains only the passed turn key, as in the prior actual
Factory helper fixture. Inheriting the fake peer's HOME=scratch would correctly
make checked_home reject scratch as overlapping HOME/.pult. The harness does not
weaken that production check or fall back to owner credentials.

The global-cap fixture replaces only the fresh idle fixture Driver before any
Backend/Broker/runtime/IO, then wraps the same actual HostSink. It holds delivery
of already committed real queued-user receipts. Queue metadata chooses the
existing host-only deferred delivery path; this is not a UI-question grant.
Four actual workers each retain8 pre-Driver calls, with Starting progress, no
adapter/Broker calls and all32 permits consumed. A fifth actual8-call peer gets
capacity failure. Its receipt is deliberately unheld so rejection can finish.
Shutdown remains Pending while the four real receipts are held; release is
followed by real Finished/slot release/known runtime and listener cleanup.

Focused tests cover actual native Once→Inbox→bare allow→seeded Rust MCP read;
separate Backend proposal consent; changed input and unsupported scopes/profiles;
duplicate IDs/changed same RPC/local9/global32; exact source/nonce/current-worker,
resume/route changes; Ticket/gen/request Arc/action expiry and one-use checks;
policy/private/context/Driver cancellation; exact-generation revoke and neighbor
independence; issued requested/resolved IO plus panic/drop retention; equal-clock
causality and late binder expiry. The private Driver action mechanics do not mint
a Broker receipt or write a native reply, and actual human denial still wins.

No installed-policy/full Plan/provider parity, public task wait API, automatic
retry, global Broker shutdown or arbitrary native tool approval is claimed.
