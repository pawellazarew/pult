# Daemon-owned permission lifecycle

`CodexRuntime::new_daemon(..., memory, broker)` is a crate-private trusted-host
constructor. The injected Broker, Driver and shared NetworkGuard remain daemon
resources. `permission_broker()` returns a clone for the daemon transition;
this does not expose a new RPC permission or create a second question broker.
The supplied resources must belong to the same trusted home/daemon.

The existing standalone constructors retain their previous behavior, including
global Driver/Broker shutdown. The daemon constructor changes resource ownership:
provider shutdown/drop closes only its own admission/preparations and processes.
It never calls global Driver begin_shutdown/shutdown or Broker shutdown/drain.
`Network::Shared` is never closed; `OwnedCurl` drains only its owned CurlProbe.
A storage fault still faults the shared Driver; resource sharing never hides an
unknown journal outcome.

Each runtime lease starts with no Ticket during owned preparation, then records
the exact Ticket returned by Driver.start_input. A synchronous reentrant stop or
shutdown at this handoff is reconciled through the preparation cancellation
watch and a fresh exact-Ticket cancel after publication. Shutdown never selects
ownership through a latest-session/provider lookup. Daemon stop and steering
also require the runtime's exact lease Ticket; a manually started shared Driver
turn cannot be mistaken for a runtime-owned one.

Provider-local cleanup requests every own process stop before waiting for
preparation IO. Its one-second checkpoint waits for owned preparations, hosts,
exact Driver Tickets and Finished-driven lease removal. Unknown cleanup returns
cleanup_unconfirmed, retaining the lease and quarantined Ticket. Repeating
shutdown retries own cleanup. A dropped shutdown waiter does not abort the owned
cleanup task. Finished is the only lease-release proof; a closed progress channel
is not a terminal event. An unresolved neighboring question or another provider's
Ticket is outside this checkpoint and cannot block or be cancelled by it.

The independent Codex owned-approval/PolicyIoGuard delta is a required
composition dependency: an approval responder must retain its exact Broker
cancel/drained proof until the worker cleanup guard releases. Replacing this
with global Broker.drain would block unrelated Claude/manual work and is not
used here. A focused composed test holds the Codex resolution write and verifies
both own Ticket retention and neighbor question independence.

Tests use actual Driver, Broker, JournalSink and a local synthetic Python
app-server/worker holder; no account, model or network requests. Neighbor turns
exercise both Claude and manual Codex identities. Scenarios cover ordinary
shutdown/drop, new Driver/Broker/network use after shutdown, exact stop identity,
quarantined terminal IO, a blocked Driver handoff, and the pending own question
with independent neighboring question. Module-only execution requires building
the real pult-worker-holder, as existing Claude vault fixtures do.

Daemon/controller wiring, shared permission State facade and provider approval
fixes are separate changes composed by Root. This slice adds no claim of full
provider/queue/MCP parity or automatic daemon-wide lifecycle completion.
