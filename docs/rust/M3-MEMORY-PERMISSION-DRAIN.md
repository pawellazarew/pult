# Scoped permission journal cleanup

Memory proposal cancellation previously dropped its Broker `RequestHandle`, then
released its memory Job and Driver Ticket. The Broker correctly retained its own
journal write, but `permission.resolved` could commit after another turn started
in the same session. The session-level status reducer then changed the newer
turn's `blocked_permission` status to `working`.

`RequestHandle::cancel(&self)` requests cancellation of that exact question.
`RequestHandle::drained(&self)` proves that the actor removed it after all of its
owned journal operations reached a known outcome. A deny decision is an earlier
notification and does not prove cleanup. Dropping the drain waiter never aborts
a write. This API does not wait for another question or session and does not
revoke session-wide permissions.

The memory proposal task pins one decision waiter, applies its deadline to the
wait, then cancels and drains the exact question outside that timeout. Its
existing memory Job and daemon HostJob remain owned through the drain. No
additional cleanup tasks are detached. The accepted-receipt wait and commit seal
retain the same proposal deadline; owned blocking database work remains tracked
until completion even when its result is no longer usable.

A hung journal operation deliberately retains the Ticket. The Driver may report
unconfirmed cleanup and require a later retry; this is not proof of completion.
A storage failure still denies execution and publishes the existing global
fault. A completed write with unknown durability remains a storage fault rather
than a grant.

Synthetic regression fixtures use the actual Broker, Driver, SQLite store and
journal/status projection. The old resolved write is held at a deterministic
barrier. Cancellation, proposal timeout and caller-future drop retain ownership
until the barrier releases; the next turn's actual permission card stays
blocked. Separate Broker fixtures cover cancellation during requested/resolved
writes, timer expiry, dropped drain waiter, independent neighboring sessions and
failed append. They make no account, model or network calls.

This change does not implement Claude ask-server roles or expand any memory
capability. The reusable request-scoped proof is intended for those later owned
question tasks as well.
