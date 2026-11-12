# Codex services backed by the owner registry

`CodexOwner` connects the shared registry, consent store, driver and captured
network-route validity callback to the real Codex worker. Constructors are trusted
host APIs: both stores must belong to the same home, and the route callback must
validate the pool's captured NetworkGuard/configuration stamp.

Snapshots refresh consent and derive effective access. Home and per-incarnation
cwd are pinned by canonical path and device/inode; project aliases resolve before
dispatch, general workspaces use the existing private-directory guard. Archive,
incarnation replacement, unsupported fork requests and path retargeting reject
dispatch. The final check may narrow approval but never widen its frozen snapshot.
Injected route callbacks run outside locks; liveness and authority are reread
following callback reentry. `execution_snapshot` retains cancelling work for
diagnostics until cleanup. Dispatch uses `snapshot_for_dispatch`, which revokes
authority immediately on cancellation, shutdown or storage fault.

The mandatory thread store owns its blocking registry transaction. It verifies
the live ticket, incarnation, provider and canonical cwd before changing only
`providerSessionId` and clearing the fork flag. Concurrent title/model/access
changes are preserved. A consuming receipt acknowledges the exact request only
after durable commit. Unknown outcomes latch the driver's global storage fault.

The factory supplies the real secret redactor and a weak Driver fault hook,
without a Driver/worker ownership cycle. It does not choose a CLI executable,
network environment, host pool or RPC authorization role.

Validation: 11 owner integration tests and 35 Driver tests, including a supervised
Python app-server fixture that reads actual sessions.json at the model boundary.
The tests verify durable native IDs, mutation preservation, access changes,
revocation, stale scope, reentrant cancellation, route denial, path identities,
private journal redaction and global faults. No account or paid model is used.
