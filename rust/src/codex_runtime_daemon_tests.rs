//! Provider-local shutdown against an actual shared Driver/Broker and fake app-server.
use super::*;
use crate::{
    journal::EventStore,
    registry::Record,
    turn_driver::{Options, Started, Worker, WorkerError},
    turn_journal::JournalSink,
    turn_snapshot::{Approval, TurnSettings},
};
use serde_json::json;
use std::{future::Future, os::unix::fs::PermissionsExt, sync::atomic::AtomicUsize};
use tokio::sync::Semaphore;
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("daemon runtime watchdog")
}
async fn accept(f: &Fixture, handle: &mut Handle) {
    let result = bounded(handle.accepted()).await;
    if let Err(error) = &result {
        eprintln!(
            "daemon fixture acceptance error: {error:?}; progress: {:?}",
            handle.progress()
        );
        if let Ok(raw) = std::fs::read_to_string(f.home.join("events/journal.jsonl")) {
            for line in raw.lines() {
                if let Ok(row) = serde_json::from_str::<Value>(line)
                    && (row["kind"] == "provider.blocked" || row["kind"] == "status.changed")
                {
                    eprintln!(
                        "fixture status: kind={} status={} code={}",
                        row["kind"], row["data"]["status"], row["data"]["code"]
                    );
                }
            }
        }
    }
    result.unwrap();
}
struct Probe(AtomicUsize);
impl crate::network_guard::Probe for Probe {
    fn probe<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: Duration,
    ) -> crate::network_guard::ProbeFuture<'a> {
        Box::pin(async move {
            self.0.fetch_add(1, Ordering::SeqCst);
            crate::network_guard::ProbeResult {
                status: Some(0),
                stdout: b"loc=US\n".to_vec(),
                stderr_bytes: 0,
            }
        })
    }
}
// Test-only second IO stage: releasing the original fixture gate is not a
// journal receipt. This permanently opens for all admitted/late waiters.
struct OwnedIoPause {
    entered: Notify,
    open: watch::Sender<bool>,
    admitted: AtomicUsize,
    receipts: AtomicUsize,
    receipt_changed: Notify,
}
impl OwnedIoPause {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: Notify::new(),
            open: watch::channel(false).0,
            admitted: AtomicUsize::new(0),
            receipts: AtomicUsize::new(0),
            receipt_changed: Notify::new(),
        })
    }
    async fn wait(&self) {
        let mut open = self.open.subscribe();
        self.entered.notify_one();
        while !*open.borrow_and_update() {
            open.changed().await.unwrap();
        }
    }
    async fn receipt(&self) {
        loop {
            let changed = self.receipt_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.receipts.load(Ordering::Acquire) > 0 {
                return;
            }
            changed.await;
        }
    }
}
struct OpenOwnedIo(Arc<OwnedIoPause>);
impl Drop for OpenOwnedIo {
    fn drop(&mut self) {
        self.0.open.send_replace(true);
    }
}
struct Sink {
    inner: Arc<JournalSink>,
    block: AtomicBool,
    permission: AtomicBool,
    entered: Notify,
    release: Arc<Semaphore>,
    after_release: Mutex<Option<Arc<OwnedIoPause>>>,
}
impl EventSink for Sink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let blocked = self.block.load(Ordering::Acquire)
            && draft["sessionId"] == "one"
            && (draft["kind"] == "message.done"
                || (self.permission.load(Ordering::Acquire)
                    && draft["kind"] == "permission.resolved"));
        let inner = self.inner.clone();
        let release = self.release.clone();
        let after_release = self.after_release.lock().unwrap().clone();
        if blocked {
            if let Some(pause) = &after_release {
                pause.admitted.fetch_add(1, Ordering::Release);
            }
            self.entered.notify_one();
        }
        Box::pin(async move {
            if blocked {
                release.acquire_owned().await.unwrap().forget();
                if let Some(pause) = &after_release {
                    pause.wait().await;
                }
            }
            let result = inner.append(draft).await;
            if blocked
                && result.is_ok()
                && let Some(pause) = after_release
            {
                pause.receipts.fetch_add(1, Ordering::Release);
                pause.receipt_changed.notify_waiters();
            }
            result
        })
    }
}
// Snapshot the exact host and lease identity while the accepted ticket owns it.
struct ExactLease {
    ticket: crate::turn_coordinator::Ticket,
    host: Arc<CodexHost>,
    nonce: Arc<()>,
}
impl ExactLease {
    fn capture(runtime: &CodexRuntime, own: &Handle) -> Self {
        let state = runtime.inner.shared.state.lock().unwrap();
        let lease = state.leases.get(own.ticket().session()).unwrap();
        assert_eq!(lease.ticket.as_ref(), Some(own.ticket()));
        Self {
            ticket: own.ticket().clone(),
            host: lease.host.upgrade().unwrap(),
            nonce: lease.nonce.clone(),
        }
    }
    fn assert_current(&self, lease: &Lease) {
        assert_eq!(lease.ticket.as_ref(), Some(&self.ticket));
        assert!(Arc::ptr_eq(&lease.nonce, &self.nonce));
        assert!(Arc::ptr_eq(&lease.host.upgrade().unwrap(), &self.host));
    }
    fn assert_retained(&self, runtime: &CodexRuntime, driver: &Driver) {
        {
            let state = runtime.inner.shared.state.lock().unwrap();
            self.assert_current(state.leases.get(self.ticket.session()).unwrap());
        }
        assert!(driver.execution_snapshot(&self.ticket).is_some());
        assert_eq!(driver.active_count(), 2);
    }
}
async fn io_phase<T>(phase: &'static str, io: &OwnedIoPause, future: impl Future<Output = T>) -> T {
    match tokio::time::timeout(Duration::from_secs(15), future).await {
        Ok(result) => result,
        Err(_) => {
            eprintln!(
                "[fixture-lifecycle] owned-io phase={phase} admitted={} receipts={}",
                io.admitted.load(Ordering::Acquire),
                io.receipts.load(Ordering::Acquire),
            );
            panic!("daemon fixture owned IO watchdog");
        }
    }
}
async fn finish_after_owned_io(
    f: &Fixture,
    runtime: &CodexRuntime,
    own: &mut Handle,
    exact: &ExactLease,
    io: &OwnedIoPause,
) {
    io_phase("journal-receipt", io, io.receipt()).await;
    let quiet = io_phase("exact-host-quiet", io, exact.host.shutdown()).await;
    if quiet.is_err() {
        eprintln!("[fixture-lifecycle] owned-io phase=exact-host-quiet cleanup-unconfirmed=true");
    }
    quiet.unwrap();
    // Host quiet proves its admitted IO/jobs are joined. The Driver's own
    // terminal append may still exceed a bounded runtime checkpoint, so retain
    // that retry while observing its ACTUAL Finished state, not Quarantined.
    let retry = runtime.shutdown();
    let mut progress = own.subscribe_progress();
    let terminal = io_phase("driver-finished", io, async {
        loop {
            let current = progress.borrow_and_update().clone();
            if let Progress::Finished(result) = current {
                break result;
            }
            progress.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        terminal.turn.outcome,
        crate::turn_coordinator::Outcome::Interrupted
    );
    io_phase("same-lease-gone", io, async {
        loop {
            let changed = runtime.inner.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = runtime.inner.shared.state.lock().unwrap();
                let Some(lease) = state.leases.get(exact.ticket.session()) else {
                    break;
                };
                exact.assert_current(lease);
            }
            changed.await;
        }
    })
    .await;
    // An earlier checkpoint error is handled only after stronger new facts:
    // actual receipt, exact host quiet, actual Finished and the same lease gone.
    match io_phase("retained-retry-result", io, retry).await {
        Ok(()) => {}
        Err(RuntimeError::CleanupUnconfirmed) => {
            assert!(io.receipts.load(Ordering::Acquire) > 0);
            assert!(matches!(own.progress(), Progress::Finished(Ok(_))));
            assert!(f.driver.execution_snapshot(&exact.ticket).is_none());
            assert!(
                !runtime
                    .inner
                    .shared
                    .state
                    .lock()
                    .unwrap()
                    .leases
                    .contains_key(exact.ticket.session())
            );
        }
        Err(_) => panic!("unexpected runtime checkpoint error"),
    }
    io_phase("known-quiescent-shutdown", io, runtime.shutdown())
        .await
        .unwrap();
}
struct Manual;
impl Worker for Manual {
    fn start(
        &self,
        _: crate::turn_coordinator::Ticket,
        _: TurnSnapshot,
        _: String,
    ) -> Task<Result<Started, WorkerError>> {
        Box::pin(async {
            Ok(Started {
                turn_id: "neighbor-manual".into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, _: crate::turn_coordinator::Ticket) -> Task<Result<(), WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    cwd: PathBuf,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
    sink: Arc<Sink>,
    driver: Arc<Driver>,
    broker: Broker,
    guard: Arc<NetworkGuard>,
}
fn key(name: &str) -> SessionKey {
    SessionKey {
        name: name.into(),
        created_at: "2026-11-12T00:00:00Z".into(),
    }
}
fn input(text: &str) -> Input {
    Input {
        text: text.into(),
        metadata: Default::default(),
    }
}
impl Fixture {
    fn new(short: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let mut store = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut store).unwrap();
        for name in ["one", "two", "three"] {
            let mut r = Record::default();
            for (k, v) in [
                ("name", name),
                ("createdAt", "2026-11-12T00:00:00Z"),
                ("cwd", cwd.to_str().unwrap()),
                ("provider", "codex"),
                ("approval", "ask"),
            ] {
                r.set_string(k, v);
            }
            registry.insert(r).unwrap();
        }
        let sink = Arc::new(Sink {
            inner: Arc::new(JournalSink::new(Arc::new(Mutex::new(store))).unwrap()),
            block: AtomicBool::new(false),
            permission: AtomicBool::new(false),
            entered: Notify::new(),
            release: Arc::new(Semaphore::new(0)),
            after_release: Mutex::new(None),
        });
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Options {
                    close_timeout: if short {
                        Duration::from_millis(100)
                    } else {
                        Options::default().close_timeout
                    },
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let broker = Broker::new(
            sink.clone(),
            permission_broker::Redactors {
                value: Arc::new(crate::redaction::redact),
                string: Arc::new(crate::redaction::redact_string),
            },
            Default::default(),
        )
        .unwrap();
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        Self {
            _temp: temp,
            home,
            cwd,
            registry: Arc::new(Mutex::new(registry)),
            consent,
            sink,
            driver,
            broker,
            guard: Arc::new(NetworkGuard::new(Arc::new(Probe(AtomicUsize::new(0))))),
        }
    }
    fn runtime(&self, tail: bool) -> Arc<CodexRuntime> {
        let mut source = include_str!("../tests/fixtures/codex_worker.py").replace(
            "'command': 'true'",
            "'command': 'true', 'availableDecisions': ['accept', 'decline', 'cancel']",
        );
        if tail {
            source=source.replace("            finish(thread, status='interrupted')","            notification('item/completed', thread, params['turnId'], item={'type':'agentMessage','id':'tail','text':'owned tail','phase':'final_answer'})\n            finish(thread, status='interrupted')");
            assert!(source.contains("owned tail"));
        }
        let script = self.home.join("app.py");
        std::fs::write(&script, source).unwrap();
        let holder = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("pult-worker-holder");
        assert!(
            holder.is_file(),
            "build pult-worker-holder before module-only tests"
        );
        CodexRuntime::new_daemon(
            Dependencies {
                home: self.home.clone(),
                registry: self.registry.clone(),
                consent: self.consent.clone(),
                driver: self.driver.clone(),
                sink: self.sink.clone(),
            },
            RuntimeConfig::default(),
            TrustedCommand {
                holder,
                program: "/usr/bin/python3".into(),
                prefix_args: vec![
                    "-B".into(),
                    script.into_os_string(),
                    self.home.clone().into_os_string(),
                ],
            },
            [
                ("HOME".into(), self.home.clone().into_os_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]
            .into_iter()
            .collect(),
            Network::Shared(self.guard.clone()),
            Limits {
                timeouts: codex_worker::Timeouts {
                    control: codex_worker::Timeouts::default().control,
                    interrupt: Duration::from_millis(300),
                    ..Default::default()
                },
                ..Default::default()
            },
            None,
            self.broker.clone(),
        )
        .unwrap()
    }
    async fn neighbor(&self, name: &str) -> Handle {
        self.neighbor_provider(name, Provider::Claude).await
    }
    async fn neighbor_provider(&self, name: &str, provider: Provider) -> Handle {
        let mut h = self
            .driver
            .start(
                TurnSnapshot {
                    key: key(name),
                    provider,
                    cwd: self.cwd.clone(),
                    settings: TurnSettings {
                        approval: Approval::Ask,
                        ..Default::default()
                    },
                },
                "manual neighbor".into(),
                Arc::new(Manual),
            )
            .unwrap();
        bounded(h.accepted()).await.unwrap();
        h
    }
    async fn question(&self) -> permission_broker::RequestHandle {
        let h = self
            .broker
            .request(permission_broker::PermissionRequest {
                session_id: "two".into(),
                tool_name: "Read".into(),
                tool_use_id: None,
                input: json!({}),
                offers: Default::default(),
                concealed: false,
            })
            .unwrap();
        bounded(async {
            while self.broker.list(None).is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        h
    }
    async fn finish(
        &self,
        mut handles: Vec<Handle>,
        question: Option<permission_broker::RequestHandle>,
    ) {
        if let Some(q) = question {
            q.cancel();
            bounded(q.drained()).await;
        }
        for h in &mut handles {
            self.driver.cancel(h.ticket());
            bounded(h.wait()).await.unwrap();
        }
        self.broker.shutdown();
        bounded(self.broker.drain()).await;
        bounded(self.driver.shutdown(Duration::from_secs(5)))
            .await
            .unwrap();
    }
}
#[tokio::test]
async fn daemon_shutdown_preserves_neighbor_ticket_broker_and_driver_admission() {
    crate::panic_guard::install();
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if let Some(location) = info.location() {
                eprintln!(
                    "[fixture-lifecycle] panic {}:{}",
                    location.file(),
                    location.line()
                );
            }
        }))
    });
    eprintln!("[fixture-lifecycle] daemon phase=start");
    let f = Fixture::new(false);
    let runtime = f.runtime(false);
    let mut own = bounded(runtime.execute(key("one"), input("hold")))
        .await
        .unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=own-accept-before");
    accept(&f, &mut own).await;
    eprintln!("[fixture-lifecycle] daemon phase=own-accept-after");
    eprintln!("[fixture-lifecycle] daemon phase=neighbor-before");
    let neighbor = f.neighbor("two").await;
    eprintln!("[fixture-lifecycle] daemon phase=neighbor-after");
    eprintln!("[fixture-lifecycle] daemon phase=question-before");
    let question = f.question().await;
    eprintln!("[fixture-lifecycle] daemon phase=question-after");
    assert!(runtime.permission_broker().reserved_count() > 0);
    eprintln!("[fixture-lifecycle] daemon phase=shutdown-before");
    bounded(runtime.shutdown()).await.unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=shutdown-after");
    eprintln!("[fixture-lifecycle] daemon phase=own-wait-before");
    bounded(own.wait()).await.unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=own-wait-after");
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    assert_eq!(f.broker.pending_count(), 1);
    assert!(!f.driver.storage_failed());
    eprintln!("[fixture-lifecycle] daemon phase=next-neighbor-before");
    let next = f.neighbor("three").await;
    eprintln!("[fixture-lifecycle] daemon phase=next-neighbor-after");
    let extra = f
        .broker
        .request(permission_broker::PermissionRequest {
            session_id: "three".into(),
            tool_name: "Read".into(),
            tool_use_id: None,
            input: json!({}),
            offers: Default::default(),
            concealed: false,
        })
        .unwrap();
    extra.cancel();
    eprintln!("[fixture-lifecycle] daemon phase=extra-drained-before");
    bounded(extra.drained()).await;
    eprintln!("[fixture-lifecycle] daemon phase=extra-drained-after");
    assert!(matches!(
        runtime.execute(key("one"), input("normal")).await,
        Err(RuntimeError::Closed)
    ));
    let replacement = f.runtime(false);
    eprintln!("[fixture-lifecycle] daemon phase=fresh-execute-before");
    let fresh_result = bounded(replacement.execute(key("one"), input("normal"))).await;
    eprintln!(
        "[fixture-lifecycle] daemon phase=fresh-execute-after error={:?}",
        fresh_result.as_ref().err()
    );
    let mut fresh = fresh_result.unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=fresh-accept-before");
    bounded(fresh.accepted()).await.unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=fresh-accept-after");
    eprintln!("[fixture-lifecycle] daemon phase=fresh-wait-before");
    bounded(fresh.wait()).await.unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=fresh-wait-after");
    eprintln!("[fixture-lifecycle] daemon phase=replacement-shutdown-before");
    bounded(replacement.shutdown()).await.unwrap();
    eprintln!("[fixture-lifecycle] daemon phase=replacement-shutdown-after");
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    assert_eq!(f.broker.pending_count(), 1);
    eprintln!("[fixture-lifecycle] daemon phase=finish-before");
    f.finish(vec![neighbor, next], Some(question)).await;
    eprintln!("[fixture-lifecycle] daemon phase=finish-after");
}
#[tokio::test]
async fn daemon_drop_does_not_close_shared_lifecycle() {
    let f = Fixture::new(false);
    let runtime = f.runtime(false);
    let mut own = runtime.execute(key("one"), input("hold")).await.unwrap();
    accept(&f, &mut own).await;
    let neighbor = f.neighbor_provider("two", Provider::Codex).await;
    let question = f.question().await;
    let shared = runtime.inner.shared.clone();
    drop(runtime);
    bounded(wait_shutdown(&shared)).await.unwrap();
    own.wait().await.unwrap();
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    assert_eq!(f.broker.pending_count(), 1);
    let next = f.neighbor("three").await;
    f.finish(vec![neighbor, next], Some(question)).await;
}
#[tokio::test]
async fn daemon_stop_cannot_select_a_manual_ticket_by_latest_session_name() {
    let f = Fixture::new(false);
    let runtime = f.runtime(false);
    let neighbor = f.neighbor_provider("one", Provider::Codex).await;
    assert!(!runtime.stop(&key("one"), None).unwrap());
    assert!(!runtime.stop_name("one").unwrap());
    bounded(runtime.shutdown()).await.unwrap();
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    f.finish(vec![neighbor], None).await;
}
#[tokio::test]
async fn daemon_shutdown_retains_quarantined_exact_lease_until_terminal_io_known() {
    let f = Fixture::new(true);
    let runtime = f.runtime(true);
    let mut own = runtime.execute(key("one"), input("hold")).await.unwrap();
    accept(&f, &mut own).await;
    let neighbor = f.neighbor("two").await;
    let exact = ExactLease::capture(&runtime, &own);
    let io = OwnedIoPause::new();
    io.open.send_replace(true); // Observe receipts without adding another block.
    *f.sink.after_release.lock().unwrap() = Some(io.clone());
    f.sink.block.store(true, Ordering::Release);
    struct Release(Arc<Semaphore>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }
    let release = Release(f.sink.release.clone());
    let stopping = runtime.shutdown();
    bounded(f.sink.entered.notified()).await;
    assert_eq!(
        bounded(stopping).await,
        Err(RuntimeError::CleanupUnconfirmed)
    );
    assert!(matches!(own.progress(), Progress::Quarantined(_)));
    assert_eq!(
        runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .leases
            .get(&key("one"))
            .unwrap()
            .ticket
            .as_ref(),
        Some(own.ticket())
    );
    assert!(f.driver.execution_snapshot(own.ticket()).is_some());
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    exact.assert_retained(&runtime, &f.driver);
    assert!(matches!(own.progress(), Progress::Quarantined(_)));
    drop(release);
    finish_after_owned_io(&f, &runtime, &mut own, &exact, &io).await;
    bounded(own.wait()).await.unwrap();
    assert!(
        !runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .leases
            .contains_key(&key("one"))
    );
    f.finish(vec![neighbor], None).await;
}

#[tokio::test]
async fn daemon_shutdown_reconciles_ticket_after_blocked_driver_handoff() {
    let mut f = Fixture::new(false);
    let entered = Arc::new(Notify::new());
    let signal = entered.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let receive = Mutex::new(Some(receive));
    struct Release(Option<std::sync::mpsc::Sender<()>>);
    impl Drop for Release {
        fn drop(&mut self) {
            if let Some(send) = self.0.take() {
                let _ = send.send(());
            }
        }
    }
    let release = Release(Some(send));
    f.driver = Arc::new(
        Driver::new(
            f.sink.clone(),
            Arc::new(move |text| {
                if text == "held-admission"
                    && let Some(receive) = receive.lock().unwrap().take()
                {
                    signal.notify_one();
                    receive.recv_timeout(Duration::from_secs(12)).unwrap();
                }
                crate::redaction::redact_string(text)
            }),
            Options::default(),
        )
        .unwrap(),
    );
    let runtime = f.runtime(false);
    let neighbor = f.neighbor("two").await;
    let preparing = runtime.execute(key("one"), input("held-admission"));
    bounded(entered.notified()).await;
    assert!(
        runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .leases
            .get(&key("one"))
            .unwrap()
            .ticket
            .is_none()
    );
    assert_eq!(
        bounded(runtime.shutdown()).await,
        Err(RuntimeError::CleanupUnconfirmed)
    );
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    drop(release);
    let mut own = bounded(preparing).await.unwrap();
    bounded(runtime.shutdown()).await.unwrap();
    bounded(own.wait()).await.unwrap();
    assert!(
        !runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .leases
            .contains_key(&key("one"))
    );
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    let next = f.neighbor("three").await;
    f.finish(vec![neighbor, next], None).await;
}

// This case requires the independent owned-approval/check-guard delta. It is
// exercised in the composed validation tree, not weakened to a global drain.
#[tokio::test]
async fn own_pending_question_holds_ticket_while_neighbor_question_stays_independent() {
    let f = Fixture::new(true);
    let runtime = f.runtime(false);
    let mut own = runtime.execute(key("one"), input("permit")).await.unwrap();
    accept(&f, &mut own).await;
    bounded(async {
        while f.broker.list(Some("one")).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let neighbor = f.neighbor("two").await;
    let question = f.question().await;
    bounded(async {
        while f.broker.list(Some("two")).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    f.sink.permission.store(true, Ordering::Release);
    let exact = ExactLease::capture(&runtime, &own);
    let io = OwnedIoPause::new();
    io.open.send_replace(true); // Observe receipts without adding another block.
    *f.sink.after_release.lock().unwrap() = Some(io.clone());
    f.sink.block.store(true, Ordering::Release);
    struct Release(Arc<Semaphore>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }
    let release = Release(f.sink.release.clone());
    let stopping = runtime.shutdown();
    bounded(f.sink.entered.notified()).await;
    assert_eq!(
        bounded(stopping).await,
        Err(RuntimeError::CleanupUnconfirmed)
    );
    assert!(f.driver.execution_snapshot(own.ticket()).is_some());
    assert_eq!(
        runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .leases
            .get(&key("one"))
            .unwrap()
            .ticket
            .as_ref(),
        Some(own.ticket())
    );
    assert_eq!(f.broker.list(Some("two")).len(), 1);
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    exact.assert_retained(&runtime, &f.driver);
    assert!(matches!(own.progress(), Progress::Quarantined(_)));
    drop(release);
    finish_after_owned_io(&f, &runtime, &mut own, &exact, &io).await;
    bounded(own.wait()).await.unwrap();
    assert_eq!(f.broker.list(Some("two")).len(), 1);
    assert!(!f.broker.storage_failed());
    let next = f.neighbor("three").await;
    f.finish(vec![neighbor, next], Some(question)).await;
}

#[tokio::test]
async fn released_fixture_gate_does_not_make_owned_terminal_io_or_retry_known() {
    let f = Fixture::new(true);
    let runtime = f.runtime(true);
    let mut own = runtime.execute(key("one"), input("hold")).await.unwrap();
    accept(&f, &mut own).await;
    let (host, nonce) = {
        let state = runtime.inner.shared.state.lock().unwrap();
        let lease = state.leases.get(&key("one")).unwrap();
        assert_eq!(lease.ticket.as_ref(), Some(own.ticket()));
        (lease.host.upgrade().unwrap(), lease.nonce.clone())
    };
    let neighbor = f.neighbor("two").await;
    let pause = OwnedIoPause::new();
    let opened_io = OpenOwnedIo(pause.clone());
    *f.sink.after_release.lock().unwrap() = Some(pause.clone());
    f.sink.block.store(true, Ordering::Release);
    struct Release(Arc<Semaphore>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }
    let release = Release(f.sink.release.clone());
    let stopping = runtime.shutdown();
    bounded(f.sink.entered.notified()).await;
    assert_eq!(
        bounded(stopping).await,
        Err(RuntimeError::CleanupUnconfirmed)
    );
    assert!(matches!(own.progress(), Progress::Quarantined(_)));
    drop(release);
    bounded(pause.entered.notified()).await;
    assert_eq!(pause.receipts.load(Ordering::Acquire), 0);
    // Same public retry as the original tests, while the admitted append is
    // provably still waiting BEFORE its actual JournalSink receipt.
    let retry = runtime.shutdown();
    let result = bounded(retry).await;
    eprintln!(
        "[fixture-lifecycle] second-io retry-cleanup-unconfirmed={} actual-receipt=false",
        result == Err(RuntimeError::CleanupUnconfirmed)
    );
    assert_eq!(result, Err(RuntimeError::CleanupUnconfirmed));
    assert_eq!(pause.receipts.load(Ordering::Acquire), 0);
    {
        let state = runtime.inner.shared.state.lock().unwrap();
        let lease = state.leases.get(&key("one")).unwrap();
        assert_eq!(lease.ticket.as_ref(), Some(own.ticket()));
        assert!(Arc::ptr_eq(&lease.nonce, &nonce));
        assert!(Arc::ptr_eq(&lease.host.upgrade().unwrap(), &host));
    }
    assert_eq!(f.driver.active_count(), 2);
    assert!(f.driver.execution_snapshot(own.ticket()).is_some());
    assert!(matches!(own.progress(), Progress::Quarantined(_)));
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    // Open the controlled second stage permanently; then observe the actual
    // receipt and this exact host's quiet joined cleanup, not a permit grant.
    drop(opened_io);
    bounded(pause.receipt()).await;
    bounded(host.shutdown()).await.unwrap();
    let retry = runtime.shutdown();
    let mut progress = own.subscribe_progress();
    let terminal = bounded(async {
        loop {
            let current = progress.borrow_and_update().clone();
            if let Progress::Finished(result) = current {
                break result;
            }
            progress.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(
        terminal.turn.outcome,
        crate::turn_coordinator::Outcome::Interrupted
    );
    bounded(retry).await.unwrap();
    bounded(runtime.shutdown()).await.unwrap();
    assert!(
        !runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .leases
            .contains_key(&key("one"))
    );
    assert!(f.driver.execution_snapshot(own.ticket()).is_none());
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    f.finish(vec![neighbor], None).await;
}
