# Holder completion follows the observed stop reason

A native leader can exit while descendants still hold stdout or stderr. An
explicit stop during that drain, or during subsequent group cleanup, now keeps
the holder's cancellation semantics. Previously an earlier natural-exit
observation could make the holder return cleanup-unconfirmed code `125`.

The final decision runs only after successful `Group.cleanup()`:

- A natural exit with drained output and two successful forwarding joins keeps
  its actual exit code, including `7`, even when a stop is pending.
- Otherwise an observed TERM, INT or owner loss permits cancellation code `0`.
- Undrained or failed natural forwarding without a stop remains code `125`.

A safe nonblocking poll checks already-pending signals after group cleanup.
Closed signal sources do not invent a stop. Both finished forwarders are joined;
unfinished forwarders are left to process exit on cancellation. There is no new
timer, environment hook or signal after reaping the process group leader.

The existing waitid/NOWAIT ownership, group signal/reap order, zombie proof,
grace periods and `Process.stop` code-125 guard remain. Cancellation code `0`
proves group cleanup; it does not prove clean stdout EOF or successful native
execution. In particular, dropping the output consumer still leaves
`Process.output_finished_cleanly()` false.

Two deterministic regression stages exercise the same private decision function
used by `run`: stops during undrained natural exit, then stops queued during
cleanup with undrained or failed forwarding. Guards preserve clean native exit
status, forwarding failures without cancellation and unknown signal behavior.
Actual holder tests cover consumer drop, native exit `7` and descendants.

This proves the corrected decision policy. It does not establish the scheduling
trigger of the original intermittent macOS resource-drain failure. Those traces
and the separate custom bad-holder failure in
[#144](https://github.com/pawellazarew/pult/issues/144) retain their own evidence.
No provider account, model call, replay or native permission grant is involved.
