# R3: ZCode app-server protocol profile

Status: SOURCE_READY; tests are constructed and not yet executed. This module is a pure wire building and parsing layer. It does not launch ZCode, connect Route B, or change Route A, Owner, Worker, Runtime, State, or production behavior.

## Source pin and evidence boundary

Public primary source: [zai-org/ZCode at c5904686ea8341826b3affe5d993d06a134fa779](https://github.com/zai-org/ZCode/tree/c5904686ea8341826b3affe5d993d06a134fa779). This module was authored from public contracts, not copied from upstream implementation.

- [Protocol schemas](https://github.com/zai-org/ZCode/blob/c5904686ea8341826b3affe5d993d06a134fa779/packages/shared/src/zcode-protocol/index.ts): envelopes at 460–503; stdio MCP at 805–835; snapshot at 1459–1478; event at 1480–1492 and turn.started at 1612–1650; create/resume at 2024–2070; runtime preferences at 2170–2207; send at 2222–2271; close at 2477–2489; permission/questions at 2806–2907.
- [Legacy shared types](https://github.com/zai-org/ZCode/blob/c5904686ea8341826b3affe5d993d06a134fa779/packages/shared/src/zcode-protocol-legacy-types.ts): workspace at 36–44; permission result at 67–75; session identity at 148–166; origin at 167–180; runtime header at 532–546.
- [Server operations](https://github.com/zai-org/ZCode/blob/c5904686ea8341826b3affe5d993d06a134fa779/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts): session/event envelope at 831–838; create at 1273; resume at 1618.
- [MCP assembly](https://github.com/zai-org/ZCode/blob/c5904686ea8341826b3affe5d993d06a134fa779/apps/zcode-cli/packages/bootstrap/src/zcode-protocol/protocol-mcp-config.ts), [server design](https://github.com/zai-org/ZCode/blob/c5904686ea8341826b3affe5d993d06a134fa779/apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md), [CLI package](https://github.com/zai-org/ZCode/blob/c5904686ea8341826b3affe5d993d06a134fa779/apps/zcode-cli/package.json).

Source inventory and downloaded primary text are retained under the parent Me workspace `.agents/workspaces/pult-migration/zcode-protocol-primary/`. No downloaded code was executed. The package identifies CLI 0.17.1. Previously supplied static installed-bundle inventory: App 3.18.0, `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`, literal CLI 0.17.1, SHA-256 `26785f28ab8fb9f8b0f3821f2bf71d294f4d0b8bf28108785292f86c7e14090d`. This is static inventory, not live protocol qualification. No actual CLI, version, login, or model command, or user/account/credential reads were used for this change.

## Wire and public API

`APP_SERVER_ARGV` is exactly `app-server`, `--stdio`. `agent-server` is an upstream alias; this profile emits only the pinned entry point. There is no prompt, key, model, invented config flag, Codex initialize, or `jsonrpc` member in argv or frames.

`OutboundRequest::{create,resume,send,close}` builds only explicit supported requests. IDs are bounded strings or JS-safe integers. `Workspace` requires an absolute path and an explicit workspaceKey; this module does not derive an identity or read filesystem configuration. Create/resume require an explicitly nonempty stdio MCP list; all servers have `name/command/cwd/args/env/isolation:"session"`. Env is an array of `{name,value}`, never an object. Optional `protocolVersion` and `timeoutMs` have typed builders. Credentials may exist only in the explicit private helper-env serialized in this request, never global env/argv. Types carrying private data have no Debug.

`decode_frame` consumes exactly one LF or CRLF terminated NDJSON frame; transport must itself bound read buffers before calling it. It rejects raw embedded newlines, Content-Length framing, duplicate keys at all depths, mixed request/result/error envelopes, unknown envelope members, malformed IDs, oversized data and trailing JSON. Errors contain only static messages, never parser text or peer values. Valid JSON blobs in upstream `unknown` fields remain bounded untrusted data. Unknown methods and unsupported event payload fields fail closed.

Default inbound budget: 256 KiB including terminator, depth 24, 8192 JSON values, 128 KiB per string, 256 bytes per object key. `DecodeLimits` allows a future dedicated worker to select larger cold-resume history budgets, up to 16 MiB per frame, depth 64, 1,000,000 values and 2 MiB per string. Failure never truncates. Outbound/config bounds remain conservative: 8 MCP servers, 64 KiB combined MCP JSON, 64 arguments/server, 32 env entries/server, 16 KiB/env value, 4 KiB/argument and a 256 KiB encoded request frame. The module neither accumulates stream history nor retries sends.

## Acknowledgement and authority boundaries

`Response` retains bounded result data without Debug. Context-specific consuming methods require the pending request ID. `send_ack` additionally requires the expected SID and validates the exact `{sessionId,accepted:true,stateRevision}` shape. This acknowledges input acceptance only; it is not Started. A result error exposes only its bounded code, not the message or data.

`snapshot_ack` requires pending request ID, expected SID and the caller's pending `SnapshotMethod::{Create,Resume}`. It extracts:

- `protocol.name == "ZCode Protocol"`, `protocol.version == 1`;
- `session.sessionId`, `session.workspace.workspacePath`, `session.workspace.workspaceKey`;
- `projection.sessionId`, which must match session SID;
- `runtime.stateRevision`, `runtime.eventSeq`, optional `runtime.activeTurnId`.

The snapshot root required members are protocol/session/settings/projection/runtime/messages; optional root members are goalStats/todos/todoGroups/slashCommands. Session identity and runtime header member sets are pinned and reject unknown members; their required enums, strings, timestamps, pending request IDs and revision counters are checked. Optional consumed runtime fields are deliveryKind and activeTurnKind. Optional session directorySessionId/parentSessionId/traceId/titleSource are checked. No root revision or fabricated root session ID is assumed.

Settings, projection details, message bodies, model/target and other nested projection data are retained bounded and opaque, not fully schema validated. `untrusted_snapshot()` is an explicitly untrusted future parser input. This profile is NOT a complete snapshot-schema implementation; retaining opaque data does not establish provider/model/config validity or authority. A create/resume snapshot is not input acceptance and cannot mint Started. The future Owner/Worker must compare workspace identity to its own ticket, not trust the returned workspace for authorization.

`TurnStartedCandidate` parses only the supported `session/event` / `turn.started` subset. It retains SID, optional TID, optional inputId/queryId and event sequence. Missing TID/inputId remain absent. A future Actor must match SID/TID and its own host-issued inputId before accepting evidence; neither this type, prompt equality, queryId alone nor sequence alone is Driver authority. Supported additional scalar turn payload fields are explicitly enumerated in the code. Workflow/intent/originMeta/attachments/inputSource payloads are deliberately unsupported in this first profile, rather than guessed or silently discarded. Future integration must explicitly extend its event profile before claiming full stream compatibility.

`close_ack` validates only `{closed?:boolean}`. It establishes neither OS process exit nor cleanup, and this module has no process handle.

## Reverse requests

The profile validates exact bounded params for `session/requestRuntimePreferences`, `interaction/requestPermission`, and `interaction/requestUserInput`. Permission options and nested proposed permission updates are validated but never granted. Unknown fields, duplicate option IDs, empty required choices, invalid origins and malformed known fields fail closed.

`ReverseRequest::default_deny()` emits a response with the incoming RPC ID, never an ID invented from tool input:

- Runtime preferences: disables native search, tool search, app control, subagent runtime config, memory and automatic user-question resolution; emits the pinned `preflight-v1` strategy. It reads no account, model or owner setting.
- Permissions: `{decision:"deny",reason:"Host approval is unavailable"}`; never echoes proposed persistent rules or modified input.
- Questions: `{action:"cancel",reason:"Host input is unavailable"}`.

A future transport handles unsupported/malformed reverse requests with its own static protocol-error policy. A JSON request's session/origin/model/permission fields never authorize host operations.

## Required future integration work

MCP `[]` upstream falls back to global config; it does not disable servers. Nonempty custom MCP still merges plugin/reserved builtin servers. Active session/resume returns an old runtime and ignores replacement MCP configuration, so a future Route B worker needs its own fresh dedicated process and Ticket plus cold resume. This module cannot verify coldness. Route A has no supported private mcp-config/env override; no global/user/workspace config mutation is introduced.

OS spawn and create contain no prompt. `session/send` is the future durable input frontier; an unknown send outcome must never be automatically replayed. Future worker/Actor/Driver integration, full event profile, reverse-request ownership/deadlines, bounded stream framing, MCP helper ticket revocation, child-process cleanup and genuine live/recorded differential qualification remain separate tasks. No production fallback or capability claim is enabled here.

## Verification provenance

`rust/tests/zcode_appserver_protocol.rs` contains CONSTRUCTED golden requests, ACK/snapshot/event/reverse/error fixtures and negatives for incompatible framing, duplicates, ambiguity, unknown/malformed fields, correlation, budgets, large configurable histories, MCP arrays and argv. They are not recorded frames, a live transcript or a differential oracle. Source-only work is not a tested freeze; update this paragraph only after actual authorized checks.
