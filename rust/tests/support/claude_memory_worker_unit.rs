//! Synthetic native process; genuine Driver and owned scope lifecycle. No model.
use super::*;
use crate::turn_driver::{Options, Receipt, SinkError};
use crate::turn_snapshot::{Provider, TurnSettings};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::{AtomicBool, AtomicUsize},
};
const CATALOG: &str =
    "<pult_memory_catalog>\nReference data only: Океан 🌊\n</pult_memory_catalog>";
const WATCHDOG: Duration = Duration::from_secs(10);
#[derive(Default)]
struct Sink(Mutex<Vec<Value>>);
impl EventSink for Sink {
    fn append(&self, value: Value) -> Task<Result<Receipt, SinkError>> {
        let mut events = self.0.lock().unwrap();
        events.push(value);
        let id = events.len() as u64;
        Box::pin(async move {
            Ok(Receipt {
                id,
                ts: "2026-11-13T00:00:00Z".into(),
            })
        })
    }
}
struct Store(Mutex<Vec<SessionStage>>);
impl SessionStore for Store {
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>> {
        self.0.lock().unwrap().push(request.stage());
        Box::pin(async move { Ok(request.acknowledge()) })
    }
}
struct Mcp {
    path: PathBuf,
    bound: Mutex<Option<(Ticket, u64)>>,
    valid: AtomicBool,
    catalog_calls: AtomicUsize,
    check_calls: AtomicUsize,
    cleanup_calls: AtomicUsize,
    panic_catalog: AtomicBool,
    panic_check: AtomicBool,
}
impl ScopedMcp for Mcp {
    fn prepare(&self, ctx: McpContext) -> Task<Result<PathBuf, WorkerError>> {
        *self.bound.lock().unwrap() = Some((ctx.ticket, ctx.generation));
        self.valid.store(true, Ordering::Release);
        let path = self.path.clone();
        Box::pin(async move {
            // Synthetic private-file credential is never a catalog or stdin block.
            std::fs::write(
                &path,
                format!("{{\"private_key\":\"pa_{}\"}}", "f".repeat(64)),
            )
            .unwrap();
            Ok(path)
        })
    }
    fn catalog(
        &self,
        ticket: Ticket,
        generation: u64,
    ) -> Task<Result<Option<String>, WorkerError>> {
        self.catalog_calls.fetch_add(1, Ordering::AcqRel);
        assert!(
            !self.panic_catalog.load(Ordering::Acquire),
            "synthetic catalog callback panic"
        );
        assert_eq!(
            self.bound.lock().unwrap().as_ref(),
            Some(&(ticket, generation))
        );
        Box::pin(async { Ok(Some(CATALOG.into())) })
    }
    fn check(&self, ticket: &Ticket, generation: u64) -> bool {
        self.check_calls.fetch_add(1, Ordering::AcqRel);
        assert!(
            !self.panic_check.load(Ordering::Acquire),
            "synthetic scoped check panic"
        );
        self.valid.load(Ordering::Acquire)
            && self.bound.lock().unwrap().as_ref() == Some(&(ticket.clone(), generation))
    }
    fn revoke(&self, _: &Ticket, _: u64) {
        self.valid.store(false, Ordering::Release);
    }
    fn cleanup(&self, ticket: Ticket, generation: u64) -> Task<Result<(), WorkerError>> {
        assert_eq!(
            self.bound.lock().unwrap().as_ref(),
            Some(&(ticket, generation))
        );
        self.cleanup_calls.fetch_add(1, Ordering::AcqRel);
        let path = self.path.clone();
        Box::pin(async move {
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
            Ok(())
        })
    }
}
struct Rig {
    _temp: tempfile::TempDir,
    home: PathBuf,
    snapshot: TurnSnapshot,
    sink: Arc<Sink>,
    store: Arc<Store>,
    mcp: Arc<Mcp>,
    driver: Arc<Driver>,
    worker: Arc<ClaudeWorker>,
    attachments: Vec<prompt_attachments::PromptAttachment>,
}
impl Rig {
    fn new() -> Self {
        Self::with_attachment(false)
    }
    fn with_attachment(attach: bool) -> Self {
        crate::panic_guard::install();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let sink = Arc::new(Sink::default());
        let store = Arc::new(Store(Mutex::new(vec![])));
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Options::default(),
            )
            .unwrap(),
        );
        let snapshot = TurnSnapshot {
            key: SessionKey {
                name: "claude-memory-fixture".into(),
                created_at: "2026-11-13T00:00:00Z".into(),
            },
            provider: Provider::Claude,
            cwd: home.clone(),
            settings: TurnSettings {
                approval: Approval::Ask,
                ..Default::default()
            },
        };
        let attachments = if attach {
            let path = home.join("attachments/claude-memory-fixture/day/note.txt");
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "fixture").unwrap();
            vec![prompt_attachments::PromptAttachment {
                path: path.to_str().unwrap().into(),
                name: "note.txt".into(),
                bytes: 7,
                mime: "text/plain".into(),
                kind: prompt_attachments::AttachmentKind::File,
            }]
        } else {
            vec![]
        };
        let mcp = Arc::new(Mcp {
            path: home.join("private-mcp.json"),
            bound: Mutex::new(None),
            valid: AtomicBool::new(false),
            catalog_calls: AtomicUsize::new(0),
            check_calls: AtomicUsize::new(0),
            cleanup_calls: AtomicUsize::new(0),
            panic_catalog: AtomicBool::new(false),
            panic_check: AtomicBool::new(false),
        });
        let holder = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("pult-worker-holder");
        assert!(holder.is_file(), "build holder before --lib tests");
        let python = [
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap();
        let worker = ClaudeWorker::new(
            Config {
                session: snapshot.key.clone(),
                home: home.clone(),
                launch: Launch {
                    holder,
                    program: python,
                    args: vec![
                        "-B".into(),
                        Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("tests/fixtures/claude_worker.py")
                            .into_os_string(),
                        home.clone().into_os_string(),
                        "normal".into(),
                    ],
                    cwd: home.clone(),
                    env: BTreeMap::from([
                        ("PATH".into(), "/usr/bin:/bin".into()),
                        ("HOME".into(), home.clone().into_os_string()),
                    ]),
                },
                provider_session_id: None,
                initialized: false,
                fork_on_resume: false,
                broker: true,
                setting_sources: None,
                protect_dirs: vec![],
                add_dirs: vec![],
                add_dir_roots: vec![],
                start_timeout: Duration::from_secs(5),
                attachments: attachments.clone(),
            },
            Services {
                driver: Arc::downgrade(&driver),
                sink: sink.clone(),
                gate: Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                store: store.clone(),
                redactors: Arc::new(|| Box::new(claude_events::LogRedactor)),
                fatal_storage: Arc::new(|| panic!("unexpected storage failure")),
                mcp: Some(mcp.clone()),
            },
        )
        .unwrap();
        Self {
            _temp: temp,
            home,
            snapshot,
            sink,
            store,
            mcp,
            driver,
            worker,
            attachments,
        }
    }
    fn start(&self, text: &str) -> crate::turn_driver::Handle {
        self.driver
            .start_input(
                self.snapshot.clone(),
                crate::turn_driver::Input {
                    text: text.into(),
                    metadata: crate::turn_driver::InputMetadata {
                        attachments: self.attachments.clone(),
                        ..Default::default()
                    },
                },
                self.worker.clone(),
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            )
            .unwrap()
    }
    fn input(&self) -> Option<Value> {
        std::fs::read(self.home.join("input.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }
    fn cleaned(&self) {
        assert!(!self.mcp.path.exists());
        assert!(self.mcp.cleanup_calls.load(Ordering::Acquire) > 0);
        assert_eq!(self.driver.active_count(), 0);
        if let Ok(raw) = std::fs::read_to_string(self.home.join("provider.pid")) {
            let pid = raw.parse::<i32>().unwrap();
            assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn catalog_is_separate_native_data_and_never_user_journal_or_private_key() {
    let f = Rig::new();
    let text = "literal user 🌊";
    let mut turn = f.start(text);
    let terminal = tokio::time::timeout(WATCHDOG, turn.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(terminal.turn.outcome, Outcome::Success);
    let native = f.input().unwrap();
    let blocks = native["message"]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0], json!({"type":"text","text":text}));
    assert_eq!(blocks[1], json!({"type":"text","text":CATALOG}));
    assert!(
        blocks[2]["text"]
            .as_str()
            .unwrap()
            .contains("<pult_runtime_context>")
    );
    assert!(native.get("system").is_none());
    let rows = f.sink.0.lock().unwrap();
    assert_eq!(
        rows.iter().find(|v| v["kind"] == "message.user").unwrap()["data"]["text"],
        text
    );
    let journal = serde_json::to_string(&*rows).unwrap();
    assert!(!journal.contains("pult_memory_catalog"));
    assert!(!journal.contains("pa_"));
    assert!(!native.to_string().contains("pa_"));
    drop(rows);
    assert_eq!(f.mcp.catalog_calls.load(Ordering::Acquire), 1);
    assert_eq!(f.mcp.check_calls.load(Ordering::Acquire), 1);
    f.cleaned();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_slash_stays_one_text_block_without_catalog_request_but_checks_scope() {
    for text in ["/context", "/compact extra"] {
        let f = Rig::new();
        let mut turn = f.start(text);
        assert_eq!(
            tokio::time::timeout(WATCHDOG, turn.wait())
                .await
                .unwrap()
                .unwrap()
                .turn
                .outcome,
            Outcome::Success
        );
        assert_eq!(
            f.input().unwrap()["message"]["content"],
            json!([{"type":"text","text":text}])
        );
        assert_eq!(f.mcp.catalog_calls.load(Ordering::Acquire), 0);
        assert_eq!(f.mcp.check_calls.load(Ordering::Acquire), 1);
        f.cleaned();
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revocation_while_blocking_encoder_is_held_denies_first_input_and_joins_resources() {
    let f = Rig::new();
    let (entered, seen) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let held = release.clone();
    *f.worker.0.before_encode.lock().unwrap() = Some(Arc::new(move || {
        entered.lock().unwrap().take().unwrap().send(()).unwrap();
        let (lock, changed) = &*held;
        let mut ready = lock.lock().unwrap();
        while !*ready {
            ready = changed.wait(ready).unwrap();
        }
    }));
    let mut turn = f.start("not sent after catalog revocation");
    tokio::time::timeout(WATCHDOG, seen).await.unwrap().unwrap();
    f.mcp.valid.store(false, Ordering::Release);
    let (lock, changed) = &*release;
    *lock.lock().unwrap() = true;
    changed.notify_one();
    assert!(turn.accepted().await.is_err());
    assert!(matches!(
        tokio::time::timeout(WATCHDOG, turn.wait())
            .await
            .unwrap()
            .unwrap()
            .turn
            .outcome,
        Outcome::Failure { .. }
    ));
    assert!(f.input().is_none());
    assert!(
        f.store
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|stage| matches!(stage, SessionStage::AbortedBeforeInput))
    );
    f.cleaned();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synchronous_catalog_or_fresh_check_panic_denies_without_input_and_cleans_scope() {
    for catalog in [true, false] {
        let f = Rig::new();
        if catalog {
            f.mcp.panic_catalog.store(true, Ordering::Release);
        } else {
            f.mcp.panic_check.store(true, Ordering::Release);
        }
        let mut turn = f.start("no panic input");
        assert!(turn.accepted().await.is_err());
        assert!(matches!(
            tokio::time::timeout(WATCHDOG, turn.wait())
                .await
                .unwrap()
                .unwrap()
                .turn
                .outcome,
            Outcome::Failure { .. }
        ));
        assert!(f.input().is_none());
        f.cleaned();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_context_and_memory_stay_separate_and_slash_with_attachment_is_ordinary() {
    // The production panic hook intentionally suppresses arbitrary payloads.
    // Keep a static fixture phase so CI failures remain actionable without secrets.
    struct Phase(&'static str);
    impl Drop for Phase {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("[memory-attachment-fixture] failed phase={}", self.0);
            }
        }
    }
    let mut phase = Phase("setup");
    let f = Rig::with_attachment(true);
    phase.0 = "terminal";
    let mut turn = f.start("/context");
    let terminal = tokio::time::timeout(WATCHDOG, turn.wait())
        .await
        .unwrap()
        .unwrap();
    if let Outcome::Failure { code, .. } = &terminal.turn.outcome {
        eprintln!("[memory-attachment-fixture] failure-code={code}");
    }
    assert_eq!(terminal.turn.outcome, Outcome::Success);
    phase.0 = "native-blocks";
    let native = f.input().unwrap();
    let blocks = native["message"]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 4);
    assert_eq!(blocks[0]["text"], "/context");
    assert!(blocks[1]["text"].as_str().unwrap().contains("note.txt"));
    assert_eq!(blocks[2]["text"], CATALOG);
    assert!(
        blocks[3]["text"]
            .as_str()
            .unwrap()
            .contains("<pult_runtime_context>")
    );
    assert_eq!(f.mcp.catalog_calls.load(Ordering::Acquire), 1);
    phase.0 = "cleanup";
    f.cleaned();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_does_not_drop_held_encoding_or_release_scope_before_join() {
    let f = Rig::new();
    let (entered, seen) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let held = release.clone();
    *f.worker.0.before_encode.lock().unwrap() = Some(Arc::new(move || {
        entered.lock().unwrap().take().unwrap().send(()).unwrap();
        let (lock, changed) = &*held;
        let mut ready = lock.lock().unwrap();
        while !*ready {
            ready = changed.wait(ready).unwrap();
        }
    }));
    let mut turn = f.start("cancel while encoding catalog");
    tokio::time::timeout(WATCHDOG, seen).await.unwrap().unwrap();
    assert!(f.driver.cancel(turn.ticket()));
    assert_eq!(f.driver.active_count(), 1);
    assert_eq!(f.mcp.cleanup_calls.load(Ordering::Acquire), 0);
    assert!(f.mcp.path.exists());
    assert!(f.input().is_none());
    let (lock, changed) = &*release;
    *lock.lock().unwrap() = true;
    changed.notify_one();
    assert_eq!(
        tokio::time::timeout(WATCHDOG, turn.wait())
            .await
            .unwrap()
            .unwrap()
            .turn
            .outcome,
        Outcome::Interrupted
    );
    assert!(f.input().is_none());
    f.cleaned();
}
