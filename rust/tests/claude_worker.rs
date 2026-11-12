//! Real process/Driver integration using a synthetic Claude fixture, no account.
use pult_core::claude_worker::{
    ClaudeWorker, Config, Services, SessionReceipt, SessionStage, SessionStore, SessionWrite,
    StoreError,
};
use pult_core::turn_coordinator::{Outcome, Ticket};
use pult_core::turn_driver::{
    DispatchDecision, Driver, EventSink, Options, Receipt, SinkError, Task,
};
use pult_core::turn_snapshot::{Approval, Provider, SessionKey, TurnSettings, TurnSnapshot};
use pult_core::worker_process::Launch;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
#[derive(Default)]
struct Sink(Mutex<Vec<Value>>);
impl EventSink for Sink {
    fn append(&self, value: Value) -> Task<Result<Receipt, SinkError>> {
        let mut rows = self.0.lock().unwrap();
        rows.push(value);
        let id = rows.len() as u64;
        Box::pin(async move {
            Ok(Receipt {
                id,
                ts: "2026-11-12T00:00:00Z".into(),
            })
        })
    }
}
struct Store(Arc<Mutex<Vec<SessionStage>>>);
impl SessionStore for Store {
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>> {
        self.0.lock().unwrap().push(request.stage());
        Box::pin(async move { Ok(request.acknowledge()) })
    }
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
fn snapshot(home: &Path) -> TurnSnapshot {
    TurnSnapshot {
        key: SessionKey {
            name: "claude-fixture".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        },
        provider: Provider::Claude,
        cwd: home.into(),
        settings: TurnSettings {
            approval: Approval::Ask,
            ..Default::default()
        },
    }
}
async fn scenario(mode: &str, panic_final_gate: bool) {
    pult_core::panic_guard::install();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    let sink = Arc::new(Sink::default());
    let driver = Arc::new(
        Driver::new(
            sink.clone(),
            Arc::new(pult_core::redaction::redact_string),
            Options::default(),
        )
        .unwrap(),
    );
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_gate = calls.clone();
    let gate = Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
        let call = calls_for_gate.fetch_add(1, Ordering::SeqCst);
        assert!(
            !(panic_final_gate && call == 1),
            "synthetic final gate panic"
        );
        DispatchDecision::Allow
    });
    let stages = Arc::new(Mutex::new(Vec::new()));
    let snapshot = snapshot(&home);
    let worker = ClaudeWorker::new(
        Config {
            session: snapshot.key.clone(),
            home: home.clone(),
            launch: Launch {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program: if mode == "missing-program" {
                    home.join("missing-provider")
                } else {
                    python()
                },
                args: vec![
                    "-B".into(),
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/fixtures/claude_worker.py")
                        .into_os_string(),
                    home.as_os_str().to_owned(),
                    mode.into(),
                ],
                cwd: home.clone(),
                env: BTreeMap::from([
                    ("PATH".into(), "/usr/bin:/bin".into()),
                    ("HOME".into(), home.as_os_str().to_owned()),
                ]),
            },
            provider_session_id: None,
            initialized: false,
            fork_on_resume: false,
            broker: false,
            setting_sources: None,
            protect_dirs: vec![],
            add_dirs: vec![],
            add_dir_roots: vec![],
            start_timeout: Duration::from_secs(5),
            attachments: vec![],
        },
        Services {
            driver: Arc::downgrade(&driver),
            sink: sink.clone(),
            gate,
            store: Arc::new(Store(stages.clone())),
            redactors: Arc::new(|| Box::new(pult_core::claude_events::LogRedactor)),
            fatal_storage: Arc::new(|| panic!("unexpected storage fault")),
            mcp: None,
        },
    )
    .unwrap();
    let mut handle = driver
        .start(snapshot, "fixture prompt".into(), worker.clone())
        .unwrap();
    let terminal = if mode == "drop-handle" {
        let mut progress = handle.subscribe_progress();
        drop(handle);
        loop {
            let state = progress.borrow().clone();
            if let pult_core::turn_driver::Progress::Finished(result) = state {
                break result.unwrap();
            }
            progress.changed().await.unwrap();
        }
    } else {
        if panic_final_gate
            || matches!(
                mode,
                "wide-mode" | "missing-program" | "malformed-mode" | "control-mode" | "null-mode"
            )
        {
            assert!(handle.accepted().await.is_err());
        } else {
            handle.accepted().await.unwrap();
            if mode == "hold" {
                assert!(driver.cancel(handle.ticket()));
            }
        }
        handle.wait().await.unwrap()
    };
    match mode {
        "normal" | "drop-handle" if !panic_final_gate => {
            assert_eq!(terminal.turn.outcome, Outcome::Success)
        }
        "hold" => assert_eq!(terminal.turn.outcome, Outcome::Interrupted),
        _ => assert!(matches!(terminal.turn.outcome, Outcome::Failure { .. })),
    }
    if mode == "assistant-block" || mode == "result-block" {
        let rows = sink.0.lock().unwrap();
        let wanted = if mode == "assistant-block" {
            "message.done"
        } else {
            "usage.updated"
        };
        let content = rows
            .iter()
            .position(|row| row["kind"] == wanted)
            .expect("normalized provider block evidence must be durable");
        let terminal = rows
            .iter()
            .position(|row| row["kind"] == "status.changed" && row["data"]["status"] == "failed")
            .unwrap();
        assert!(
            content < terminal,
            "provider evidence must precede Driver terminal"
        );
    }
    if matches!(
        mode,
        "wide-mode" | "malformed-mode" | "control-mode" | "null-mode"
    ) {
        assert!(worker.is_retired());
    }
    if matches!(mode, "malformed-mode" | "control-mode" | "null-mode") {
        assert!(
            matches!(&terminal.turn.outcome,Outcome::Failure{code,..} if code=="protocol_error")
        );
    }
    let stages = stages.lock().unwrap();
    if mode == "wide-mode" {
        assert!(
            stages.contains(&SessionStage::Initialized),
            "valid wider init must reach the trusted store before denial"
        );
    }
    if matches!(mode, "malformed-mode" | "control-mode" | "null-mode") {
        assert!(
            !stages.contains(&SessionStage::Initialized),
            "malformed presence cannot be persisted as legacy omission"
        );
    }
    if panic_final_gate || mode == "missing-program" {
        assert!(stages.contains(&SessionStage::Reserved));
        assert!(stages.contains(&SessionStage::AbortedBeforeInput));
    } else {
        assert!(!stages.contains(&SessionStage::AbortedBeforeInput));
    }
    assert_eq!(driver.active_count(), 0);
    if panic_final_gate {
        assert!(!home.join("input.json").exists());
    }
    // A returned terminal is only valid after proven process cleanup.
    if let Ok(pid) = std::fs::read_to_string(home.join("provider.pid")) {
        let pid = nix::unistd::Pid::from_raw(pid.parse().unwrap());
        assert!(
            nix::sys::signal::kill(pid, None).is_err(),
            "provider survived terminal cleanup"
        );
    }
}
macro_rules! case {
    ($name:ident,$mode:literal,$panic:literal) => {
        #[tokio::test]
        async fn $name() {
            tokio::time::timeout(Duration::from_secs(20), scenario($mode, $panic))
                .await
                .unwrap();
        }
    };
}
case!(
    ordinary_native_ack_and_result_are_owned_through_cleanup,
    "normal",
    false
);
case!(
    final_gate_panic_keeps_process_for_cleanup_and_sends_no_input,
    "normal",
    true
);
case!(wider_init_mode_is_rejected, "wide-mode", false);
case!(
    completed_without_result_finishes_with_failure_instead_of_hanging,
    "completed-only",
    false
);
case!(cancellation_stops_the_exact_owned_provider, "hold", false);

