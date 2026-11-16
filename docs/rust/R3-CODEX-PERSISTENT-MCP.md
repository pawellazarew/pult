# Codex persistent memory MCP

The Rust Codex runtime keeps one shared app-server pool for memory-on and memory-off
sessions. Each cold native thread receives its own persistent `pult_memory` MCP
registration. Ordinary terminal/interrupt completion closes the exact Ticket's
memory authority and drains admitted IO before releasing the Driver slot; the
provider, native thread and MCP helper remain available for the next Ticket.

## Registration and authority

A random host epoch, the trusted SessionKey incarnation and a fresh `cm_…`
registration credential bind the helper to one thread. Bootstrap permits the
static tool inventory. Thread binding follows the validated start/resume reply and
the exact ThreadStore receipt. Cold legacy resume must preserve the existing SID;
a missing rollout fails explicitly instead of starting a replacement conversation.

A fresh memory-on Ticket receives a Backend handle without a per-turn MCP secret.
The daemon admits a call only after all these facts match:

- the registration's native thread and its exact active Ticket;
- native turn/start ACK and trusted turn/started;
- an unconsumed native item/started ledger entry for that server, tool and call ID;
- the exact native argument object, including ordinary nested argument metadata;
- actual Driver Accepted with its durable user event and public turn ID;
- the current memory policy, scope, registry incarnation and Driver authority.

The helper's `_meta.threadId`, `_meta.callId`, and object
`_meta["x-codex-turn-metadata"].{thread_id,turn_id}` select a candidate for those
checks. They cannot create a Ticket, choose an owner handle or replace a native
ledger entry. A direct public MCP call with forged metadata has no authority.
Changed arguments fail without consuming the legitimate entry. Replays consume
at most once; closed native turn IDs cannot bind a later Ticket, even after the
previous Turn allocation is released.

Pending calls can wait for reordered native frames/ACK/Accepted for at most ten
seconds. Caller Drop cancels a pending waiter before IO. After synchronous ledger
consumption and Backend admission, the daemon owns the IO through its known
outcome and Broker cleanup, including when the helper exits or its caller drops.
Bridge waiters and the short ledger admission section observe only captured
Control liveness and cheap daemon flags. They acquire no Registry, Driver or
filesystem lock. Ledger consumption/capacity admission grants no memory operation;
full current record/policy/Driver verification remains inside owned read/propose
work before Store/Broker access, with the existing post-read recheck.
An invalid/overflowed trusted native ledger closes admission before returning the
failure. An untrusted helper argument mismatch denies only that request.

## Inventory, policy and failure behavior

All five memory definitions are installed for cold off and read-only threads too.
This enables off → on → off on the same helper/native thread with older static
inventory profiles. Off calls are denied; read-only proposals are denied before
Backend IO or a Broker question. Every accepted write still requires its separate
human approval, including filesystem Full mode. Tool definitions themselves grant
no read or write authority. Their presence can add prompt cost; no production
cost or latency measurement is claimed here.

Known cancellation before any input dispatch/thread RPC preserves a previously
healthy warm registration captured at that exact Job admission. Its cancelled
Ticket still revokes and drains normally, including while waiting for the two
memory slots. It can explicitly retry on the same provider/thread/helper after
peers release their slots. Initial bootstrap, actual readiness failure and
uncertain dispatch keep conservative registration closure/quarantine.

Failure of the registration during preparation closes that registration. The helper observes closure
through its bootstrap socket and exits while the shared provider and other
threads remain alive. That failed thread reports `memory_unavailable` until a cold
pool attach can install a fresh registration. There is no automatic replay,
new-SID fallback or warm-thread override assumption.

The CM helper duplicates its stdio file descriptors without changing FD flags.
After heartbeat closure it exits explicitly, avoiding Tokio's uncancellable pipe
worker shutdown wait. Memory database/journal IO remains owned by the daemon.
Legacy Claude/ZCode `mt_…` helpers retain their transport. The daemon rejects mixed
hello roles. CLI purpose guards reject presence of `PULT_CODEX_MEMORY_KEY`, including
empty and mixed values, before owner filesystem/socket access. Memory/ask helpers
also reject mixed purpose environments. Versions remain local observations.

## Bounds

| Resource | Limit |
| --- | --- |
| Registrations | 32 per host, 256 daemon-wide; no live eviction |
| Memory-on Tickets | 2 across Codex hosts, retained through owned drain |
| Backend turns / concurrent calls | existing 4 / 16 per turn |
| Pending bridge calls | 16 daemon-wide, 512 KiB total queued envelopes |
| One envelope / native argument object | 64 KiB |
| One identity / tool name | 512 / 128 bytes |
| Native call ledger | 256 calls per Ticket, 256 KiB aggregate identity+argument bytes |
| Non-evicting native turn IDs | 1024 per registration, at most 512 KiB identity bytes |
| Global native ID retention | 8192 entries, 8 MiB byte permits |

A native-ID capacity/conflict closes the registration; subsequent prompts require
cold attachment. This matches the existing 1024 completed native turns host budget.
No bounded ledger eviction revives an old turn. Slot wait cancellation precedes
Backend preparation; admitted work retains its slot until actual IO drain.

## Source profiles and validation boundary

Pinned Codex source profiles are C163 `4ebc485ca321243727539187169425fcf972f2c4` and
C167 `d2c035639366e0bf2c316aa2065c24aabc12bcdc`. Both native started items carry the
invocation argument value alongside server/tool/call ID before MCP transmission:
[C163 item creation](https://github.com/openai/codex/blob/4ebc485ca321243727539187169425fcf972f2c4/codex-rs/core/src/mcp_tool_call.rs#L990),
[C167 item creation](https://github.com/openai/codex/blob/d2c035639366e0bf2c316aa2065c24aabc12bcdc/codex-rs/core/src/mcp_tool_call.rs#L1062).
Missing/null/non-object arguments, missing native metadata, and any rewrite that
breaks exact argument equality fail closed in this profile.

Controlled verification uses the actual Rust daemon, MCP executable, holder,
Driver, Backend, Broker, SQLite store, Node client and local app-server peers.
It covers warm reuse, off/on policy, exact source provenance, approval, scope,
late/replayed/forged calls, dropped callers, native ID reuse, helper pipe shutdown,
CLI owner-credential isolation, queue continuation and cold legacy same-SID resume.
Installed CLI profile qualification, provider background work and the full Rust UI
remain separate migration work. Controlled peers do not establish account/model
compatibility or production performance.
