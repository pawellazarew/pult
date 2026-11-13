use pult_core::claude_host_services::{ClaudeOwner, InheritMode, OwnerError, RouteValidity};
use pult_core::claude_settings::Settings;
use pult_core::claude_worker::{
    ClaudeWorker, Config, SessionReceipt, SessionStage, SessionStore, SessionWrite, StoreError,
};
use pult_core::consent_store::ConsentStore;
use pult_core::journal::EventStore;
use pult_core::registry::{Record, Registry};
use pult_core::turn_coordinator::Outcome;
use pult_core::turn_driver::{Driver, DriverError, Options, Task};
use pult_core::turn_journal::JournalSink;
use pult_core::turn_snapshot::{Approval, Provider, SessionKey};
use pult_core::worker_process::Launch;
use std::{
    collections::BTreeMap,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
fn install_test_hook() {
    pult_core::panic_guard::install();
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if let Some(at) = info.location() {
                eprintln!("Claude owner fixture panic at {}:{}", at.file(), at.line());
            }
        }))
    });
}
fn diagnostic_pid(f: &Fixture, phase: &'static str) {
    let pid = std::fs::read_to_string(f.home.join("provider.pid"))
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0);
    let present = pid
        .is_some_and(|pid| nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok());
    eprintln!("[fixture-lifecycle] owner phase={phase} provider-pid={pid:?} present={present}");
}
const WAIT: Duration = Duration::from_secs(20);
macro_rules! case {($name:ident,$body:block)=>{#[tokio::test]async fn $name(){install_test_hook();tokio::time::timeout(WAIT,async $body).await.expect("Claude owner watchdog");}};}
const PARENT: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    cwd: PathBuf,
    child_home: PathBuf,
    key: SessionKey,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
    sink: Arc<JournalSink>,
    driver: Arc<Driver>,
}
impl Fixture {
    fn new(approval: &str, prepare: impl FnOnce(&mut Record)) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let child_home = home.join("child-home");
        std::fs::create_dir(&child_home).unwrap();
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
            ("title", "original-title"),
        ] {
            record.set_string(k, v);
        }
        prepare(&mut record);
        registry.insert(record).unwrap();
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        let sink = Arc::new(JournalSink::new(Arc::new(Mutex::new(journal))).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(pult_core::redaction::redact_string),
                Options::default(),
            )
            .unwrap(),
        );
        Self {
            _temp: temp,
            home,
            cwd,
            child_home,
            key,
            registry: Arc::new(Mutex::new(registry)),
            consent,
            sink,
            driver,
        }
    }
    fn resolver(&self) -> InheritMode {
        let settings = Settings::new(&self.child_home, self.home.join("managed")).unwrap();
        Arc::new(move |ctx| {
            settings
                .effective_mode(&ctx.cwd, ctx.setting_sources.as_deref())
                .map_err(|_| OwnerError::Unavailable)
        })
    }
    fn owner(&self, route: RouteValidity) -> Arc<ClaudeOwner> {
        self.owner_with(route, self.resolver(), Arc::new(|| {}))
    }
    fn owner_with(
        &self,
        route: RouteValidity,
        inherit: InheritMode,
        fatal: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<ClaudeOwner> {
        ClaudeOwner::new(
            self.home.clone(),
            self.registry.clone(),
            Arc::downgrade(&self.driver),
            self.consent.clone(),
            route,
            inherit,
            fatal,
        )
        .unwrap()
    }
    fn config(&self, mode: &str) -> Config {
        let record = self.record();
        let id = record.scalar("providerSessionId");
        Config {
            session: self.key.clone(),
            home: self.home.clone(),
            launch: Launch {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program: "/usr/bin/python3".into(),
                args: vec![
                    "-B".into(),
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/fixtures/claude_owner.py")
                        .into_os_string(),
                    self.home.clone().into_os_string(),
                    mode.into(),
                ],
                cwd: self.cwd.clone(),
                env: BTreeMap::from([
                    ("PATH".into(), "/usr/bin:/bin".into()),
                    ("HOME".into(), self.child_home.clone().into_os_string()),
                ]),
            },
            provider_session_id: id.clone(),
            initialized: id.is_some(),
            fork_on_resume: record.get("forkOnResume").is_some(),
            broker: false,
            setting_sources: record.scalar("settingSources"),
            protect_dirs: vec![],
            add_dirs: vec![],
            add_dir_roots: vec![],
            start_timeout: Duration::from_secs(5),
            attachments: vec![],
        }
    }
    fn record(&self) -> Record {
        self.registry.lock().unwrap().find("chat").unwrap().clone()
    }
    fn argv(&self) -> Vec<String> {
        serde_json::from_slice(&std::fs::read(self.home.join("argv.json")).unwrap()).unwrap()
    }
}
struct HoldInit {
    inner: Arc<dyn SessionStore>,
    entered: tokio::sync::Notify,
    release: Arc<tokio::sync::Semaphore>,
}
impl SessionStore for HoldInit {
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>> {
        let hold = matches!(request.stage(), SessionStage::Initialized);
        let inner = self.inner.clone();
        let release = self.release.clone();
        if hold {
            self.entered.notify_one();
        }
        Box::pin(async move {
            if hold {
                release.acquire_owned().await.unwrap().forget();
            }
            inner.persist(request).await
        })
    }
}
struct Release(Arc<tokio::sync::Semaphore>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.add_permits(1);
    }
}
case!(
    native_candidate_is_durable_before_input_and_init_changes_only_owned_fields,
    {
        let f = Fixture::new("ask", |_| {});
        let owner = f.owner(Arc::new(|_, _| true));
        let snapshot = owner.snapshot(&f.key).unwrap();
        let mut services = owner.services(f.sink.clone(), None);
        let hold = Arc::new(HoldInit {
            inner: services.store.clone(),
            entered: tokio::sync::Notify::new(),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        });
        services.store = hold.clone();
        let unblock = Release(hold.release.clone());
        let worker = ClaudeWorker::new(f.config("normal"), services).unwrap();
        let mut turn = f.driver.start(snapshot, "prompt".into(), worker).unwrap();
        hold.entered.notified().await;
        let reserved = f.record().scalar("claudeReservedSessionId").unwrap();
        assert!(f.record().get("providerSessionId").is_none());
        assert_eq!(
            std::fs::read_to_string(f.home.join("input-proof")).unwrap(),
            reserved
        );
        f.registry
            .lock()
            .unwrap()
            .update_checked(&f.key, |r| {
                r.set_string("title", "changed-title");
                r.set_string("model", "new-model");
                r.set_string("approval", "workspace");
                Ok(())
            })
            .unwrap();
        drop(unblock);
        turn.accepted().await.unwrap();
        assert_eq!(turn.wait().await.unwrap().turn.outcome, Outcome::Success);
        let record = f.record();
        assert_eq!(record.scalar("providerSessionId"), Some(reserved));
        assert!(record.get("claudeReservedSessionId").is_none());
        assert_eq!(record.scalar("title").as_deref(), Some("changed-title"));
        assert_eq!(record.scalar("approval").as_deref(), Some("workspace"));
        assert_eq!(record.scalar("model").as_deref(), Some("new-model"));
    }
);
case!(
    fork_compares_confirmed_parent_then_commits_new_native_identity,
    {
        let f = Fixture::new("ask", |r| {
            r.set_string("providerSessionId", PARENT);
            r.set_bool("forkOnResume", true);
        });
        let owner = f.owner(Arc::new(|_, _| true));
        let worker =
            ClaudeWorker::new(f.config("normal"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "fork".into(), worker)
            .unwrap();
        turn.accepted().await.unwrap();
        turn.wait().await.unwrap();
        assert_ne!(
            f.record().scalar("providerSessionId").as_deref(),
            Some(PARENT)
        );
        assert!(f.record().get("forkOnResume").is_none());
        assert!(f.record().get("claudeReservedSessionId").is_none());
        let args = f.argv();
        assert!(args.iter().any(|arg| arg == "--fork-session"));
        assert!(args.windows(2).any(|v| v == ["--resume", PARENT]));
    }
);
case!(fork_cannot_claim_the_unchanged_parent_was_copied, {
    let f = Fixture::new("ask", |r| {
        r.set_string("providerSessionId", PARENT);
        r.set_bool("forkOnResume", true);
    });
    let owner = f.owner(Arc::new(|_, _| true));
    let worker =
        ClaudeWorker::new(f.config("same-fork"), owner.services(f.sink.clone(), None)).unwrap();
    let mut turn = f
        .driver
        .start(owner.snapshot(&f.key).unwrap(), "fork".into(), worker)
        .unwrap();
    assert!(turn.accepted().await.is_err());
    turn.wait().await.unwrap();
    assert_eq!(
        f.record().scalar("providerSessionId").as_deref(),
        Some(PARENT)
    );
    assert!(f.record().get("forkOnResume").is_some());
    assert!(f.record().get("claudeReservedSessionId").is_some());
    assert!(matches!(owner.snapshot(&f.key), Err(OwnerError::Uncertain)));
});
case!(
    inherited_bypass_requires_current_provider_consent_and_sticky_evidence,
    {
        let f = Fixture::new("inherit", |r| {
            r.set_string("inheritSeen", "bypassPermissions")
        });
        let owner = f.owner(Arc::new(|_, _| true));
        assert_eq!(
            owner.snapshot(&f.key).unwrap().settings.approval,
            Approval::Ask
        );
        f.consent
            .lock()
            .unwrap()
            .grant(&[Provider::Claude], chrono::Utc::now())
            .unwrap();
        assert_eq!(
            owner.snapshot(&f.key).unwrap().settings.approval,
            Approval::Inherit
        );
        let worker =
            ClaudeWorker::new(f.config("bypass"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
            .unwrap();
        turn.accepted().await.unwrap();
        turn.wait().await.unwrap();
        assert_eq!(
            f.record().scalar("inheritSeen").as_deref(),
            Some("bypassPermissions")
        );
        f.consent
            .lock()
            .unwrap()
            .revoke(chrono::Utc::now())
            .unwrap();
        assert_eq!(
            owner.snapshot(&f.key).unwrap().settings.approval,
            Approval::Ask
        );
    }
);
case!(
    unexpected_inherited_bypass_is_durable_evidence_before_rejection,
    {
        let f = Fixture::new("inherit", |_| {});
        let owner = f.owner(Arc::new(|_, _| true));
        assert_eq!(
            owner.snapshot(&f.key).unwrap().settings.approval,
            Approval::Inherit
        );
        let worker =
            ClaudeWorker::new(f.config("bypass"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
            .unwrap();
        assert!(turn.accepted().await.is_err());
        assert!(matches!(
            turn.wait().await.unwrap().turn.outcome,
            Outcome::Failure { .. }
        ));
        assert!(f.record().get("providerSessionId").is_some());
        assert!(f.record().get("claudeReservedSessionId").is_none());
        assert_eq!(
            owner.snapshot(&f.key).unwrap().settings.approval,
            Approval::Ask
        );
    }
);
case!(
    cancelled_init_retains_diagnostic_identity_without_restoring_old_settings,
    {
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=start");
        let f = Fixture::new("ask", |_| {});
        let owner = f.owner(Arc::new(|_, _| true));
        let mut services = owner.services(f.sink.clone(), None);
        let hold = Arc::new(HoldInit {
            inner: services.store.clone(),
            entered: tokio::sync::Notify::new(),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        });
        services.store = hold.clone();
        let unblock = Release(hold.release.clone());
        let worker = ClaudeWorker::new(f.config("hold"), services).unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
            .unwrap();
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=init-entered-before");
        hold.entered.notified().await;
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=init-entered-after");
        diagnostic_pid(&f, "owner-cancel-init-init-entered-after");
        assert!(f.driver.cancel(turn.ticket()));
        f.registry
            .lock()
            .unwrap()
            .update_checked(&f.key, |r| {
                r.set_string("title", "after-cancel");
                Ok(())
            })
            .unwrap();
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=release-init-before");
        drop(unblock);
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=release-init-after");
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=turn-wait-before");
        diagnostic_pid(&f, "owner-cancel-init-turn-wait-before");
        assert_eq!(
            turn.wait().await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        eprintln!("[fixture-lifecycle] owner-cancel-init phase=turn-wait-after");
        diagnostic_pid(&f, "owner-cancel-init-turn-wait-after");
        assert!(f.record().get("providerSessionId").is_some());
        assert!(f.record().get("claudeReservedSessionId").is_none());
        assert_eq!(f.record().scalar("title").as_deref(), Some("after-cancel"));
    }
);
case!(
    removed_archived_or_recreated_records_cannot_be_resurrected_by_init,
    {
        for mutation in ["archive", "recreate", "provider"] {
            let f = Fixture::new("ask", |_| {});
            let owner = f.owner(Arc::new(|_, _| true));
            let mut services = owner.services(f.sink.clone(), None);
            let hold = Arc::new(HoldInit {
                inner: services.store.clone(),
                entered: tokio::sync::Notify::new(),
                release: Arc::new(tokio::sync::Semaphore::new(0)),
            });
            services.store = hold.clone();
            let unblock = Release(hold.release.clone());
            let worker = ClaudeWorker::new(f.config("normal"), services).unwrap();
            let mut turn = f
                .driver
                .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
                .unwrap();
            hold.entered.notified().await;
            {
                let mut registry = f.registry.lock().unwrap();
                if mutation == "recreate" || mutation == "provider" {
                    let mut record = registry.remove_checked(&f.key).unwrap();
                    if mutation == "recreate" {
                        record.set_string("createdAt", "2027-01-01T00:00:00Z");
                    } else {
                        record.set_string("provider", "codex");
                    }
                    record.remove("claudeReservedSessionId");
                    record.set_string("title", "new-incarnation");
                    registry.insert(record).unwrap();
                } else {
                    registry
                        .update_checked(&f.key, |r| {
                            if mutation == "archive" {
                                r.set_bool("archived", true);
                            } else {
                                r.set_string("provider", "codex");
                            }
                            Ok(())
                        })
                        .unwrap();
                }
            }
            drop(unblock);
            assert!(turn.accepted().await.is_err());
            turn.wait().await.unwrap();
            assert!(f.record().get("providerSessionId").is_none());
            if mutation == "recreate" {
                assert_eq!(
                    f.record().scalar("title").as_deref(),
                    Some("new-incarnation")
                );
            }
            assert!(!f.driver.storage_failed());
        }
    }
);
case!(
    unknown_registry_commit_latches_driver_before_reentrant_host_hook,
    {
        let f = Fixture::new("ask", |_| {});
        let path = f.home.join("sessions.json");
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let registry = f.registry.clone();
        let driver = f.driver.clone();
        let owner = f.owner_with(
            Arc::new(move |_, _| {
                std::fs::write(&path, "changed outside owner").unwrap();
                true
            }),
            f.resolver(),
            Arc::new(move || {
                assert!(driver.storage_failed());
                assert!(registry.try_lock().is_ok());
                count.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let snapshot = owner.snapshot(&f.key).unwrap();
        let worker =
            ClaudeWorker::new(f.config("normal"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f.driver.start(snapshot, "prompt".into(), worker).unwrap();
        assert!(matches!(
            turn.wait().await,
            Err(DriverError::StorageUnavailable)
        ));
        assert!(f.driver.storage_failed());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(!f.home.join("input-proof").exists());
    }
);
#[test]
fn provider_path_pins_and_mandatory_resolver_fail_closed() {
    pult_core::panic_guard::install();
    let f = Fixture::new("inherit", |_| {});
    let owner = f.owner_with(
        Arc::new(|_, _| true),
        Arc::new(|_| panic!("synthetic resolver panic")),
        Arc::new(|| {}),
    );
    assert!(owner.snapshot(&f.key).is_err());
    let good = f.owner(Arc::new(|_, _| true));
    good.snapshot(&f.key).unwrap();
    let replacement = f.home.join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    let original = f.home.join("old-project");
    std::fs::rename(&f.cwd, &original).unwrap();
    symlink(&replacement, &f.cwd).unwrap();
    assert!(matches!(
        good.snapshot(&f.key),
        Err(OwnerError::InvalidPath)
    ));
    let other = Fixture::new("ask", |r| r.set_string("provider", "zcode"));
    assert!(matches!(
        other.owner(Arc::new(|_, _| true)).snapshot(&other.key),
        Err(OwnerError::InvalidSession)
    ));
}

case!(
    fresh_consent_revocation_restricts_full_before_native_input,
    {
        let f = Fixture::new("full", |_| {});
        f.consent
            .lock()
            .unwrap()
            .grant(&[Provider::Claude], chrono::Utc::now())
            .unwrap();
        let consent = f.consent.clone();
        let owner = f.owner(Arc::new(move |_, _| {
            consent.lock().unwrap().revoke(chrono::Utc::now()).unwrap();
            true
        }));
        let snapshot = owner.snapshot(&f.key).unwrap();
        assert_eq!(snapshot.settings.approval, Approval::Full);
        let worker =
            ClaudeWorker::new(f.config("normal"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f.driver.start(snapshot, "prompt".into(), worker).unwrap();
        turn.accepted().await.unwrap();
        turn.wait().await.unwrap();
        assert!(
            f.argv()
                .windows(2)
                .any(|v| v == ["--permission-mode", "manual"])
        );
        assert_eq!(f.record().scalar("approval").as_deref(), Some("full"));
    }
);
case!(
    subsequent_ticket_resumes_only_the_confirmed_native_session,
    {
        let f = Fixture::new("ask", |_| {});
        let owner = f.owner(Arc::new(|_, _| true));
        let worker =
            ClaudeWorker::new(f.config("normal"), owner.services(f.sink.clone(), None)).unwrap();
        let mut first = f
            .driver
            .start(
                owner.snapshot(&f.key).unwrap(),
                "first".into(),
                worker.clone(),
            )
            .unwrap();
        first.accepted().await.unwrap();
        first.wait().await.unwrap();
        let id = f.record().scalar("providerSessionId").unwrap();
        let mut second = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "second".into(), worker)
            .unwrap();
        second.accepted().await.unwrap();
        second.wait().await.unwrap();
        assert_eq!(f.record().scalar("providerSessionId"), Some(id.clone()));
        assert!(f.argv().windows(2).any(|v| v == ["--resume", id.as_str()]));
        assert!(f.record().get("claudeReservedSessionId").is_none());
    }
);
struct CancelReserved {
    inner: Arc<dyn SessionStore>,
    driver: Arc<Driver>,
}
impl SessionStore for CancelReserved {
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>> {
        let reserved = matches!(request.stage(), SessionStage::Reserved);
        let ticket = request.ticket().clone();
        let inner = self.inner.clone();
        let driver = self.driver.clone();
        Box::pin(async move {
            let result = inner.persist(request).await;
            if reserved && result.is_ok() {
                driver.cancel(&ticket);
            }
            result
        })
    }
}
case!(
    known_no_input_cancellation_clears_only_its_owned_candidate,
    {
        let f = Fixture::new("ask", |_| {});
        let owner = f.owner(Arc::new(|_, _| true));
        let mut services = owner.services(f.sink.clone(), None);
        services.store = Arc::new(CancelReserved {
            inner: services.store.clone(),
            driver: f.driver.clone(),
        });
        let worker = ClaudeWorker::new(f.config("normal"), services).unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
            .unwrap();
        assert_eq!(
            turn.wait().await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        assert!(!f.home.join("input-proof").exists());
        assert!(f.record().get("claudeReservedSessionId").is_none());
        assert!(f.record().get("providerSessionId").is_none());
        assert!(owner.snapshot(&f.key).is_ok());
    }
);
case!(
    inherit_resolver_reentrant_cancel_denies_dispatch_after_callback,
    {
        let f = Fixture::new("inherit", |_| {});
        let driver = Arc::downgrade(&f.driver);
        let key = f.key.clone();
        let real = f.resolver();
        let owner = f.owner_with(
            Arc::new(|_, _| true),
            Arc::new(move |ctx| {
                if let Some(driver) = driver.upgrade()
                    && let Some(ticket) = driver.active_ticket(&key)
                {
                    driver.cancel(&ticket);
                }
                real(ctx)
            }),
            Arc::new(|| {}),
        );
        let snapshot = owner.snapshot(&f.key).unwrap();
        let worker =
            ClaudeWorker::new(f.config("normal"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f.driver.start(snapshot, "prompt".into(), worker).unwrap();
        assert_ne!(turn.wait().await.unwrap().turn.outcome, Outcome::Success);
        assert!(!f.home.join("input-proof").exists());
        assert!(f.record().get("claudeReservedSessionId").is_none());
    }
);
#[test]
fn unresolved_candidates_including_future_values_never_become_fresh_authority() {
    install_test_hook();
    for raw in ["null", "false", "42", r#"{"future":true}"#] {
        let f = Fixture::new("ask", |r| {
            r.set_raw(
                "claudeReservedSessionId",
                serde_json::value::RawValue::from_string(raw.into()).unwrap(),
            );
        });
        assert!(matches!(
            f.owner(Arc::new(|_, _| true)).snapshot(&f.key),
            Err(OwnerError::Uncertain)
        ));
    }
}

case!(
    duplicate_init_rechecks_reported_full_after_a_healthy_manual_init,
    {
        let f = Fixture::new("inherit", |_| {});
        let owner = f.owner(Arc::new(|_, _| true));
        let worker = ClaudeWorker::new(
            f.config("duplicate-bypass"),
            owner.services(f.sink.clone(), None),
        )
        .unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
            .unwrap();
        assert!(turn.accepted().await.is_err());
        assert!(matches!(
            turn.wait().await.unwrap().turn.outcome,
            Outcome::Failure { .. }
        ));
        assert_eq!(
            f.record().scalar("inheritSeen").as_deref(),
            Some("bypassPermissions")
        );
        assert_eq!(
            owner.snapshot(&f.key).unwrap().settings.approval,
            Approval::Ask
        );
    }
);
case!(
    duplicate_fork_init_is_idempotent_for_the_same_owned_child,
    {
        let f = Fixture::new("ask", |r| {
            r.set_string("providerSessionId", PARENT);
            r.set_bool("forkOnResume", true);
        });
        let owner = f.owner(Arc::new(|_, _| true));
        let worker = ClaudeWorker::new(
            f.config("duplicate-fork"),
            owner.services(f.sink.clone(), None),
        )
        .unwrap();
        let mut turn = f
            .driver
            .start(owner.snapshot(&f.key).unwrap(), "prompt".into(), worker)
            .unwrap();
        turn.accepted().await.unwrap();
        assert_eq!(turn.wait().await.unwrap().turn.outcome, Outcome::Success);
        assert_eq!(
            f.record().scalar("providerSessionId").as_deref(),
            Some("11111111-2222-4333-8444-555555555555")
        );
    }
);
case!(
    registry_wait_does_not_hide_cancellation_or_hold_the_driver_lock,
    {
        let f = Fixture::new("ask", |_| {});
        let once = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let entered = Arc::new(tokio::sync::Notify::new());
        let arriving = entered.clone();
        let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        struct Unblock(Arc<(Mutex<bool>, std::sync::Condvar)>);
        impl Drop for Unblock {
            fn drop(&mut self) {
                *self.0.0.lock().unwrap() = true;
                self.0.1.notify_all();
            }
        }
        let unblock = Unblock(release.clone());
        let registry = f.registry.clone();
        let barrier = release.clone();
        let join = Arc::new(Mutex::new(None));
        let joining = join.clone();
        let owner = f.owner(Arc::new(move |_, _| {
            if !once.swap(true, Ordering::SeqCst) {
                let registry = registry.clone();
                let barrier = barrier.clone();
                let arriving = arriving.clone();
                let (tx, rx) = std::sync::mpsc::channel();
                *joining.lock().unwrap() = Some(std::thread::spawn(move || {
                    let _guard = registry.lock().unwrap();
                    tx.send(()).unwrap();
                    arriving.notify_one();
                    let (mut flag, changed) = (barrier.0.lock().unwrap(), &barrier.1);
                    while !*flag {
                        flag = changed.wait(flag).unwrap();
                    }
                }));
                rx.recv().unwrap();
            }
            true
        }));
        let snapshot = owner.snapshot(&f.key).unwrap();
        let worker =
            ClaudeWorker::new(f.config("normal"), owner.services(f.sink.clone(), None)).unwrap();
        let mut turn = f.driver.start(snapshot, "prompt".into(), worker).unwrap();
        entered.notified().await;
        assert!(f.driver.cancel(turn.ticket()));
        drop(unblock);
        assert_ne!(turn.wait().await.unwrap().turn.outcome, Outcome::Success);
        let child = join.lock().unwrap().take().unwrap();
        tokio::task::spawn_blocking(move || child.join().unwrap())
            .await
            .unwrap();
        assert!(!f.home.join("input-proof").exists());
        assert!(f.record().get("claudeReservedSessionId").is_none());
    }
);

case!(
    current_read_only_or_ask_rejects_old_full_init_even_when_global_consent_remains,
    {
        eprintln!("[fixture-lifecycle] owner-narrow-init phase=start");
        for narrowed in ["read-only", "ask"] {
            let f = Fixture::new("full", |_| {});
            f.consent
                .lock()
                .unwrap()
                .grant(&[Provider::Claude], chrono::Utc::now())
                .unwrap();
            let owner = f.owner(Arc::new(|_, _| true));
            let snapshot = owner.snapshot(&f.key).unwrap();
            let mut services = owner.services(f.sink.clone(), None);
            let hold = Arc::new(HoldInit {
                inner: services.store.clone(),
                entered: tokio::sync::Notify::new(),
                release: Arc::new(tokio::sync::Semaphore::new(0)),
            });
            services.store = hold.clone();
            let unblock = Release(hold.release.clone());
            let worker = ClaudeWorker::new(f.config("bypass"), services).unwrap();
            let mut turn = f.driver.start(snapshot, "prompt".into(), worker).unwrap();
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=init-entered-before");
            hold.entered.notified().await;
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=init-entered-after");
            diagnostic_pid(&f, "owner-narrow-init-init-entered-after");
            f.registry
                .lock()
                .unwrap()
                .update_checked(&f.key, |r| {
                    r.set_string("approval", narrowed);
                    Ok(())
                })
                .unwrap();
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=release-init-before");
            drop(unblock);
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=release-init-after");
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=accepted-before");
            assert!(turn.accepted().await.is_err());
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=accepted-after");
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=turn-wait-before");
            diagnostic_pid(&f, "owner-narrow-init-turn-wait-before");
            assert!(matches!(
                turn.wait().await.unwrap().turn.outcome,
                Outcome::Failure { .. }
            ));
            assert_eq!(f.record().scalar("approval").as_deref(), Some(narrowed));
            eprintln!("[fixture-lifecycle] owner-narrow-init phase=turn-wait-after");
            diagnostic_pid(&f, "owner-narrow-init-turn-wait-after");
            assert!(f.record().get("providerSessionId").is_some());
            assert!(f.record().get("claudeReservedSessionId").is_none());
            assert!(!f.driver.storage_failed());
        }
    }
);
