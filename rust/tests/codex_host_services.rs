use pult_core::codex_host_services::{CodexOwner, OwnerError, RouteValidity};
use pult_core::codex_worker::{CodexHost, HostConfig, Limits, SessionSpec, Timeouts};
use pult_core::consent_store::ConsentStore;
use pult_core::journal::EventStore;
use pult_core::registry::{Record, Registry};
use pult_core::turn_coordinator::Outcome;
use pult_core::turn_driver::{Driver, Options};
use pult_core::turn_journal::JournalSink;
use pult_core::turn_snapshot::{Approval, Provider, SessionKey};
use pult_core::worker_process::Launch;
use serde_json::Value;
use std::collections::BTreeMap;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
const WAIT: Duration = Duration::from_secs(20);
macro_rules! case {($name:ident,$body:block)=>{#[tokio::test]async fn $name(){pult_core::panic_guard::install();tokio::time::timeout(WAIT,async $body).await.expect("owner watchdog");}};}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    cwd: PathBuf,
    key: SessionKey,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
    sink: Arc<JournalSink>,
    driver: Arc<Driver>,
}
impl Fixture {
    fn new(approval: &str) -> Self {
        Self::new_with(approval, |_, _, _| {})
    }
    fn new_with(approval: &str, prepare: impl FnOnce(&Path, &Path, &mut Record)) -> Self {
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
        for (name, value) in [
            ("name", key.name.as_str()),
            ("createdAt", key.created_at.as_str()),
            ("provider", "codex"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", approval),
            ("model", "old-model"),
            ("title", "old-title"),
        ] {
            record.set_string(name, value);
        }
        prepare(&home, &cwd, &mut record);
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
            key,
            registry: Arc::new(Mutex::new(registry)),
            consent,
            sink,
            driver,
        }
    }
    fn owner(&self, route: RouteValidity) -> Arc<CodexOwner> {
        CodexOwner::new(
            self.home.clone(),
            self.registry.clone(),
            Arc::downgrade(&self.driver),
            self.consent.clone(),
            route,
        )
        .unwrap()
    }
    fn logs(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("messages.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|v| serde_json::from_str(v).unwrap())
            .collect()
    }
    fn host(&self, owner: &Arc<CodexOwner>) -> Arc<CodexHost> {
        // Reuse the real supervised app-server fixture; add an independent
        // durable Registry check in Python at the exact model dispatch boundary.
        let source = include_str!("fixtures/codex_worker.py").replace(
            "elif method == 'turn/start':\n",
            "elif method == 'turn/start':\n        saved = json.loads((home / 'sessions.json').read_text())\n        record = next(r for r in saved['sessions'] if r['name'] == 'chat')\n        assert record['providerSessionId'] == params['threadId'], 'thread not durable before model'\n        (home / 'receipt-proof').write_text(record['providerSessionId'])\n"
        ).replace("text='done'", "text='sk-proj-abcdefghijklmnop12345678'");
        let path = self.home.join("app_server.py");
        std::fs::write(&path, source).unwrap();
        CodexHost::start(
            HostConfig {
                launch: Launch {
                    holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                    program: Path::new("/usr/bin/python3").into(),
                    args: vec![
                        "-B".into(),
                        path.into_os_string(),
                        self.home.clone().into_os_string(),
                    ],
                    cwd: self.home.clone(),
                    env: BTreeMap::from([
                        ("HOME".into(), self.home.clone().into_os_string()),
                        ("PATH".into(), "/usr/bin:/bin".into()),
                    ]),
                },
                fingerprint: "trusted-scripted-network-stamp".into(),
                limits: Limits::default(),
                timeouts: Timeouts {
                    control: Duration::from_secs(2),
                    interrupt: Duration::from_millis(300),
                    ..Default::default()
                },
            },
            owner.services(self.sink.clone(), None),
        )
        .unwrap()
    }
    fn spec(&self, snapshot: &pult_core::turn_snapshot::TurnSnapshot) -> SessionSpec {
        SessionSpec {
            key: self.key.clone(),
            home: self.home.clone(),
            cwd: snapshot.cwd.clone(),
            resume_id: None,
            broker: true,
            attachments: vec![],
        }
    }
}
case!(
    native_id_is_durable_before_model_and_mutated_metadata_is_not_overwritten,
    {
        let f = Fixture::new("ask");
        let registry = f.registry.clone();
        let key = f.key.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let owner = f.owner(Arc::new(move |_, _| {
            if count.fetch_add(1, Ordering::AcqRel) == 0 {
                registry
                    .lock()
                    .unwrap()
                    .update_checked(&key, |record| {
                        record.set_string("title", "new-title");
                        record.set_string("model", "new-model");
                        record.set_string("approval", "read-only");
                        Ok(())
                    })
                    .unwrap();
            }
            true
        }));
        let snapshot = owner.snapshot(&f.key).unwrap();
        let host = f.host(&owner);
        let worker = host.worker(f.spec(&snapshot)).unwrap();
        let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
        handle.accepted().await.unwrap();
        assert_eq!(handle.wait().await.unwrap().turn.outcome, Outcome::Success);
        assert!(calls.load(Ordering::Acquire) >= 2);
        let record = f.registry.lock().unwrap().find("chat").unwrap().clone();
        assert_eq!(record.scalar("title").as_deref(), Some("new-title"));
        assert_eq!(record.scalar("model").as_deref(), Some("new-model"));
        assert_eq!(record.scalar("approval").as_deref(), Some("read-only"));
        assert_eq!(
            record.scalar("providerSessionId"),
            Some(std::fs::read_to_string(f.home.join("receipt-proof")).unwrap())
        );
        let turn = f
            .logs()
            .into_iter()
            .find(|v| v["method"] == "turn/start")
            .unwrap();
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(turn["params"]["model"], "old-model");
        let journal = std::fs::read_to_string(f.home.join("events/journal.jsonl")).unwrap();
        assert!(!journal.contains("sk-proj-abcdefghijklmnop12345678"));
        assert!(journal.contains("<token>"));
        host.shutdown().await.unwrap();
    }
);
case!(
    full_consent_revocation_narrows_frozen_full_before_dispatch,
    {
        let f = Fixture::new("full");
        f.consent
            .lock()
            .unwrap()
            .grant(&[Provider::Codex], chrono::Utc::now())
            .unwrap();
        let consent = f.consent.clone();
        let owner = f.owner(Arc::new(move |_, _| {
            consent.lock().unwrap().revoke(chrono::Utc::now()).unwrap();
            true
        }));
        let snapshot = owner.snapshot(&f.key).unwrap();
        assert_eq!(snapshot.settings.approval, Approval::Full);
        let host = f.host(&owner);
        let worker = host.worker(f.spec(&snapshot)).unwrap();
        let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
        handle.accepted().await.unwrap();
        assert_eq!(handle.wait().await.unwrap().turn.outcome, Outcome::Success);
        let turn = f
            .logs()
            .into_iter()
            .find(|v| v["method"] == "turn/start")
            .unwrap();
        assert_eq!(turn["params"]["sandboxPolicy"]["type"], "workspaceWrite");
        assert_eq!(turn["params"]["approvalPolicy"], "on-request");
        assert_eq!(
            f.registry
                .lock()
                .unwrap()
                .find("chat")
                .unwrap()
                .scalar("approval")
                .as_deref(),
            Some("full")
        );
        host.shutdown().await.unwrap();
    }
);
case!(
    session_grant_can_cover_full_but_revoked_current_grant_is_rechecked,
    {
        let f = Fixture::new("full");
        f.registry
            .lock()
            .unwrap()
            .update_checked(&f.key, |record| {
                record.set_string("grant", "cli-once");
                Ok(())
            })
            .unwrap();
        let registry = f.registry.clone();
        let key = f.key.clone();
        let owner = f.owner(Arc::new(move |_, _| {
            registry
                .lock()
                .unwrap()
                .update_checked(&key, |record| {
                    record.remove("grant");
                    Ok(())
                })
                .unwrap();
            true
        }));
        let snapshot = owner.snapshot(&f.key).unwrap();
        assert_eq!(snapshot.settings.approval, Approval::Full);
        let host = f.host(&owner);
        let worker = host.worker(f.spec(&snapshot)).unwrap();
        let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
        let _ = handle.wait().await.unwrap();
        assert_eq!(
            f.logs()
                .into_iter()
                .find(|v| v["method"] == "turn/start")
                .unwrap()["params"]["sandboxPolicy"]["type"],
            "workspaceWrite"
        );
        host.shutdown().await.unwrap();
    }
);
case!(
    archival_or_recreated_incarnation_rejects_receipt_without_resurrection,
    {
        for recreate in [false, true] {
            let f = Fixture::new("ask");
            let registry = f.registry.clone();
            let key = f.key.clone();
            let owner = f.owner(Arc::new(move |_, _| {
                let mut registry = registry.lock().unwrap();
                if recreate {
                    let mut record = registry.remove_checked(&key).unwrap();
                    record.set_string("createdAt", "2026-11-13T00:00:00Z");
                    registry.insert(record).unwrap();
                } else {
                    registry.archive("chat", true).unwrap();
                }
                true
            }));
            let snapshot = owner.snapshot(&f.key).unwrap();
            let host = f.host(&owner);
            let worker = host.worker(f.spec(&snapshot)).unwrap();
            let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
            assert!(!matches!(
                handle.wait().await.unwrap().turn.outcome,
                Outcome::Success
            ));
            assert!(f.logs().iter().all(|v| v["method"] != "turn/start"));
            assert!(
                f.registry
                    .lock()
                    .unwrap()
                    .find("chat")
                    .unwrap()
                    .get("providerSessionId")
                    .is_none()
            );
            assert!(!f.driver.storage_failed());
            host.shutdown().await.unwrap();
        }
    }
);
case!(
    route_reentrant_cancel_prevents_registry_write_and_dispatch,
    {
        let f = Fixture::new("ask");
        let weak = Arc::downgrade(&f.driver);
        let owner = f.owner(Arc::new(move |ticket, _| {
            weak.upgrade().unwrap().cancel(ticket);
            true
        }));
        let snapshot = owner.snapshot(&f.key).unwrap();
        let host = f.host(&owner);
        let worker = host.worker(f.spec(&snapshot)).unwrap();
        let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
        let key = handle.ticket().clone();
        assert_eq!(f.driver.active_ticket(&f.key), Some(key.clone()));
        assert!(f.driver.snapshot_for_dispatch(&key).is_some());
        assert!(f.driver.public_turn_id(&key).is_none());
        assert!(!matches!(
            handle.wait().await.unwrap().turn.outcome,
            Outcome::Success
        ));
        assert!(f.driver.snapshot_for_dispatch(&key).is_none());
        assert!(f.driver.active_ticket(&f.key).is_none());
        assert!(f.logs().iter().all(|v| v["method"] != "turn/start"));
        assert!(
            f.registry
                .lock()
                .unwrap()
                .find("chat")
                .unwrap()
                .get("providerSessionId")
                .is_none()
        );
        host.shutdown().await.unwrap();
    }
);
case!(unconfirmed_registry_write_latches_global_driver_failure, {
    let f = Fixture::new("ask");
    let path = f.home.join("sessions.json");
    let owner = f.owner(Arc::new(move |_, _| {
        std::fs::write(&path, "changed outside owner").unwrap();
        true
    }));
    let snapshot = owner.snapshot(&f.key).unwrap();
    let host = f.host(&owner);
    let worker = host.worker(f.spec(&snapshot)).unwrap();
    let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
    let outcome = handle.wait().await;
    assert!(matches!(
        outcome,
        Err(pult_core::turn_driver::DriverError::StorageUnavailable)
    ));
    assert!(f.driver.storage_failed());
    assert!(f.logs().iter().all(|v| v["method"] != "turn/start"));
    assert!(f.driver.snapshot_for_dispatch(handle.ticket()).is_none());
    host.shutdown().await.unwrap();
});
case!(required_route_denial_prevents_receipt_and_model_dispatch, {
    let f = Fixture::new("read-only");
    let owner = f.owner(Arc::new(|_, _| false));
    let snapshot = owner.snapshot(&f.key).unwrap();
    let host = f.host(&owner);
    let worker = host.worker(f.spec(&snapshot)).unwrap();
    let mut handle = f.driver.start(snapshot, "normal".into(), worker).unwrap();
    assert!(!matches!(
        handle.wait().await.unwrap().turn.outcome,
        Outcome::Success
    ));
    assert!(f.logs().iter().all(|v| v["method"] != "turn/start"));
    assert!(
        f.registry
            .lock()
            .unwrap()
            .find("chat")
            .unwrap()
            .get("providerSessionId")
            .is_none()
    );
    host.shutdown().await.unwrap();
});
case!(
    driver_queries_track_exact_public_turn_and_revoke_cancelled_dispatch,
    {
        let f = Fixture::new("read-only");
        let owner = f.owner(Arc::new(|_, _| true));
        let snapshot = owner.snapshot(&f.key).unwrap();
        let host = f.host(&owner);
        let worker = host.worker(f.spec(&snapshot)).unwrap();
        let mut handle = f
            .driver
            .start(snapshot.clone(), "hold".into(), worker)
            .unwrap();
        let accepted = handle.accepted().await.unwrap();
        let ticket = handle.ticket().clone();
        assert_eq!(
            f.driver.snapshot_for_dispatch(&ticket),
            Some(snapshot.clone())
        );
        assert_eq!(f.driver.execution_snapshot(&ticket), Some(snapshot.clone()));
        assert_eq!(f.driver.public_turn_id(&ticket), Some(accepted.turn_id));
        assert_eq!(f.driver.active_ticket(&f.key), Some(ticket.clone()));
        assert!(f.driver.cancel(&ticket));
        assert!(f.driver.snapshot_for_dispatch(&ticket).is_none());
        assert_eq!(f.driver.execution_snapshot(&ticket), Some(snapshot));
        assert_eq!(f.driver.active_ticket(&f.key), Some(ticket.clone()));
        assert_eq!(
            handle.wait().await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        assert!(f.driver.active_ticket(&f.key).is_none());
        assert!(f.driver.execution_snapshot(&ticket).is_none());
        assert!(f.driver.public_turn_id(&ticket).is_none());
        host.shutdown().await.unwrap();
    }
);
#[test]
fn unreadable_consent_cannot_preserve_even_a_session_full_grant() {
    let f = Fixture::new_with("full", |_, _, record| {
        record.set_string("grant", "cli-once")
    });
    let owner = f.owner(Arc::new(|_, _| true));
    assert_eq!(
        owner.snapshot(&f.key).unwrap().settings.approval,
        Approval::Full
    );
    std::fs::create_dir(f.home.join("consent.json")).unwrap();
    assert_eq!(owner.snapshot(&f.key).unwrap_err(), OwnerError::Storage);
}
#[test]
fn canonical_aliases_are_supported_but_retarget_and_unsupported_fork_are_rejected() {
    let f = Fixture::new_with("ask", |home, cwd, record| {
        let alias = home.join("alias");
        symlink(cwd, &alias).unwrap();
        record.set_string("cwd", alias.to_str().unwrap());
    });
    let alias = f.home.join("alias");
    let owner = f.owner(Arc::new(|_, _| true));
    assert_eq!(owner.snapshot(&f.key).unwrap().cwd, f.cwd);
    std::fs::remove_file(&alias).unwrap();
    let other = f.home.join("other");
    std::fs::create_dir(&other).unwrap();
    symlink(other, &alias).unwrap();
    assert_eq!(owner.snapshot(&f.key).unwrap_err(), OwnerError::InvalidPath);
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |record| {
            record.set_bool("forkOnResume", true);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        owner.snapshot(&f.key).unwrap_err(),
        OwnerError::UnsupportedFork
    );
}
#[test]
fn home_ancestor_and_general_workspace_guards_apply_even_with_full_grant() {
    let f = Fixture::new_with("full", |home, _, record| {
        record.set_string("grant", "cli-once");
        record.set_string("cwd", home.to_str().unwrap());
    });
    let owner = f.owner(Arc::new(|_, _| true));
    assert_eq!(owner.snapshot(&f.key).unwrap_err(), OwnerError::InvalidPath);
    let f = Fixture::new_with("full", |_, _, record| {
        record.set_string("grant", "cli-once");
        record.set_string("scope", "general");
    });
    let owner = f.owner(Arc::new(|_, _| true));
    assert_eq!(owner.snapshot(&f.key).unwrap_err(), OwnerError::InvalidPath);
    let f = Fixture::new_with("full", |home, _, record| {
        let root = home.join("conversations");
        let cwd = root.join("chat-ABC123");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&cwd).unwrap();
        for path in [&root, &cwd] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        record.set_string("cwd", cwd.to_str().unwrap());
        record.set_string("scope", "general");
        record.set_string("grant", "cli-once");
    });
    let owner = f.owner(Arc::new(|_, _| true));
    assert_eq!(
        owner.snapshot(&f.key).unwrap().settings.approval,
        Approval::Full
    );
}
