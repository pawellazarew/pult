# R4 scoped helper credentials at owner CLI boundaries

On source `ec904f297e4055b8ab2b68a0e914cbe68e5c1490`, generic Rust CLI requests
ignored ambient PULT_ASK_KEY / PULT_RUNTIME_KEY and could authenticate with the
owner token. Two actual executable tests reproduced this through a controlled
private socket: each helper-key-only process sent the synthetic owner token in
HELLO and completed daemon.status. This is a Rust preview CLI finding, not an
installed-service or real-account incident.

The baseline fixture uses private scratch files and invented credentials. Its
initial 0644 marker failure happened before HELLO and is explicitly not authority
proof; after the fixture marker/config/token permissions were corrected to 0600,
both owner-HELLO assertions failed as intended. Persistent baseline logs and the
exact test-source snapshot are retained outside this repository.

## Minimal production change

Only main.rs changes. A private reject_helper_credentials guard rejects the
**presence** of ASK/RUNTIME environment keys, including empty and non-UTF8 values,
before owner home/config/token/socket access. It returns one static error without
reflecting either key. Mixed helper + memory credentials fail at this guard
before choosing a memory role or reading owner display settings.

| Entry | Boundary |
| --- | --- |
| Generic agent/perm/memory/catalog/events RPC commands and daemon status/stop | First operation in cli_request; memory-only routes remain immediately below it. |
| Read/tree localization | First operation in cli_language, before owner display config. |
| daemon serve | Before existing memory-purpose check and serve initialization. |
| events tail | Before subscription client entry; its older internal guard handled only memory keys. |
| daemon logs | Existing local helper already rejects all four scoped keys before IO. |
| agent wait / prompt --wait | Existing OwnerClient already rejects all four scoped keys before IO. |
| mcp-ask | Dedicated Ask route remains allowed; sends ask HELLO and only perm.request, never owner token. |
| memory read / turn CLI transports | Remain allowed with their own sole credential; no owner token or display config. |
| version / --version / -v / --help / --skill | Harmless local output remains available without owner home access. |

This source has no daemon start CLI command. No new service/start path, global
guard on mcp-ask, backend authorization rule, catalog or public capability is
introduced. Explicit library request APIs are unchanged; this fix separates
ambient CLI purposes without redefining trusted library-call authentication.

## Focused acceptance

The new actual CLI tests keep both baseline owner-HELLO regressions, then cover:

- ASK and RUNTIME, empty and nonempty, before invalid home and mixed memory keys;
- daemon status/catalog/read/tree/bare prompt/serve/events-tail entry points;
- FIFO owner config, token and scratch marker, with no socket connection;
- positive owner HELLO, positive scoped memory read and turn HELLO with poisoned
  owner files, and harmless version/help/skill output.

The existing dedicated Ask helper suite and scoped-memory / turn-MCP suites run
separately against controlled sockets, scratch daemons and repository peers.
No actual provider CLI, account, OS service manager or user configuration is
used. Exact executed results, hashes and preserved RED diagnostics belong to the
persistent TESTED handoff. Full production cutover remains separate.

Local macOS results: focused actual CLI 6/6, dedicated Ask 8/8, scoped-memory
17 scenarios, turn-MCP 13 scenarios, and existing CLI regression 32/32 all pass;
all-targets Clippy (-D warnings), fmt and diff-check pass. Production code stays
the reviewed 16 inserted main.rs lines.

For composition with the accepted bare-prompt CLI slice, that one test-matrix
command accepts exactly its preexisting OwnerClient static rejection as well as
the new generic rejection. Both require exit 1, empty stdout and the same
FIFO/no-connect proof. The other six commands require only the new exact static
message. Baseline owner-HELLO tests remain tied to daemon.status and unchanged.
