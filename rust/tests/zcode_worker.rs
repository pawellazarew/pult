//! Actual holder + synthetic native Route A + durable Owner/Driver/journal.
use pult_core::{
    consent_store::ConsentStore,
    journal::EventStore,
    registry::{Record, Registry},
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{Driver, Handle, Input, InputMetadata, Options},
    turn_journal::JournalSink,
    turn_snapshot::{SessionKey, TurnSnapshot},
    worker_process::{Launch, SpawnDenied, SpawnGate, SpawnPermit},
    zcode_host_services::{
        Acceptance, Attempt, Error as StoreError, JoinedCleanup, ReserveRequest, SessionStore,
        TurnStartedEvidence, ZcodeOwner,
    },
    zcode_launch::ContextLanguage,
    zcode_worker::{Config, ProviderSignal, Services, ZcodeWorker},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
struct Gate {
    owner: Arc<ZcodeOwner>,
    attempt: Attempt,
    panic_release: bool,
    barrier: Option<Arc<GateBarrier>>,
}
struct Permit(bool);
impl SpawnPermit for Permit {}
impl Drop for Permit {
    fn drop(&mut self) {
        assert!(!self.0, "synthetic release panic");
    }
}
impl SpawnGate for Gate {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        if let Some(barrier) = &self.barrier {
            barrier.entered.notify_one();
            let mut released = barrier.released.lock().unwrap();
            while !*released {
                released = barrier.wake.wait(released).unwrap();
            }
        }
        if !self.owner.seal_spawn(&self.attempt) {
            return Err(SpawnDenied);
        }
        Ok(Box::new(Permit(self.panic_release)))
    }
}
#[derive(Default)]
struct GateBarrier {
    entered: tokio::sync::Notify,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}
