# Claude worker integration in progress

The worker branch starts with the trusted launch-policy layer. `claude_launch`
ports the measured Node argv contract: explicit approval modes, read-only tool
exclusions and Bash ask, protected-directory rule escaping, bounded add-dir roots,
resume/fork switches and host prompts only with an MCP configuration. The Rust
helper is selected explicitly; its private MCP payload contains the question
credential, never the owner token, and reserves the `pult` server name.

User input is serialized separately as native stdin blocks with an input UUID,
images and optional runtime data. Slash-command recognition preserves JavaScript
whitespace and path boundaries, so an absolute path is not treated as a command.
The input budget accounts for base64 expansion of the existing 25 MiB attachment
budget. The future process transport must accept this budget separately from its
bounded output framing; merely building the frame does not prove transmission.

Seven local tests include 53 cases compared with the actual built Node24 helpers
(argv, slash commands, directory boundaries and native user input), plus private
configuration and invalid-input checks. The first Rust slash implementation
incorrectly treated a path as a command; the independent oracle failed and the
corrected implementation passes. All-targets clippy and formatting also pass.
No installed Claude process, account or model is used.

Remaining in this branch: supervised process ownership, warm/resume lifecycle,
exact-ticket cancellation and cleanup, durable session/init handling, the real
Rust `mcp-ask` command and scoped permission bridge, current-policy checks,
provider-event integration, and the daemon/CLI execution path. The configuration
builder does not make its referenced command operational. Existing sessions and
RPC support are not changed by this layer alone. Publish the worker step after
its end-to-end acceptance; this document does not close provider issue #105.
