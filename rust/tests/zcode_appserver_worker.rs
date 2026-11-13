//! Actual holder/native byte fixture and real Driver/Owner/Registry/Journal.
//! Fake resources supply a real helper descriptor, not production memory wiring.
use pult_core::turn_driver::{Task, WorkerError};
use pult_core::{
    consent_store::ConsentStore,
    journal::EventStore,
    registry::{Record, Registry},
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{Driver, Handle, Input, InputMetadata, Options},
    turn_journal::JournalSink,
    turn_snapshot::{Approval, SessionKey, TurnSnapshot},
    worker_process::{Launch, SpawnDenied, SpawnGate, SpawnPermit},
    zcode_appserver_protocol::{SessionMode, StdioMcpServer},
    zcode_appserver_worker::*,
    zcode_host_services::{AppServerInputFrontier, Attempt, ZcodeOwner},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
struct Spawn {
    owner: Arc<ZcodeOwner>,
    attempt: Attempt,
}
struct SpawnHeld;
impl SpawnPermit for SpawnHeld {}
impl SpawnGate for Spawn {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        if !self.owner.seal_spawn(&self.attempt) {
            return Err(SpawnDenied);
        }
        Ok(Box::new(SpawnHeld))
    }
}
struct InputAdmission {
    gate: Arc<Mutex<()>>,
}
struct InputHeld<'a> {
    _guard: MutexGuard<'a, ()>,
}
impl InputPermit for InputHeld<'_> {}
impl InputGate for InputAdmission {
    fn enter(&self) -> Result<Box<dyn InputPermit + '_>, WorkerError> {
        Ok(Box::new(InputHeld {
            _guard: self.gate.lock().unwrap(),
        }))
    }
}
struct ResourceHeld<'a> {
    _guard: MutexGuard<'a, ()>,
}
impl ResourcePermit for ResourceHeld<'_> {}
struct Block {
    entered: tokio::sync::Notify,
    release: tokio::sync::Semaphore,
}
impl Block {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Semaphore::new(0),
        })
    }
    async fn wait(&self) {
        self.entered.notify_one();
        self.release.acquire().await.unwrap().forget();
    }
    fn release(&self) {
        self.release.add_permits(1);
    }
}
struct Resources {
    registry: Arc<Mutex<Registry>>,
    home: PathBuf,
    gate: Mutex<()>,
    revoked: Mutex<HashSet<(Ticket, u64)>>,
    drains: AtomicUsize,
    prepare_block: Mutex<Option<Arc<Block>>>,
    catalog_block: Mutex<Option<Arc<Block>>>,
    drain_block: Mutex<Option<Arc<Block>>>,
}
impl ScopedResources for Resources {
    fn prepare(&self, context: ResourceContext) -> Task<Result<PreparedResources, WorkerError>> {
        let enabled = pult_core::memory_policy::Policy::record(
            self.registry
                .lock()
                .unwrap()
                .find(&context.snapshot.key.name)
                .unwrap(),
        )
        .unwrap()
        .read;
        let home = self.home.clone();
        let block = self.prepare_block.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(block) = block {
                block.wait().await;
            }
            if !enabled {
                return Err(WorkerError {
                    code: "provider_unavailable".into(),
                    message: "memory off".into(),
                });
            }
            let server = StdioMcpServer::new(
                "pult-memory",
                env!("CARGO_BIN_EXE_pult-memory-mcp"),
                home.to_str().unwrap(),
                &["--home".into(), home.to_str().unwrap().into()],
                &[("PULT_MEMORY_KEY".into(), format!("mt_{}", "a".repeat(64)))],
            )
            .unwrap();
            PreparedResources::new(context, vec![server])
        })
    }
    fn catalog(&self, _: Ticket, _: u64) -> Task<Result<Option<String>, WorkerError>> {
        let block = self.catalog_block.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(block) = block {
                block.wait().await;
            }
            Ok(Some("summary data".into()))
        })
    }
    fn check<'a>(
        &'a self,
        frontier: &'a AppServerInputFrontier<'_>,
        ticket: &Ticket,
        generation: u64,
    ) -> Result<Box<dyn ResourcePermit + 'a>, WorkerError> {
        let guard = self.gate.lock().unwrap();
        if self
            .revoked
            .lock()
            .unwrap()
            .contains(&(ticket.clone(), generation))
            || !pult_core::memory_policy::Policy::record(frontier.current_record())
                .unwrap()
                .read
        {
            return Err(WorkerError {
                code: "access_changed".into(),
                message: "revoked".into(),
            });
        }
        Ok(Box::new(ResourceHeld { _guard: guard }))
    }
    fn revoke(&self, ticket: &Ticket, generation: u64) {
        let _guard = self.gate.lock().unwrap();
        self.revoked
            .lock()
            .unwrap()
            .insert((ticket.clone(), generation));
    }
    fn drain(&self, _: Ticket, _: u64) -> Task<Result<(), WorkerError>> {
        self.drains.fetch_add(1, Ordering::Relaxed);
        let block = self.drain_block.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(block) = block {
                block.wait().await;
            }
            Ok(())
        })
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
    resources: Arc<Resources>,
}
impl Rig {
    fn new(resume: bool) -> Self {
        pult_core::panic_guard::install();
        static HOOK: std::sync::Once = std::sync::Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                if let Some(at) = info.location() {
                    eprintln!("app-server fixture panic {}:{}", at.file(), at.line());
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
            created_at: "2026-11-13T00:00:00Z".into(),
        };
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let mut r = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
        ] {
            r.set_string(k, v);
        }
        r.set_raw(
            "memory",
            serde_json::value::to_raw_value(&json!({"read":true,"write":"ask"})).unwrap(),
        );
        if resume {
            r.set_string("providerSessionId", "known-native");
        }
        registry.insert(r).unwrap();
        let registry = Arc::new(Mutex::new(registry));
        let journal = Arc::new(Mutex::new(journal));
        let sink = Arc::new(JournalSink::new(journal.clone()).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(pult_core::redaction::redact_string),
                Options::default(),
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
        let resources = Arc::new(Resources {
            registry: registry.clone(),
            home: home.clone(),
            gate: Mutex::new(()),
            revoked: Mutex::new(HashSet::new()),
            drains: AtomicUsize::new(0),
            prepare_block: Mutex::new(None),
            catalog_block: Mutex::new(None),
            drain_block: Mutex::new(None),
        });
        Self {
            _temp: temp,
            home,
            key,
            registry,
            journal,
            driver,
            owner,
            sink,
            resources,
        }
    }
    fn worker(&self, mode: &str) -> Arc<ZcodeAppServerWorker> {
        self.worker_with(mode, |_, _| {})
    }
    fn worker_with(
        &self,
        mode: &str,
        configure: impl FnOnce(&mut Config, &mut Services),
    ) -> Arc<ZcodeAppServerWorker> {
        let program = self.home.join(format!("native-{mode}"));
        std::fs::copy(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/zcode_appserver_worker.py"),
            &program,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = self.owner.clone();
        let policy = self.owner.clone();
        let mut config = Config {
            session: self.key.clone(),
            home: self.home.clone(),
            launch: Launch {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program,
                args: vec![],
                cwd: self.home.join("project"),
                env: BTreeMap::from([
                    ("HOME".into(), self.home.as_os_str().to_owned()),
                    ("PATH".into(), "/usr/bin:/bin".into()),
                ]),
            },
            workspace_key: "workspace".into(),
            native_mode: SessionMode::Guarded,
            captured_approval: Approval::Ask,
            start_deadline: Instant::now() + Duration::from_secs(15),
            reverse_timeout: Duration::from_secs(3),
            attachments: vec![],
            language: pult_core::zcode_launch::ContextLanguage::En,
        };
        let mut services = Services {
            driver: Arc::downgrade(&self.driver),
            owner: self.owner.clone(),
            store: self.owner.app_server_store(),
            sink: self.sink.clone(),
            gate: Arc::new(move |t: &Ticket, s: &TurnSnapshot| policy.gate(t, s)),
            spawn_gate: Arc::new(move |attempt, _, _| {
                Ok(Arc::new(Spawn {
                    owner: owner.clone(),
                    attempt,
                }))
            }),
            input_gate: Arc::new(|_, _| {
                Ok(Arc::new(InputAdmission {
                    gate: Arc::new(Mutex::new(())),
                }))
            }),
            resources: self.resources.clone(),
            interactions: Arc::new(DenyInteractions),
            redactors: Arc::new(|| Box::new(pult_core::zcode_events::LogRedactor)),
            fatal_storage: Arc::new(|| {}),
        };
        configure(&mut config, &mut services);
        ZcodeAppServerWorker::new(config, services).unwrap()
    }
    fn start(&self, worker: Arc<ZcodeAppServerWorker>) -> Handle {
        let owner = self.owner.clone();
        self.driver
            .start_input(
                self.owner.snapshot(&self.key).unwrap(),
                Input {
                    text: "literal user input ; $(not executable)".into(),
                    metadata: InputMetadata {
                        queue_item_id: Some("queue-fixture".into()),
                        queue_item_at: Some("at".into()),
                        ..Default::default()
                    },
                },
                worker,
                Arc::new(move |t: &Ticket, s: &TurnSnapshot| owner.gate(t, s)),
            )
            .unwrap()
    }
    fn record(&self) -> Record {
        self.registry.lock().unwrap().find("chat").unwrap().clone()
    }
    fn proof(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("proof.jsonl"))
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}
async fn bounded<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), f)
        .await
        .expect("worker watchdog")
}
#[tokio::test]
async fn real_holder_ack_in_both_orders_uses_actual_driver_receipt_and_durable_identity() {
    for mode in ["ack-first", "event-first"] {
        let f = Rig::new(false);
        let worker = f.worker(mode);
        let mut h = f.start(worker.clone());
        let accepted = bounded(h.accepted()).await.unwrap();
        assert!(accepted.user_event_id > 0);
        assert!(accepted.turn_id.starts_with("pult-turn-"));
        let journal = f
            .journal
            .lock()
            .unwrap()
            .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
            .unwrap();
        assert!(journal.iter().any(|r| {
            let v: Value = serde_json::from_str(r.json.get()).unwrap();
            v["id"] == accepted.user_event_id && v["kind"] == "message.user"
        }));
        let terminal = bounded(h.wait()).await.unwrap();
        assert_eq!(terminal.turn.outcome, Outcome::Success);
        assert!(worker.is_retired());
        assert!(f.record().get("zcodePendingInput").is_none());
        let proof = f.proof();
        assert!(proof.iter().any(|v| v["safe_prefs"] == true));
        assert!(proof.iter().any(|v| v["send_marker_present"] == true
            && v["sid_durable"] == true
            && v["content_ok"] == true));
        assert_eq!(
            proof
                .iter()
                .filter(|v| v["method"] == "session/send")
                .count(),
            1
        );
        assert_eq!(f.resources.drains.load(Ordering::Relaxed), 1);
    }
}
async fn wait_file(home: &std::path::Path, name: &str) {
    bounded(async {
        while !home.join(name).exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
}
fn assert_pending<T>(mut future: std::pin::Pin<&mut impl std::future::Future<Output = T>>) {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(future.as_mut().poll(&mut cx).is_pending());
}
fn alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    if std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .ok()
        .and_then(|s| s.rsplit_once(") ").map(|(_, tail)| tail.starts_with('Z')))
        == Some(true)
    {
        return false;
    }
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}
#[tokio::test]
async fn ack_only_and_event_only_stay_starting_until_the_other_native_fact() {
    for (mode, barrier) in [("ack-first-hold", "start"), ("event-first-hold", "ack")] {
        let f = Rig::new(false);
        let worker = f.worker(mode);
        let mut h = f.start(worker.clone());
        wait_file(&f.home, &format!("{barrier}.entered")).await;
        assert!(matches!(
            h.progress(),
            pult_core::turn_driver::Progress::Starting
        ));
        assert!(f.record().get("zcodePendingInput").is_some());
        assert!(
            !f.journal
                .lock()
                .unwrap()
                .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
                .unwrap()
                .iter()
                .any(
                    |r| serde_json::from_str::<Value>(r.json.get()).unwrap()["kind"]
                        == "message.user"
                )
        );
        std::fs::write(f.home.join(format!("{barrier}.release")), "").unwrap();
        bounded(h.accepted()).await.unwrap();
        assert_eq!(
            bounded(h.wait()).await.unwrap().turn.outcome,
            Outcome::Success
        );
        assert!(worker.is_retired());
    }
}
// Failure-only, host-owned diagnostics. Never dump native frames, arbitrary
// errors, arguments, paths or private helper configuration. A cleanup retry
// below cannot turn the original watchdog into a passing test.
async fn cold_resume_watchdog(
    rig: &Rig,
    worker: &Arc<ZcodeAppServerWorker>,
    handle: &Handle,
    phase: &'static str,
) -> ! {
    use pult_core::turn_driver::{Progress, Worker};
    let progress = match handle.progress() {
        Progress::Starting => "starting",
        Progress::Running(_) => "running",
        Progress::Closing => "closing",
        Progress::Quarantined(_) => "quarantined",
        Progress::Finished(_) => "finished",
    };
    // A held Registry can itself explain the stall. Do not wait for it while
    // trying to report a watchdog, and do not use this observation as authority.
    let marker = rig.registry.try_lock().ok().and_then(|registry| {
        registry
            .find("chat")
            .map(|record| record.get("zcodePendingInput").is_some())
    });
    let method = std::fs::read_to_string(rig.home.join("proof.jsonl"))
        .ok()
        .and_then(|proof| {
            proof
                .lines()
                .filter_map(|line| {
                    let value: Value = serde_json::from_str(line).ok()?;
                    match value["method"].as_str()? {
                        "session/resume" => Some("resume"),
                        "session/setMode" => Some("set-mode"),
                        "session/subscribe" => Some("subscribe"),
                        "session/send" => Some("send"),
                        "session/close" => Some("close"),
                        _ => None,
                    }
                })
                .next_back()
        })
        .unwrap_or("none-or-unreadable");
    let native_alive = std::fs::read_to_string(rig.home.join("provider.pid"))
        .ok()
        .and_then(|pid| pid.parse::<u32>().ok())
        .map(alive);
    eprintln!(
        "cold-resume watchdog: phase={phase} progress={progress} marker={marker:?} retired={} last-method={method} close-observed={} resource-drains={} native-alive={native_alive:?}",
        worker.is_retired(),
        rig.home.join("closed.entered").exists(),
        rig.resources.drains.load(Ordering::Relaxed),
    );
    // Evidence is captured first. Afterwards ask the actual owned Worker to
    // close, retaining its process/marker/IO joins; no direct PID kill or reset.
    let cleanup = tokio::time::timeout(
        Duration::from_secs(30),
        worker.close(handle.ticket().clone()),
    )
    .await;
    eprintln!(
        "cold-resume watchdog cleanup: returned={} ok={}",
        cleanup.is_ok(),
        matches!(cleanup, Ok(Ok(()))),
    );
    panic!("cold-resume {phase} watchdog");
}
#[tokio::test]
async fn cold_resume_applies_captured_mode_and_never_creates_a_new_session() {
    let f = Rig::new(true);
    let worker = f.worker("ack-first");
    let mut h = f.start(worker.clone());
    let accepted = match tokio::time::timeout(Duration::from_secs(30), h.accepted()).await {
        Ok(result) => result,
        Err(_) => cold_resume_watchdog(&f, &worker, &h, "accepted").await,
    };
    accepted.unwrap();
    let terminal = match tokio::time::timeout(Duration::from_secs(30), h.wait()).await {
        Ok(result) => result,
        Err(_) => cold_resume_watchdog(&f, &worker, &h, "completion").await,
    };
    assert_eq!(terminal.unwrap().turn.outcome, Outcome::Success);
    let proof = f.proof();
    let methods: Vec<_> = proof.iter().filter_map(|v| v["method"].as_str()).collect();
    assert_eq!(
        methods,
        [
            "session/resume",
            "session/setMode",
            "session/subscribe",
            "session/send",
            "session/close"
        ]
    );
    assert_eq!(
        f.record().scalar("providerSessionId").as_deref(),
        Some("known-native")
    );
}
#[tokio::test]
async fn memory_off_and_unsupported_options_are_unavailable_before_os_spawn() {
    for mode in 0..5 {
        let f = Rig::new(false);
        if mode == 0 {
            f.registry
                .lock()
                .unwrap()
                .update_checked(&f.key, |r| {
                    r.remove("memory");
                    Ok(())
                })
                .unwrap();
        }
        if mode == 1 {
            f.registry
                .lock()
                .unwrap()
                .update_checked(&f.key, |r| {
                    r.set_string("model", "unsupported-selection");
                    Ok(())
                })
                .unwrap();
        }
        let w = f.worker_with("ack-first", |c, _| {
            if mode == 2 {
                c.native_mode = SessionMode::Yolo;
            }
            if mode == 3 {
                c.native_mode = SessionMode::Auto;
            }
            if mode == 4 {
                c.launch.cwd = c.home.clone();
            }
        });
        let mut h = f.start(w.clone());
        assert!(bounded(h.accepted()).await.is_err());
        let _ = bounded(h.wait()).await;
        assert!(!f.home.join("provider.pid").exists());
        assert!(f.record().get("zcodePendingInput").is_none());
        assert!(w.is_retired());
    }
}
#[tokio::test]
async fn unknown_ack_missing_ids_and_eof_without_terminal_never_retry_or_fallback() {
    for mode in [
        "wrong-ack",
        "missing-start-id",
        "finish-only",
        "resume-unavailable",
    ] {
        let f = Rig::new(mode == "resume-unavailable");
        let w = f.worker_with(mode, |c, _| {
            c.start_deadline = Instant::now() + Duration::from_secs(2)
        });
        let mut h = f.start(w.clone());
        let accepted = bounded(h.accepted()).await;
        let terminal = bounded(h.wait()).await.unwrap();
        assert_ne!(terminal.turn.outcome, Outcome::Success);
        let proof = f.proof();
        assert!(
            proof
                .iter()
                .filter(|v| v["method"] == "session/send")
                .count()
                <= 1
        );
        if mode != "finish-only" {
            assert!(accepted.is_err());
            assert!(f.record().get("zcodePendingInput").is_some());
        }
        assert!(w.is_retired());
    }
}
#[tokio::test]
async fn invalid_raw_duplicate_cannot_become_a_terminal_success() {
    let f = Rig::new(false);
    let w = f.worker("duplicate-wire");
    let mut h = f.start(w.clone());
    let _ = bounded(h.accepted()).await;
    assert_ne!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    assert_eq!(
        f.proof()
            .iter()
            .filter(|v| v["method"] == "session/send")
            .count(),
        1
    );
    assert!(w.is_retired());
}
#[tokio::test]
async fn cancelled_resources_preparation_and_catalog_are_owned_until_release() {
    for catalog in [false, true] {
        let f = Rig::new(false);
        let block = Block::new();
        if catalog {
            *f.resources.catalog_block.lock().unwrap() = Some(block.clone());
        } else {
            *f.resources.prepare_block.lock().unwrap() = Some(block.clone());
        }
        let w = f.worker("ack-first");
        let mut h = f.start(w.clone());
        bounded(block.entered.notified()).await;
        assert!(f.driver.cancel(h.ticket()));
        assert_eq!(f.driver.active_count(), 1);
        assert!(!w.is_retired());
        assert!(!f.home.join("provider.pid").exists());
        block.release();
        let _ = bounded(h.accepted()).await;
        assert_eq!(
            bounded(h.wait()).await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        assert!(!f.home.join("provider.pid").exists());
        assert!(w.is_retired());
    }
}
// Only entered after an original30s watchdog has already failed. No native
// frames, errors, arguments, paths, input or private helper config are printed.
async fn appserver_drain_watchdog(
    rig: &Rig,
    worker: &Arc<ZcodeAppServerWorker>,
    ticket: &Ticket,
    progress: &tokio::sync::watch::Receiver<pult_core::turn_driver::Progress>,
    block: &Block,
    phase: &'static str,
    drain_released: bool,
) -> ! {
    use pult_core::turn_driver::{Progress, Worker};
    let progress = match progress.borrow().clone() {
        Progress::Starting => "starting",
        Progress::Running(_) => "running",
        Progress::Closing => "closing",
        Progress::Quarantined(_) => "quarantined",
        Progress::Finished(_) => "finished",
    };
    let marker = rig.registry.try_lock().ok().and_then(|registry| {
        registry
            .find("chat")
            .map(|record| record.get("zcodePendingInput").is_some())
    });
    let alive_file = |name: &str| {
        std::fs::read_to_string(rig.home.join(name))
            .ok()
            .and_then(|pid| pid.parse::<u32>().ok())
            .map(alive)
    };
    let last_method = std::fs::read_to_string(rig.home.join("proof.jsonl"))
        .ok()
        .and_then(|proof| {
            proof
                .lines()
                .filter_map(|line| {
                    let row: Value = serde_json::from_str(line).ok()?;
                    match row["method"].as_str()? {
                        "session/create" => Some("create"),
                        "session/resume" => Some("resume"),
                        "session/setMode" => Some("set-mode"),
                        "session/subscribe" => Some("subscribe"),
                        "session/send" => Some("send"),
                        "session/close" => Some("close"),
                        _ => None,
                    }
                })
                .next_back()
        })
        .unwrap_or("none-or-unreadable");
    let revoked_count = rig
        .resources
        .revoked
        .try_lock()
        .ok()
        .map(|entries| entries.len());
    eprintln!(
        "appserver-drain watchdog: phase={phase} progress={progress} active={} marker={marker:?} retired={} last-method={last_method} close-observed={} resource-drains={} revoked-count={revoked_count:?} native-alive={:?} descendant-alive={:?} drain-released={drain_released} release-permits={}",
        rig.driver.active_count(),
        worker.is_retired(),
        rig.home.join("closed.entered").exists(),
        rig.resources.drains.load(Ordering::Relaxed),
        alive_file("provider.pid"),
        alive_file("descendant.pid"),
        block.release.available_permits(),
    );
    // Capture precedes this failure-only owned cleanup. Unblock only this test's
    // resource waiter if its normal release was never reached. No direct PID
    // kill, native replay or diagnostic retry can turn this failed test to PASS.
    if !drain_released {
        block.release();
    }
    let cleanup = tokio::time::timeout(Duration::from_secs(5), worker.close(ticket.clone())).await;
    eprintln!(
        "appserver-drain watchdog cleanup: returned={} known={}",
        cleanup.is_ok(),
        matches!(cleanup, Ok(Ok(())))
    );
    panic!("appserver-drain {phase} watchdog");
}
#[tokio::test]
async fn close_ack_does_not_release_before_resource_drain_and_descendants_join() {
    let f = Rig::new(false);
    let block = Block::new();
    *f.resources.drain_block.lock().unwrap() = Some(block.clone());
    let w = f.worker("descendant");
    let mut h = f.start(w.clone());
    let progress = h.subscribe_progress();
    let ticket = h.ticket().clone();
    let accepted = match tokio::time::timeout(Duration::from_secs(30), h.accepted()).await {
        Ok(result) => result,
        Err(_) => {
            appserver_drain_watchdog(&f, &w, &ticket, &progress, &block, "accepted", false).await
        }
    };
    accepted.unwrap();
    if tokio::time::timeout(Duration::from_secs(30), block.entered.notified())
        .await
        .is_err()
    {
        appserver_drain_watchdog(
            &f,
            &w,
            &ticket,
            &progress,
            &block,
            "resource-drain-entry",
            false,
        )
        .await;
    }
    assert!(f.home.join("closed.entered").exists());
    assert_eq!(f.driver.active_count(), 1);
    assert!(!w.is_retired());
    let mut waiting = Box::pin(h.wait());
    assert_pending(waiting.as_mut());
    let pid: u32 = std::fs::read_to_string(f.home.join("descendant.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!alive(pid));
    block.release();
    let terminal = match tokio::time::timeout(Duration::from_secs(30), waiting).await {
        Ok(result) => result,
        Err(_) => {
            appserver_drain_watchdog(
                &f,
                &w,
                &ticket,
                &progress,
                &block,
                "completion-after-drain-release",
                true,
            )
            .await
        }
    };
    assert_eq!(terminal.unwrap().turn.outcome, Outcome::Success);
    assert!(w.is_retired());
}
struct BlockingGate {
    block: Arc<Blocking>,
}
struct Blocking {
    entered: tokio::sync::Notify,
    released: Mutex<bool>,
    wake: std::sync::Condvar,
}
impl Blocking {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: tokio::sync::Notify::new(),
            released: Mutex::new(false),
            wake: std::sync::Condvar::new(),
        })
    }
    fn wait(&self) {
        self.entered.notify_one();
        let mut r = self.released.lock().unwrap();
        while !*r {
            r = self.wake.wait(r).unwrap();
        }
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
struct BlockingHeld<'a> {
    _guard: MutexGuard<'a, bool>,
}
impl InputPermit for BlockingHeld<'_> {}
impl InputGate for BlockingGate {
    fn enter(&self) -> Result<Box<dyn InputPermit + '_>, WorkerError> {
        self.block.wait();
        Ok(Box::new(BlockingHeld {
            _guard: self.block.released.lock().unwrap(),
        }))
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_cancel_while_registry_frontier_and_runtime_gate_are_held_prevents_send() {
    let f = Rig::new(false);
    let block = Blocking::new();
    let b = block.clone();
    let w = f.worker_with("ack-first", move |_, s| {
        s.input_gate = Arc::new(move |_, _| Ok(Arc::new(BlockingGate { block: b.clone() })))
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    assert!(matches!(
        f.registry.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(f.driver.active_count(), 1);
    block.release();
    let _ = bounded(h.accepted()).await;
    assert_eq!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(w.is_retired());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_memory_policy_after_precheck_is_used_at_first_handoff() {
    let f = Rig::new(false);
    let block = Blocking::new();
    let b = block.clone();
    let w = f.worker_with("ack-first", move |_, s| {
        s.input_gate = Arc::new(move |_, _| {
            b.wait();
            Ok(Arc::new(InputAdmission {
                gate: Arc::new(Mutex::new(())),
            }))
        })
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |r| {
            r.set_raw(
                "memory",
                serde_json::value::to_raw_value(&json!({"read":false,"write":"off"}))?,
            );
            Ok(())
        })
        .unwrap();
    block.release();
    assert!(bounded(h.accepted()).await.is_err());
    let _ = bounded(h.wait()).await;
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(w.is_retired());
}
use pult_core::zcode_host_services::{
    Acceptance, AppServerAttempt, AppServerSessionStore, AppServerStartedEvidence,
    Error as StoreError, HostInputIds, JoinedCleanup, NativeSessionReceipt, ReserveRequest,
};
struct HoldingStore {
    inner: Arc<dyn AppServerSessionStore>,
    block: Arc<Block>,
    accept: bool,
}
impl AppServerSessionStore for HoldingStore {
    fn reserve(
        &self,
        r: ReserveRequest,
        ids: HostInputIds,
    ) -> Task<Result<AppServerAttempt, StoreError>> {
        self.inner.reserve(r, ids)
    }
    fn record_session(
        &self,
        a: AppServerAttempt,
        s: String,
    ) -> Task<Result<NativeSessionReceipt, StoreError>> {
        let inner = self.inner.clone();
        let block = self.block.clone();
        let hold = !self.accept;
        Box::pin(async move {
            if hold {
                block.wait().await;
            }
            inner.record_session(a, s).await
        })
    }
    fn accept_started(
        &self,
        a: AppServerAttempt,
        e: AppServerStartedEvidence,
    ) -> Task<Result<Acceptance, StoreError>> {
        let inner = self.inner.clone();
        let block = self.block.clone();
        let hold = self.accept;
        Box::pin(async move {
            if hold {
                block.wait().await;
            }
            inner.accept_started(a, e).await
        })
    }
    fn clear_before_bootstrap(
        &self,
        a: AppServerAttempt,
        j: JoinedCleanup,
    ) -> Task<Result<(), StoreError>> {
        self.inner.clear_before_bootstrap(a, j)
    }
    fn retire(&self, a: AppServerAttempt, j: JoinedCleanup) -> Task<Result<(), StoreError>> {
        self.inner.retire(a, j)
    }
}
#[tokio::test]
async fn cancelled_owned_sid_and_accept_store_cannot_release_or_late_publish() {
    for accept in [false, true] {
        let f = Rig::new(false);
        let block = Block::new();
        let b = block.clone();
        let w = f.worker_with("ack-first", move |_, s| {
            s.store = Arc::new(HoldingStore {
                inner: s.store.clone(),
                block: b,
                accept,
            })
        });
        let mut h = f.start(w.clone());
        bounded(block.entered.notified()).await;
        assert!(f.driver.cancel(h.ticket()));
        assert_eq!(f.driver.active_count(), 1);
        assert!(!w.is_retired());
        block.release();
        let _ = bounded(h.accepted()).await;
        assert_eq!(
            bounded(h.wait()).await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        assert!(f.record().get("zcodePendingInput").is_some());
        let proof = f.proof();
        assert_eq!(
            proof
                .iter()
                .filter(|v| v["method"] == "session/send")
                .count(),
            usize::from(accept)
        );
        assert!(w.is_retired());
    }
}
struct HoldingSink {
    inner: Arc<dyn pult_core::turn_driver::EventSink>,
    block: Arc<Block>,
}
impl pult_core::turn_driver::EventSink for HoldingSink {
    fn append(
        &self,
        v: Value,
    ) -> Task<Result<pult_core::turn_driver::Receipt, pult_core::turn_driver::SinkError>> {
        let inner = self.inner.clone();
        let block = self.block.clone();
        Box::pin(async move {
            block.wait().await;
            inner.append(v).await
        })
    }
}
#[tokio::test]
async fn cancelled_status_sink_finishes_owned_io_before_clear_and_never_spawns() {
    let f = Rig::new(false);
    let block = Block::new();
    let b = block.clone();
    let w = f.worker_with("ack-first", move |_, s| {
        s.sink = Arc::new(HoldingSink {
            inner: s.sink.clone(),
            block: b,
        })
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(f.driver.active_count(), 1);
    assert!(!f.home.join("provider.pid").exists());
    block.release();
    let _ = bounded(h.accepted()).await;
    assert_eq!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert!(f.record().get("zcodePendingInput").is_none());
    assert!(!f.home.join("provider.pid").exists());
    assert!(w.is_retired());
}
struct HoldingInteraction {
    block: Arc<Block>,
}
impl NativeInteractions for HoldingInteraction {
    fn handle(
        &self,
        _: ReverseContext,
        r: pult_core::zcode_appserver_protocol::ReverseRequest,
    ) -> Task<Result<BoundReverseReply, WorkerError>> {
        let block = self.block.clone();
        Box::pin(async move {
            block.wait().await;
            BoundReverseReply::default_deny(&r)
        })
    }
    fn revoke(&self, _: &Ticket, _: u64) {}
}
#[tokio::test]
async fn reverse_request_callback_is_owned_during_cancelled_bootstrap() {
    let f = Rig::new(false);
    let block = Block::new();
    let b = block.clone();
    let w = f.worker_with("ack-first", move |_, s| {
        s.interactions = Arc::new(HoldingInteraction { block: b })
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    assert!(f.driver.cancel(h.ticket()));
    assert_eq!(f.driver.active_count(), 1);
    assert!(!w.is_retired());
    block.release();
    let _ = bounded(h.accepted()).await;
    assert_eq!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(w.is_retired());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inherited_deadline_is_checked_after_a_blocked_input_gate_not_reset() {
    let f = Rig::new(false);
    let block = Blocking::new();
    let b = block.clone();
    let deadline = Instant::now() + Duration::from_secs(2);
    let w = f.worker_with("ack-first", move |c, s| {
        c.start_deadline = deadline;
        s.input_gate = Arc::new(move |_, _| Ok(Arc::new(BlockingGate { block: b.clone() })));
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    tokio::time::sleep_until(deadline.into()).await;
    block.release();
    assert!(bounded(h.accepted()).await.is_err());
    let _ = bounded(h.wait()).await;
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(w.is_retired());
}
struct PanicDropPermit;
impl InputPermit for PanicDropPermit {}
impl Drop for PanicDropPermit {
    fn drop(&mut self) {
        panic!("controlled admission release panic")
    }
}
struct PanicDropGate;
impl InputGate for PanicDropGate {
    fn enter(&self) -> Result<Box<dyn InputPermit + '_>, WorkerError> {
        Ok(Box::new(PanicDropPermit))
    }
}
#[tokio::test]
async fn panic_after_sealed_handoff_keeps_actual_pid_and_unknown_marker_until_join() {
    let f = Rig::new(false);
    let w = f.worker_with("blocked-running", |_, s| {
        s.input_gate = Arc::new(|_, _| Ok(Arc::new(PanicDropGate)))
    });
    let mut h = f.start(w.clone());
    assert!(bounded(h.accepted()).await.is_err());
    let _ = bounded(h.wait()).await;
    let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!alive(pid));
    let disk: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("sessions.json")).unwrap()).unwrap();
    assert!(disk["sessions"][0].get("zcodePendingInput").is_some());
    assert!(f.driver.storage_failed());
    assert!(
        f.proof()
            .iter()
            .filter(|v| v["method"] == "session/send")
            .count()
            <= 1
    );
    assert!(w.is_retired());
}
#[tokio::test]
async fn dropped_client_receiver_does_not_abandon_owned_native_turn() {
    let f = Rig::new(false);
    let w = f.worker("ack-first-hold");
    let h = f.start(w.clone());
    wait_file(&f.home, "start.entered").await;
    drop(h);
    std::fs::write(f.home.join("start.release"), "").unwrap();
    bounded(async {
        while f.driver.active_count() != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(w.is_retired());
    assert!(f.record().get("zcodePendingInput").is_none());
    assert_eq!(
        f.proof()
            .iter()
            .filter(|v| v["method"] == "session/send")
            .count(),
        1
    );
}
#[tokio::test]
async fn actual_pending_first_write_is_owned_through_cancel_and_never_replayed() {
    let f = Rig::new(false);
    let w = f.worker("blocked-input");
    let owner = f.owner.clone();
    let mut h = f
        .driver
        .start_input(
            f.owner.snapshot(&f.key).unwrap(),
            Input {
                text: format!("literal user input{}", "x".repeat(120_000)),
                metadata: InputMetadata {
                    queue_item_id: Some("q".into()),
                    queue_item_at: Some("at".into()),
                    ..Default::default()
                },
            },
            w.clone(),
            Arc::new(move |t: &Ticket, s: &TurnSnapshot| owner.gate(t, s)),
        )
        .unwrap();
    wait_file(&f.home, "write.entered").await;
    bounded(async {
        while !w.observed_pending_input_write() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(f.driver.cancel(h.ticket()));
    let _ = bounded(h.accepted()).await;
    assert_eq!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!alive(pid));
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(w.is_retired());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_storage_fault_before_input_seal_wins_and_stops_the_owned_holder() {
    let f = Rig::new(false);
    let block = Blocking::new();
    let b = block.clone();
    let w = f.worker_with("ack-first", move |_, s| {
        s.input_gate = Arc::new(move |_, _| Ok(Arc::new(BlockingGate { block: b.clone() })))
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    f.driver.report_storage_failure();
    block.release();
    assert!(bounded(h.accepted()).await.is_err());
    assert!(bounded(h.wait()).await.is_err());
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(w.is_retired());
}
#[tokio::test]
async fn typed_terminal_profile_rejects_missing_result_and_honors_actual_failure() {
    for mode in ["malformed-terminal", "failed-terminal"] {
        let f = Rig::new(false);
        let w = f.worker(mode);
        let mut h = f.start(w.clone());
        let _ = bounded(h.accepted()).await;
        assert_ne!(
            bounded(h.wait()).await.unwrap().turn.outcome,
            Outcome::Success
        );
        assert!(w.is_retired());
    }
}
struct PanicSink;
impl pult_core::turn_driver::EventSink for PanicSink {
    fn append(
        &self,
        _: Value,
    ) -> Task<Result<pult_core::turn_driver::Receipt, pult_core::turn_driver::SinkError>> {
        Box::pin(async { panic!("controlled unknown external IO") })
    }
}
#[tokio::test]
async fn unknown_external_sink_panic_quarantines_without_any_native_pid() {
    let f = Rig::new(false);
    let w = f.worker_with("ack-first", |_, s| s.sink = Arc::new(PanicSink));
    let mut h = f.start(w.clone());
    assert!(bounded(h.accepted()).await.is_err());
    assert!(bounded(h.wait()).await.is_err());
    assert!(f.driver.storage_failed());
    assert!(!w.is_retired());
    assert!(!f.home.join("provider.pid").exists());
    assert!(f.record().get("zcodePendingInput").is_some());
}
#[tokio::test]
async fn expected_large_opaque_rpc_snapshot_does_not_use_the_event_queue_budget() {
    let f = Rig::new(false);
    let w = f.worker("large-snapshot");
    let mut h = f.start(w.clone());
    bounded(h.accepted()).await.unwrap();
    assert_eq!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    assert!(w.is_retired());
}
#[tokio::test]
async fn reflected_private_helper_key_is_redacted_without_entering_argv_or_common_env() {
    let f = Rig::new(false);
    let w = f.worker("reflect-key");
    let mut h = f.start(w.clone());
    bounded(h.accepted()).await.unwrap();
    assert_eq!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    let rows = f
        .journal
        .lock()
        .unwrap()
        .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
        .unwrap();
    let text = rows
        .iter()
        .map(|r| r.json.get())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!text.contains(&format!("mt_{}", "a".repeat(64))));
    assert!(text.contains("<token>"));
    assert!(w.is_retired());
}

struct ErrorInteraction {
    calls: AtomicUsize,
    bootstrap: bool,
    wrong_id: bool,
}
impl NativeInteractions for ErrorInteraction {
    fn handle(
        &self,
        _: ReverseContext,
        r: pult_core::zcode_appserver_protocol::ReverseRequest,
    ) -> Task<Result<BoundReverseReply, WorkerError>> {
        let fail = self.bootstrap || self.calls.fetch_add(1, Ordering::SeqCst) > 0;
        let wrong = self.wrong_id;
        Box::pin(async move {
            if fail {
                if wrong {
                    let other = pult_core::zcode_appserver_protocol::ReverseRequest::RuntimePreferences {
                        id: pult_core::zcode_appserver_protocol::RequestId::string("foreign-id").unwrap(),
                        session_id: "foreign".into(),
                        scope: pult_core::zcode_appserver_protocol::RuntimePreferencesScope::RuntimeMaterialization,
                    };
                    return BoundReverseReply::default_deny(&other);
                }
                return Err(WorkerError {
                    code: "interaction_failed".into(),
                    message: "static fixture".into(),
                });
            }
            BoundReverseReply::default_deny(&r)
        })
    }
    fn revoke(&self, _: &Ticket, _: u64) {}
}
#[tokio::test]
async fn reverse_failures_wake_rpc_or_running_actor_without_deadline() {
    for kind in 0..3 {
        let f = Rig::new(false);
        let mode = if kind == 0 {
            "ack-first"
        } else {
            "reverse-running"
        };
        let w = f.worker_with(mode, |c, s| {
            c.start_deadline = Instant::now() + Duration::from_secs(60);
            s.interactions = Arc::new(ErrorInteraction {
                calls: AtomicUsize::new(0),
                bootstrap: kind == 0,
                wrong_id: kind == 2,
            });
        });
        let mut h = f.start(w.clone());
        if kind == 0 {
            assert!(
                tokio::time::timeout(Duration::from_secs(5), h.accepted())
                    .await
                    .unwrap()
                    .is_err()
            );
        } else {
            bounded(h.accepted()).await.unwrap();
            while !f.home.join("reverse-running.entered").exists() {
                tokio::task::yield_now().await;
            }
            std::fs::write(f.home.join("reverse-running.release"), "").unwrap();
        }
        let completion = tokio::time::timeout(Duration::from_secs(5), h.wait())
            .await
            .expect("IO failure must wake actor before deadline")
            .unwrap();
        assert_ne!(completion.turn.outcome, Outcome::Success);
        assert!(w.is_retired());
        let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(!alive(pid));
    }
}

#[tokio::test]
async fn saturated_event_queue_failure_stays_sticky_while_accept_store_is_owned() {
    let f = Rig::new(false);
    let block = Block::new();
    let b = block.clone();
    let w = f.worker_with("event-flood", move |_, s| {
        s.store = Arc::new(HoldingStore {
            inner: s.store.clone(),
            block: b,
            accept: true,
        });
    });
    let mut h = f.start(w.clone());
    bounded(block.entered.notified()).await;
    std::fs::write(f.home.join("flood.release"), "").unwrap();
    let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while alive(pid) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("capacity failure stops holder even while Store is owned");
    assert!(!w.is_retired());
    block.release();
    assert!(bounded(h.accepted()).await.is_err());
    assert_ne!(
        bounded(h.wait()).await.unwrap().turn.outcome,
        Outcome::Success
    );
    assert!(w.is_retired());
}

fn forced_unknown_worker(f: &Rig, mode: &str) -> Arc<ZcodeAppServerWorker> {
    let wrapper = f.home.join("forced-unknown-holder");
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/zcode_holder_forced_unknown.py"),
        &wrapper,
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        f.home.join("actual-holder.path"),
        env!("CARGO_BIN_EXE_pult-worker-holder"),
    )
    .unwrap();
    f.worker_with(mode, |config, _| {
        config.launch.holder = wrapper;
    })
}
#[tokio::test]
async fn actual_holder_unknown_exit_quarantines_without_external_cancel_or_replay() {
    use pult_core::turn_driver::{DriverError, Progress};
    let f = Rig::new(false);
    let worker = forced_unknown_worker(&f, "ack-first");
    let mut handle = f.start(worker.clone());
    let accepted = bounded(handle.accepted()).await.unwrap();
    assert!(accepted.user_event_id > 0);
    assert!(accepted.turn_id.starts_with("pult-turn-"));
    // NativeStarted legitimately resolves the unknown-input marker already.
    // Unknown later cleanup must preserve that accepted identity/state.
    let accepted_marker = f.record().get("zcodePendingInput").is_some();
    let accepted_native = f.record().scalar("providerSessionId");
    wait_file(&f.home, "forced-holder-proof.json").await;
    let joined: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("forced-holder-proof.json")).unwrap())
            .unwrap();
    assert_eq!(joined["real_holder_exit_zero"], true);
    assert_eq!(joined["native_close_observed"], true);
    assert_eq!(joined["internal_owner_rebound"], true);
    let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        !alive(pid),
        "real native peer did not finish before forced125"
    );
    let proof = f.proof();
    assert_eq!(
        proof
            .iter()
            .filter(|v| v["method"] == "session/send")
            .count(),
        1
    );
    assert!(proof.iter().any(|v| v["send_marker_present"] == true
        && v["sid_durable"] == true
        && v["content_ok"] == true));
    // Normative assertion: a completed native turn with unknown owned cleanup
    // must reach Quarantined without an external cancel driving the supervisor.
    // The30s bound is the same watchdog as the other actual-holder cases.
    let completion = tokio::time::timeout(Duration::from_secs(30), handle.wait()).await;
    let quarantined_without_cancel =
        matches!(&completion, Ok(Err(DriverError::CleanupUnconfirmed)))
            && matches!(handle.progress(), Progress::Quarantined(_));
    let originally_running = matches!(handle.progress(), Progress::Running(_));
    let originally_pending = completion.is_err();
    assert_eq!(f.driver.active_count(), 1, "unknown cleanup freed capacity");
    assert_eq!(
        f.record().get("zcodePendingInput").is_some(),
        accepted_marker
    );
    assert_eq!(f.record().scalar("providerSessionId"), accepted_native);
    assert!(!worker.is_retired());
    if !quarantined_without_cancel {
        eprintln!(
            "stop-unknown counterexample: wait-timed-out={originally_pending} retained-running={originally_running} real-holder-joined=true native-finished=true exact-started=true replay=false"
        );
        // Failure-only owned cleanup request. It cannot satisfy the original
        // no-external-cancel assertion or convert this counterexample to PASS.
        f.driver.cancel(handle.ticket());
        let after_cancel = bounded(handle.wait()).await;
        assert!(matches!(after_cancel, Err(DriverError::CleanupUnconfirmed)));
        assert!(matches!(handle.progress(), Progress::Quarantined(_)));
    }
    assert_eq!(
        f.proof()
            .iter()
            .filter(|v| v["method"] == "session/send")
            .count(),
        1,
        "unknown cleanup replayed native input"
    );
    assert!(
        quarantined_without_cancel,
        "unknown cleanup must quarantine without an external cancellation"
    );
}

#[tokio::test]
async fn before_native_started_unknown_holder_exit_reaches_quarantine_without_start_deadline() {
    use pult_core::turn_driver::{DriverError, Progress};
    let f = Rig::new(true);
    let worker = forced_unknown_worker(&f, "resume-unavailable");
    let mut handle = f.start(worker.clone());
    wait_file(&f.home, "forced-holder-proof.json").await;
    let joined: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("forced-holder-proof.json")).unwrap())
            .unwrap();
    assert_eq!(joined["real_holder_exit_zero"], true);
    assert_eq!(joined["native_close_observed"], false);
    let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!alive(pid));
    let proof = f.proof();
    assert_eq!(
        proof
            .iter()
            .filter(|v| v["method"] == "session/resume")
            .count(),
        1
    );
    assert!(!proof.iter().any(|v| v["method"] == "session/send"));
    // Observe after the actual owned holder has joined. Do not wait for the
    // separate default30s Driver start timeout to mask a stuck start receiver.
    // Neither launch nor Driver deadlines are modified by this5s watchdog.
    let accepted = tokio::time::timeout(Duration::from_secs(5), handle.accepted()).await;
    let quarantined_without_cancel = matches!(&accepted, Ok(Err(DriverError::CleanupUnconfirmed)))
        && matches!(handle.progress(), Progress::Quarantined(_));
    let originally_starting = matches!(handle.progress(), Progress::Starting);
    let originally_pending = accepted.is_err();
    assert_eq!(f.driver.active_count(), 1);
    assert!(f.record().get("zcodePendingInput").is_some());
    assert_eq!(
        f.record().scalar("providerSessionId").as_deref(),
        Some("known-native")
    );
    assert!(!worker.is_retired());
    if !quarantined_without_cancel {
        eprintln!(
            "stop-unknown before-start counterexample: accepted-timed-out={originally_pending} retained-starting={originally_starting} real-holder-joined=true native-finished=true native-started=false model-input=false"
        );
        // Cleanup only after preserving the failed original observation.
        f.driver.cancel(handle.ticket());
        assert!(matches!(
            bounded(handle.wait()).await,
            Err(DriverError::CleanupUnconfirmed)
        ));
    }
    assert!(!f.proof().iter().any(|v| v["method"] == "session/send"));
    assert!(
        quarantined_without_cancel,
        "unknown pre-start cleanup must quarantine without waiting for the start deadline"
    );
}

#[tokio::test]
async fn unknown_cleanup_before_resources_preserves_quarantine_without_drain_entry() {
    use pult_core::turn_driver::{DriverError, Progress};
    let f = Rig::new(false);
    let block = Block::new();
    *f.resources.drain_block.lock().unwrap() = Some(block.clone());
    let worker = forced_unknown_worker(&f, "ack-first");
    let mut handle = f.start(worker.clone());
    let accepted = bounded(handle.accepted()).await.unwrap();
    assert!(accepted.user_event_id > 0);
    assert!(accepted.turn_id.starts_with("pult-turn-"));
    wait_file(&f.home, "forced-holder-proof.json").await;
    let joined: Value =
        serde_json::from_slice(&std::fs::read(f.home.join("forced-holder-proof.json")).unwrap())
            .unwrap();
    assert_eq!(joined["real_holder_exit_zero"], true);
    assert_eq!(joined["native_close_observed"], true);
    assert!(matches!(
        bounded(handle.wait()).await,
        Err(DriverError::CleanupUnconfirmed)
    ));
    assert!(matches!(handle.progress(), Progress::Quarantined(_)));
    // The actual owned outer125 is rejected BEFORE resources.drain. A waiter
    // for this notification alone would remain pending even after close ACK.
    assert_eq!(f.resources.drains.load(Ordering::Relaxed), 0);
    let mut entered = Box::pin(block.entered.notified());
    assert_pending(entered.as_mut());
    assert_eq!(f.driver.active_count(), 1);
    assert!(!worker.is_retired());
    let pid: u32 = std::fs::read_to_string(f.home.join("provider.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(!alive(pid));
    assert_eq!(
        f.proof()
            .iter()
            .filter(|row| row["method"] == "session/send")
            .count(),
        1
    );
}
