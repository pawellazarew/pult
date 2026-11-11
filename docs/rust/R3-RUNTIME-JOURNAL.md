# Execution journal integration

The daemon owns one turn driver and one authoritative event store. Execution
appends use an internal sink with a weak reference to daemon state. Once polled,
a write owns its blocking append and commit publication even if the requesting
client disconnects. The sink and driver do not form an ownership cycle.

After a successful append, the same daemon event cursor and subscription watch
advance monotonically. A delayed older publication cannot overwrite a newer
cursor. Projection failures remain a separate degraded-state flag; they do not
turn a committed global event into a failed write.

Append failures and blocking-task panics return a fixed diagnostic and latch the
driver's global storage fault, cancelling active execution and refusing future
admission. Publication and fault notification occur outside the journal mutex.
A later append cannot clear that latch. Execution cleanup is awaited during
daemon shutdown before releasing its ownership guard. An unconfirmed cleanup
retains that guard and retries; it cannot acknowledge a stopped daemon. The public
serve future delegates to an owned supervisor: cancelling its caller requests
shutdown without dropping the daemon lease. Accept failures also follow cleanup.

Eight tests cover shared cursor publication, older notices, dropped callers, weak
ownership, poisoned test-RPC writes, the global storage latch, quarantine retries
and cancellation/restart of the real scratch daemon. Provider RPC dispatch is a separate step.
