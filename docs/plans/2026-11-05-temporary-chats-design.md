# Temporary conversations

Approved scope: Pavel chose a conversation without a project or saved history; after approving the workspace UI, he explicitly requested this next implementation stage on 2026-11-05. The alternatives and provider research are retained in the original design/2026-11-05-paseo-ui-preview/INCOGNITO-RESEARCH.md. This implements that chosen memory-only design.

A temporary conversation is a separate conversation type, independent of Normal/Expanded/Focus. It starts outside projects, with a fixed title, a small temporary indicator and a one-time explanation. It survives client disconnect/reconnect and window closure while the daemon is alive. Explicit End and delete erases its state; daemon restart never restores it. It never converts an existing saved conversation.

## Storage and protocol

Use a separate TemporaryChatService, with a fresh daemon epoch and authoritative per-chat revisions. Temporary text, drafts, messages, receipts and provider identifiers stay in RAM. Do not use EventStore, the saved registry, ordinary drafts, start journal, notifications, automatic titles, search or exports. Snapshot responses have a 512 KiB serialized budget under the 1 MiB NDJSON frame limit; at most 8 chats and 4 MiB total. Refuse growth with a fixed memory_limit error rather than persisting or silently truncating history.

RPC namespace temporary: list, start, read, draft, configure, prompt, stop, remove. Only existing authenticated owner connections may call it. Start and prompt have bounded in-memory idempotency receipts, retained until removal. Old epochs are rejected; requests never silently recreate an expired chat. The first version refuses overlapping turns; existing saved-chat Send now/queue behavior is unchanged.

A draft uses a separate draft revision and optimistic compare-and-set. UI applies edits immediately, serializes writes without localStorage, flushes a pending latest draft on navigation, and handles conflicts without overwriting a newer local edit. Provider/model choices are configurable before the first message. Provider APIs are lazy-created on first send. End/remove first invalidates callbacks and removes RAM state, then closes the transport and its neutral workspace. Daemon shutdown closes all transports. Orphan neutral workspace directories are cleaned on startup without loading any conversation data.

## Providers

A temporary transport is separate from ordinary manager/adapters. It exposes a bounded text-only stream, interrupt and close, and never emits raw provider payloads to the durable event bus. Every turn obeys the existing network guard. Errors are fixed codes, not raw stderr or prompt-bearing exception messages. No project/global instructions, user extensions, MCP, memory read/write or tools are enabled. Authentication and the provider's unavoidable built-in system/security policy remain in place.

Claude must use its native no-session-persistence and isolation flags with a live multi-turn process, without ordinary --resume. Codex must use a native ephemeral thread and a verified tool/context-free profile. Capabilities remain disabled until installed CLI probes establish the contract; ZCode is unavailable unless a true non-persistent path is verified. There is no fallback to ordinary saved sessions. Live canary probes must verify two-turn memory, no tools/extensions/project markers and no prompt/response in local CLI histories/debug files. The public claim covers Pult and local CLI history, not provider-side retention, OS swap or crash dumps.

## UI

Use separate activeTemporaryId and snapshots. Temporary IDs never enter AgentView, UiState.sessions, ordinary saved tabs, selected, drafts or attachment hooks. A dedicated TemporaryChat uses text-only Markdown under a restricted bridge (copyText/openExternal), with local file/image contexts disabled. No attachment picker, dictation, file/runtime panel, export, archive or auto-title. Temporary chats have their own sidebar group and new-chat entry. Hiding or switching is independent of explicit deletion.

## Acceptance

Canary text is absent from every file under PULT_HOME, UI storage and the CLI transcript/debug locations. Reconnect and a second authorized client see the same live conversation and daemon draft; client closure does not delete it. Ending during output blocks late callbacks; restart loses all temporary data and rejects old-epoch requests. Guard failures, cancellation, unsupported versions, idempotent retries and memory limits are tested. Saved-chat behavior and the approved palette/modes remain covered by existing checks. Provider behavior is live-probed before being advertised as available.

Implementation is stacked on approved UI head 30ce16e (PR #53) until that dependency can merge on green CI. No installed Pult, user CLI configuration or active work is restarted for development.
