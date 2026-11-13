# Strict raw NDJSON subprocess transport

This opt-in transport preserves native wire bytes for a protocol-owned decoder.
It does not connect a ZCode Worker, change provider selection, grant dispatch
permission, or complete Route B / shared-memory acceptance.

The existing `Process`, holder, startup acknowledgement, PID ownership, stop signal,
stdin write guard and reader joins are reused. The JSON strict, Codex and Claude
profiles keep their original behavior. The holder acknowledgement is still parsed
privately before a provider-output collector starts.

## Selecting the raw profile

`Framing::raw_ndjson(max_wire_bytes, max_input_bytes)` validates separate nonzero
limits, each at most 16 MiB. Both include the terminating LF or CRLF. A raw output
channel holds one frame; the collector can additionally retain one pending frame
and its bounded reader buffer. A byte limit is a serialized frame bound, not a
promise that the whole decoder/worker uses that exact amount of memory.

`Process::recv_raw()` and `take_raw_output()` return `RawFrame`. Its only payload
access is `as_bytes()`; it has no Debug, serde or Clone implementation. Bytes,
including LF/CRLF, duplicate keys, malformed JSON and invalid UTF-8, reach the native
codec unchanged. The raw collector validates bounded complete lines, not JSON
semantics. The codec must validate the actual bytes before taking any action.
Parsing into `serde_json::Value` and then re-encoding would erase duplicate keys
before that validation and is not supported by this path.

Oversize, unterminated final frame and read failure are terminal static transport
errors. Raw transport never discards an invalid frame and resumes at a valid tail.
It does not infer acceptance, native identity or protocol success from EOF.

JSON accessors reject a raw Process, and raw accessors reject a JSON Process,
before consuming or transferring its receiver. Receiver transfer remains single
use. Receiving directly after a successful transfer fails. If output is transferred,
its owner must deliberately drain or drop it during shutdown: closing the Process's
internal empty receiver does not close the external one.

## Preparing input before a seal

`Framing::prepare_raw(Vec<u8>)` performs pure bounded preparation: exact one LF or
CRLF frame, UTF-8, no embedded line break, and complete JSON syntax checked through
borrowed `RawValue`. It never converts to Value or re-encodes. This is syntax only;
native schema, duplicate-key policy and request correlation belong to the codec.

`PreparedInput` retains a private raw/JSON profile tag. `send_prepared` rejects a
wrong profile or a frame exceeding the actual Process input limit before touching
stdin. A failed preparation/profile check does not poison the next valid input.
`send(Value)` and `Framing::encode(Value)` are unavailable for a raw profile.
Existing JSON prepared-input compatibility remains unchanged.

Prepare bytes before acquiring host admission or sealing input. Constructing the
async `send_prepared` future does not send; its first poll can write. A future
Route B supervisor must perform its fresh checks and exact InputAction seal before
that first poll, retain Process ownership through panic/cancel, and never replay
an unknown delivery. The existing WriteGuard closes stdin if a polled write is
interrupted; a second frame cannot be sent afterward. Transport preparation itself
is not a dispatch capability and does not establish a native request ID or receipt.

## EOF, joins and cleanup are separate facts

`output_finished_cleanly()` requires the acknowledged collector's normal EOF with
a live receiver, successful reader join, and a completed `Process::stop` outcome.
Reader panic, abort, read error, truncated frame, oversize or a receiver already
closed before EOF cannot manufacture that result. A raw normal EOF still says
nothing about JSON/protocol validity or whether the consumer processed every frame.

`stop()` can successfully confirm the holder outcome while reporting no clean
stdout completion: a reader blocked on a transferred full receiver is aborted and
joined. EOF observed before a reader panic/abort also lacks a successful normal
join. Neither stop success nor a native session/close acknowledgement is an input
acceptance or a natural-EOF recovery proof. Future Worker code must additionally
join its decoder, writer, memory, permission, Store and Sink work before releasing
its owned slot; this transport does not perform those drains.

## Verification scope

Tests use the actual Rust holder and controlled Python byte fixtures with temporary
HOME values. They never start a provider, access an account or mutate provider
configuration. `raw_worker_process` covers exact duplicate/malformed/non-UTF8 bytes,
fragmented CRLF/LF, an exact 16 MiB frame, fatal oversize/truncation without resync,
wrong-profile access and single transfer, pure preparation, input budget/profile
checks, natural EOF plus actual joins, cancellation and a wrapper panic after the
first blocked write poll, retained Process ownership, poisoned stdin and descendant
cleanup. A saturated transferred-receiver case waits for an explicit child-written
barrier and full channel before stop; an immediate stop alone could legitimately
observe an empty normal EOF.

Unit tests separately inject raw read error, reader panic/abort after EOF and a
dropped receiver. Existing `worker_process` JSON integration tests remain required.
The writer-panic fixture exercises a controlled wrapper panic after a real pending
write poll, not a claimed native writer failure or a complete Route B vault.
Actual ZCode codec/Worker/Owner integration and installed CLI qualification remain
open.

Local scoped verification on macOS / Rust 1.99.1 used a dedicated worktree target:
12 raw integration tests, 20 existing JSON/process integration tests and 13 process
unit tests passed with default test concurrency. All-target clippy with `-D warnings`,
fmt and diff checks passed. No full migration-suite or CI result is claimed here.
A temporary lossy Value/re-encode mutation made the actual duplicate-byte fixture
fail (exit 101); restoring the original source made the raw suite pass again.
Persistent logs: `.agents/workspaces/pult-migration/raw-transport-*` in the parent
Me workspace. The initial saturated-receiver test was corrected to establish real
backpressure with barriers; the initial clippy `err_expect` finding was fixed
without adding an allow. Neither production timeouts nor assertions were relaxed.
