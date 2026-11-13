# Native ZCode cleanup uncertainty must wake both Driver waiters

## Proven counterexample; CI cause remains unknown

The controlled actual-holder test makes an owned wrapper return125 only after
the real Rust holder has exited0 and its native peer has finished. The wrapper's
subsequent exit closes its final inherited stdio FDs. It checks its original parent
and explicitly
rebinds the real holder's internal owner argv1 to the wrapper PID; provider argv
and inherited stdin/stdout/stderr data remain unchanged. Its signal handlers set
flags only. Its single owner loop signals only its unreaped Popen holder and
always waits/joins; it never directly signals a provider PID/group or detaches.
This is a synthetic unknown outer acknowledgement, not installed native CLI
qualification or evidence of the earlier macOS CI root cause.

Before this fix, a native turn received the real joint ACK/NativeStarted evidence
and Driver receipt, but ordinary handle.wait stayed Running for the30s watchdog.
The supervisor had published Closed::Unconfirmed after real Process.stop rejected
outer125, then awaited an explicit retry. Driver was still waiting for the
supervisor's completion oneshot, sent only after cleanup. An external cancel
would enter Driver close/quarantine, demonstrating the circular wait. Two exact
baseline runs failed the no-external-cancel invariant in31.09/31.37 seconds.

A second controlled case rejects resume before NativeStarted and sends no model
input. The real holder again joins successfully before outer125. Before this fix,
the Worker.start result receiver remained pending/Starting for an observation
watchdog5s AFTER the actual holder proof. No launch or Driver deadline was changed;
the shorter observation excludes the separate default30s Driver timeout from
masking the locked start receiver. That baseline also failed on the exact invariant.

The unknown-input marker is legitimately resolved by actual NativeStarted during
acceptance. The post-start case therefore snapshots/preserves its accepted marker
state and native identity; it does not invent a requirement to retain an already
resolved input marker. The pre-start case still retains its unresolved marker.

## Minimal notification change

A private await_owned helper observes both the owned result oneshot and a fresh
Closed watch. Both Worker.start's result receiver and Started.done use it. A fresh
watch is obtained before moving ownership or publishing Started. Existing
Unconfirmed is checked before selecting; a biased watch branch and a second check
on the ready oneshot branch cover simultaneous readiness. Unconfirmed yields only
a static cleanup_unconfirmed error/failure. A lost Pending cleanup owner fails
closed. Confirmed cleanup still awaits the actual oneshot: it cannot fabricate a
native start, outcome or Success.

This wakes the existing Driver finish/close protocol. Driver.close observes the
same owned Unconfirmed state and publishes Quarantined while retaining capacity.
The supervisor, Process, exact native attempt, private resources and IO joins
remain owned exactly as before; no dropped result waiter abandons them. A later
explicit retry can proceed only through the existing real cleanup proof.

No supervisor ordering, graceful session/close RPC, native ACK/Started/receipt
verification, first input handoff, owned cleanup, deadlines or process proof is
changed. Normal native Success is delivered in the original order after joined
cleanup; Driver.close cancellation cannot rewrite it to Interrupted. There is no
automatic retry, input replay, false stopped claim or global storage-fault latch
for an ordinary OS cleanup error. Actual storage/IO uncertainty classification
is unchanged.

## Verification

Both actual-holder counterexamples must reach Quarantined without an external
cancel, retain capacity/Worker ownership, and never report Success or replay input.
Failure-only cleanup cannot turn the original invariant into PASS. Four deterministic
private waiter tests cover existing Unconfirmed versus a ready result, transition
plus ready result in the same poll, Confirmed without any native result, and loss
of a Pending cleanup owner. Existing native Worker tests retain normal close/order
and unknown IO behavior; Factory/Core/Owner/runtime regression scopes are recorded
with exact source and log hashes in the external migration handoff.

No claim is made that a green run of this patch establishes the cause of the
separate intermittent macOS cold-resume CI watchdog. Its failure-only diagnostic
trace is still needed to identify that upstream trigger.

Local scoped verification on macOS arm64 / Rust1.99.1 passed173 cases:4 waiter,
26 native Worker,13 Factory,25 Core memory turn,15 session memory/API,47 Owner,
13 runtime unit,11 runtime integration,1 auth ordering and18 RouteA Worker.
Real binaries, all-target clippy with warnings denied, formatting and whitespace
checks passed. This branch derives from frozenFactory04c; newer Root M3 Runtime
composition tests must be rerun after integration, rather than claimed here.
