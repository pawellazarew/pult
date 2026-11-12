//! Supervised synthetic processes + real Registry/Consent/Journal, no account.
use pult_core::{
    claude_runtime::{
        ClaudeRuntime, Dependencies, Limits, McpFactory, RuntimeError, SettingsRoots,
        TrustedCommand,
    },
    claude_worker::{McpContext, ScopedMcp},
    consent_store::ConsentStore,
    journal::EventStore,
    network_guard::{NetworkGuard, Probe, ProbeFuture, ProbeResult},
    registry::{Record, Registry},
    runtime_config::RuntimeConfig,
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{Driver, Input, InputMetadata, Options, Task, WorkerError},
    turn_journal::JournalSink,
    turn_snapshot::SessionKey,
    worker_env::Environment,
};
use serde_json::Value;
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
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
struct Mcp(PathBuf);
impl ScopedMcp for Mcp {
    fn prepare(&self, _: McpContext) -> Task<Result<PathBuf, WorkerError>> {
        let path = self.0.clone();
        Box::pin(async move { Ok(path) })
    }
    fn revoke(&self, _: &Ticket, _: u64) {}
    fn cleanup(&self, _: Ticket, _: u64) -> Task<Result<(), WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
    sink: Arc<JournalSink>,
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
                        "Claude runtime fixture at {}:{}",
                        location.file(),
                        location.line()
                    );
                }
            }))
        });
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.join("project")).unwrap();
        std::fs::write(home.join("mcp.json"), "{\"mcpServers\":{}}").unwrap();
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        for name in ["one", "two"] {
            let mut record = Record::default();
            for (k, v) in [
                ("name", name),
                ("createdAt", key(name).created_at.as_str()),
                ("provider", "claude"),
                ("cwd", home.join("project").to_str().unwrap()),
                ("approval", "ask"),
            ] {
                record.set_string(k, v);
            }
            registry.insert(record).unwrap();
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
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        Self {
            _temp: temp,
            home,
            registry: Arc::new(Mutex::new(registry)),
            consent,
            sink,
            driver,
        }
    }
    fn factory(&self) -> McpFactory {
        let path = self.home.join("mcp.json");
        Arc::new(move |_| Ok(Arc::new(Mcp(path.clone()))))
    }
    fn runtime(&self, block: bool) -> (ClaudeRuntime, Arc<ProbeFixture>, Arc<NetworkGuard>) {
        self.custom(
            RuntimeConfig::default(),
            self.factory(),
            Limits::default(),
            block,
        )
    }
    fn custom(
        &self,
        cfg: RuntimeConfig,
        factory: McpFactory,
        limits: Limits,
        block: bool,
    ) -> (ClaudeRuntime, Arc<ProbeFixture>, Arc<NetworkGuard>) {
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
        let runtime = ClaudeRuntime::new(
            Dependencies {
                home: self.home.clone(),
                registry: self.registry.clone(),
                consent: self.consent.clone(),
                driver: self.driver.clone(),
                sink: self.sink.clone(),
            },
            TrustedCommand {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program: python,
                prefix_args: vec![
                    "-B".into(),
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("tests/fixtures/claude_runtime.py")
                        .into_os_string(),
                    self.home.clone().into_os_string(),
                ],
            },
            cfg,
            parent,
            SettingsRoots {
                child_home: self.home.clone(),
                managed_directory: self.home.join("managed"),
            },
            guard.clone(),
            factory,
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
    fn stopped(&self) {
        for row in self.rows("launches.jsonl") {
            let pid = row["pid"].as_i64().unwrap() as i32;
            assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_sessions_independent_stop_and_next_explicit_turn_fresh_resume() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, _, _) = f.runtime(false);
        let mut a = r.execute(key("one"), input("hold-turn")).await.unwrap();
        let mut b = r.execute(key("two"), input("hold-turn")).await.unwrap();
        let accepted = a.accepted().await.unwrap();
        b.accepted().await.unwrap();
        assert!(!r.stop(&key("one"), Some("stale")).unwrap());
        assert!(r.stop(&key("one"), Some(&accepted.turn_id)).unwrap());
        assert_eq!(a.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
        r.wait_idle(&key("one")).await;
        assert!(r.busy(&key("two")));
        let id = f.record("one").scalar("providerSessionId").unwrap();
        let mut next = r.execute(key("one"), input("explicit next")).await.unwrap();
        assert_eq!(next.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.wait_idle(&key("one")).await;
        let rows = f.rows("launches.jsonl");
        assert!(rows.iter().any(|row| {
            row["args"]
                .as_array()
                .unwrap()
                .windows(2)
                .any(|v| v[0] == "--resume" && v[1] == id)
        }));
        assert!(r.stop_name("two").unwrap());
        assert_eq!(b.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
        r.shutdown().await.unwrap();
        assert!(!r.stop(&key("one"), None).unwrap());
        f.stopped();
        for row in rows {
            assert!(row["env"].get("ANTHROPIC_API_KEY").is_none());
            assert!(row["env"].get("HTTPS_PROXY").is_none());
        }
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_waiter_reserves_capacity_and_stop_cancels_blocked_probe() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, probe, _) = f.custom(
            RuntimeConfig::default(),
            f.factory(),
            Limits {
                turns: 1,
                ..Default::default()
            },
            true,
        );
        let waiter = r.execute(key("one"), input("normal"));
        drop(waiter);
        probe.entered.notified().await;
        assert!(matches!(
            r.execute(key("two"), input("normal")).await,
            Err(RuntimeError::Capacity)
        ));
        assert!(r.stop_name("one").unwrap());
        r.wait_idle(&key("one")).await;
        r.shutdown().await.unwrap();
        assert!(f.rows("launches.jsonl").is_empty());
        assert!(
            f.rows("events/journal.jsonl")
                .iter()
                .all(|v| v["kind"] != "message.user")
        );
    })
    .await
    .unwrap();
}
struct Barrier {
    entered: tokio::sync::Notify,
    pair: (Mutex<bool>, Condvar),
}
impl Barrier {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: tokio::sync::Notify::new(),
            pair: (Mutex::new(false), Condvar::new()),
        })
    }
    fn block(&self) {
        self.entered.notify_one();
        let mut open = self.pair.0.lock().unwrap();
        while !*open {
            open = self.pair.1.wait(open).unwrap();
        }
    }
    fn release(&self) {
        *self.pair.0.lock().unwrap() = true;
        self.pair.1.notify_all();
    }
}
struct Release(Arc<Barrier>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_and_shutdown_join_factory_io_without_late_user_receipt() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let barrier = Barrier::new();
        let release = Release(barrier.clone());
        let blocking = barrier.clone();
        let path = f.home.join("mcp.json");
        let factory: McpFactory = Arc::new(move |_| {
            blocking.block();
            Ok(Arc::new(Mcp(path.clone())))
        });
        let (r, _, _) = f.custom(RuntimeConfig::default(), factory, Limits::default(), false);
        let waiter = r.execute(key("one"), input("normal"));
        barrier.entered.notified().await;
        drop(waiter);
        assert!(r.stop_name("one").unwrap());
        let mut stopped = r.shutdown();
        assert!(futures_probe_pending(&mut stopped).await);
        assert!(r.busy(&key("one")));
        drop(release);
        stopped.await.unwrap();
        assert!(f.rows("launches.jsonl").is_empty());
        assert!(
            f.rows("events/journal.jsonl")
                .iter()
                .all(|v| v["kind"] != "message.user")
        );
    })
    .await
    .unwrap();
}
async fn futures_probe_pending<T>(future: &mut Task<T>) -> bool {
    std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx).is_pending())).await
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_settings_and_uncertain_marker_reject_before_receipt() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let mut cfg = RuntimeConfig::default();
        cfg.mcp.servers.push("unported-server".into());
        let (r, _, _) = f.custom(cfg, f.factory(), Limits::default(), false);
        assert!(matches!(
            r.execute(key("one"), input("normal")).await,
            Err(RuntimeError::Unsupported)
        ));
        r.shutdown().await.unwrap();
        f.registry
            .lock()
            .unwrap()
            .update_checked(&key("one"), |record| {
                record.set_string("claudeReservedSessionId", "unknown");
                Ok(())
            })
            .unwrap();
        let (r, _, _) = f.runtime(false);
        let error = match r.execute(key("one"), input("normal")).await {
            Err(e) => e,
            Ok(_) => panic!("uncertain conversation admitted"),
        };
        assert_eq!(error.code(), "start_unknown");
        assert!(error.to_string().contains("Автоматический повтор запрещён"));
        r.shutdown().await.unwrap();
        assert!(f.rows("launches.jsonl").is_empty());
        assert!(
            f.rows("events/journal.jsonl")
                .iter()
                .all(|v| v["kind"] != "message.user")
        );
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn route_generation_change_after_factory_wait_denies_native_input() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let barrier = Barrier::new();
        let release = Release(barrier.clone());
        let blocking = barrier.clone();
        let path = f.home.join("mcp.json");
        let factory: McpFactory = Arc::new(move |_| {
            blocking.block();
            Ok(Arc::new(Mcp(path.clone())))
        });
        let (r, _, guard) = f.custom(RuntimeConfig::default(), factory, Limits::default(), false);
        let waiter = r.execute(key("one"), input("normal"));
        barrier.entered.notified().await;
        guard.clear_cache().unwrap();
        drop(release);
        let mut handle = waiter.await.unwrap();
        assert!(matches!(
            handle.wait().await.unwrap().turn.outcome,
            Outcome::Failure { .. }
        ));
        r.shutdown().await.unwrap();
        assert!(f.rows("inputs.jsonl").is_empty());
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_shutdown_preserves_unowned_driver_ticket_and_shared_guard() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, _, guard) = f.runtime(false);
        let (r2, _, _) = f.runtime(false);
        let mut other = r2.execute(key("two"), input("hold-turn")).await.unwrap();
        other.accepted().await.unwrap();
        let generation = guard.generation().unwrap();
        r.shutdown().await.unwrap();
        assert_eq!(guard.generation().unwrap(), generation);
        assert!(matches!(
            other.progress(),
            pult_core::turn_driver::Progress::Running(_)
        ));
        assert_eq!(f.driver.active_count(), 1);
        assert!(r2.stop_name("two").unwrap());
        assert_eq!(
            other.wait().await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        r2.shutdown().await.unwrap();
        f.stopped();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn factory_reentry_shutdown_is_lock_free_and_rechecked_before_admission() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let slot = Arc::new(std::sync::OnceLock::<std::sync::Weak<ClaudeRuntime>>::new());
        let access = slot.clone();
        let path = f.home.join("mcp.json");
        let factory: McpFactory = Arc::new(move |_| {
            let runtime = access.get().unwrap().upgrade().unwrap();
            drop(runtime.shutdown());
            Ok(Arc::new(Mcp(path.clone())))
        });
        let (r, _, _) = f.custom(RuntimeConfig::default(), factory, Limits::default(), false);
        let r = Arc::new(r);
        assert!(slot.set(Arc::downgrade(&r)).is_ok());
        assert!(matches!(
            r.execute(key("one"), input("normal")).await,
            Err(RuntimeError::Cancelled)
        ));
        r.shutdown().await.unwrap();
        assert!(f.rows("launches.jsonl").is_empty());
        assert_eq!(f.driver.active_count(), 0);
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fresh_facade_uses_only_current_frozen_attachments() {
    tokio::time::timeout(WAIT, async {
        use pult_core::prompt_attachments::{AttachmentKind, PromptAttachment};
        let f = Fixture::new();
        let (r, _, _) = f.runtime(false);
        let mut first = r.execute(key("one"), input("normal")).await.unwrap();
        assert_eq!(first.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.wait_idle(&key("one")).await;
        let path = f.home.join("attachments/one/day/note.txt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "fresh attachment").unwrap();
        let mut next = input("");
        next.metadata.attachments.push(PromptAttachment {
            path: path.to_str().unwrap().into(),
            name: "note.txt".into(),
            bytes: 16,
            mime: "text/plain".into(),
            kind: AttachmentKind::File,
        });
        let mut second = r.execute(key("one"), next).await.unwrap();
        assert_eq!(second.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.wait_idle(&key("one")).await;
        let mut third = r.execute(key("one"), input("normal again")).await.unwrap();
        assert_eq!(third.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.shutdown().await.unwrap();
        let rows = f.rows("inputs.jsonl");
        assert_eq!(rows.len(), 3);
        assert!(!rows[0].to_string().contains("note.txt"));
        assert!(rows[1].to_string().contains("note.txt"));
        assert!(!rows[2].to_string().contains("note.txt"));
        f.stopped();
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_receipt_preserves_owner_metadata_and_ordinary_rejects_forgery() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, _, _) = f.runtime(false);
        let mut queued = input("normal");
        queued.metadata.queue_item_id = Some("owner-item".into());
        queued.metadata.queue_item_at = Some("".into());
        assert!(matches!(
            r.execute(
                key("one"),
                Input {
                    text: queued.text.clone(),
                    metadata: queued.metadata.clone()
                }
            )
            .await,
            Err(RuntimeError::Unsupported)
        ));
        let mut handle = r.execute_queued(key("one"), queued).await.unwrap();
        assert_eq!(handle.wait().await.unwrap().turn.outcome, Outcome::Success);
        r.shutdown().await.unwrap();
        let rows = f.rows("events/journal.jsonl");
        let user = rows
            .iter()
            .find(|row| row["kind"] == "message.user")
            .unwrap();
        assert_eq!(user["data"]["queueItemId"], "owner-item");
        assert_eq!(user["data"]["queueItemAt"], "");
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_provider_owner_stops_process_and_owned_preparing_task() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, _, _) = f.runtime(false);
        let mut handle = r.execute(key("one"), input("hold-turn")).await.unwrap();
        handle.accepted().await.unwrap();
        drop(r);
        assert_eq!(
            handle.wait().await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        f.stopped();
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unexpected_factory_panic_is_static_fault_and_releases_only_after_join() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let factory: McpFactory = Arc::new(|_| panic!("synthetic host callback failure"));
        let (r, _, _) = f.custom(RuntimeConfig::default(), factory, Limits::default(), false);
        assert!(matches!(
            r.execute(key("one"), input("normal")).await,
            Err(RuntimeError::Storage)
        ));
        assert!(f.driver.storage_failed());
        r.shutdown().await.unwrap();
        assert!(f.rows("inputs.jsonl").is_empty());
    })
    .await
    .unwrap();
}

#[test]
fn constructor_checks_runtime_and_home_but_defers_all_filesystem_identity_work() {
    let f = Fixture::new();
    let build = |home: PathBuf, child_home: PathBuf| {
        let parent: Environment = [
            ("HOME".into(), f.home.clone().into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]
        .into_iter()
        .collect();
        ClaudeRuntime::new(
            Dependencies {
                home,
                registry: f.registry.clone(),
                consent: f.consent.clone(),
                driver: f.driver.clone(),
                sink: f.sink.clone(),
            },
            TrustedCommand {
                holder: "/not/installed/holder".into(),
                program: "/not/installed/claude".into(),
                prefix_args: vec![],
            },
            RuntimeConfig::default(),
            parent,
            SettingsRoots {
                child_home,
                managed_directory: f.home.join("managed"),
            },
            Arc::new(NetworkGuard::new(Arc::new(ProbeFixture {
                block: false,
                entered: tokio::sync::Notify::new(),
                calls: AtomicUsize::new(0),
            }))),
            f.factory(),
            Limits::default(),
        )
    };
    assert!(matches!(
        build(f.home.clone(), f.home.clone()),
        Err(RuntimeError::Invalid)
    ));
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _entered = tokio.enter();
    assert!(matches!(
        build(f.home.clone(), f.home.join("different-child")),
        Err(RuntimeError::Invalid)
    ));
    let runtime = build(f.home.join("does-not-exist"), f.home.clone()).unwrap();
    assert!(f.rows("launches.jsonl").is_empty());
    drop(runtime);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_storage_fault_cancels_pending_probe_without_dispatch() {
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let (r, probe, _) = f.runtime(true);
        let waiter = r.execute(key("one"), input("normal"));
        probe.entered.notified().await;
        f.driver.report_storage_failure();
        assert!(matches!(waiter.await, Err(RuntimeError::Storage)));
        r.shutdown().await.unwrap();
        assert!(f.rows("launches.jsonl").is_empty());
    })
    .await
    .unwrap();
}
