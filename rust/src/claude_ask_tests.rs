//! Real Driver, daemon connection, journal and Broker; no provider/model/network.
use super::*;
use crate::{
    codex_runtime::{CodexRuntime, Dependencies, Network, TrustedCommand},
    turn_driver::{Handle, Started, Worker},
    turn_snapshot::{Approval, SessionKey, TurnSettings},
};
use std::{future::Future, time::Duration};
use tokio::{io::BufReader, net::UnixStream};

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("ask fixture watchdog")
}
struct Probe;
impl crate::network_guard::Probe for Probe {
    fn probe<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: Duration,
    ) -> crate::network_guard::ProbeFuture<'a> {
        Box::pin(async { panic!("ask fixture must not probe network") })
    }
}
struct FixtureWorker {
    backend: Arc<Backend>,
    gate: Arc<dyn DispatchGate>,
}
impl Worker for FixtureWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        _: String,
    ) -> Task<Result<Started, WorkerError>> {
        let backend = self.backend.clone();
        let gate = self.gate.clone();
        Box::pin(async move {
            backend
                .prepare(
                    McpContext {
                        session: snapshot.key,
                        ticket,
                        generation: 1,
                        approval: Approval::Ask,
                    },
                    gate,
                )
                .await?;
            Ok(Started {
                turn_id: "actual-ask-input".into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        self.backend.revoke(&ticket, 1);
        self.backend.drain(ticket, 1)
    }
}
struct Fixture {
    _home: tempfile::TempDir,
    state: Arc<State>,
    backend: Arc<Backend>,
    runtime: Arc<CodexRuntime>,
    handle: Handle,
    allowed: Arc<AtomicBool>,
    key: String,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_barrier(None).await
    }
    async fn with_barrier(barrier: Option<Arc<IoBarrier>>) -> Self {
        Self::with_options(barrier, None).await
    }
    async fn with_options(
        barrier: Option<Arc<IoBarrier>>,
        override_gate: Option<Arc<dyn DispatchGate>>,
    ) -> Self {
        let (home, state, sink) = crate::runtime_journal::tests::fixture();
        let sink: Arc<dyn crate::turn_driver::EventSink> = match barrier {
            Some(barrier) => Arc::new(BarrierSink {
                inner: sink,
                barrier,
            }),
            None => sink,
        };
        let key = SessionKey {
            name: "chat".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let cwd = home.path().join("project");
        std::fs::create_dir(&cwd).unwrap();
        let mut record = crate::registry::Record::default();
        for (field, value) in [
            ("name", "chat"),
            ("createdAt", key.created_at.as_str()),
            ("cwd", cwd.to_str().unwrap()),
            ("provider", "claude"),
            ("approval", "ask"),
        ] {
            record.set_string(field, value);
        }
        state.registry.lock().unwrap().insert(record).unwrap();
        let runtime = CodexRuntime::new(
            Dependencies {
                home: state.home.clone(),
                registry: state.registry.clone(),
                consent: Arc::new(Mutex::new(
                    crate::consent_store::ConsentStore::open(&state.home).unwrap(),
                )),
                driver: state.driver.get().unwrap().clone(),
                sink,
            },
            Default::default(),
            TrustedCommand {
                holder: "/bin/echo".into(),
                program: "/bin/echo".into(),
                prefix_args: vec![],
            },
            Default::default(),
            Network::Shared(Arc::new(crate::network_guard::NetworkGuard::new(Arc::new(
                Probe,
            )))),
            Default::default(),
        )
        .unwrap();
        assert!(state.native_runtime.set(runtime.clone()).is_ok());
        let backend = Backend::new(Arc::downgrade(&state));
        assert!(state.claude_asks.set(backend.clone()).is_ok());
        let allowed = Arc::new(AtomicBool::new(true));
        let checking = allowed.clone();
        let gate: Arc<dyn DispatchGate> = Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
            if checking.load(Ordering::Acquire) {
                DispatchDecision::Allow
            } else {
                DispatchDecision::Deny
            }
        });
        let gate = override_gate.unwrap_or(gate);
        let mut handle = state
            .driver
            .get()
            .unwrap()
            .start(
                TurnSnapshot {
                    key,
                    cwd,
                    provider: Provider::Claude,
                    settings: TurnSettings {
                        approval: Approval::Ask,
                        ..Default::default()
                    },
                },
                "test permission".into(),
                Arc::new(FixtureWorker {
                    backend: backend.clone(),
                    gate,
                }),
            )
            .unwrap();
        let receipt = bounded(handle.accepted()).await.unwrap();
        assert!(receipt.user_event_id > 0);
        let key = backend.control(handle.ticket(), 1).unwrap().key.clone();
        Self {
            _home: home,
            state,
            backend,
            runtime,
            handle,
            allowed,
            key,
        }
    }
    fn call(&self, params: Value) -> Task<Result<Value, WorkerError>> {
        self.backend
            .call(self.backend.lookup(&self.key).unwrap(), params)
    }
    async fn requested(&self) -> String {
        let mut changed = self.state.committed.subscribe();
        loop {
            let drafts = self
                .state
                .store
                .lock()
                .unwrap()
                .read_from(0, Some("chat"), 100, crate::MAX_LINE)
                .unwrap();
            if let Some(id) = drafts
                .iter()
                .filter_map(|event| serde_json::from_str::<Value>(event.json.get()).ok())
                .find(|event| event["kind"] == "permission.requested")
                .and_then(|event| event["data"]["id"].as_str().map(str::to_owned))
            {
                return id;
            }
            bounded(changed.changed()).await.unwrap();
        }
    }
    async fn close(&mut self) {
        self.state
            .driver
            .get()
            .unwrap()
            .cancel(self.handle.ticket());
        bounded(self.handle.wait()).await.unwrap();
        bounded(self.runtime.shutdown()).await.unwrap();
        bounded(self.state.host_jobs.wait()).await;
    }
    async fn socket(
        &self,
        hello: Value,
    ) -> (
        BufReader<tokio::net::unix::OwnedReadHalf>,
        tokio::net::unix::OwnedWriteHalf,
        tokio::task::JoinHandle<crate::Result<()>>,
    ) {
        let (client, server) = UnixStream::pair().unwrap();
        let state = self.state.clone();
        let stop = state.stop.subscribe();
        let task = tokio::spawn(crate::connection(server, state, stop));
        let (reader, mut writer) = client.into_split();
        crate::write_value(&mut writer, &hello).await.unwrap();
        (BufReader::new(reader), writer, task)
    }
}
async fn frame(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Value {
    serde_json::from_slice(&bounded(crate::read_line(reader)).await.unwrap().unwrap()).unwrap()
}
fn params() -> Value {
    json!({"sessionId":"chat","toolName":"Bash","toolUseId":"native-tool","input":{"command":"original"}})
}

#[tokio::test]
async fn actual_question_has_only_once_offer_and_preserves_human_restriction() {
    let mut fixture = Fixture::new().await;
    let call = tokio::spawn(fixture.call(params()));
    let id = fixture.requested().await;
    let chosen = Decision::Allow {
        scope: Scope::Once,
        updated_input: Some(json!({"command":"restricted"})),
        answers: None,
    };
    assert!(
        bounded(
            fixture
                .runtime
                .resolve_permission(&id, chosen, "human")
                .unwrap()
                .wait()
        )
        .await
        .unwrap()
    );
    assert_eq!(
        bounded(call).await.unwrap().unwrap(),
        json!({"behavior":"allow","updatedInput":{"command":"restricted"}})
    );
    fixture.close().await;
}
#[tokio::test]
async fn foreign_session_and_secret_payload_never_create_a_card() {
    let mut fixture = Fixture::new().await;
    let mut foreign = params();
    foreign["sessionId"] = json!("neighbor");
    assert!(fixture.call(foreign).await.is_err());
    let mut leaked = params();
    leaked["input"]["echo"] = json!(fixture.key);
    assert!(fixture.call(leaked).await.is_err());
    assert!(fixture.runtime.list_permissions(None).is_empty());
    fixture.close().await;
}
#[tokio::test]
async fn gate_is_fresh_again_after_human_approval() {
    let mut fixture = Fixture::new().await;
    let call = tokio::spawn(fixture.call(params()));
    let id = fixture.requested().await;
    fixture.allowed.store(false, Ordering::Release);
    bounded(
        fixture
            .runtime
            .resolve_permission(&id, Decision::allow(Scope::Once), "human")
            .unwrap()
            .wait(),
    )
    .await
    .unwrap();
    assert!(bounded(call).await.unwrap().is_err());
    fixture.close().await;
}
#[tokio::test]
async fn dropped_caller_cancels_and_drains_only_its_question() {
    let mut fixture = Fixture::new().await;
    let call = tokio::spawn(fixture.call(params()));
    let _id = fixture.requested().await;
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    fixture.backend.revoke(fixture.handle.ticket(), 1);
    bounded(fixture.backend.drain(fixture.handle.ticket().clone(), 1))
        .await
        .unwrap();
    assert!(fixture.runtime.list_permissions(None).is_empty());
    assert!(fixture.backend.lookup(&fixture.key).is_none());
    fixture.close().await;
}
#[tokio::test]
async fn generation_revoke_cannot_touch_another_scope() {
    let mut fixture = Fixture::new().await;
    fixture.backend.revoke(fixture.handle.ticket(), 2);
    assert!(fixture.backend.lookup(&fixture.key).is_some());
    fixture.backend.revoke(fixture.handle.ticket(), 1);
    assert!(fixture.backend.lookup(&fixture.key).is_none());
    fixture.close().await;
}
#[tokio::test]
async fn actual_connection_rejects_mixed_credentials_and_owner_methods() {
    let mut fixture = Fixture::new().await;
    let (mut reader, writer, task) = fixture
        .socket(json!({"type":"hello","protocol":1,"ask":fixture.key,"token":"fixture"}))
        .await;
    assert_eq!(frame(&mut reader).await["code"], "bad_token");
    drop(writer);
    drop(reader);
    bounded(task).await.unwrap().unwrap();
    let (mut reader, mut writer, task) = fixture
        .socket(json!({"type":"hello","protocol":1,"ask":fixture.key}))
        .await;
    let hello = frame(&mut reader).await;
    assert_eq!(
        hello["capabilities"]["supportedMethods"],
        json!(["perm.request"])
    );
    assert_eq!(hello["capabilities"]["partialMethods"], json!([]));
    for method in [
        "daemon.status",
        "perm.resolve",
        "events.subscribe",
        "memory.list",
        "agent.prompt",
    ] {
        crate::write_value(&mut writer, &json!({"id":1,"method":method,"params":{}}))
            .await
            .unwrap();
        assert_eq!(frame(&mut reader).await["error"]["code"], "forbidden");
    }
    drop(writer);
    drop(reader);
    bounded(task).await.unwrap().unwrap();
    fixture.close().await;
}
#[tokio::test]
async fn actual_connection_eof_cancels_and_drains_pending_inbox() {
    let mut fixture = Fixture::new().await;
    let (mut reader, mut writer, task) = fixture
        .socket(json!({"type":"hello","protocol":1,"ask":fixture.key}))
        .await;
    assert_eq!(frame(&mut reader).await["type"], "hello_ok");
    crate::write_value(
        &mut writer,
        &json!({"id":1,"method":"perm.request","params":params()}),
    )
    .await
    .unwrap();
    fixture.requested().await;
    drop(writer);
    drop(reader);
    bounded(task).await.unwrap().unwrap();
    fixture.backend.revoke(fixture.handle.ticket(), 1);
    bounded(fixture.backend.drain(fixture.handle.ticket().clone(), 1))
        .await
        .unwrap();
    assert!(fixture.runtime.list_permissions(None).is_empty());
    fixture.close().await;
}
#[test]
fn purpose_key_is_redacted_without_hiding_structural_ids_or_email() {
    let key = secret().unwrap();
    assert!(valid_key(&key));
    assert!(!valid_key(&"a".repeat(64)));
    let value = crate::redaction::redact_memory_capabilities(
        &json!({"id":"a".repeat(32), "email":"owner@example.com", "text":format!("prefix_{key}_suffix"), key.clone():"concealed"}),
    );
    assert_eq!(value["id"], "a".repeat(32));
    assert_eq!(value["email"], "owner@example.com");
    assert_eq!(value["text"], "prefix_<token>_suffix");
    assert_eq!(value["<token>"], "<redacted>");
    assert!(!value.to_string().contains(&key));
}

struct IoBarrier {
    entered: Notify,
    release: Semaphore,
    blocked: AtomicBool,
}
impl Default for IoBarrier {
    fn default() -> Self {
        Self {
            entered: Notify::new(),
            release: Semaphore::new(0),
            blocked: AtomicBool::new(false),
        }
    }
}
struct BarrierSink {
    inner: Arc<dyn crate::turn_driver::EventSink>,
    barrier: Arc<IoBarrier>,
}
impl crate::turn_driver::EventSink for BarrierSink {
    fn append(
        &self,
        draft: Value,
    ) -> Task<Result<crate::turn_driver::Receipt, crate::turn_driver::SinkError>> {
        let inner = self.inner.clone();
        let barrier = self.barrier.clone();
        Box::pin(async move {
            if draft["kind"] == "permission.resolved"
                && !barrier.blocked.swap(true, Ordering::AcqRel)
            {
                barrier.entered.notify_one();
                barrier.release.acquire().await.unwrap().forget();
            }
            inner.append(draft).await
        })
    }
}
#[tokio::test]
async fn cancelled_ask_keeps_actual_ticket_until_its_resolved_write_finishes() {
    let barrier = Arc::new(IoBarrier::default());
    let mut fixture = Fixture::with_barrier(Some(barrier.clone())).await;
    let call = tokio::spawn(fixture.call(params()));
    fixture.requested().await;
    fixture
        .state
        .driver
        .get()
        .unwrap()
        .cancel(fixture.handle.ticket());
    bounded(barrier.entered.notified()).await;
    assert_eq!(fixture.state.driver.get().unwrap().active_count(), 1);
    assert!(
        fixture
            .backend
            .control(fixture.handle.ticket(), 1)
            .unwrap()
            .jobs
            .load(Ordering::Acquire)
            > 0
    );
    let mut finished = Box::pin(fixture.handle.wait());
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(finished.as_mut().poll(&mut context).is_pending());
    drop(finished);
    barrier.release.add_permits(1);
    let _result = bounded(call).await.unwrap();
    bounded(fixture.handle.wait()).await.unwrap();
    assert_eq!(fixture.state.driver.get().unwrap().active_count(), 0);
    fixture.close().await;
}

struct GateBarrier {
    entered: Arc<Notify>,
    release: Option<std::sync::mpsc::Sender<()>>,
    gate: Arc<dyn DispatchGate>,
}
impl GateBarrier {
    fn new() -> Self {
        Self::on_call(1)
    }
    fn on_call(target: usize) -> Self {
        let entered = Arc::new(Notify::new());
        let signal = entered.clone();
        let (release, receive) = std::sync::mpsc::channel();
        let receive = Mutex::new(receive);
        let calls = AtomicUsize::new(0);
        let gate = Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
            if calls.fetch_add(1, Ordering::AcqRel) + 1 == target {
                signal.notify_one();
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(15))
                    .unwrap();
            }
            DispatchDecision::Allow
        });
        Self {
            entered,
            release: Some(release),
            gate,
        }
    }
    fn release(&mut self) {
        self.release.take().unwrap().send(()).unwrap();
    }
}
impl Drop for GateBarrier {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}
async fn pending_preparation(drop_caller: bool) {
    let mut fixture = Fixture::new().await;
    let ticket = fixture.handle.ticket().clone();
    fixture.backend.drain(ticket.clone(), 1).await.unwrap();
    let snapshot = fixture
        .state
        .driver
        .get()
        .unwrap()
        .snapshot_for_dispatch(&ticket)
        .unwrap();
    let mut barrier = GateBarrier::new();
    let pending = fixture.backend.prepare(
        McpContext {
            session: snapshot.key,
            ticket: ticket.clone(),
            generation: 2,
            approval: Approval::Ask,
        },
        barrier.gate.clone(),
    );
    bounded(barrier.entered.notified()).await;
    let mut pending = Some(pending);
    if drop_caller {
        drop(pending.take());
        assert!(
            !fixture
                .backend
                .control(&ticket, 2)
                .expect("preparation must be registered before its gate")
                .valid()
        );
    } else {
        fixture.backend.revoke(&ticket, 2);
    }
    let mut drain = fixture.backend.drain(ticket.clone(), 2);
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(
        drain.as_mut().poll(&mut cx).is_pending(),
        "drain falsely completed before owned preparation returned"
    );
    barrier.release();
    if let Some(pending) = pending {
        assert!(bounded(pending).await.is_err());
    }
    bounded(drain).await.unwrap();
    assert!(fixture.backend.control(&ticket, 2).is_none());
    fixture.close().await;
}
#[tokio::test]
async fn revoked_preparation_cannot_publish_a_key_after_drain() {
    pending_preparation(false).await;
}
#[tokio::test]
async fn dropped_preparation_is_revoked_before_its_blocking_gate_returns() {
    pending_preparation(true).await;
}

