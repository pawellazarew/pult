# Current session status projection

The pure reducer follows the existing Node status rules, including advisory
limits, working-session initialization and late tool activity that must not
resurrect a finished conversation. The bounded cache contains registered session
incarnations and status cursors only; it retains no message or tool payload.

Seed it from the recovered registry or a newly created incarnation. Never replay
historical running statuses over startup recovery. Feed new durable events in
global journal order under the host's store mutex: cursor checks reject stale
input, they do not reorder it. Changes identify the exact incarnation for a
checked metadata update; metadata-only events do not change the status receipt.
`can_register` is a read-only capacity check, not a reservation. A trusted
same-name reseed can replace its existing slot even when the cache is full.

Validation: 12 tests and 4,140 comparisons with the actual Node 24 reducer.
Null malformed status/limit data becomes a total no-op rather than Node's throw;
production appends already require object data. Phase, usage, attention, broker
pending counts, persistence and RPC integration are outside this pure slice.
This module adds no State/RPC wiring; the catalogue remains 27 implemented
methods out of 98.
