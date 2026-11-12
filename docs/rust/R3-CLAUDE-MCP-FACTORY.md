# Private scoped Claude MCP files

`claude_mcp::Factory::new(backend, gate, helper, extras)` returns an
`Arc<Factory>` implementing `claude_worker::ScopedMcp`. The gate and helper
executable are trusted host selections. The immutable extra-server map is
retained; the `pult` namespace is rejected rather than replacing host input.
Provider arguments never select a filename, helper, key, or cleanup target.

`prepare(McpContext)` reserves its exact Ticket/generation synchronously before
owned authorization/file IO. It calls `Backend::prepare` with the captured gate
and uses `claude_launch::mcp_ask_config`. The credential exists only in the
private JSON file's helper environment. It is not passed in argv, logged,
serialized in a diagnostic, or read from an owner token/config file. The helper
gets `--home HOME mcp-ask`, not the credential as an argument.

Preparation returns a new path; it does not rewrite an existing configuration.
Home/run directories must be owned by the effective user and mode 0700. A
random per-scope directory is exclusively created and pinned by an open FD;
`config.json` is exclusively created with NOFOLLOW and mode 0600. Owned newly
created modes are set through FDs, without chmod of an existing home/run.
Writes and both directory entries are synced before returning the path.
Home/run/scope pathname identities are rechecked before publication.

Revocation is synchronous in-memory work. Dropping an unpolled prepare waiter
also revokes. Neither cancellation nor timeout abandons the owned authorization
or file task. Cleanup revokes, waits for preparation, waits for the backend's
exact question drain, then performs owned FD-relative file removal. Dropping a
cleanup waiter does not abort removal. At most 64 scope preparations and 64
cleanup tasks are admitted; a capacity error is not proof of cleanup.

Cleanup atomically renames the config to a fresh name within its private scope,
inspects its inode/type against the retained file FD, and unlinks only a matching
owned file. Static foreign replacement/symlink is retained in quarantine and
returns `cleanup_unconfirmed`. Directory removal similarly checks the pinned
identity; unexpected contents are not recursively removed. Sync/removal failure
retains the scope record and a subsequent cleanup may retry. No secret or
path-specific OS error is reflected publicly. Missing or uncertain resources
are conservatively unconfirmed, not silently treated as removed.

This is not a sandbox against a malicious same-UID/full-shell process with
access to private directory contents. Portable POSIX has no atomic
compare-inode-and-unlink operation: quarantine inspection/unlink relies on
exclusive trusted ownership of private contents. FD-bound traversal protects
against outer pathname replacement; it does not establish isolation from a
same-UID adversary able to alter that quarantine concurrently. No stronger
identity-race guarantee is claimed.

Tests use actual private temp directories, the real Driver/backend, and
controlled file-IO barriers. They cover immutable helper JSON and extra MCP
servers, modes, reserved namespace, cancellation/drop before publication,
cleanup waiter drop, run replacement, run/config symlinks, foreign replacement
and cleanup failure/retry. Existing actual helper CLI/Role/Broker fixtures are
run separately; this slice does not claim a new whole factory-to-CLI-to-Broker
end-to-end test or a live Claude/provider call.

There is no runtime factory issuer/controller integration or automatic memory /
runtime MCP server here. A later trusted host can use the full McpContext at
prepare time for additional servers; this module never invents a public turn ID
from a Ticket or session lookup. Root's pending `public_turn` context extension
must be preserved when this factory is composed with that runtime work.
