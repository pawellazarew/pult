# Driver spawn seal

`turn_driver::SpawnAction` is trusted-host, exact-Ticket admission for a single
Route A OS spawn. Construct it with the actual Driver Ticket and an absolute
monotonic deadline; share the same action through the host's opaque attempt.
It contains no native identity, callback, IO or process and has no Debug/Serialize.

`Driver::seal_spawn(ticket, expectedSnapshot, action)` performs bounded checks
and the Ready(0)→Sealed(1) CAS while holding the same Driver state mutex used by
cancel, storage failure and shutdown. It requires the exact ticket/generation,
unchanged full snapshot, Dispatching phase, no cancel/fault/close, an unexpired
uncancelled action and no prior successful spawn seal for that Ticket. The
per-Control flag prevents a fresh action bypassing the one-spawn limit.
Starting and Running are not spawn frontiers. Rejection does not consume an
otherwise unused Ticket seal or independently cancel an action.

The mutex is released before returning: **no filesystem work, injected callback,
OS spawn or wait occurs under it**. The host must first finish policy/filesystem
checks, then call this method from Process's synchronous SpawnGate frontier.
Process retains the host admission permit through the actual Command.spawn.
This composes the Driver atomic decision with the already prepared OS launch;
it does not treat an earlier check followed by an async spawn as a seal.

`action.cancel()` competes for Ready(0)→NeverSent(2). A successful seal is
irreversible. Driver cancellation before the seal prevents the grant; after
the seal, a new PID is allowed and remains fully owned until stopped/joined.
Sealed does not claim successful native execution. NeverSent proves no successful
Driver seal, and is insufficient on its own to clear durable markers, release
owned IO or report process cleanup. The host must also join all preparation,
process/readers and storage work before using its separate cleanup proof.

This is an additive prerequisite, without Worker/Owner/Process/State integration
or a new public RPC. Existing memory action semantics are unchanged. Tests use
real Driver state with controlled in-memory worker/close barriers: Starting vs
Dispatching/Running, deadline/cancel/fault/shutdown, wrong generation/incarnation/
snapshot, one-spawn-per-Ticket, after-seal cancellation retaining cleanup and
concurrent cancel/seal linearization. They prove admission/ownership behavior,
not OS process-tree cleanup; existing Process frontier tests cover that layer.
