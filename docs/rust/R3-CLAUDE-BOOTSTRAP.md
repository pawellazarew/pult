# Selected Claude bootstrap

`runtime_bootstrap::load_claude` is read-only, owned blocking startup work. It
returns checked Pult configuration, a BASE-only child environment, canonical
holder/Claude/curl executable paths, empty trusted prefix arguments and the
actual child HOME/managed settings directory. It never looks up Codex. Existing
`load` retains its Codex contract and `app-server` prefix unchanged.

An explicit host `PULT_CLAUDE_BIN` must be absolute, available and executable;
invalid overrides never fall back to PATH. Otherwise only absolute PATH entries
are searched, skipping empty/relative entries. Executable aliases are resolved
without running a version/login command. Holder/curl overrides remain fixture
inputs gated by exact `PULT_TEST=1`; override variables never enter child env.

Pult's home/config checks and before/after home identity checks are shared with
the existing loader. Errors and Debug contain static diagnostics/counts, not
paths, config values or environment secrets. The filtered child HOME must be present
as an absolute source value; its bytes are preserved, including canonical aliases,
so the later settings resolver and child process use the same HOME. This loader
checks its shape without opening native settings, `.claude.json`, authentication
files or account metadata. It does not require the HOME directory to exist.

Managed paths follow the actual Node helper
`src/mcp/browser.ts::claudeManagedSettingsFiles`: macOS uses
`/Library/Application Support/ClaudeCode`; the other supported Unix platform
uses `/etc/claude-code`. This bootstrap does not list/read those directories.
Node's separate testHome override selects one
`PULT_HOME/claude-managed-settings.json` file. That file seam is not representable
by the current directory-only Rust Settings constructor and is intentionally
not synthesized here. Root integration must add a typed test seam if inherited
managed-policy fixtures need it; ordinary vertical fixtures use explicit Ask.

Only BASE environment variables survive: HOME, USER, PATH, LANG, TERM and TMPDIR.
Ambient native credentials, loader hooks, proxy values and Pult owner/Ask/memory
capabilities are dropped. Routing and scoped MCP capability injection still
belong to the later checked controller/factory, not the bootstrap snapshot.

Tests resolve fake executable files but never launch them. They cover Claude
without Codex, Codex without Claude, override failures, aliases, actual HOME,
managed path selection, environment/privacy and unsafe/malformed Pult config,
plus the existing Codex bootstrap cases. No State/router wiring, real provider
calls, authentication changes or full Claude-provider claim is included.
