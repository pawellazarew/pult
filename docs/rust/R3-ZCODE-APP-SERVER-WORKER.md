# Dedicated ZCode app-server Worker (inactive library slice)

This slice implements actual holder/raw-pipe execution for one fresh ZCode
app-server process per Ticket. It does not activate a Runtime provider, wire the
production memory backend or native permission Broker, or qualify an installed
CLI/account. Existing Route A, codec, Driver, Runtime, State and catalog remain
unchanged. The only Owner addition is a readonly current-record getter on its
already-held app-server frontier; the new module is exported by the library.

## Admission and bootstrap

The host supplies a trusted Launch with no arguments. Worker adds exactly
`app-server --stdio`; native content/MCP configuration/keys never enter argv.
The common app-server environment cannot contain `PULT_MEMORY_KEY`. Native MCP
servers use the codec's private stdio env array and session isolation. No provider
configuration file, global config, settings flag or HOME substitution is added.

V1 is memory-on only. ScopedResources preparation must reject memory-off before
spawn and return a nonempty typed server list for an enabled scope; an empty list
is rejected because upstream falls back to global configuration. No dummy/no-op
MCP server is supplied. The future Runtime may choose Route A for memory-off
before dispatch; this Worker never falls back after beginning an Attempt.

Unsupported model/effort/service-tier/browser options fail before OS spawn.
V1 accepts only captured Plan/Guarded/Yolo; other native modes are explicitly
unsupported. Launch cwd must equal the trusted canonical snapshot cwd.
Captured approval must equal the trusted snapshot; Yolo is rejected unless Full,
and ReadOnly requires captured Plan. These host checks do not qualify native mode
semantics or complete filesystem/permission parity. Native startup/plugins/
automation can still execute during bootstrap; no no-execution guarantee is made.

The absolute start deadline is captured by the caller before slot/preparation
waits. It is reused by reservation, all bootstrap waits and the actual input CAS;
it is never reset after a slow Store/Sink/resource/gate operation. Each Worker is
one-shot, including after completion. Constructor and start/close methods are
trusted Rust host APIs, not JSON commands or new IPC capabilities.

Resources/catalog are owned through completion. The original user journal text
is unchanged; bounded catalog and attachment data become native content sections.
Create requests a host SID allowed by the pinned SDK, but persists no actual SID
until the strictly correlated create snapshot confirms it. Resume uses only the
captured native SID. Snapshot workspace path/key must match the trusted snapshot,
and an already active native turn is refused. Captured mode is checked/applied
with setMode before an explicit legacy subscribe. Bootstrap ACKs are not Started.

## Real input frontier

Owner writes a durable version-2 unknown-input marker before OS spawn. Actual SID
persistence completes before send. Requests are encoded/prepared before admission.
The final handoff holds:

`Consent -> Registry -> Runtime input permit -> Resource permit -> Attempts -> Driver`.

The Runtime gate is supplied by the host and must do only bounded admission work.
ScopedResources::check explicitly borrows the same frontier lifetime and receives
its readonly CURRENT Record, including memory policy/fingerprint. It must not
reacquire Registry or perform FS/DB/callback work. A production adapter cannot
substitute the existing Registry-locking TurnMemory::check here. Its permit must
hold exact lease/control revocation admission through the first handoff.

After Owner input seal, the exact observer/pending-send binding is installed and
one bounded synchronous writer-queue try_send runs while every permit/frontier is
still held. Queue failure after seal is unknown, never a retry permission. The
single writer owns the real Process borrow through send_prepared and its native
WriteGuard. Cancellation uses cached StopSignal without needing the vault mutex.
The Process remains inside its vault through startup acknowledgement, blocked
write, panic and cleanup; it is not moved into a disposable waiter future.

observed_pending_input_write is readonly host diagnostics: it records an actual
Pending poll of this Job's first input write. It does not prove byte delivery,
accepted input, absence of execution, natural EOF or cleanup. It adds no config
switch or IPC method. Public host turn/input IDs retain 128 random bits with UUID
separators; contiguous 32-hex turn IDs would legitimately be rejected by Driver's
unchanged secret-redaction guard.

## Reader, correlation and output

Actual RawFrame bytes pass through the strict Foundation codec before Value or
normalization. Raw transport does not discard invalid tails. A bounded pending
map binds exact string RPC ID, method and SID; numeric IDs are not coerced. Unknown
or duplicate response IDs fail before any Actor response enqueue. Bootstrap is
sequential, with one expected snapshot at a time; its bounded opaque history may
exceed 3 MiB and does not consume the 2 MiB event queue budget. The codec/raw frame
ceiling remains 16 MiB. No history truncation or hidden 2 MiB RPC limit is added.

