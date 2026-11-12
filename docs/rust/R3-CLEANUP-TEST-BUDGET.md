# Cleanup timeout is not a terminal outcome

The ordinary Codex runtime fixture previously supplied a 200 ms Driver close
budget, shorter than the host's 300 ms interrupt budget, before owned event IO
and reader drain. That is not the production contract: ordinary integration now
uses Options::default(), including its unchanged 5 s close budget.

A separate real-process regression retains the explicit 200 ms budget. The fake
provider emits a real final agent-message frame before interrupt confirmation;
a controlled EventSink holds its durable append. Driver wait must return
CleanupUnconfirmed, retain quarantine and both executions, keep the neighboring
turn running, and emit no successful terminal. Releasing the append and retrying
cleanup with the same public turn ID yields Interrupted without another native
turn/start; the neighbor then completes successfully on the shared warm host.

The counterfactual assertion expecting immediate Interrupted deterministically
fails at the held append with CleanupUnconfirmed. This demonstrates why a short
cleanup budget cannot be used to assert immediate terminal success. It does not
change production timing, weaken quarantine or treat timeouts as successful stop.

The historical Linux CI log identified the ordinary stop assertion location but
hid the exact error under the safe panic hook. That log alone does not prove its
error variant. New test diagnostics print only error/outcome kinds, never raw
provider text. The deterministic regression supplies separate direct evidence
of the owned-tail scenario and its recovery contract.
