# Prepared process launch and private stderr

This is a trusted-host IO seam for the future ZCode Route A worker. It does not
add a provider worker, RPC method, credentials discovery, MCP support, or runtime
routing. Existing Claude/Codex callers continue to use `spawn_owned` and count-only
stderr; stdout framing, stdin limits, holder acknowledgement, and cleanup remain
unchanged.

## Launch frontier

`Process::prepare_launch(launch, framing, stderr_policy).await` validates the
launch through the existing owned blocking-validation path and constructs an
opaque `PreparedLaunch`. No process has been spawned. Dropping the prepared value
is safe. Dropping a preparation waiter does not cancel its blocking filesystem
work, and is not a completion receipt: the supervisor must retain its owned job
and await preparation through cancellation, as existing process supervisors do.

`Process::spawn_prepared_owned(prepared, gate).await` calls a synchronous frontier:

1. `SpawnGate::enter` checks fresh host authority and returns a `SpawnPermit`.
2. The permit remains alive through the actual `Command::spawn`.
3. A `Process` owns the Child/PID before the permit is released.
4. Only then does startup await the holder's acknowledgement.

There is no await/poll boundary in steps 1–3. The host must implement the seal with
an exact Ticket/incarnation check and serialized cancellation/fault publication
(for example its short admission mutex or an equivalent synchronous CAS
protocol). An existing provider check callback is **not** automatically a
`SpawnGate`. Cancellation before the seal must deny spawn. Cancellation after
the seal may create a PID; the owned supervisor must stop it, join readers and
retain ownership until cleanup is known. A Driver cancellation which does not
participate in this protocol cannot promise that no PID will be created.

Gate enter panics become static pre-spawn denial. Permit release panics become a
`SpawnFailure` containing the already owned Process. Host callback payloads are
never formatted into diagnostics. Embedders must install `panic_guard::install`
at startup because Rust's default panic hook runs even for caught panics. Permit
Drop must be short and perform no blocking IO or external callbacks. The host
must keep the startup future owned through acknowledgement/cancellation; dropping
it sends TERM via the existing Process guard but does not prove cleanup.

The seal is not executable-path identity pinning: filesystem metadata validation
has the existing path/exec race boundary. No sandbox or OS argv privacy guarantee
is added. Prepared argv/env and private stderr have no raw Debug representation.

## Optional stderr evidence

`StderrPolicy::CountOnly` is the default. `PrivateTail { max_bytes }` accepts only
1–65,536 bytes, validated before spawning. The collector drains stderr into a
fixed-size read buffer and a bounded ring; it never clones an entire unbounded
stream or builds an unbounded line. Total stderr bytes are still counted.

`Process::take_private_stderr` returns a one-shot `PrivateStderr` only after
successful `stop`, confirmed stderr EOF and successful reader join. Before
cleanup, on read failure, reader panic/abort/timeout, or unconfirmed holder
cleanup, it returns `Incomplete`. Count-only returns `Disabled`; a second take
returns `Taken`. The trusted host may inspect raw bytes for classification, but
must not put this evidence in public errors, events or logs. Receipt Debug shows
only its byte count. EOF decoding and classification remain provider work.

## Verification

Real `pult-worker-holder` plus local Python/shell fixtures test cancellation/fault
before seal, gate panic, release panic with retained PID, cancellation after seal,
ACK failure retaining uncertain cleanup, bounded exact tail independent of stdout,
invalid budgets and default count-only behavior. Unit tests cover bounded ring
allocation, read errors and aborted readers without fabricated EOF evidence.
No provider/account/network calls are used.


## Retain the startup owner before awaiting ACK

`Process::begin_spawn(prepared, gate)` returns an opaque `StartingProcess`
synchronously after the actual spawn frontier. It exposes a diagnostic PID and
best-effort `stop_signal`; neither is cleanup or native-input acceptance proof.
A supervisor places this value in its retained vault before its first await,
copies the signal for cancellation, and borrows `acknowledge(&mut self)` from
that vault in its isolated task. If the task unexpectedly panics, the outer
owner can recover the value and call `into_process().stop()` rather than lose
the PID in a dropped startup future.

The ACK future borrows its stdout reader from Process. A pending/unwinding
future must not move/drop that FD: the holder may still need to write its ACK.
The pending reader stays with the Process through holder wait during cleanup.
A polled ACK cannot be retried after cancellation/panic; partial line state is
not acceptance. An unacknowledged Process rejects stdin. Successful ACK still
means only holder readiness, not a provider's `turn.started` or a user receipt.
The old `spawn_prepared_owned` wrapper delegates to the split with its previous
caller-owned cancellation contract.

Real-holder tests panic an isolated startup task before its first ACK poll and
after two controlled Pending polls. The vault still owns the holder, its stdout
FD survives the unwind, and the real holder subsequently starts a synthetic
provider/descendant. Owned stop proves their exit and joins stderr. This does
not claim the ACK implementation spontaneously panics. A runtime counterfactual
moving the reader into the future makes the latter regression fail; the exact
positive source is restored before verification. No model/account calls occur.