Reader and writer remain live while the supervisor awaits Store/Sink/resource IO.
The reader updates native observations before any such IO. Both strictly matched
send ACK and native turn.started with actual SID/TID plus both captured host IDs
are required. Early event/ACK order is supported. Owner acceptance is persisted,
the exact receipt checked, then Worker returns Started. Driver alone publishes
its accepted user event. Worker waits for real Progress::Running/public turn/event
before releasing normalized output; no fabricated source ID or synthetic Running
is used. Pending native reverse calls do not synchronously block this handshake.

The inline event_profile checks consumed payload fields from official ZCode pin
c5904686ea8341826b3affe5d993d06a134fa779, shared protocol index.ts: model.streaming
around 1430, turn.completed around 1691, turn.failed around 1726. Actual params are
session/event.params. It validates stream kinds/consumed field types, required
terminal counters/response/duration/resultType and cacheStats. Failure error
message/type fields are checked; unused bounded usage/error data/attribution are
not promoted into authority or public diagnostics. This is a deliberately partial
event profile, not full SDK stream/schema parity.

Only matching SID/TID and matching terminal inputId when present can complete the
accepted turn. A typed success result is required; model finish/done and EOF are
not terminal success. Completed cancelled/error result types and turn.failed
remain failures/interruption as appropriate. Known observational notifications
are ignored without granting permission or acceptance; unknown codec types fail
closed. Existing Normalizer runs only after strict typed handling and actual
accepted native pin. Its result signals do not grant Owner or Driver authority.

Native data events have a 2 MiB aggregate RAII queue/early-data budget and count
limit; capacity failure is explicit, without truncation. Expected RPC snapshots
are separate. The normalizer retains its existing per-event/text bounds.

## Native interactions and cleanup

V1 NativeInteractions replies are bound to the incoming request ID and only have
safe-default runtime preferences or deny/cancel constructors. Approval/modified
input constructors are absent. Unknown/malformed methods terminate the attempt
under static error policy. This does not implement native Broker/permission/
question parity or sandbox native builtins. Before acceptance the original start
deadline also bounds interactions; after publication requests have their own
bounded timeout. An admitted callback remains owned after caller cancellation or
timeout; timeout does not abort it and declare cleanup. Transport/callback failures
are sticky on an independent watch channel, so a full event queue cannot lose the
actor/RPC wakeup. Ready input is revoked before publishing failure. The owned
writer monitor joins its IO task, including panic, while Process stays in the vault.
Already queued valid typed terminal events retain their order; natural EOF is not
reclassified as an early transport error.

At terminal, close new admissions and revoke resources/interactions first.
A bounded best-effort typed native close may then run on the existing writer.
Its ACK never proves OS cleanup. Stop the
actual holder, join decoder/writer/reverse tasks, confirm Process cleanup and
await resource drain. The external raw receiver is owned by the reader and is
closed/drained through that task's known outcome. A successful close/drain cannot
substitute for the other proof.

Store/Sink/resource work is separately spawned and awaited through external
cancellation, including task construction. Unknown completion/panic faults
execution and quarantines BEFORE any JoinedCleanup/marker clear/retire. A known
Sink error faults execution without inventing a permanently pending task. A
handoff-thread panic can poison held guards and publishes storage failure only
after unwinding. Neither case loses a retained native PID. Cleanup retry retains
ownership when holder stop is unconfirmed.

Only exact cancelled-before-bootstrap process/input actions plus known joins/IO
can clear a never-spawned marker. Sealed bootstrap without current send preserves
uncertainty, as does unknown ACK/write. Current-input retry, new-SID resume
fallback and Route A MissingAfterJoin proof construction are absent. Close never
acknowledges Stopped while external completion is unknown. Runtime admission/slot
release and production backend wiring remain host responsibilities.

## Verification boundary

The new integration binary uses real Driver/Owner/Registry/Journal, actual Rust
holder, and a controlled Python native peer. FakeResources supplies a descriptor
for the real pult-memory-mcp executable and checks held current metadata/gates;
the fake peer does not execute memory tools. Therefore these tests prove Worker
ownership/wire composition, not production M3 memory delivery or a real provider.

Scenarios cover both ACK/start orders and no early deferred receipt; bootstrap
runtime-preferences while create ACK is pending; cold resume/setMode/subscribe;
actual SID-before-send; malformed/unknown ACK/IDs/EOF/terminal and duplicate raw
keys; expected 3 MiB opaque snapshot; no memory-off/unsupported-option spawn;
held prepare/catalog/Store/Sink and reverse IO; current memory policy race;
cancellation/fault/deadline under held frontier; actual pending first write;
post-handoff release panic; bootstrap/running callback errors, foreign reply ID
and event queue saturation during owned Store IO; real descendant stop plus resource-drain barrier after
native close ACK; dropped client and unknown-IO quarantine; reflected private-key redaction without changing privacy
rules. Existing foundation,
Owner and Route A suites remain separate regressions. Full old-base tests, Runtime
activation, real shared backend/Broker/MCP acceptance and installed CLI/account
qualification are not claimed by this slice.