impl GateBarrier {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
struct Rig {
    _temp: tempfile::TempDir,
    home: PathBuf,
    key: SessionKey,
    registry: Arc<Mutex<Registry>>,
    journal: Arc<Mutex<EventStore>>,
    driver: Arc<Driver>,
    owner: Arc<ZcodeOwner>,
    sink: Arc<JournalSink>,
    signals: Arc<Mutex<Vec<ProviderSignal>>>,
}
fn python() -> PathBuf {
    [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
    .unwrap()
}
impl Rig {
    fn new(resume: Option<&str>) -> Self {
        Self::options(resume, Options::default())
    }
    fn options(resume: Option<&str>, options: Options) -> Self {
        pult_core::panic_guard::install();
        static HOOK: std::sync::Once = std::sync::Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                if let Some(at) = info.location() {
                    eprintln!("ZCode fixture panic {}:{}", at.file(), at.line());
                }
            }))
        });
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let key = SessionKey {
            name: "chat".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let mut rec = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
            ("title", "preserved"),
        ] {
            rec.set_string(k, v);
        }
        if let Some(v) = resume {
            rec.set_string("providerSessionId", v);
        }
        registry.insert(rec).unwrap();
        let registry = Arc::new(Mutex::new(registry));
        let journal = Arc::new(Mutex::new(journal));
        let sink = Arc::new(JournalSink::new(journal.clone()).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(pult_core::redaction::redact_string),
                options,
            )
            .unwrap(),
        );
        let owner = ZcodeOwner::new(
            home.clone(),
            registry.clone(),
            Arc::downgrade(&driver),
            Arc::new(Mutex::new(ConsentStore::open(&home).unwrap())),
            Arc::new(|_, _| true),
            Arc::new(|| {}),
        )
        .unwrap();
        Self {
            _temp: temp,
            home,
            key,
            registry,
            journal,
            driver,
            owner,
            sink,
            signals: Arc::default(),
        }
    }
    fn snapshot(&self) -> TurnSnapshot {
        self.owner.snapshot(&self.key).unwrap()
    }
    fn worker(&self, mode: &str) -> Arc<ZcodeWorker> {
        self.worker_gate(mode, false, false)
    }
    fn worker_gate(&self, mode: &str, panic_enter: bool, panic_release: bool) -> Arc<ZcodeWorker> {
        self.worker_barrier(mode, panic_enter, panic_release, None)
    }
    fn worker_barrier(
        &self,
        mode: &str,
        panic_enter: bool,
        panic_release: bool,
        barrier: Option<Arc<GateBarrier>>,
    ) -> Arc<ZcodeWorker> {
        self.worker_store(mode, panic_enter, panic_release, barrier, None)
    }
    fn worker_store(
        &self,
        mode: &str,
        panic_enter: bool,
        panic_release: bool,
        barrier: Option<Arc<GateBarrier>>,
        store: Option<Arc<dyn SessionStore>>,
    ) -> Arc<ZcodeWorker> {
        let owner = self.owner.clone();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let restrict = mode == "restrict-final";
        let gate_owner = self.owner.clone();
        let signals = self.signals.clone();
        ZcodeWorker::new(
            Config {
                session: self.key.clone(),
                home: self.home.clone(),
                launch: Launch {
                    holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                    program: python(),
                    args: vec![
                        "-B".into(),
                        Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("tests/fixtures/zcode_worker.py")
                            .into_os_string(),
                        self.home.as_os_str().to_owned(),
                        mode.into(),
                    ],
                    cwd: self.home.join("project"),
                    env: BTreeMap::from([
                        ("PATH".into(), "/usr/bin:/bin".into()),
                        ("HOME".into(), self.home.as_os_str().to_owned()),
                    ]),
                },
                attachments: vec![],
                broker_context: false,
                language: ContextLanguage::En,
                start_timeout: Duration::from_secs(5),
                terminal_grace: Duration::from_secs(1),
            },
            Services {
                driver: Arc::downgrade(&self.driver),
                sink: self.sink.clone(),
                gate: Arc::new(move |t: &Ticket, s: &TurnSnapshot| {
                    let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if restrict && n >= 1 {
                        pult_core::turn_driver::DispatchDecision::Restrict(
                            pult_core::turn_snapshot::Approval::ReadOnly,
                        )
                    } else {
                        gate_owner.gate(t, s)
                    }
                }),
                store: store.unwrap_or_else(|| self.owner.store()),
                spawn_gate: Arc::new(move |attempt, _, _| {
                    assert!(!panic_enter, "synthetic gate construction panic");
                    Ok(Arc::new(Gate {
                        owner: owner.clone(),
                        attempt,
                        panic_release,
                        barrier: barrier.clone(),
                    }))
                }),
                redactors: Arc::new(|| Box::new(pult_core::zcode_events::LogRedactor)),
                fatal_storage: Arc::new(|| {}),
                provider_signal: Arc::new(move |v| signals.lock().unwrap().push(v)),
            },
        )
        .unwrap()
    }
    fn start(&self, worker: Arc<ZcodeWorker>, deferred: bool) -> Handle {
        let snapshot = self.snapshot();
        let gate = self.owner.clone();
        self.driver
            .start_input(
                snapshot,
                Input {
                    text: "literal ; $(not-a-command) 🌊".into(),
                    metadata: InputMetadata {
                        queue_item_id: deferred.then(|| "queue-fixture".into()),
                        queue_item_at: deferred.then(|| "2026-11-12T00:00:00Z".into()),
                        ..Default::default()
                    },
                },
                worker,
                Arc::new(move |t: &Ticket, s: &TurnSnapshot| gate.gate(t, s)),
            )
            .unwrap()
    }
    fn record(&self) -> Record {
        self.registry.lock().unwrap().find("chat").unwrap().clone()
    }
    fn events(&self) -> Vec<Value> {
        self.journal
            .lock()
            .unwrap()
            .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
            .unwrap()
            .into_iter()
            .map(|r| serde_json::from_str(r.json.get()).unwrap())
            .collect()
    }
    async fn finish(&self, mut h: Handle) -> Outcome {
        tokio::time::timeout(Duration::from_secs(10), h.wait())
            .await
            .unwrap()
            .unwrap()
            .turn
            .outcome
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_acceptance_persists_identity_before_deferred_user_and_content() {
    let f = Rig::new(None);
    let worker = f.worker("normal");
    let mut h = f.start(worker.clone(), true);
    let accepted = tokio::time::timeout(Duration::from_secs(10), h.accepted())
        .await
        .unwrap()
        .unwrap();
    assert!(accepted.turn_id.starts_with("zcode-turn-"));
    assert!(!accepted.turn_id.contains("sess_fixture"));
    assert_eq!(f.finish(h).await, Outcome::Success);
    assert!(worker.is_retired());
    let rec = f.record();
    assert_eq!(
        rec.scalar("providerSessionId").as_deref(),
        Some("sess_fixture_native")
    );
    assert!(rec.get("zcodePendingInput").is_none());
    assert_eq!(rec.scalar("title").as_deref(), Some("preserved"));
    let observed = std::fs::read_to_string(f.home.join("reservation-observed")).unwrap();
    assert!(observed.contains("zcodePendingInput"));
    assert!(!observed.contains("not-a-command"));
    let argv: Vec<String> =
        serde_json::from_slice(&std::fs::read(f.home.join("argv.json")).unwrap()).unwrap();
    let prompt = &argv[argv.iter().position(|v| v == "-p").unwrap() + 1];
    assert!(prompt.starts_with("literal ; $(not-a-command) 🌊"));
    assert!(!argv.iter().any(|v| v == "--session-id"));
    let events = f.events();
    let user = events
        .iter()
        .position(|v| v["kind"] == "message.user")
        .unwrap();
    let delta = events
        .iter()
        .position(|v| v["kind"] == "message.delta")
        .unwrap();
    assert!(user < delta);
    assert_eq!(
        events[user]["data"]["text"],
        "literal ; $(not-a-command) 🌊"
    );
    assert_eq!(
        events
            .iter()
            .filter(|v| v["kind"] == "status.changed" && v["data"]["status"] == "done")
            .count(),
        1
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_uses_only_captured_native_id() {
    let f = Rig::new(Some("sess_existing"));
    assert_eq!(
        f.finish(f.start(f.worker("normal"), false)).await,
        Outcome::Success
    );
    let argv: Vec<String> =
        serde_json::from_slice(&std::fs::read(f.home.join("argv.json")).unwrap()).unwrap();
    assert_eq!(
        argv[argv.iter().position(|v| v == "--resume").unwrap() + 1],
        "sess_existing"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identity_only_is_unknown_not_deferred_acceptance() {
    let f = Rig::new(None);
    let mut h = f.start(f.worker("session-only"), true);
    assert!(
        tokio::time::timeout(Duration::from_secs(10), h.accepted())
            .await
            .unwrap()
            .is_err()
    );
    assert!(matches!(f.finish(h).await, Outcome::Failure { .. }));
    assert_eq!(
        f.record().scalar("providerSessionId").as_deref(),
        Some("sess_fixture_native")
    );
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(!f.events().iter().any(|v| v["kind"] == "message.user"));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_eof_fallback_and_native_cancel() {
    for (mode, outcome) in [
        ("completed-only", Outcome::Success),
        ("cancelled", Outcome::Interrupted),
    ] {
        let f = Rig::new(None);
        assert_eq!(f.finish(f.start(f.worker(mode), false)).await, outcome);
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflicting_and_malformed_identity_fail_closed() {
    for mode in ["conflict", "malformed"] {
        let f = Rig::new(None);
        assert!(
            matches!(f.finish(f.start(f.worker(mode),false)).await,Outcome::Failure{code,..}if code=="protocol_error")
        );
        assert_eq!(
            f.record().scalar("providerSessionId").as_deref(),
            Some("sess_fixture_native")
        );
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn private_stderr_evidence_is_static_and_provider_scoped() {
    for (mode, signal) in [
        ("auth", ProviderSignal::Authentication),
        ("quota", ProviderSignal::Quota),
        ("missing", ProviderSignal::MissingSession),
    ] {
        let f = Rig::new(None);
        assert!(matches!(
            f.finish(f.start(f.worker(mode), true)).await,
            Outcome::Failure { .. }
        ));
        assert_eq!(*f.signals.lock().unwrap(), vec![signal]);
        assert!(!f.driver.storage_failed());
        let text = serde_json::to_string(&f.events()).unwrap();
        assert!(!text.contains("authentication_required"));
        assert!(!text.contains("quota_exceeded"));
        assert!(!text.contains("session native not found"));
        assert!(f.record().get("zcodePendingInput").is_some());
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_after_acceptance_joins_actual_process() {
    let f = Rig::new(None);
    let mut h = f.start(f.worker("hold"), false);
    h.accepted().await.unwrap();
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(f.finish(h).await, Outcome::Interrupted);
    assert_eq!(f.driver.active_count(), 0);
    let pid: i32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn construction_panic_proves_never_sent_and_clears_reservation() {
    let f = Rig::new(None);
    assert!(matches!(
        f.finish(f.start(f.worker_gate("normal", true, false), true))
            .await,
        Outcome::Failure { .. }
    ));
    assert!(!f.home.join("provider.pid").exists());
    assert!(f.record().get("zcodePendingInput").is_none());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn seal_release_panic_retains_pid_cleanup_and_unknown_marker() {
    let f = Rig::new(None);
    assert!(matches!(
        f.finish(f.start(f.worker_gate("hold", false, true), true))
            .await,
        Outcome::Failure { .. }
    ));
    assert_eq!(f.driver.active_count(), 0);
    assert!(f.record().get("zcodePendingInput").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_blocked_gate_keeps_slot_until_join_and_cannot_late_spawn() {
    let f = Rig::options(
        None,
        Options {
            close_timeout: Duration::from_millis(200),
            ..Default::default()
        },
    );
    let barrier = Arc::new(GateBarrier::default());
    let mut h = f.start(
        f.worker_barrier("normal", false, false, Some(barrier.clone())),
        true,
    );
    tokio::time::timeout(Duration::from_secs(10), barrier.entered.notified())
        .await
        .unwrap();
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), h.wait())
            .await
            .unwrap()
            .unwrap_err(),
        pult_core::turn_driver::DriverError::CleanupUnconfirmed
    );
    assert_eq!(f.driver.active_count(), 1);
    assert!(!f.home.join("provider.pid").exists());
    barrier.release();
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(f.finish(h).await, Outcome::Interrupted);
    assert!(!f.home.join("provider.pid").exists());
    assert!(f.record().get("zcodePendingInput").is_none());
    assert!(!f.events().iter().any(|v| v["kind"] == "message.user"));
}

struct HoldReserve {
    inner: Arc<dyn SessionStore>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
}
impl SessionStore for HoldReserve {
    fn reserve(
        &self,
        request: ReserveRequest,
    ) -> pult_core::turn_driver::Task<Result<Attempt, StoreError>> {
        // Capture an owned permit future outside the borrowed trait object.
        let task = self.inner.reserve(request);
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            let result = task.await;
            entered.notify_one();
            let _permit = release.acquire().await.unwrap();
            result
        })
    }
    fn record_native_session(
        &self,
        a: Attempt,
        s: String,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.record_native_session(a, s)
    }
    fn accept_turn_started(
        &self,
        a: Attempt,
        e: TurnStartedEvidence,
    ) -> pult_core::turn_driver::Task<Result<Acceptance, StoreError>> {
        self.inner.accept_turn_started(a, e)
    }
    fn clear_never_sent(
        &self,
        a: Attempt,
        p: JoinedCleanup,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.clear_never_sent(a, p)
    }
    fn retire(
        &self,
        a: Attempt,
        p: JoinedCleanup,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.retire(a, p)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_owned_store_cannot_release_slot_or_late_spawn() {
    let f = Rig::options(
        None,
        Options {
            close_timeout: Duration::from_millis(200),
            ..Default::default()
        },
    );
    let store = Arc::new(HoldReserve {
        inner: f.owner.store(),
        entered: Default::default(),
        release: Arc::new(tokio::sync::Semaphore::new(0)),
    });
    let mut h = f.start(
        f.worker_store("normal", false, false, None, Some(store.clone())),
        true,
    );
    tokio::time::timeout(Duration::from_secs(10), store.entered.notified())
        .await
        .unwrap();
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), h.wait())
            .await
            .unwrap()
            .unwrap_err(),
        pult_core::turn_driver::DriverError::CleanupUnconfirmed
    );
    assert_eq!(f.driver.active_count(), 1);
    assert!(!f.home.join("provider.pid").exists());
    store.release.add_permits(1);
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(f.finish(h).await, Outcome::Interrupted);
    assert!(f.record().get("zcodePendingInput").is_none());
    assert!(!f.home.join("provider.pid").exists());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn final_narrowing_rejects_prepared_wider_argv_without_spawn() {
    let f = Rig::new(None);
    assert!(matches!(
        f.finish(f.start(f.worker("restrict-final"), true)).await,
        Outcome::Failure { .. }
    ));
    assert!(!f.home.join("provider.pid").exists());
    assert!(f.record().get("zcodePendingInput").is_none());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_waiter_does_not_drop_owned_execution() {
    let f = Rig::new(None);
    let h = f.start(f.worker("normal"), false);
    let mut progress = h.subscribe_progress();
    drop(h);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = progress.borrow_and_update().clone();
            if let pult_core::turn_driver::Progress::Finished(r) = current {
                assert_eq!(r.unwrap().turn.outcome, Outcome::Success);
                break;
            }
            progress.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(f.driver.active_count(), 0);
    assert!(f.record().get("zcodePendingInput").is_none());
}

struct PanicClear {
    inner: Arc<dyn SessionStore>,
    io: Arc<GateBarrier>,
    thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    home: PathBuf,
    retires: Arc<std::sync::atomic::AtomicUsize>,
}
impl SessionStore for PanicClear {
    fn reserve(
        &self,
        r: ReserveRequest,
    ) -> pult_core::turn_driver::Task<Result<Attempt, StoreError>> {
        self.inner.reserve(r)
    }
    fn record_native_session(
        &self,
        a: Attempt,
        s: String,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.record_native_session(a, s)
    }
    fn accept_turn_started(
        &self,
        a: Attempt,
        e: TurnStartedEvidence,
    ) -> pult_core::turn_driver::Task<Result<Acceptance, StoreError>> {
        self.inner.accept_turn_started(a, e)
    }
    fn clear_never_sent(
        &self,
        _: Attempt,
        _: JoinedCleanup,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        let io = self.io.clone();
        let thread = self.thread.clone();
        let path = self.home.join("late-store-write");
        Box::pin(async move {
            let ready = io.clone();
            *thread.lock().unwrap() = Some(std::thread::spawn(move || {
                ready.entered.notify_one();
                let mut released = ready.released.lock().unwrap();
                while !*released {
                    released = ready.wake.wait(released).unwrap();
                }
                std::fs::write(path, "owned IO completed").unwrap();
            }));
            io.entered.notified().await;
            panic!("synthetic callback panic after starting IO");
        })
    }
    fn retire(
        &self,
        _: Attempt,
        _: JoinedCleanup,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.retires
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_clear_io_cannot_be_erased_by_successful_retire() {
    let f = Rig::options(
        None,
        Options {
            close_timeout: Duration::from_millis(200),
            ..Default::default()
        },
    );
    let io = Arc::new(GateBarrier::default());
    let thread = Arc::new(Mutex::new(None));
    let retires = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let store = Arc::new(PanicClear {
        inner: f.owner.store(),
        io: io.clone(),
        thread: thread.clone(),
        home: f.home.clone(),
        retires: retires.clone(),
    });
    let mut h = f.start(
        f.worker_store("normal", true, false, None, Some(store)),
        true,
    );
    let result = tokio::time::timeout(Duration::from_secs(10), h.wait())
        .await
        .unwrap();
    let still_owned = f.driver.active_count();
    let calls = retires.load(std::sync::atomic::Ordering::SeqCst);
    // Release/join the intentional external IO even when the old source fails.
    io.release();
    thread.lock().unwrap().take().unwrap().join().unwrap();
    assert_eq!(
        result.unwrap_err(),
        pult_core::turn_driver::DriverError::CleanupUnconfirmed
    );
    assert_eq!(still_owned, 1);
    assert_eq!(calls, 0);
    assert!(f.driver.storage_failed());
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(f.home.join("late-store-write").exists());
    assert!(!f.home.join("provider.pid").exists());
}

struct HoldAccept {
    inner: Arc<dyn SessionStore>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    deadline: Arc<Mutex<Option<std::time::Instant>>>,
}
impl SessionStore for HoldAccept {
    fn reserve(
        &self,
        r: ReserveRequest,
    ) -> pult_core::turn_driver::Task<Result<Attempt, StoreError>> {
        *self.deadline.lock().unwrap() = Some(r.deadline());
        self.inner.reserve(r)
    }
    fn record_native_session(
        &self,
        a: Attempt,
        s: String,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.record_native_session(a, s)
    }
    fn accept_turn_started(
        &self,
        a: Attempt,
        e: TurnStartedEvidence,
    ) -> pult_core::turn_driver::Task<Result<Acceptance, StoreError>> {
        let task = self.inner.accept_turn_started(a, e);
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            let result = task.await;
            entered.notify_one();
            let _permit = release.acquire().await.unwrap();
            result
        })
    }
    fn clear_never_sent(
        &self,
        a: Attempt,
        p: JoinedCleanup,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.clear_never_sent(a, p)
    }
    fn retire(
        &self,
        a: Attempt,
        p: JoinedCleanup,
    ) -> pult_core::turn_driver::Task<Result<(), StoreError>> {
        self.inner.retire(a, p)
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn late_owned_acceptance_cannot_publish_started_or_deferred_receipt() {
    let f = Rig::new(None);
    let store = Arc::new(HoldAccept {
        inner: f.owner.store(),
        entered: Default::default(),
        release: Arc::new(tokio::sync::Semaphore::new(0)),
        deadline: Default::default(),
    });
    let mut h = f.start(
        f.worker_store("normal", false, false, None, Some(store.clone())),
        true,
    );
    tokio::time::timeout(Duration::from_secs(10), store.entered.notified())
        .await
        .unwrap();
    let deadline = store.deadline.lock().unwrap().unwrap();
    // An absolute deadline barrier, not a scheduling sleep or larger timeout.
    assert!(
        tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline) + Duration::from_millis(1),
            std::future::pending::<()>()
        )
        .await
        .is_err()
    );
    assert!(std::time::Instant::now() >= deadline);
    assert!(!f.events().iter().any(|v| v["kind"] == "message.user"));
    store.release.add_permits(1);
    let accepted = tokio::time::timeout(Duration::from_secs(10), h.accepted())
        .await
        .unwrap();
    let outcome = f.finish(h).await;
    assert!(accepted.is_err());
    assert!(matches!(outcome,Outcome::Failure{code,..}if code=="start_unknown"));
    assert!(!f.events().iter().any(|v| v["kind"] == "message.user"));
    assert_eq!(
        f.record().scalar("providerSessionId").as_deref(),
        Some("sess_fixture_native")
    );
    assert_eq!(f.driver.active_count(), 0);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_unused_facade_denies_future_start() {
    let f = Rig::new(None);
    let worker = f.worker("normal");
    worker.begin_shutdown();
    assert!(
        matches!(f.finish(f.start(worker,true)).await,Outcome::Failure{code,..}if code=="worker_retired")
    );
    assert!(!f.home.join("provider.pid").exists());
    assert!(f.record().get("zcodePendingInput").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_failed_result_overrides_native_cancelled_completion() {
    let f = Rig::new(None);
    assert!(
        matches!(f.finish(f.start(f.worker("cancelled-result-failure"),false)).await,Outcome::Failure{code,..}if code=="provider_failed")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_close_during_owned_acceptance_cannot_publish_late_started() {
    use pult_core::turn_driver::Worker;
    let f = Rig::new(None);
    let store = Arc::new(HoldAccept {
        inner: f.owner.store(),
        entered: Default::default(),
        release: Arc::new(tokio::sync::Semaphore::new(0)),
        deadline: Default::default(),
    });
    let worker = f.worker_store("normal", false, false, None, Some(store.clone()));
    let mut h = f.start(worker.clone(), true);
    tokio::time::timeout(Duration::from_secs(10), store.entered.notified())
        .await
        .unwrap();
    let mut close = worker.close(h.ticket().clone());
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(
        close.as_mut().poll(&mut context).is_pending(),
        "close must revoke now but join owned store"
    );
    assert_eq!(f.driver.active_count(), 1);
    store.release.add_permits(1);
    let accepted = tokio::time::timeout(Duration::from_secs(10), h.accepted())
        .await
        .unwrap();
    let _ = f.finish(h).await;
    tokio::time::timeout(Duration::from_secs(10), close)
        .await
        .unwrap()
        .unwrap();
    assert!(accepted.is_err());
    assert!(!f.events().iter().any(|v| v["kind"] == "message.user"));
    assert!(!f.driver.storage_failed());
    assert_eq!(f.driver.active_count(), 0);
}
