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
struct Sink {
    inner: Arc<JournalSink>,
    block: AtomicBool,
    permission: AtomicBool,
    entered: Notify,
    release: Arc<Semaphore>,
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
        if blocked {
            self.entered.notify_one();
        }
        Box::pin(async move {
            if blocked {
                release.acquire_owned().await.unwrap().forget();
            }
            inner.append(draft).await
        })
    }
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
    let f = Fixture::new(false);
    let runtime = f.runtime(false);
    let mut own = bounded(runtime.execute(key("one"), input("hold")))
        .await
        .unwrap();
    accept(&f, &mut own).await;
    let neighbor = f.neighbor("two").await;
    let question = f.question().await;
    assert!(runtime.permission_broker().reserved_count() > 0);
    bounded(runtime.shutdown()).await.unwrap();
    bounded(own.wait()).await.unwrap();
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    assert_eq!(f.broker.pending_count(), 1);
    assert!(!f.driver.storage_failed());
    let next = f.neighbor("three").await;
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
    bounded(extra.drained()).await;
    assert!(matches!(
        runtime.execute(key("one"), input("normal")).await,
        Err(RuntimeError::Closed)
    ));
    let replacement = f.runtime(false);
    let mut fresh = bounded(replacement.execute(key("one"), input("normal")))
        .await
        .unwrap();
    bounded(fresh.accepted()).await.unwrap();
    bounded(fresh.wait()).await.unwrap();
    bounded(replacement.shutdown()).await.unwrap();
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    assert_eq!(f.broker.pending_count(), 1);
    f.finish(vec![neighbor, next], Some(question)).await;
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
    drop(release);
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
    drop(release);
    bounded(runtime.shutdown()).await.unwrap();
    bounded(own.wait()).await.unwrap();
    assert_eq!(f.broker.list(Some("two")).len(), 1);
    assert!(!f.broker.storage_failed());
    let next = f.neighbor("three").await;
    f.finish(vec![neighbor, next], Some(question)).await;
}