case!(
    provider_block_preserves_assistant_evidence_before_terminal,
    "assistant-block",
    false
);
case!(
    provider_block_preserves_usage_before_terminal,
    "result-block",
    false
);

case!(
    startup_failure_releases_only_its_never_sent_reservation,
    "missing-program",
    false
);

case!(
    dropped_caller_handle_does_not_abandon_provider_or_durable_completion,
    "drop-handle",
    false
);

case!(
    malformed_init_permission_mode_is_not_legacy_absence,
    "malformed-mode",
    false
);
case!(
    control_characters_in_init_mode_are_rejected,
    "control-mode",
    false
);
case!(
    explicit_null_init_mode_is_not_legacy_absence,
    "null-mode",
    false
);

// Exercise Worker retirement against the real owner rather than an ACK-only store.
struct OwnerRig {
    _temp: tempfile::TempDir,
    home: PathBuf,
    cwd: PathBuf,
    registry: Arc<Mutex<pult_core::registry::Registry>>,
    driver: Arc<Driver>,
    sink: Arc<pult_core::turn_journal::JournalSink>,
    owner: Arc<pult_core::claude_host_services::ClaudeOwner>,
    key: SessionKey,
}
const NATIVE_PARENT: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NATIVE_CHILD: &str = "11111111-2222-4333-8444-555555555555";
impl OwnerRig {
    fn new(approval: &str, fork: bool) -> Self {
        use pult_core::{
            claude_host_services::ClaudeOwner,
            claude_settings::Settings,
            consent_store::ConsentStore,
            journal::EventStore,
            registry::{Record, Registry},
            turn_journal::JournalSink,
        };
        use std::os::unix::fs::PermissionsExt;
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
        let mut record = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", key.created_at.as_str()),
            ("provider", "claude"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", approval),
        ] {
            record.set_string(k, v);
        }
        if fork {
            record.set_string("providerSessionId", NATIVE_PARENT);
            record.set_bool("forkOnResume", true);
        }
        registry.insert(record).unwrap();
        let registry = Arc::new(Mutex::new(registry));
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        if approval == "full" {
            consent
                .lock()
                .unwrap()
                .grant(&[Provider::Claude], chrono::Utc::now())
                .unwrap();
        }
        let sink = Arc::new(JournalSink::new(Arc::new(Mutex::new(journal))).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(pult_core::redaction::redact_string),
                Options::default(),
            )
            .unwrap(),
        );
        let settings = Settings::new(&home, home.join("managed")).unwrap();
        let owner = ClaudeOwner::new(
            home.clone(),
            registry.clone(),
            Arc::downgrade(&driver),
            consent,
            Arc::new(|_, _| true),
            Arc::new(move |ctx| {
                settings
                    .effective_mode(&ctx.cwd, ctx.setting_sources.as_deref())
                    .map_err(|_| pult_core::claude_host_services::OwnerError::Unavailable)
            }),
            Arc::new(|| {}),
        )
        .unwrap();
        Self {
            _temp: temp,
            home,
            cwd,
            registry,
            driver,
            sink,
            owner,
            key,
        }
    }
    fn record(&self) -> pult_core::registry::Record {
        self.registry.lock().unwrap().find("chat").unwrap().clone()
    }
    fn config(&self, mode: &str) -> Config {
        let record = self.record();
        let id = record.scalar("providerSessionId");
        Config {
            session: self.key.clone(),
            home: self.home.clone(),
            launch: Launch {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program: python(),
                args: vec![
                    "-B".into(),
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/fixtures/claude_worker_identity.py")
                        .into_os_string(),
                    self.home.clone().into_os_string(),
                    mode.into(),
                ],
                cwd: self.cwd.clone(),
                env: BTreeMap::from([
                    ("PATH".into(), "/usr/bin:/bin".into()),
                    ("HOME".into(), self.home.clone().into_os_string()),
                ]),
            },
            provider_session_id: id.clone(),
            initialized: id.is_some(),
            fork_on_resume: record.get("forkOnResume").is_some(),
            broker: false,
            setting_sources: None,
            protect_dirs: vec![],
            add_dirs: vec![],
            add_dir_roots: vec![],
            start_timeout: Duration::from_secs(5),
            attachments: vec![],
        }
    }
    fn inputs(&self) -> usize {
        std::fs::read_to_string(self.home.join("inputs.jsonl"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    fn stopped(&self) {
        let pid: i32 = std::fs::read_to_string(self.home.join("provider.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err(),
            "provider outlived cleanup"
        );
    }
    async fn reject_stale_then_rebuild(&self, old: Arc<ClaudeWorker>) {
        assert!(old.is_retired(), "denied init must revoke facade reuse");
        let mut refused = self
            .driver
            .start(
                self.owner.snapshot(&self.key).unwrap(),
                "must not reuse old identity".into(),
                old,
            )
            .unwrap();
        let failure = refused.wait().await.unwrap().turn.outcome;
        assert!(matches!(failure,Outcome::Failure{code,..}if code=="worker_retired"));
        assert_eq!(self.inputs(), 1);
        assert!(self.record().get("claudeReservedSessionId").is_none());
        let rebuilt = ClaudeWorker::new(
            self.config("normal"),
            self.owner.services(self.sink.clone(), None),
        )
        .unwrap();
        let mut next = self
            .driver
            .start(
                self.owner.snapshot(&self.key).unwrap(),
                "explicit next input".into(),
                rebuilt,
            )
            .unwrap();
        next.accepted().await.unwrap();
        assert_eq!(next.wait().await.unwrap().turn.outcome, Outcome::Success);
        assert_eq!(self.inputs(), 2);
        self.stopped();
        let launch: Vec<String> = serde_json::from_str(
            std::fs::read_to_string(self.home.join("launches.jsonl"))
                .unwrap()
                .lines()
                .last()
                .unwrap(),
        )
        .unwrap();
        let id = self.record().scalar("providerSessionId").unwrap();
        assert!(launch.windows(2).any(|v| v == ["--resume", id.as_str()]));
        assert!(!launch.iter().any(|v| v == "--fork-session"));
    }
}
struct InitBarrier {
    inner: Arc<dyn SessionStore>,
    entered: tokio::sync::Notify,
    release: Arc<tokio::sync::Semaphore>,
}
impl SessionStore for InitBarrier {
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>> {
        let init = matches!(request.stage(), SessionStage::Initialized);
        let inner = self.inner.clone();
        let release = self.release.clone();
        if init {
            self.entered.notify_one();
        }
        Box::pin(async move {
            if init {
                release.acquire_owned().await.unwrap().forget();
            }
            inner.persist(request).await
        })
    }
}
struct InitRelease(Arc<tokio::sync::Semaphore>);
impl Drop for InitRelease {
    fn drop(&mut self) {
        self.0.add_permits(1);
    }
}
async fn denied_init_keeps_evidence(approval: &str, fork: bool) {
    pult_core::panic_guard::install();
    let f = OwnerRig::new(approval, fork);
    let worker =
        ClaudeWorker::new(f.config("bypass"), f.owner.services(f.sink.clone(), None)).unwrap();
    let mut turn = f
        .driver
        .start(
            f.owner.snapshot(&f.key).unwrap(),
            "first input".into(),
            worker.clone(),
        )
        .unwrap();
    assert!(turn.accepted().await.is_err());
    assert!(matches!(
        turn.wait().await.unwrap().turn.outcome,
        Outcome::Failure { .. }
    ));
    f.stopped();
    let record = f.record();
    if fork {
        assert_eq!(
            record.scalar("providerSessionId").as_deref(),
            Some(NATIVE_CHILD)
        );
    } else {
        assert!(record.get("providerSessionId").is_some());
    }
    assert!(record.get("claudeReservedSessionId").is_none());
    assert!(record.get("forkOnResume").is_none());
    if approval == "inherit" {
        assert_eq!(
            record.scalar("inheritSeen").as_deref(),
            Some("bypassPermissions")
        );
    }
    f.reject_stale_then_rebuild(worker).await;
}
macro_rules! owner_case{($name:ident,$body:block)=>{#[tokio::test]async fn $name(){tokio::time::timeout(Duration::from_secs(20),async $body).await.unwrap();}};}
owner_case!(
    valid_wider_init_is_durable_before_the_worker_denies_continuation,
    {
        denied_init_keeps_evidence("ask", false).await;
    }
);
owner_case!(
    denied_fork_child_is_durable_and_old_private_parent_cannot_be_reused,
    {
        denied_init_keeps_evidence("ask", true).await;
    }
);
owner_case!(
    owner_rejected_inherited_bypass_retires_after_sticky_evidence,
    {
        denied_init_keeps_evidence("inherit", true).await;
    }
);
owner_case!(
    current_policy_downgrade_retains_known_id_then_requires_recreation,
    {
        pult_core::panic_guard::install();
        for approval in ["ask", "read-only"] {
            let f = OwnerRig::new("full", true);
            let mut services = f.owner.services(f.sink.clone(), None);
            let barrier = Arc::new(InitBarrier {
                inner: services.store.clone(),
                entered: tokio::sync::Notify::new(),
                release: Arc::new(tokio::sync::Semaphore::new(0)),
            });
            services.store = barrier.clone();
            let release = InitRelease(barrier.release.clone());
            let worker = ClaudeWorker::new(f.config("bypass"), services).unwrap();
            let mut turn = f
                .driver
                .start(
                    f.owner.snapshot(&f.key).unwrap(),
                    "first input".into(),
                    worker.clone(),
                )
                .unwrap();
            barrier.entered.notified().await;
            f.registry
                .lock()
                .unwrap()
                .update_checked(&f.key, |r| {
                    r.set_string("approval", approval);
                    Ok(())
                })
                .unwrap();
            drop(release);
            assert!(turn.accepted().await.is_err());
            assert!(matches!(
                turn.wait().await.unwrap().turn.outcome,
                Outcome::Failure { .. }
            ));
            f.stopped();
            assert_eq!(
                f.record().scalar("providerSessionId").as_deref(),
                Some(NATIVE_CHILD)
            );
            assert!(f.record().get("claudeReservedSessionId").is_none());
            f.reject_stale_then_rebuild(worker).await;
        }
    }
);

owner_case!(
    subagent_or_malformed_init_cannot_replace_the_owned_fork_identity,
    {
        pult_core::panic_guard::install();
        for mode in ["foreign-child", "malformed-parent"] {
            let f = OwnerRig::new("ask", true);
            let worker =
                ClaudeWorker::new(f.config(mode), f.owner.services(f.sink.clone(), None)).unwrap();
            let mut turn = f
                .driver
                .start(
                    f.owner.snapshot(&f.key).unwrap(),
                    "first input".into(),
                    worker.clone(),
                )
                .unwrap();
            let accepted = turn.accepted().await;
            // Even if an invalid peer sent a matching command ACK afterwards, it
            // cannot attribute the child's init to the root's ownership checkpoint.
            assert!(accepted.is_err());
            let terminal = turn.wait().await.unwrap();
            let expected = if mode == "foreign-child" {
                "not_implemented"
            } else {
                "protocol_error"
            };
            assert!(matches!(terminal.turn.outcome, Outcome::Failure {code,..} if code==expected));
            f.stopped();
            assert!(worker.is_retired());
            assert_eq!(
                f.record().scalar("providerSessionId").as_deref(),
                Some(NATIVE_PARENT)
            );
            assert_eq!(
                f.record().scalar("claudeReservedSessionId").as_deref(),
                Some(NATIVE_PARENT)
            );
            assert!(f.record().get("forkOnResume").is_some());
        }
    }
);
owner_case!(
    legacy_root_init_null_and_empty_parent_still_confirm_the_owned_fork,
    {
        pult_core::panic_guard::install();
        for mode in ["root-null", "root-empty"] {
            let f = OwnerRig::new("ask", true);
            let worker =
                ClaudeWorker::new(f.config(mode), f.owner.services(f.sink.clone(), None)).unwrap();
            let mut turn = f
                .driver
                .start(
                    f.owner.snapshot(&f.key).unwrap(),
                    "first input".into(),
                    worker.clone(),
                )
                .unwrap();
            turn.accepted().await.unwrap();
            assert_eq!(turn.wait().await.unwrap().turn.outcome, Outcome::Success);
            f.stopped();
            assert!(!worker.is_retired());
            assert_eq!(
                f.record().scalar("providerSessionId").as_deref(),
                Some(NATIVE_CHILD)
            );
            assert!(f.record().get("claudeReservedSessionId").is_none());
        }
    }
);
