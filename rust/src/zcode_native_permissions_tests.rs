use crate::{
    consent_store::ConsentStore,
    memory::{Context, MemoryStore},
    memory_turn::Backend,
    permission_broker::{Decision, Scope},
    registry::Record,
    runtime_config::RuntimeConfig,
    turn_coordinator::Outcome,
    turn_driver::Input,
    turn_snapshot::{Provider, SessionKey},
    worker_env::Environment,
    zcode_runtime::{Dependencies, TrustedCommand, ZcodeRuntime},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
struct Probe;
impl crate::network_guard::Probe for Probe {
    fn probe<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: Duration,
    ) -> crate::network_guard::ProbeFuture<'a> {
        Box::pin(async {
            crate::network_guard::ProbeResult {
                status: Some(0),
                stdout: b"loc=US\n".to_vec(),
                stderr_bytes: 0,
            }
        })
    }
}
async fn bounded<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), f)
        .await
        .expect("native permission owned watchdog")
}
fn binary(name: &str) -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(name)
}
struct Pause {
    entered: Arc<tokio::sync::Notify>,
    release: tokio::sync::oneshot::Receiver<()>,
}
#[derive(Default)]
pub(super) struct Hooks {
    before: Mutex<Option<Pause>>,
    after: Mutex<Option<Pause>>,
    panic_after: std::sync::atomic::AtomicBool,
    requests: std::sync::atomic::AtomicUsize,
    pending: Mutex<std::sync::Weak<super::NativePending>>,
    adapter: Mutex<std::sync::Weak<super::Adapter>>,
    binder: Mutex<Option<BlockingPause>>,
}
impl Hooks {
    pub(super) fn before_binder(&self) {
        let pause = self.binder.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            let mut open = pause.release.0.lock().unwrap();
            while !*open {
                open = pause.release.1.wait(open).unwrap();
            }
        }
    }
    pub(super) fn bind_adapter(&self, adapter: &Arc<super::Adapter>) {
        *self.adapter.lock().unwrap() = Arc::downgrade(adapter);
    }
    async fn fire(slot: &Mutex<Option<Pause>>) {
        let pause = slot.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            let _ = pause.release.await;
        }
    }
    pub(super) async fn before_request(&self, pending: &Arc<super::NativePending>) {
        *self.pending.lock().unwrap() = Arc::downgrade(pending);
        self.requests
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        Self::fire(&self.before).await;
    }
    pub(super) async fn after_request(&self) {
        Self::fire(&self.after).await;
    }
    pub(super) fn after_issuance(&self) {
        assert!(
            !self
                .panic_after
                .swap(false, std::sync::atomic::Ordering::AcqRel),
            "controlled panic after actual Broker request"
        );
    }
}
struct PauseGuard {
    entered: Arc<tokio::sync::Notify>,
    release: Option<tokio::sync::oneshot::Sender<()>>,
}
struct BlockingPause {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
struct BlockingGuard {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
impl BlockingGuard {
    fn new(slot: &Mutex<Option<BlockingPause>>) -> Self {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        *slot.lock().unwrap() = Some(BlockingPause {
            entered: entered.clone(),
            release: release.clone(),
        });
        Self { entered, release }
    }
    async fn entered(&self) {
        bounded(self.entered.notified()).await;
    }
}
impl Drop for BlockingGuard {
    fn drop(&mut self) {
        *self.release.0.lock().unwrap() = true;
        self.release.1.notify_all();
    }
}
impl PauseGuard {
    fn new(slot: &Mutex<Option<Pause>>) -> Self {
        let entered = Arc::new(tokio::sync::Notify::new());
        let (send, receive) = tokio::sync::oneshot::channel();
        *slot.lock().unwrap() = Some(Pause {
            entered: entered.clone(),
            release: receive,
        });
        Self {
            entered,
            release: Some(send),
        }
    }
    async fn entered(&self) {
        bounded(self.entered.notified()).await;
    }
    fn release(mut self) {
        let _ = self.release.take().unwrap().send(());
    }
}
impl Drop for PauseGuard {
    fn drop(&mut self) {
        if let Some(send) = self.release.take() {
            let _ = send.send(());
        }
    }
}
/// Wrap only the actual shared Broker sink. The real durable append finishes,
/// then its delivery is held: Actor IO is still admitted and can start a late
/// resolved write after cancellation. No fake journal receipt is constructed.
struct BrokerGate {
    sink: Arc<dyn crate::turn_driver::EventSink>,
    kind: &'static str,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    used: std::sync::atomic::AtomicBool,
    released: std::sync::atomic::AtomicBool,
}
impl BrokerGate {
    fn release(&self) {
        if !self
            .released
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            self.release.add_permits(1);
        }
    }
}
impl crate::turn_driver::EventSink for BrokerGate {
    fn append(
        &self,
        draft: Value,
    ) -> crate::turn_driver::Task<Result<crate::turn_driver::Receipt, crate::turn_driver::SinkError>>
    {
        let block = draft["sessionId"] == "native-permission"
            && draft["kind"] == self.kind
            && !self.used.swap(true, std::sync::atomic::Ordering::AcqRel);
        // Trait future cannot borrow self; the wrapped gate is accessed through
        // a future-owned shared signal without moving any authority/receipt.
        let append = self.sink.append(draft);
        if !block {
            return append;
        }
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            let result = append.await;
            entered.notify_one();
            release.acquire().await.unwrap().forget();
            result
        })
    }
}
/// Holds delivery of real durable user receipts, never fabricates an ID. The
/// Host-only queued metadata selects Driver's existing deferred append path.
struct UserReceipts {
    sink: Arc<dyn crate::turn_driver::EventSink>,
    entered: std::sync::atomic::AtomicUsize,
    changed: tokio::sync::Notify,
    open: tokio::sync::watch::Sender<bool>,
}
impl UserReceipts {
    async fn entered(&self, count: usize) {
        bounded(async {
            loop {
                let changed = self.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if self.entered.load(std::sync::atomic::Ordering::Acquire) >= count {
                    break;
                }
                changed.await;
            }
        })
        .await;
    }
}
struct OwnedUserReceipts(Arc<UserReceipts>);
impl crate::turn_driver::EventSink for OwnedUserReceipts {
    fn before_release(
        &self,
        completion: crate::turn_driver::Completion,
    ) -> crate::turn_driver::Task<Result<(), crate::turn_driver::SinkError>> {
        self.0.sink.before_release(completion)
    }
    fn read_completion(
        &self,
        reference: crate::turn_completion::CompletionRef,
    ) -> crate::turn_driver::Task<
        Result<
            crate::turn_completion::CompletedAnswer,
            crate::turn_completion::CompletionReadError,
        >,
    > {
        self.0.sink.read_completion(reference)
    }
    fn append(
        &self,
        draft: Value,
    ) -> crate::turn_driver::Task<Result<crate::turn_driver::Receipt, crate::turn_driver::SinkError>>
    {
        let block = draft["kind"] == "message.user"
            && draft["data"].get("queueItemId").is_some()
            && draft["sessionId"] != "native-cap-4";
        let append = self.0.sink.append(draft);
        let gate = self.0.clone();
        let mut opened = gate.open.subscribe();
        Box::pin(async move {
            let receipt = append.await?;
            if block {
                gate.entered
                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                gate.changed.notify_waiters();
                while !*opened.borrow_and_update() {
                    opened.changed().await.expect("owned receipt gate");
                }
            }
            Ok(receipt)
        })
    }
}
pub(crate) struct Fixture {
    _home: tempfile::TempDir,
    pub(crate) state: Arc<crate::State>,
    service: Arc<super::Service>,
    broker_gate: Option<Arc<BrokerGate>>,
    receipts: Option<Arc<UserReceipts>>,
    server_stop: tokio::sync::watch::Sender<bool>,
    server: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub(crate) runtime: ZcodeRuntime,
    pub(crate) key: SessionKey,
    note: Value,
}
impl Fixture {
    pub(crate) async fn new() -> Self {
        Self::with_gate(None).await
    }
    async fn with_gate(kind: Option<&'static str>) -> Self {
        Self::configured(kind, false).await
    }
    async fn configured(kind: Option<&'static str>, hold_receipts: bool) -> Self {
        crate::panic_guard::install();
        let (home, original, original_sink) = crate::runtime_journal::tests::fixture();
        let (state, sink, receipts) = if hold_receipts {
            assert_eq!(original.driver.get().unwrap().active_count(), 0);
            assert_eq!(original.host_jobs.active(), 0);
            assert!(
                original.native_runtime.get().is_none()
                    && original.claude_runtime.get().is_none()
                    && original.zcode_runtime.get().is_none()
            );
            assert!(original.memory_turns.get().is_none() && original.permissions.get().is_none());
            drop(original_sink);
            let mut owned = Arc::try_unwrap(original)
                .ok()
                .expect("fresh fixture State must be unique");
            drop(owned.driver.take().unwrap());
            let state = Arc::new(owned);
            let receipts = Arc::new(UserReceipts {
                sink: state.execution_sink(),
                entered: std::sync::atomic::AtomicUsize::new(0),
                changed: tokio::sync::Notify::new(),
                open: tokio::sync::watch::channel(false).0,
            });
            let sink: Arc<dyn crate::turn_driver::EventSink> =
                Arc::new(OwnedUserReceipts(receipts.clone()));
            let driver = crate::turn_driver::Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Default::default(),
            )
            .unwrap();
            state.driver.set(Arc::new(driver)).ok().unwrap();
            (state, sink, Some(receipts))
        } else {
            (original, original_sink, None)
        };
        crate::initialize_scratch(&state.home).unwrap();
        crate::checked_home(&state.home).unwrap();
        let run = state.home.join("run");
        std::fs::create_dir(&run).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = tokio::net::UnixListener::bind(run.join("pultd.sock")).unwrap();
        let (server_stop, mut stopping) = tokio::sync::watch::channel(false);
        let serving = state.clone();
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _=stopping.changed()=>break,
                    accepted=listener.accept()=>{
                        let (socket,_)=accepted.unwrap();
                        connections.spawn(crate::connection(socket,serving.clone(),stopping.clone()));
                    }
                }
            }
            while let Some(result) = connections.join_next().await {
                assert!(result.is_ok(), "owned memory connection task panic");
            }
        });
        let cwd = state.home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        *state.memory.lock().unwrap() = Ok(MemoryStore::open(&state.home).unwrap());
        let key = SessionKey {
            name: "native-permission".into(),
            created_at: "2026-11-13T00:00:00Z".into(),
        };
        let mut record = Record::default();
        for (k, v) in [
            ("name", key.name.as_str()),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("approval", "read-only"),
            ("cwd", cwd.to_str().unwrap()),
            ("scope", "project"),
            ("status", "cold"),
        ] {
            record.set_string(k, v);
        }
        record.set_raw(
            "memory",
            serde_json::value::to_raw_value(&json!({"read":true,"write":"off"})).unwrap(),
        );
        state.registry.lock().unwrap().insert(record).unwrap();
        let mut consent = ConsentStore::open(&state.home).unwrap();
        consent
            .grant(&[Provider::Zcode], chrono::Utc::now())
            .unwrap();
        let consent = Arc::new(Mutex::new(consent));
        let memory = Backend::new(Arc::downgrade(&state), binary("pult-memory-mcp"));
        state.memory_turns.set(memory.clone()).ok().unwrap();
        let config = RuntimeConfig::default();
        let broker_gate = kind.map(|kind| {
            Arc::new(BrokerGate {
                sink: sink.clone(),
                kind,
                entered: Arc::new(tokio::sync::Notify::new()),
                release: Arc::new(tokio::sync::Semaphore::new(0)),
                used: std::sync::atomic::AtomicBool::new(false),
                released: std::sync::atomic::AtomicBool::new(false),
            })
        });
        if let Some(gate) = &broker_gate {
            let broker = crate::permission_broker::Broker::new(
                gate.clone(),
                crate::permission_broker::Redactors {
                    value: Arc::new(crate::redaction::redact),
                    string: Arc::new(crate::redaction::redact_string),
                },
                Default::default(),
            )
            .unwrap();
            state.permissions.set(broker).ok().unwrap();
        } else {
            crate::permission_state::ensure_locked(&state, &config).unwrap();
        }
        let service = super::Service::new(Arc::downgrade(&state));
        let context = Context {
            project_id: Some(crate::memory_project::resolve(&cwd).unwrap()),
            session: Some(key.name.clone()),
        };
        let note = state.memory.lock().unwrap().as_mut().unwrap().execute("memory.add",
            &json!({"commandId":"native-permission-seed","name":"Original native read",
                "summary":"A fixture fact","details":"EXACT_SHARED_NATIVE_DETAILS","reason":"Owned test seed"}),&context).unwrap();
        let runtime = ZcodeRuntime::new_daemon(
            Dependencies {
                home: state.home.clone(),
                registry: state.registry.clone(),
                consent,
                driver: state.driver.get().unwrap().clone(),
                sink,
            },
            TrustedCommand {
                holder: binary("pult-worker-holder"),
                program: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/zcode_native_permission.py"),
                prefix_args: vec![],
            },
            config,
            Environment::from([
                ("HOME".into(), state.home.clone().into_os_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
            Environment::new(),
            Arc::new(crate::network_guard::NetworkGuard::new(Arc::new(Probe))),
            Default::default(),
            memory,
            service.clone(),
        )
        .unwrap();
        Self {
            _home: home,
            state,
            service,
            broker_gate,
            receipts,
            server_stop,
            server: Mutex::new(Some(server)),
            runtime,
            key,
            note,
        }
    }
    async fn stop_server(&self) {
        self.server_stop.send_replace(true);
        let server = self.server.lock().unwrap().take();
        if let Some(server) = server {
            bounded(server).await.unwrap();
        }
        bounded(self.state.host_jobs.wait()).await;
        assert_eq!(
            self.state
                .clients
                .load(std::sync::atomic::Ordering::Acquire),
            0
        );
    }
    pub(crate) async fn finish(&self) {
        bounded(self.runtime.shutdown()).await.unwrap();
        self.stop_server().await;
    }
    pub(crate) fn proof(&self) -> Option<Value> {
        std::fs::read(self.state.home.join("native-permission-proof.json"))
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
    }
    pub(crate) async fn start(&self) -> crate::turn_driver::Handle {
        let mut handle = bounded(self.runtime.execute(
            self.key.clone(),
            Input {
                text: json!({"id":self.note["id"]}).to_string(),
                metadata: Default::default(),
            },
        ))
        .await
        .unwrap();
        assert!(bounded(handle.accepted()).await.unwrap().user_event_id > 0);
        handle
    }
    pub(crate) async fn card(&self) -> Value {
        bounded(async {
            loop {
                if let Some(card) = crate::permission_state::list(&self.state, Some(&self.key.name))
                    .into_iter()
                    .next()
                {
                    break card;
                }
                assert!(
                    !self.proof().is_some_and(|p| p["replied"] == true),
                    "native reply before expected Inbox card"
                );
                tokio::task::yield_now().await;
            }
        })
        .await
    }
    fn neighbor(&self) -> crate::permission_broker::RequestHandle {
        crate::permission_state::request(
            &self.state,
            crate::permission_broker::PermissionRequest {
                session_id: "independent-neighbor".into(),
                tool_name: "Read".into(),
                tool_use_id: Some("neighbor-read".into()),
                input: json!({"file_path":"neighbor-fixture"}),
                offers: Default::default(),
                concealed: false,
            },
        )
        .unwrap()
    }
    fn assert_neighbor(&self, id: &str) {
        assert!(
            crate::permission_state::list(&self.state, Some("independent-neighbor"))
                .iter()
                .any(|card| card["id"] == id)
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(receipts) = &self.receipts {
            receipts.open.send_replace(true);
        }
        self.server_stop.send_replace(true);
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_request_reaches_actual_inbox_once_and_shared_helper_after_acceptance() {
    struct FailureStage(std::cell::Cell<u8>);
    impl Drop for FailureStage {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("native permission failure phase={}", self.0.get());
            }
        }
    }
    let stage = FailureStage(std::cell::Cell::new(0));
    let f = Fixture::new().await;
    stage.0.set(1);
    let mut h = bounded(f.runtime.execute(
        f.key.clone(),
        Input {
            text: json!({"id":f.note["id"]}).to_string(),
            metadata: Default::default(),
        },
    ))
    .await
    .unwrap();
    stage.0.set(2);
    let accepted = bounded(h.accepted()).await.unwrap();
    stage.0.set(3);
    assert!(accepted.user_event_id > 0);
    let card = bounded(async {
        loop {
            if let Some(card) = crate::permission_state::list(&f.state, Some(&f.key.name))
                .into_iter()
                .next()
            {
                break Some(card);
            }
            if f.proof().is_some_and(|p| p["replied"] == true) {
                break None;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    if card.is_none() {
        let proof = f.proof().unwrap();
        assert_eq!(proof["rpcId"], "native-permission-rpc");
        assert_eq!(
            proof["nativeStarted"], true,
            "baseline must observe actual matching native Started"
        );
        assert_eq!(
            proof["decision"], "deny",
            "baseline must be the conservative reverse reply"
        );
        stage.0.set(4);
        bounded(h.wait()).await.unwrap();
        f.finish().await;
        stage.0.set(5);
        eprintln!(
            "expected RED native_started=true durable_accepted=true matching_rpc_deny=true owned_cleanup_known=true inbox_missing=true"
        );
        panic!(
            "actual native permission request never reached shared Inbox after real accepted receipt"
        );
    }
    let card = card.unwrap();
    stage.0.set(6);
    assert_eq!(card["toolName"], "ZCodePermission");
    crate::permission_state::resolve(
        &f.state,
        card["id"].as_str().unwrap(),
        Decision::allow(Scope::Once),
        "fixture-owner",
    )
    .unwrap();
    stage.0.set(7);
    let terminal = bounded(h.wait()).await.unwrap();
    if terminal.turn.outcome != Outcome::Success {
        let tag = match &terminal.turn.outcome {
            Outcome::Failure { code, .. } => match code.as_str() {
                "protocol_error" => 1,
                "access_changed" => 2,
                "worker_panic" => 3,
                "provider_unavailable" => 4,
                "start_unknown" => 7,
                "storage_unavailable" => 8,
                _ => 5,
            },
            Outcome::Interrupted => 6,
            _ => 0,
        };
        let proof = f.proof();
        let allow = proof.as_ref().is_some_and(|p| p["decision"] == "allow");
        let helper = proof
            .as_ref()
            .is_some_and(|p| p.get("memoryDetails").is_some());
        eprintln!(
            "first native permission outcome failure tag={tag} peer_allow={allow} helper_details_present={helper}"
        );
        let step = proof
            .as_ref()
            .and_then(|p| p["helperStep"].as_str())
            .map(|s| match s {
                "profile" => 1,
                "spawned" => 2,
                "initialized" => 3,
                "get" => 4,
                _ => 5,
            })
            .unwrap_or(0);
        let handshake = proof
            .as_ref()
            .is_some_and(|p| p["helperErrorHandshake"] == true);
        let home = proof.as_ref().is_some_and(|p| p["helperErrorHome"] == true);
        let class = proof
            .as_ref()
            .and_then(|p| p["errorClass"].as_str())
            .map(|s| match s {
                "AssertionError" => 1,
                "JSONDecodeError" => 2,
                "KeyError" => 3,
                "BrokenPipeError" => 4,
                _ => 5,
            })
            .unwrap_or(0);
        eprintln!(
            "native helper diagnostic step={step} class={class} handshake={handshake} home={home}"
        );
        let hello_ok = proof.as_ref().is_some_and(|p| p["helperHelloOk"] == true);
        let hello_bad_token = proof
            .as_ref()
            .is_some_and(|p| p["helperHelloBadToken"] == true);
        let hello_policy = proof
            .as_ref()
            .is_some_and(|p| p["helperHelloPolicy"] == true);
        eprintln!(
            "native helper purpose-only probe hello_ok={hello_ok} bad_token={hello_bad_token} policy={hello_policy}"
        );
    }
    assert_eq!(terminal.turn.outcome, Outcome::Success);
    stage.0.set(8);
    let proof = f.proof().unwrap();
    assert_eq!(proof["decision"], "allow");
    stage.0.set(9);
    assert_eq!(proof["memoryDetails"], "EXACT_SHARED_NATIVE_DETAILS");
    assert_eq!(proof["wireKeys"], json!(["id", "result"]));
    assert_eq!(proof["resultKeys"], json!(["decision"]));
    assert_eq!(proof["memoryId"], f.note["id"]);
    stage.0.set(10);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_display_envelope_is_denied_without_modifying_native_input_or_neighbor() {
    let f = Fixture::new().await;
    let neighbor = f.neighbor();
    let mut handle = f.start().await;
    let card = f.card().await;
    let mut changed = card["input"].clone();
    changed["reason"] = json!("a changed human override is unsupported");
    crate::permission_state::resolve(
        &f.state,
        card["id"].as_str().unwrap(),
        Decision::Allow {
            scope: Scope::Once,
            updated_input: Some(changed),
            answers: None,
        },
        "fixture-owner",
    )
    .unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    let proof = f.proof().unwrap();
    assert_eq!(proof["decision"], "deny");
    assert!(proof.get("memoryDetails").is_none());
    assert_eq!(proof["memoryId"], f.note["id"]);
    assert_eq!(proof["resultKeys"], json!(["decision", "reason"]));
    f.assert_neighbor(neighbor.id());
    neighbor.cancel();
    bounded(neighbor.drained()).await;
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panic_after_issued_broker_request_retains_unknown_slot_through_blocked_io_and_neighbor() {
    panic_issued_with_blocked_io("permission.requested").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panic_after_issued_broker_request_retains_unknown_slot_through_resolved_io_and_neighbor() {
    panic_issued_with_blocked_io("permission.resolved").await;
}
async fn panic_issued_with_blocked_io(kind: &'static str) {
    let f = Fixture::with_gate(Some(kind)).await;
    let neighbor = f.neighbor();
    let after = PauseGuard::new(&f.service.hooks.after);
    f.service
        .hooks
        .panic_after
        .store(true, std::sync::atomic::Ordering::Release);
    let mut handle = f.start().await;
    let ticket = handle.ticket().clone();
    if kind == "permission.resolved" {
        let card = f.card().await;
        crate::permission_state::resolve(
            &f.state,
            card["id"].as_str().unwrap(),
            Decision::allow(Scope::Once),
            "fixture-owner",
        )
        .unwrap();
    }
    bounded(f.broker_gate.as_ref().unwrap().entered.notified()).await;
    after.entered().await;
    assert_eq!(f.service.slots.available_permits(), 31);
    after.release();
    assert!(matches!(
        bounded(handle.wait()).await,
        Err(crate::turn_driver::DriverError::CleanupUnconfirmed)
    ));
    assert!(matches!(
        handle.progress(),
        crate::turn_driver::Progress::Quarantined(_)
    ));
    assert_eq!(
        f.state.driver.get().unwrap().active_ticket(&f.key),
        Some(ticket.clone())
    );
    assert_eq!(f.service.slots.available_permits(), 31);
    assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    f.assert_neighbor(neighbor.id());
    f.broker_gate.as_ref().unwrap().release();
    // Exact Broker IO may now finish; lost question-task drain proof remains
    // Unknown, so neither its call capacity nor Driver lease may be released.
    bounded(async {
        while f.state.permissions.get().unwrap().reserved_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(bounded(f.runtime.shutdown()).await.is_err());
    assert_eq!(
        f.state.driver.get().unwrap().active_ticket(&f.key),
        Some(ticket)
    );
    assert_eq!(f.service.slots.available_permits(), 31);
    f.assert_neighbor(neighbor.id());
    neighbor.cancel();
    bounded(neighbor.drained()).await;
    f.stop_server().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caller_drop_and_cancel_keep_actual_requested_io_until_owned_drain_and_neighbor_survives() {
    let f = Fixture::with_gate(Some("permission.requested")).await;
    let neighbor = f.neighbor();
    let before = PauseGuard::new(&f.service.hooks.before);
    let handle = f.start().await;
    let ticket = handle.ticket().clone();
    let mut progress = handle.subscribe_progress();
    before.entered().await;
    drop(handle);
    assert_eq!(f.service.slots.available_permits(), 31);
    assert_eq!(
        f.state.driver.get().unwrap().active_ticket(&f.key),
        Some(ticket.clone())
    );
    before.release();
    bounded(f.broker_gate.as_ref().unwrap().entered.notified()).await;
    assert!(f.runtime.stop(&f.key, None).unwrap());
    assert!(bounded(f.runtime.shutdown()).await.is_err());
    assert_eq!(
        f.state.driver.get().unwrap().active_ticket(&f.key),
        Some(ticket)
    );
    assert_eq!(f.service.slots.available_permits(), 31);
    f.assert_neighbor(neighbor.id());
    assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    f.broker_gate.as_ref().unwrap().release();
    // A retry is retained, but its checkpoint may precede actual worker release.
    // Only real Finished plus exact slot release permits the final known close.
    let retry = tokio::spawn(f.runtime.shutdown());
    bounded(async {
        loop {
            if matches!(
                &*progress.borrow_and_update(),
                crate::turn_driver::Progress::Finished(_)
            ) {
                break;
            }
            progress.changed().await.unwrap();
        }
    })
    .await;
    let early = bounded(retry).await.unwrap();
    assert!(matches!(
        early,
        Ok(()) | Err(crate::zcode_runtime::RuntimeError::CleanupUnconfirmed)
    ));
    assert_eq!(f.state.driver.get().unwrap().active_ticket(&f.key), None);
    assert_eq!(f.service.slots.available_permits(), 32);
    f.assert_neighbor(neighbor.id());
    assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    neighbor.cancel();
    bounded(neighbor.drained()).await;
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unqualified_native_profiles_never_open_inbox_or_owner_fallback() {
    struct Case(&'static str);
    impl Drop for Case {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("unsupported native profile={}", self.0);
            }
        }
    }
    for case in [
        "missing_tid",
        "foreign_tid",
        "origin",
        "pre_started",
        "persistent_rule",
        "modified_native_option",
        "always_option",
        "session_option",
        "capability_input",
    ] {
        let _case = Case(case);
        let f = Fixture::new().await;
        let mut handle = bounded(f.runtime.execute(
            f.key.clone(),
            Input {
                text: json!({"id":f.note["id"],"case":case}).to_string(),
                metadata: Default::default(),
            },
        ))
        .await
        .unwrap();
        let accepted = bounded(handle.accepted()).await.unwrap();
        assert!(accepted.user_event_id > 0);
        assert_eq!(
            bounded(handle.wait()).await.unwrap().turn.outcome,
            Outcome::Success,
            "profile={case}"
        );
        let proof = f.proof().unwrap();
        assert_eq!(proof["decision"], "deny", "profile={case}");
        assert!(proof.get("memoryDetails").is_none());
        assert!(crate::permission_state::list(&f.state, Some(&f.key.name)).is_empty());
        assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 0);
        assert_eq!(f.service.slots.available_permits(), 32);
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn five_actual_workers_cannot_exceed_global_32_while_driver_receipts_are_held() {
    struct Phase(std::cell::Cell<usize>);
    impl Drop for Phase {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("actual global cap phase={}", self.0.get());
            }
        }
    }
    let phase = Phase(std::cell::Cell::new(0));
    let f = Fixture::configured(None, true).await;
    phase.0.set(1);
    let receipts = f.receipts.as_ref().unwrap();
    let mut handles = Vec::new();
    let mut keys = Vec::new();
    for i in 0..5 {
        phase.0.set(10 + i * 10);
        let key = SessionKey {
            name: format!("native-cap-{i}"),
            created_at: f.key.created_at.clone(),
        };
        let mut record = f
            .state
            .registry
            .lock()
            .unwrap()
            .find(&f.key.name)
            .unwrap()
            .clone();
        record.set_string("name", &key.name);
        f.state.registry.lock().unwrap().insert(record).unwrap();
        phase.0.set(11 + i * 10);
        let mut handle = bounded(f.runtime.execute_queued(
            key.clone(),
            Input {
                text: json!({"id":f.note["id"],"count":8}).to_string(),
                metadata: crate::turn_driver::InputMetadata {
                    queue_item_id: Some(format!("cap-receipt-{i}")),
                    queue_item_at: Some("2026-11-13T00:00:00Z".into()),
                    ..Default::default()
                },
            },
        ))
        .await
        .unwrap();
        phase.0.set(12 + i * 10);
        if i < 4 {
            receipts.entered(i + 1).await;
        } else {
            let terminal = bounded(handle.wait()).await.unwrap();
            assert!(
                matches!(terminal.turn.outcome,Outcome::Failure{ref code,..} if code=="capacity")
            );
        }
        phase.0.set(13 + i * 10);
        if i < 4 {
            bounded(async {
                while f.service.slots.available_permits() != 32 - 8 * (i + 1) {
                    tokio::task::yield_now().await;
                }
            })
            .await;
        }
        handles.push(handle);
        keys.push(key);
    }
    phase.0.set(60);
    assert_eq!(f.service.slots.available_permits(), 0);
    assert_eq!(
        f.service
            .hooks
            .requests
            .load(std::sync::atomic::Ordering::Acquire),
        0
    );
    assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 0);
    for handle in &handles[..4] {
        assert!(matches!(
            handle.progress(),
            crate::turn_driver::Progress::Starting
        ));
    }
    assert!((4..=5).contains(&f.state.driver.get().unwrap().active_count()));
    // Cancellation starts while every actual durable user receipt is still
    // retained. The fifth peer cannot bypass global admission into the Broker.
    for key in &keys[..4] {
        assert!(f.runtime.stop(key, None).unwrap());
    }
    phase.0.set(61);
    let mut closing = f.runtime.shutdown();
    assert!(matches!(
        closing
            .as_mut()
            .poll(&mut std::task::Context::from_waker(std::task::Waker::noop())),
        std::task::Poll::Pending
    ));
    phase.0.set(62);
    receipts.open.send_replace(true);
    phase.0.set(63);
    let retry = tokio::spawn(closing);
    for (i, handle) in handles.iter().enumerate() {
        phase.0.set(70 + i);
        let mut progress = handle.subscribe_progress();
        let wait = async {
            loop {
                if matches!(
                    &*progress.borrow_and_update(),
                    crate::turn_driver::Progress::Finished(_)
                ) {
                    break;
                }
                progress.changed().await.unwrap();
            }
        };
        if tokio::time::timeout(Duration::from_secs(15), wait)
            .await
            .is_err()
        {
            for (n, h) in handles.iter().enumerate() {
                let tag = match h.progress() {
                    crate::turn_driver::Progress::Starting => 1,
                    crate::turn_driver::Progress::Running(_) => 2,
                    crate::turn_driver::Progress::Closing => 3,
                    crate::turn_driver::Progress::Quarantined(_) => 4,
                    crate::turn_driver::Progress::Finished(_) => 5,
                };
                eprintln!("actual global cap handle={n} progress={tag}");
            }
            eprintln!(
                "actual global cap remaining_slots={} broker_reserved={}",
                f.service.slots.available_permits(),
                f.state.permissions.get().unwrap().reserved_count()
            );
            panic!("actual global cap known close watchdog");
        }
    }
    assert!(matches!(
        bounded(retry).await.unwrap(),
        Ok(()) | Err(crate::zcode_runtime::RuntimeError::CleanupUnconfirmed)
    ));
    assert_eq!(f.service.slots.available_permits(), 32);
    assert_eq!(f.state.driver.get().unwrap().active_count(), 0);
    assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 0);
    let terminal = bounded(handles[4].wait()).await.unwrap();
    assert!(matches!(terminal.turn.outcome,Outcome::Failure{ref code,..} if code=="capacity"));
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_context_and_ticket_revocation_after_actual_card_cannot_authorize_handoff() {
    for fault in 0..4 {
        let f = Fixture::new().await;
        let after = PauseGuard::new(&f.service.hooks.after);
        let mut handle = f.start().await;
        after.entered().await;
        let card = f.card().await;
        match fault {
            0 => {
                f.state
                    .registry
                    .lock()
                    .unwrap()
                    .update_checked(&f.key, |r| {
                        r.set_raw(
                            "memory",
                            serde_json::value::to_raw_value(&json!({"read":false,"write":"off"}))
                                .unwrap(),
                        );
                        Ok(())
                    })
                    .unwrap();
            }
            1 => {
                f.state.session_memory.lock().unwrap().revoke(&f.key.name);
            }
            2 => {
                f.state.driver.get().unwrap().cancel(handle.ticket());
            }
            3 => {
                f.state
                    .registry
                    .lock()
                    .unwrap()
                    .update_checked(&f.key, |r| {
                        r.set_bool("private", true);
                        Ok(())
                    })
                    .unwrap();
            }
            _ => unreachable!(),
        }
        crate::permission_state::resolve(
            &f.state,
            card["id"].as_str().unwrap(),
            Decision::allow(Scope::Once),
            "fixture-owner",
        )
        .unwrap();
        after.release();
        let terminal = bounded(handle.wait()).await.unwrap();
        assert_ne!(terminal.turn.outcome, Outcome::Success, "fault={fault}");
        assert!(
            !f.proof().is_some_and(|p| p["decision"] == "allow"),
            "fault={fault}"
        );
        assert_eq!(f.service.slots.available_permits(), 32);
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_native_once_does_not_approve_a_separate_shared_memory_proposal() {
    let f = Fixture::new().await;
    f.state
        .registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |r| {
            r.set_string("approval", "ask");
            r.set_raw(
                "memory",
                serde_json::value::to_raw_value(&json!({"read":true,"write":"ask"})).unwrap(),
            );
            Ok(())
        })
        .unwrap();
    let cwd = PathBuf::from(
        f.state
            .registry
            .lock()
            .unwrap()
            .find(&f.key.name)
            .unwrap()
            .scalar("cwd")
            .unwrap(),
    );
    let context = Context {
        project_id: Some(crate::memory_project::resolve(&cwd).unwrap()),
        session: Some(f.key.name.clone()),
    };
    let before = f
        .state
        .memory
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .execute("memory.list", &json!({}), &context)
        .unwrap();
    let mut handle = bounded(f.runtime.execute(
        f.key.clone(),
        Input {
            text: json!({"id":f.note["id"],"case":"proposal"}).to_string(),
            metadata: Default::default(),
        },
    ))
    .await
    .unwrap();
    assert!(bounded(handle.accepted()).await.unwrap().user_event_id > 0);
    let native = f.card().await;
    assert_eq!(native["toolName"], "ZCodePermission");
    crate::permission_state::resolve(
        &f.state,
        native["id"].as_str().unwrap(),
        Decision::allow(Scope::Once),
        "fixture-owner",
    )
    .unwrap();
    let proposal = bounded(async {
        loop {
            if let Some(card) = crate::permission_state::list(&f.state, Some(&f.key.name))
                .into_iter()
                .find(|c| c["toolName"] == "pult_memory.propose")
            {
                break card;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_ne!(proposal["id"], native["id"]);
    assert!(f.proof().is_some_and(|p| p["decision"] == "allow"));
    assert_eq!(
        f.state
            .memory
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .execute("memory.list", &json!({}), &context)
            .unwrap(),
        before
    );
    crate::permission_state::resolve(
        &f.state,
        proposal["id"].as_str().unwrap(),
        Decision::deny(),
        "fixture-owner",
    )
    .unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    let proof = f.proof().unwrap();
    assert_eq!(proof["helperGetError"], true);
    assert_eq!(
        f.state
            .memory
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .execute("memory.list", &json!({}), &context)
            .unwrap(),
        before
    );
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_actual_pending_rejects_wrong_ticket_generation_request_arc_and_expired_action() {
    use crate::zcode_appserver_worker::ReverseContext;
    let f = Fixture::new().await;
    let mut handle = f.start().await;
    let card = f.card().await;
    let pending = f.service.hooks.pending.lock().unwrap().upgrade().unwrap();
    let source = pending.source.get().unwrap();
    let mut other = source.initial().clone();
    other.key.name = "other-ticket".into();
    let wrong = crate::turn_coordinator::Coordinator::new(Default::default())
        .unwrap()
        .reserve(other)
        .unwrap();
    let adapter = f.service.scoped(f.key.clone());
    for (ticket, generation) in [
        (wrong.clone(), pending.generation),
        (pending.ticket.clone(), pending.generation + 1),
    ] {
        assert!(
            bounded(adapter.handle(
                ReverseContext {
                    ticket,
                    generation,
                    pending: Some(pending.clone())
                },
                pending.request.clone()
            ))
            .await
            .is_err()
        );
    }
    let crate::zcode_appserver_protocol::ReverseRequest::Permission {
        payload: crate::zcode_appserver_protocol::NativePermissionPayload::Retained(data),
        ..
    } = &*pending.request
    else {
        unreachable!()
    };
    let raw = format!(
        "{{\"id\":\"native-permission-rpc\",\"method\":\"interaction/requestPermission\",\"params\":{}}}\n",
        data.untrusted_params().get()
    );
    let crate::zcode_appserver_protocol::Incoming::Reverse(copy) =
        crate::zcode_appserver_protocol::decode_frame(raw.as_bytes()).unwrap()
    else {
        unreachable!()
    };
    assert!(
        bounded(adapter.handle(
            ReverseContext {
                ticket: pending.ticket.clone(),
                generation: pending.generation,
                pending: Some(pending.clone())
            },
            Arc::new(copy)
        ))
        .await
        .is_err()
    );
    let driver = f.state.driver.get().unwrap();
    let expired = crate::turn_driver::NativeReplyAction::new(
        pending.ticket.clone(),
        std::time::Instant::now() - Duration::from_secs(1),
    );
    assert!(!driver.seal_native_reply(
        &pending.ticket,
        source.initial(),
        source.accepted(),
        &expired
    ));
    let foreign = crate::turn_driver::NativeReplyAction::new(
        wrong,
        std::time::Instant::now() + Duration::from_secs(30),
    );
    assert!(!driver.seal_native_reply(
        &pending.ticket,
        source.initial(),
        source.accepted(),
        &foreign
    ));
    assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 1);
    // All negatives above must leave the actual original card/action usable.
    crate::permission_state::resolve(
        &f.state,
        card["id"].as_str().unwrap(),
        Decision::allow(Scope::Once),
        "fixture-owner",
    )
    .unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    assert_eq!(
        f.proof().unwrap()["memoryDetails"],
        "EXACT_SHARED_NATIVE_DETAILS"
    );
    assert!(!driver.seal_native_reply(
        &pending.ticket,
        source.initial(),
        source.accepted(),
        pending.action.get().unwrap()
    ));
    assert!(
        bounded(adapter.handle(
            ReverseContext {
                ticket: pending.ticket.clone(),
                generation: pending.generation,
                pending: Some(pending.clone())
            },
            pending.request.clone()
        ))
        .await
        .is_err()
    );
    drop(pending);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_duplicate_ids_changed_same_rpc_and_local_ninth_call_fail_closed() {
    for (case, count, expected) in [
        ("duplicate_rpc", 1, "protocol_error"),
        ("duplicate_request", 1, "protocol_error"),
        ("changed_same_rpc", 1, "protocol_error"),
        ("normal", 9, "capacity"),
    ] {
        let f = Fixture::new().await;
        let mut handle = bounded(f.runtime.execute(
            f.key.clone(),
            Input {
                text: json!({"id":f.note["id"],"case":case,"count":count}).to_string(),
                metadata: Default::default(),
            },
        ))
        .await
        .unwrap();
        let terminal = bounded(handle.wait()).await.unwrap();
        assert!(
            matches!(terminal.turn.outcome,Outcome::Failure{ref code,..}if code==expected),
            "case={case}"
        );
        assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
        assert_eq!(f.service.slots.available_permits(), 32);
        assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 0);
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn driver_reply_action_is_single_use_without_becoming_human_approval() {
    let f = Fixture::new().await;
    let mut handle = f.start().await;
    let card = f.card().await;
    let pending = f.service.hooks.pending.lock().unwrap().upgrade().unwrap();
    let source = pending.source.get().unwrap();
    let driver = f.state.driver.get().unwrap();
    let action = crate::turn_driver::NativeReplyAction::new(
        pending.ticket.clone(),
        std::time::Instant::now() + Duration::from_secs(30),
    );
    let mut wrong_receipt = source.accepted().clone();
    wrong_receipt.user_event_id += 1;
    assert!(!driver.seal_native_reply(&pending.ticket, source.initial(), &wrong_receipt, &action));
    let mut wrong_snapshot = source.initial().clone();
    wrong_snapshot.cwd = f.state.home.clone();
    assert!(!driver.seal_native_reply(
        &pending.ticket,
        &wrong_snapshot,
        source.accepted(),
        &action
    ));
    assert!(driver.seal_native_reply(
        &pending.ticket,
        source.initial(),
        source.accepted(),
        &action
    ));
    assert!(!driver.seal_native_reply(
        &pending.ticket,
        source.initial(),
        source.accepted(),
        &action
    ));
    let cancelled = crate::turn_driver::NativeReplyAction::new(
        pending.ticket.clone(),
        std::time::Instant::now() + Duration::from_secs(30),
    );
    assert!(cancelled.cancel());
    assert!(!cancelled.cancel());
    assert!(!driver.seal_native_reply(
        &pending.ticket,
        source.initial(),
        source.accepted(),
        &cancelled
    ));
    // A separate private Driver action does not issue a Broker receipt or write
    // a native reply. Actual human denial still controls the pending request.
    assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    crate::permission_state::resolve(
        &f.state,
        card["id"].as_str().unwrap(),
        Decision::deny(),
        "fixture-owner",
    )
    .unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    assert_eq!(f.proof().unwrap()["decision"], "deny");
    drop(pending);
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_adapter_revoke_is_exact_generation_and_never_cancels_neighbor_cards() {
    use crate::zcode_appserver_worker::NativeInteractions;
    for exact in [false, true] {
        let f = Fixture::new().await;
        let neighbor = f.neighbor();
        let mut handle = f.start().await;
        let card = f.card().await;
        let pending = f.service.hooks.pending.lock().unwrap().upgrade().unwrap();
        let adapter = f.service.hooks.adapter.lock().unwrap().upgrade().unwrap();
        let generation = pending.generation + u64::from(!exact);
        adapter.revoke(&pending.ticket, generation);
        bounded(adapter.drain(pending.ticket.clone(), generation))
            .await
            .unwrap();
        if !exact {
            assert!(
                crate::permission_state::list(&f.state, Some(&f.key.name))
                    .iter()
                    .any(|c| c["id"] == card["id"])
            );
            crate::permission_state::resolve(
                &f.state,
                card["id"].as_str().unwrap(),
                Decision::allow(Scope::Once),
                "fixture-owner",
            )
            .unwrap();
        }
        assert_eq!(
            bounded(handle.wait()).await.unwrap().turn.outcome,
            Outcome::Success
        );
        assert_eq!(
            f.proof().unwrap()["decision"],
            if exact { "deny" } else { "allow" }
        );
        f.assert_neighbor(neighbor.id());
        neighbor.cancel();
        bounded(neighbor.drained()).await;
        drop(pending);
        f.finish().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_once_card_cannot_be_promoted_to_session_or_rule_scope() {
    let f = Fixture::new().await;
    let mut handle = f.start().await;
    let card = f.card().await;
    assert!(card.get("offers").is_none());
    for scope in [Scope::Session, Scope::Rule] {
        let result = crate::permission_state::resolve(
            &f.state,
            card["id"].as_str().unwrap(),
            Decision::allow(scope),
            "fixture-owner",
        )
        .unwrap();
        assert!(matches!(
            bounded(result.wait()).await,
            Err(crate::permission_broker::BrokerError::InvalidScope)
        ));
        assert!(
            crate::permission_state::list(&f.state, Some(&f.key.name))
                .iter()
                .any(|c| c["id"] == card["id"])
        );
        assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    }
    crate::permission_state::resolve(
        &f.state,
        card["id"].as_str().unwrap(),
        Decision::deny(),
        "fixture-owner",
    )
    .unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    assert_eq!(f.proof().unwrap()["decision"], "deny");
    f.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_poststarted_binder_remains_owned_through_cancel_and_quarantine_until_joined() {
    let f = Fixture::new().await;
    let binder = BlockingGuard::new(&f.service.hooks.binder);
    struct Phase<'a> {
        f: &'a Fixture,
        at: std::cell::Cell<u8>,
    }
    impl Drop for Phase<'_> {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!(
                    "actual binder phase={} raw_slots_free={} driver_active={} broker_reserved={} adapter_requests={}",
                    self.at.get(),
                    self.f.service.slots.available_permits(),
                    self.f.state.driver.get().unwrap().active_count(),
                    self.f.state.permissions.get().unwrap().reserved_count(),
                    self.f
                        .service
                        .hooks
                        .requests
                        .load(std::sync::atomic::Ordering::Acquire)
                );
            }
        }
    }
    let phase = Phase {
        f: &f,
        at: std::cell::Cell::new(0),
    };
    let mut handle = f.start().await;
    let ticket = handle.ticket().clone();
    let mut progress = handle.subscribe_progress();
    binder.entered().await;
    assert!(matches!(
        handle.progress(),
        crate::turn_driver::Progress::Running(_)
    ));
    assert_eq!(
        f.service
            .hooks
            .requests
            .load(std::sync::atomic::Ordering::Acquire),
        0
    );
    assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 0);
    assert_eq!(f.service.slots.available_permits(), 31);
    assert!(f.runtime.stop(&f.key, None).unwrap());
    phase.at.set(1);
    assert!(matches!(
        bounded(handle.wait()).await,
        Err(crate::turn_driver::DriverError::CleanupUnconfirmed)
    ));
    phase.at.set(2);
    assert!(matches!(
        handle.progress(),
        crate::turn_driver::Progress::Quarantined(_)
    ));
    assert_eq!(
        f.state.driver.get().unwrap().active_ticket(&f.key),
        Some(ticket)
    );
    phase.at.set(3);
    // await_source ended before issuing any handler/Broker IO, so its raw
    // request scope has dropped. The independent owned SOURCE binder is still
    // blocked and must retain the exact Worker/Driver Ticket until its join.
    assert_eq!(f.service.slots.available_permits(), 32);
    phase.at.set(4);
    assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    drop(binder);
    let closing = tokio::spawn(f.runtime.shutdown());
    bounded(async {
        loop {
            if matches!(
                &*progress.borrow_and_update(),
                crate::turn_driver::Progress::Finished(_)
            ) {
                break;
            }
            progress.changed().await.unwrap();
        }
    })
    .await;
    assert!(matches!(
        bounded(closing).await.unwrap(),
        Ok(()) | Err(crate::zcode_runtime::RuntimeError::CleanupUnconfirmed)
    ));
    assert_eq!(f.state.driver.get().unwrap().active_ticket(&f.key), None);
    assert_eq!(f.service.slots.available_permits(), 32);
    assert_eq!(f.state.permissions.get().unwrap().reserved_count(), 0);
    assert!(!f.proof().is_some_and(|p| p["decision"] == "allow"));
    f.finish().await;
}
