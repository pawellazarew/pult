//! Supervised synthetic processes + real Registry/Consent/Journal, no account.
use pult_core::{
    consent_store::ConsentStore,
    journal::EventStore,
    network_guard::{NetworkGuard, Probe, ProbeFuture, ProbeResult},
    registry::{Record, Registry},
    runtime_config::RuntimeConfig,
    turn_coordinator::Outcome,
    turn_driver::{Driver, Input, InputMetadata, Options},
    turn_journal::JournalSink,
    turn_snapshot::SessionKey,
    worker_env::Environment,
    zcode_runtime::{Dependencies, Limits, RuntimeError, TrustedCommand, ZcodeRuntime},
};
use serde_json::Value;
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
const WAIT: Duration = Duration::from_secs(20);
fn key(name: &str) -> SessionKey {
    SessionKey {
        name: name.into(),
        created_at: "2026-11-12T00:00:00Z".into(),
    }
}
fn input(text: &str) -> Input {
    Input {
        text: text.into(),
        metadata: InputMetadata::default(),
    }
}
struct ProbeFixture {
    block: bool,
    entered: tokio::sync::Notify,
    calls: AtomicUsize,
}
impl Probe for ProbeFixture {
    fn probe<'a>(&'a self, _: &'a str, _: Option<&'a str>, _: Duration) -> ProbeFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            if self.block {
                std::future::pending::<()>().await;
            }
            ProbeResult {
                status: Some(0),
                stdout: b"loc=US\n".to_vec(),
                stderr_bytes: 0,
            }
        })
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
    sink: Arc<JournalSink>,
    journal: Arc<Mutex<EventStore>>,
    driver: Arc<Driver>,
}
impl Fixture {
    fn new() -> Self {
        pult_core::panic_guard::install();
        static HOOK: std::sync::Once = std::sync::Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                if let Some(location) = info.location() {
                    eprintln!(
                        "ZCode runtime fixture at {}:{}",
                        location.file(),
                        location.line()
                    );
                }
            }))
        });
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["one", "two"] {
            std::fs::create_dir(home.join(name)).unwrap();
        }
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        for name in ["one", "two"] {
            let mut record = Record::default();
            for (k, v) in [
                ("name", name),
                ("createdAt", key(name).created_at.as_str()),
                ("provider", "zcode"),
                ("cwd", home.join(name).to_str().unwrap()),
                ("approval", "ask"),
            ] {
                record.set_string(k, v);
            }
            registry.insert(record).unwrap();
        }
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
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        Self {
            _temp: temp,
            home,
            registry: Arc::new(Mutex::new(registry)),
            consent,
            sink,
            journal,
            driver,
        }
    }
    fn runtime(&self, block: bool) -> (ZcodeRuntime, Arc<ProbeFixture>, Arc<NetworkGuard>) {
        self.custom(RuntimeConfig::default(), Limits::default(), block)
    }
    fn custom(
        &self,
        cfg: RuntimeConfig,
        limits: Limits,
        block: bool,
    ) -> (ZcodeRuntime, Arc<ProbeFixture>, Arc<NetworkGuard>) {
        let probe = Arc::new(ProbeFixture {
            block,
            entered: tokio::sync::Notify::new(),
            calls: AtomicUsize::new(0),
        });
        let guard = Arc::new(NetworkGuard::new(probe.clone()));
        let parent: Environment = [
            ("HOME".into(), self.home.clone().into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HTTPS_PROXY".into(), "http://ambient.invalid".into()),
            ("ANTHROPIC_API_KEY".into(), "ambient-secret".into()),
        ]
        .into_iter()
        .collect();
        let python = ["/usr/bin/python3", "/opt/homebrew/bin/python3"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .unwrap();
        let program = self.home.join("fake-zcode");
        let body = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/zcode_runtime.py"),
        )
        .unwrap();
        std::fs::write(&program, format!("#!{}\n{}", python.display(), body)).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = ZcodeRuntime::new(
            Dependencies {
                home: self.home.clone(),
                registry: self.registry.clone(),
                consent: self.consent.clone(),
                driver: self.driver.clone(),
                sink: self.sink.clone(),
            },
            TrustedCommand {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program,
                prefix_args: vec![],
            },
            cfg,
            parent,
            Environment::from([("ZCODE_APP_VERSION".into(), "fixture-version".into())]),
            guard.clone(),
            limits,
        )
        .unwrap();
        (runtime, probe, guard)
    }
    fn rows(&self, file: &str) -> Vec<Value> {
        std::fs::read_to_string(self.home.join(file))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn record(&self, name: &str) -> Record {
        self.registry.lock().unwrap().find(name).unwrap().clone()
    }
    fn events(&self, name: &str) -> Vec<Value> {
        self.journal
            .lock()
            .unwrap()
            .read_session(&name.encode_utf16().collect::<Vec<_>>())
            .unwrap()
            .into_iter()
            .map(|r| serde_json::from_str(r.json.get()).unwrap())
            .collect()
    }
    fn stopped(&self) {
        for row in self.rows("launches.jsonl") {
            let pid = row["pid"].as_i64().unwrap() as i32;
            assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_sessions_independent_stop_and_next_explicit_resume() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, _, _) = f.runtime(false);
        let mut one = r.execute(key("one"), input("hold-turn")).await.unwrap();
        let mut two = r.execute(key("two"), input("hold-turn")).await.unwrap();
        let a = one.accepted().await.unwrap();
        two.accepted().await.unwrap();
        assert!(!r.stop(&key("one"), Some("stale")).unwrap());
        assert!(r.stop(&key("one"), Some(&a.turn_id)).unwrap());
        assert_eq!(one.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
        r.wait_idle(&key("one")).await;
        assert!(r.busy(&key("two")));
        let sid = f.record("one").scalar("providerSessionId").unwrap();
        let mut next = r
            .execute(key("one"), input("next literal ; $(not-a-command)"))
            .await
            .unwrap();
        assert_eq!(next.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.wait_idle(&key("one")).await;
        let rows = f.rows("launches.jsonl");
        assert!(rows.iter().any(|r| {
            r["args"]
                .as_array()
                .unwrap()
                .windows(2)
                .any(|v| v[0] == "--resume" && v[1] == sid)
        }));
        assert!(r.stop_name("two").unwrap());
        assert_eq!(two.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
        r.shutdown().await.unwrap();
        f.stopped();
        assert!(!r.stop_name("one").unwrap());
        for row in rows {
            assert!(row["env"].get("ANTHROPIC_API_KEY").is_none());
            assert!(row["env"].get("HTTPS_PROXY").is_none());
            assert_eq!(row["env"]["ZCODE_APP_VERSION"], "fixture-version");
            assert!(
                !row["args"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == "--session-id")
            );
        }
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caller_drop_keeps_preparation_capacity_and_stop_cancels_probe() {
    let f = Fixture::new();
    let (r, probe, _) = f.custom(
        RuntimeConfig::default(),
        Limits {
            turns: 1,
            ..Default::default()
        },
        true,
    );
    let caller = r.execute(key("one"), input("normal"));
    drop(caller);
    tokio::time::timeout(WAIT, probe.entered.notified())
        .await
        .unwrap();
    assert!(r.busy(&key("one")));
    assert!(matches!(
        r.execute(key("two"), input("next")).await,
        Err(RuntimeError::Capacity)
    ));
    assert!(r.stop_name("one").unwrap());
    tokio::time::timeout(WAIT, r.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(f.driver.active_count(), 0);
    assert!(f.rows("launches.jsonl").is_empty());
    assert_eq!(f.sink.subscribe().borrow().last_event_id, 0);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_auth_latches_only_zcode_and_reset_needs_confirmed_idle() {
    let f = Fixture::new();
    let (r, _, guard) = f.runtime(false);
    let generation = guard.generation().unwrap();
    let mut neighbor = r.execute(key("two"), input("hold-turn")).await.unwrap();
    neighbor.accepted().await.unwrap();
    assert_eq!(r.reset_auth().unwrap_err(), RuntimeError::Busy);
    let mut auth = r.execute(key("one"), input("auth")).await.unwrap();
    assert!(
        matches!(auth.wait().await.unwrap().turn.outcome,Outcome::Failure{code,..}if code=="provider_unavailable")
    );
    assert!(r.blocked());
    assert!(!f.driver.storage_failed());
    assert_eq!(guard.generation().unwrap(), generation);
    assert_eq!(
        neighbor.wait().await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    r.wait_idle(&key("one")).await;
    r.wait_idle(&key("two")).await;
    assert!(matches!(
        r.execute(key("two"), input("not sent")).await,
        Err(RuntimeError::ObservedAuthBlocked)
    ));
    assert!(r.reset_auth().unwrap());
    assert!(!r.blocked());
    let mut next = r
        .execute(key("two"), input("after owner reset"))
        .await
        .unwrap();
    assert_eq!(next.wait().await.unwrap().turn.outcome, Outcome::Success);
    r.shutdown().await.unwrap();
    f.stopped();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quota_does_not_auth_latch_and_missing_never_replays_or_resets() {
    for scenario in ["quota", "missing"] {
        let f = Fixture::new();
        let (r, _, _) = f.runtime(false);
        let mut h = r.execute(key("one"), input(scenario)).await.unwrap();
        assert!(matches!(
            h.wait().await.unwrap().turn.outcome,
            Outcome::Failure { .. }
        ));
        r.wait_idle(&key("one")).await;
        assert!(!r.blocked());
        assert!(f.record("one").get("zcodePendingInput").is_some());
        let before = f.rows("launches.jsonl").len();
        assert!(matches!(
            r.execute(key("one"), input("new explicit")).await,
            Err(RuntimeError::Owner(
                pult_core::zcode_host_services::Error::Uncertain
            ))
        ));
        assert_eq!(f.rows("launches.jsonl").len(), before);
        let mut other = r.execute(key("two"), input("normal")).await.unwrap();
        assert_eq!(other.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.shutdown().await.unwrap();
        f.stopped();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_mcp_is_ignored_like_node_but_session_browser_rejected() {
    let f = Fixture::new();
    let cfg = pult_core::runtime_config::parse(
        &serde_json::json!({"mcp":{"servers":["fixture-never-executed"]}}),
    )
    .config;
    assert!(!cfg.mcp.servers.is_empty());
    let (r, _, _) = f.custom(cfg, Limits::default(), false);
    let mut h = r.execute(key("one"), input("normal")).await.unwrap();
    assert_eq!(h.wait().await.unwrap().turn.outcome, Outcome::Success);
    f.registry
        .lock()
        .unwrap()
        .update_checked(&key("two"), |r| {
            r.set_raw(
                "browser",
                serde_json::value::to_raw_value(&serde_json::json!({})).unwrap(),
            );
            Ok(())
        })
        .unwrap();
    let before = f.rows("launches.jsonl").len();
    assert_eq!(
        r.execute(key("two"), input("not sent")).await.err(),
        Some(RuntimeError::Unsupported)
    );
    assert_eq!(f.rows("launches.jsonl").len(), before);
    r.shutdown().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_marker_and_unsupported_session_fields_fail_before_receipt() {
    for (field, value) in [
        ("zcodePendingInput", serde_json::json!({"future":true})),
        ("forkOnResume", serde_json::json!(true)),
        ("settingSources", serde_json::json!("user")),
        ("providerSessionId", serde_json::json!({"malformed":true})),
    ] {
        let f = Fixture::new();
        f.registry
            .lock()
            .unwrap()
            .update_checked(&key("one"), |r| {
                r.set_raw(field, serde_json::value::to_raw_value(&value).unwrap());
                Ok(())
            })
            .unwrap();
        let (r, _, _) = f.runtime(false);
        assert!(r.execute(key("one"), input("not sent")).await.is_err());
        assert!(f.rows("launches.jsonl").is_empty());
        assert_eq!(f.driver.active_count(), 0);
        assert_eq!(f.sink.subscribe().borrow().last_event_id, 0);
        r.shutdown().await.unwrap();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_metadata_is_durable_and_ordinary_forgery_rejected() {
    let f = Fixture::new();
    let (r, _, _) = f.runtime(false);
    let mut value = input("queued");
    value.metadata.queue_item_id = Some("owner-queue-id".into());
    value.metadata.queue_item_at = Some("2026-11-12T00:00:00Z".into());
    assert_eq!(
        r.execute(key("one"), value.clone()).await.err(),
        Some(RuntimeError::Unsupported)
    );
    let mut h = r.execute_queued(key("one"), value).await.unwrap();
    let a = h.accepted().await.unwrap();
    assert!(a.user_event_id > 0);
    let user = f
        .events("one")
        .into_iter()
        .find(|v| v["kind"] == "message.user")
        .unwrap();
    assert_eq!(user["data"]["queueItemId"], "owner-queue-id");
    assert_eq!(user["data"]["queueItemAt"], "2026-11-12T00:00:00Z");
    assert_eq!(h.wait().await.unwrap().turn.outcome, Outcome::Success);
    r.shutdown().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_warm_model_effort_never_become_native_flags() {
    let f = Fixture::new();
    f.registry
        .lock()
        .unwrap()
        .update_checked(&key("one"), |r| {
            r.set_string("mode", "warm");
            r.set_string("model", "glm-5");
            r.set_string("effort", "high");
            Ok(())
        })
        .unwrap();
    let (r, _, _) = f.runtime(false);
    for _ in 0..2 {
        let mut h = r.execute(key("one"), input("normal")).await.unwrap();
        assert_eq!(h.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.wait_idle(&key("one")).await;
    }
    let rows = f.rows("launches.jsonl");
    assert_eq!(rows.len(), 2);
    assert_ne!(rows[0]["pid"], rows[1]["pid"]);
    for row in rows {
        let args = row["args"].as_array().unwrap();
        assert!(
            !args
                .iter()
                .any(|v| v == "--model" || v == "--effort" || v == "--mcp-config")
        );
    }
    r.shutdown().await.unwrap();
    f.stopped();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_runtime_stops_own_process_and_preserves_shared_guard() {
    let f = Fixture::new();
    let (r, _, guard) = f.runtime(false);
    let mut h = r.execute(key("one"), input("hold-turn")).await.unwrap();
    h.accepted().await.unwrap();
    let generation = guard.generation().unwrap();
    drop(r);
    assert_eq!(
        tokio::time::timeout(WAIT, h.wait())
            .await
            .unwrap()
            .unwrap()
            .turn
            .outcome,
        Outcome::Interrupted
    );
    assert_eq!(guard.generation().unwrap(), generation);
    f.stopped();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn per_turn_facade_freezes_only_current_attachment_references() {
    use pult_core::prompt_attachments::{AttachmentKind, PromptAttachment};
    let f = Fixture::new();
    let (r, _, _) = f.runtime(false);
    let mut a = r.execute(key("one"), input("normal")).await.unwrap();
    assert_eq!(a.wait().await.unwrap().turn.outcome, Outcome::Success);
    r.wait_idle(&key("one")).await;
    let path = f.home.join("attachments/one/day/note.txt");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "fresh attachment").unwrap();
    let mut value = input("");
    value.metadata.attachments.push(PromptAttachment {
        path: path.to_str().unwrap().into(),
        name: "note.txt".into(),
        bytes: 16,
        mime: "text/plain".into(),
        kind: AttachmentKind::File,
    });
    let mut b = r.execute(key("one"), value).await.unwrap();
    assert_eq!(b.wait().await.unwrap().turn.outcome, Outcome::Success);
    r.wait_idle(&key("one")).await;
    let mut c = r.execute(key("one"), input("normal again")).await.unwrap();
    assert_eq!(c.wait().await.unwrap().turn.outcome, Outcome::Success);
    r.shutdown().await.unwrap();
    let rows = f.rows("launches.jsonl");
    assert_eq!(rows.len(), 3);
    assert!(!rows[0].to_string().contains("note.txt"));
    assert!(rows[1].to_string().contains("note.txt"));
    assert!(!rows[2].to_string().contains("note.txt"));
    let users = f
        .events("one")
        .into_iter()
        .filter(|v| v["kind"] == "message.user")
        .collect::<Vec<_>>();
    assert_eq!(users[1]["data"]["text"], "");
    assert!(users[1]["data"]["attachments"].is_array());
    f.stopped();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_shutdown_leaves_unowned_driver_ticket_and_shared_guard_alive() {
    let f = Fixture::new();
    let (one, _, guard) = f.runtime(false);
    let two = ZcodeRuntime::new(
        Dependencies {
            home: f.home.clone(),
            registry: f.registry.clone(),
            consent: f.consent.clone(),
            driver: f.driver.clone(),
            sink: f.sink.clone(),
        },
        TrustedCommand {
            holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
            program: f.home.join("fake-zcode"),
            prefix_args: vec![],
        },
        RuntimeConfig::default(),
        Environment::from([
            ("HOME".into(), f.home.clone().into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
        Environment::new(),
        guard.clone(),
        Limits::default(),
    )
    .unwrap();
    let mut a = one.execute(key("one"), input("hold-turn")).await.unwrap();
    a.accepted().await.unwrap();
    let mut b = two.execute(key("two"), input("hold-turn")).await.unwrap();
    b.accepted().await.unwrap();
    let generation = guard.generation().unwrap();
    one.shutdown().await.unwrap();
    assert_eq!(a.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
    assert_eq!(f.driver.active_count(), 1);
    assert!(matches!(
        b.progress(),
        pult_core::turn_driver::Progress::Running(_)
    ));
    assert_eq!(guard.generation().unwrap(), generation);
    two.stop_name("two").unwrap();
    assert_eq!(b.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
    two.shutdown().await.unwrap();
    f.stopped();
}