#[tokio::test]
async fn deadline_expiry_during_final_gate_cannot_deliver_late_allow() {
    let mut barrier = GateBarrier::on_call(3);
    let mut fixture = Fixture::with_options(None, Some(barrier.gate.clone())).await;
    let state = fixture.state.clone();
    let control = fixture.backend.control(fixture.handle.ticket(), 1).unwrap();
    let job = control.admit().unwrap();
    let tracked = state.host_jobs.track();
    let (_cancel, cancelled) = watch::channel(false);
    let expires = tokio::time::Instant::now() + Duration::from_secs(3);
    let call = tokio::spawn(async move {
        let _job = job;
        let _tracked = tracked;
        Backend::question(state, control, params(), cancelled, expires).await
    });
    let id = fixture.requested().await;
    bounded(
        fixture
            .runtime
            .resolve_permission(&id, Decision::allow(Scope::Once), "human")
            .unwrap()
            .wait(),
    )
    .await
    .unwrap();
    bounded(barrier.entered.notified()).await;
    // Wait for the actual injected proposal deadline, not a scheduling delay.
    tokio::time::sleep_until(expires).await;
    barrier.release();
    assert_eq!(bounded(call).await.unwrap().unwrap()["behavior"], "deny");
    fixture.close().await;
}

#[tokio::test]
async fn owner_token_cannot_impersonate_a_provider_question() {
    let mut fixture = Fixture::new().await;
    let (mut reader, mut writer, task) = fixture
        .socket(json!({"type":"hello","protocol":1,"token":"fixture","client":"shell"}))
        .await;
    assert_eq!(frame(&mut reader).await["type"], "hello_ok");
    crate::write_value(
        &mut writer,
        &json!({"id":1,"method":"perm.request","params":params()}),
    )
    .await
    .unwrap();
    assert_eq!(frame(&mut reader).await["error"]["code"], "forbidden");
    assert!(fixture.runtime.list_permissions(None).is_empty());
    drop(writer);
    drop(reader);
    bounded(task).await.unwrap().unwrap();
    fixture.close().await;
}
#[tokio::test]
async fn existing_connection_cannot_use_a_revoked_turn_key() {
    let mut fixture = Fixture::new().await;
    let (mut reader, mut writer, task) = fixture
        .socket(json!({"type":"hello","protocol":1,"ask":fixture.key,"client":"shell"}))
        .await;
    assert_eq!(frame(&mut reader).await["type"], "hello_ok");
    fixture.backend.revoke(fixture.handle.ticket(), 1);
    bounded(fixture.backend.drain(fixture.handle.ticket().clone(), 1))
        .await
        .unwrap();
    crate::write_value(
        &mut writer,
        &json!({"id":1,"method":"perm.request","params":params()}),
    )
    .await
    .unwrap();
    assert_eq!(frame(&mut reader).await["error"]["code"], "forbidden");
    assert!(fixture.runtime.list_permissions(None).is_empty());
    drop(writer);
    drop(reader);
    bounded(task).await.unwrap().unwrap();
    fixture.close().await;
}
#[tokio::test]
async fn ask_auth_never_falls_back_across_other_purposes_or_protocols() {
    let mut fixture = Fixture::new().await;
    for purpose in ["memory", "memoryTurn", "runtime"] {
        let mut hello = json!({"type":"hello","protocol":1,"ask":fixture.key});
        hello[purpose] = json!("unrelated");
        let (mut reader, writer, task) = fixture.socket(hello).await;
        assert_eq!(frame(&mut reader).await["code"], "bad_token");
        drop(writer);
        drop(reader);
        bounded(task).await.unwrap().unwrap();
    }
    let (mut reader, writer, task) = fixture
        .socket(json!({"type":"hello","protocol":2,"ask":fixture.key}))
        .await;
    assert_eq!(frame(&mut reader).await["code"], "bad_protocol");
    drop(writer);
    drop(reader);
    bounded(task).await.unwrap().unwrap();
    fixture.close().await;
}
