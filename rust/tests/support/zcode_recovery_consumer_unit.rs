//! Genuine holder + synthetic Route A, real Owner/Driver/Registry/journal.
//! The operator acknowledgement is constructed at this trusted crate boundary.
use super::*;
use crate::{
    consent_store::ConsentStore,
    journal::EventStore,
    registry::Record,
    turn_coordinator::Outcome,
    turn_driver::{EventSink, InputMetadata, Options, Receipt, SinkError},
    turn_journal::JournalSink,
};
use std::os::unix::fs::PermissionsExt;
const WAIT: Duration = Duration::from_secs(40);
struct Probe;
impl crate::network_guard::Probe for Probe {
    fn probe<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: Duration,
    ) -> crate::network_guard::ProbeFuture<'a> {
        Box::pin(async {
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
    hold: AtomicBool,
    entered: Arc<Notify>,
    release: Arc<tokio::sync::Semaphore>,
}
impl EventSink for Sink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let hold =
            self.hold.load(Ordering::Acquire) && draft["data"]["recovery"]["phase"] == "requested";
        let task = self.inner.append(draft);
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            if hold {
                entered.notify_one();
                let _permit = release.acquire().await.unwrap();
            }
            task.await
        })
    }
}
struct Rig {
    _temp: tempfile::TempDir,
    home: PathBuf,
    key: SessionKey,
    registry: Arc<Mutex<Registry>>,
    journal: Arc<Mutex<EventStore>>,
    sink: Arc<Sink>,
    driver: Arc<Driver>,
    runtime: Arc<ZcodeRuntime>,
}
fn input(text: &str) -> Input {
    Input {
        text: text.into(),
        metadata: InputMetadata::default(),
    }
}
impl Rig {
    fn new() -> Self {
        crate::panic_guard::install();
        static HOOK: std::sync::Once = std::sync::Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                if let Some(at) = info.location() {
                    eprintln!("recovery consumer fixture {}:{}", at.file(), at.line());
                }
            }))
        });
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let key = SessionKey {
            name: "one".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        for name in ["one", "two"] {
            let cwd = home.join(name);
            std::fs::create_dir(&cwd).unwrap();
            let mut row = Record::default();
            for (k, v) in [
                ("name", name),
                ("createdAt", key.created_at.as_str()),
                ("provider", "zcode"),
                ("cwd", cwd.to_str().unwrap()),
                ("approval", "ask"),
                ("title", "preserved"),
                ("providerSessionId", "sess_existing"),
            ] {
                row.set_string(k, v);
            }
            row.set_raw(
                "queue",
                serde_json::value::RawValue::from_string(
                    r#"[{"id":"queue-1","at":"t","text":"old queued text","future":"\ud800"}]"#
                        .into(),
                )
                .unwrap(),
            );
            row.set_raw(
                "queueDispatch",
                serde_json::value::to_raw_value(&serde_json::json!({"id":"queue-1","at":"t"}))
                    .unwrap(),
            );
            row.set_bool("queuePaused", true);
            registry.insert(row).unwrap();
        }
        let registry = Arc::new(Mutex::new(registry));
        let journal = Arc::new(Mutex::new(journal));
        let sink = Arc::new(Sink {
            inner: Arc::new(JournalSink::new(journal.clone()).unwrap()),
            hold: AtomicBool::new(false),
            entered: Arc::new(Notify::new()),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        });
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Options::default(),
            )
            .unwrap(),
        );
        let python = ["/usr/bin/python3", "/opt/homebrew/bin/python3"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .unwrap();
        let program = home.join("fake-zcode");
        let body = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/zcode_runtime.py"),
        )
        .unwrap();
        let body = body.replace("if prompt.startswith('missing'):", "if prompt.startswith('broken-missing'):\n    print('{',flush=True);print('session native not found',file=sys.stderr,flush=True);sys.exit(1)\nif prompt.startswith('missing'):");
        let body = body.replace("if prompt.startswith('hold-turn'):", "if prompt.startswith('started-missing'):\n    print('session native not found',file=sys.stderr,flush=True);sys.exit(1)\nif prompt.startswith('hold-turn'):");
        std::fs::write(&program, format!("#!{}\n{}", python.display(), body)).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        // cargo build --bins before a direct --lib invocation, as in other real
        // process unit fixtures. This is an actual holder, never an invented PID.
        let holder = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("pult-worker-holder");
        assert!(holder.is_file(), "build holder before recovery unit tests");
        let runtime = Arc::new(
            ZcodeRuntime::new(
                Dependencies {
                    home: home.clone(),
                    registry: registry.clone(),
                    consent: Arc::new(Mutex::new(ConsentStore::open(&home).unwrap())),
                    driver: driver.clone(),
                    sink: sink.clone(),
                },
                TrustedCommand {
                    holder,
                    program,
                    prefix_args: vec![],
                },
                RuntimeConfig::default(),
                Environment::from([
                    ("HOME".into(), home.clone().into_os_string()),
                    ("PATH".into(), "/usr/bin:/bin".into()),
                ]),
                Environment::new(),
                Arc::new(NetworkGuard::new(Arc::new(Probe))),
                Limits::default(),
            )
            .unwrap(),
        );
        Self {
            _temp: temp,
            home,
            key,
            registry,
            journal,
            sink,
            driver,
            runtime,
        }
    }
    fn record(&self) -> Record {
        self.registry
            .lock()
            .unwrap()
            .find(&self.key.name)
            .unwrap()
            .clone()
    }
    fn events(&self) -> Vec<Value> {
        self.journal
            .lock()
            .unwrap()
            .read_session(&self.key.name.encode_utf16().collect::<Vec<_>>())
            .unwrap()
            .into_iter()
            .map(|r| serde_json::from_str(r.json.get()).unwrap())
            .collect()
    }
    fn launches(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("launches.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn missing(&self, queued: bool) -> Terminal {
        let mut request = input("missing");
        if queued {
            request.metadata.queue_item_id = Some("queue-1".into());
            request.metadata.queue_item_at = Some("t".into());
        }
        let mut handle = if queued {
            self.runtime.execute_queued(self.key.clone(), request).await
        } else {
            self.runtime.execute(self.key.clone(), request).await
        }
        .unwrap();
        let terminal = tokio::time::timeout(WAIT, handle.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(&terminal.turn.outcome,Outcome::Failure{code,..}if code=="native_session_missing")
        );
        assert!(terminal.turn.provider_turn_id.is_none());
        terminal
    }
    fn action(&self, id: String) -> OwnerRecoveryAction {
        OwnerRecoveryAction::from_authenticated_owner(self.key.clone(), id).unwrap()
    }
    async fn shutdown(&self) {
        tokio::time::timeout(WAIT, self.runtime.shutdown())
            .await
            .unwrap()
            .unwrap();
        for row in self.launches() {
            let pid = row["pid"].as_i64().unwrap() as i32;
            assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
        }
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn genuine_missing_proof_is_extracted_by_every_synchronous_reap_path() {
    for path in ["busy", "query", "auth_reset", "submit", "shutdown"] {
        let f = Rig::new();
        f.missing(false).await;
        match path {
            "busy" => assert!(!f.runtime.busy(&f.key)),
            "query" => {
                assert!(f.runtime.pending_recovery(&f.key).is_some());
            }
            "auth_reset" => assert_eq!(f.runtime.reset_auth(), Ok(false)),
            "submit" => assert!(matches!(
                f.runtime
                    .execute(f.key.clone(), input("never resent"))
                    .await,
                Err(RuntimeError::Owner(OwnerError::Uncertain))
            )),
            _ => {
                f.runtime.shutdown().await.unwrap();
            }
        }
        let descriptor = f.runtime.pending_recovery(&f.key).unwrap();
        assert_eq!(descriptor.state, RecoveryState::Available);
        assert!(descriptor.may_have_executed);
        assert!(f.record().get("zcodePendingInput").is_some());
        assert_eq!(f.launches().len(), 1);
        f.shutdown().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_confirmation_is_metadata_only_and_keeps_queue_and_old_history() {
    let f = Rig::new();
    let old_terminal = f.missing(true).await;
    let before = f.record();
    let descriptor = f.runtime.pending_recovery(&f.key).unwrap();
    let wrong = f
        .runtime
        .confirm_missing_for_next_turn(f.action("zr-wrong".into()))
        .await;
    assert_eq!(wrong, Err(RuntimeError::Invalid));
    assert_eq!(
        f.events()
            .iter()
            .filter(|v| v["data"]["recovery"].is_object())
            .count(),
        0
    );
    let result = f
        .runtime
        .confirm_missing_for_next_turn(f.action(descriptor.recovery_id.clone()))
        .await
        .unwrap();
    assert!(result.requested_event_id > old_terminal.terminal_event_id.unwrap());
    assert!(result.committed_event_id > result.requested_event_id);
    assert!(result.may_have_executed);
    assert!(f.runtime.pending_recovery(&f.key).is_none());
    let after = f.record();
    assert!(after.get("providerSessionId").is_none());
    assert!(after.get("zcodePendingInput").is_none());
    assert_eq!(after.scalar("title"), before.scalar("title"));
    assert_eq!(
        after.get("queue").unwrap().get(),
        before.get("queue").unwrap().get()
    );
    assert_eq!(
        after.get("queueDispatch").unwrap().get(),
        before.get("queueDispatch").unwrap().get()
    );
    assert_eq!(after.get("queuePaused").unwrap().get(), "true");
    assert_eq!(f.launches().len(), 1);
    let events = f.events();
    let requested = events
        .iter()
        .find(|v| v["data"]["recovery"]["phase"] == "requested")
        .unwrap();
    assert!(requested["data"].get("changes").is_none());
    assert!(!events.iter().any(|v| v["kind"] == "message.user"));
    let mut next = f
        .runtime
        .execute(f.key.clone(), input("new explicit input"))
        .await
        .unwrap();
    assert_eq!(next.wait().await.unwrap().turn.outcome, Outcome::Success);
    f.shutdown().await;
    let rows = f.launches();
    assert_eq!(rows.len(), 2);
    assert!(
        !rows[1]["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "--resume")
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_confirmation_waiter_does_not_cancel_owned_store_or_send_input() {
    let f = Rig::new();
    f.missing(false).await;
    let descriptor = f.runtime.pending_recovery(&f.key).unwrap();
    let call = f
        .runtime
        .confirm_missing_for_next_turn(f.action(descriptor.recovery_id));
    drop(call);
    tokio::time::timeout(WAIT, f.runtime.wait_idle(&f.key))
        .await
        .unwrap();
    assert!(f.record().get("zcodePendingInput").is_none());
    assert_eq!(f.launches().len(), 1);
    assert!(
        f.events()
            .iter()
            .any(|v| v["data"]["recovery"]["phase"] == "committed")
    );
    f.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_quarantines_pending_warning_io_without_harming_neighbor() {
    let f = Rig::new();
    f.missing(false).await;
    let descriptor = f.runtime.pending_recovery(&f.key).unwrap();
    let two = SessionKey {
        name: "two".into(),
        created_at: f.key.created_at.clone(),
    };
    let mut neighbor = f
        .runtime
        .execute(two.clone(), input("hold-turn"))
        .await
        .unwrap();
    neighbor.accepted().await.unwrap();
    f.sink.hold.store(true, Ordering::Release);
    let call = f
        .runtime
        .confirm_missing_for_next_turn(f.action(descriptor.recovery_id));
    tokio::time::timeout(WAIT, f.sink.entered.notified())
        .await
        .unwrap();
    assert!(f.runtime.busy(&f.key));
    assert_eq!(f.runtime.reset_auth(), Err(RuntimeError::Busy));
    assert!(matches!(
        f.runtime.execute(f.key.clone(), input("not sent")).await,
        Err(RuntimeError::Busy)
    ));
    assert!(f.runtime.stop(&f.key, None).unwrap());
    tokio::time::timeout(WAIT, async {
        loop {
            let changed = f.runtime.inner.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if f.runtime
                .inner
                .shared
                .state
                .lock()
                .unwrap()
                .get(&f.key)
                .is_some_and(|entry| entry.quarantined)
            {
                break;
            }
            changed.await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    f.sink.release.add_permits(1);
    assert!(call.await.is_err());
    tokio::time::timeout(WAIT, f.runtime.wait_idle(&f.key))
        .await
        .unwrap();
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(matches!(neighbor.progress(), Progress::Running(_)));
    assert_eq!(
        f.runtime.pending_recovery(&f.key).unwrap().state,
        RecoveryState::Available
    );
    f.runtime.stop(&two, None).unwrap();
    neighbor.wait().await.unwrap();
    f.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_query_does_not_initialize_and_full_cache_does_not_block_fresh_chat() {
    let f = Rig::new();
    assert!(f.runtime.inner.owner.get().is_none());
    assert!(f.runtime.pending_recovery(&f.key).is_none());
    assert!(f.runtime.inner.owner.get().is_none());
    {
        let mut state = f.runtime.inner.shared.state.lock().unwrap();
        for index in 0..RECOVERY_CAPACITY {
            state.recoveries.insert(
                SessionKey {
                    name: format!("filled-{index}"),
                    created_at: f.key.created_at.clone(),
                },
                CachedRecovery {
                    id: format!("zr-filled-{index}"),
                    proof: None,
                    terminal: None,
                    state: RecoveryState::Unconfirmed,
                },
            );
        }
    }
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |row| {
            row.remove("providerSessionId");
            Ok(())
        })
        .unwrap();
    let mut fresh = f
        .runtime
        .execute(f.key.clone(), input("normal"))
        .await
        .unwrap();
    assert_eq!(fresh.wait().await.unwrap().turn.outcome, Outcome::Success);
    f.runtime.wait_idle(&f.key).await;
    let two = SessionKey {
        name: "two".into(),
        created_at: f.key.created_at.clone(),
    };
    assert!(matches!(
        f.runtime.execute(two, input("must not launch")).await,
        Err(RuntimeError::Capacity)
    ));
    assert_eq!(f.launches().len(), 1);
    assert_eq!(
        f.runtime
            .inner
            .shared
            .state
            .lock()
            .unwrap()
            .recoveries
            .len(),
        RECOVERY_CAPACITY
    );
    f.shutdown().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nonresumed_missing_is_diagnostic_without_recovery_authority() {
    let f = Rig::new();
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |row| {
            row.remove("providerSessionId");
            Ok(())
        })
        .unwrap();
    f.missing(false).await;
    assert!(f.runtime.pending_recovery(&f.key).is_none());
    assert!(f.record().get("zcodePendingInput").is_some());
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_native_start_blocks_recovery_but_recoverable_bad_line_is_not_read_error() {
    for prompt in ["started-missing", "broken-missing"] {
        let f = Rig::new();
        let mut handle = f
            .runtime
            .execute(f.key.clone(), input(prompt))
            .await
            .unwrap();
        let terminal = tokio::time::timeout(WAIT, handle.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(terminal.turn.outcome, Outcome::Failure { .. }));
        f.runtime.wait_idle(&f.key).await;
        if prompt == "started-missing" {
            assert!(f.runtime.pending_recovery(&f.key).is_none());
            assert!(terminal.turn.provider_turn_id.is_some());
        } else {
            // The existing recovering JSONL profile deliberately discards this
            // line. A joined clean EOF is not a claim that no bytes/work ran.
            assert_eq!(
                f.runtime.pending_recovery(&f.key).unwrap().state,
                RecoveryState::Available
            );
        }
        assert_eq!(f.launches().len(), 1);
        f.shutdown().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn storage_finished_error_is_diagnostic_unconfirmed_not_recovery_authority() {
    let f = Rig::new();
    // Exercise the synchronous reap independent of the watcher: a terminal
    // storage error never grants a reset even if a producer proof were present.
    let key = f.key.clone();
    let (_send, progress) = watch::channel(Progress::Finished(Err(
        crate::turn_driver::DriverError::StorageUnavailable,
    )));
    {
        let mut state = f.runtime.inner.shared.state.lock().unwrap();
        let (cancel, _) = watch::channel(false);
        state.insert(
            key.clone(),
            Entry {
                worker: None,
                expected_resume: Some(Some("sess_existing".into())),
                recovery_slot: Some(RecoveryReservation {
                    id: "zr-storage".into(),
                    expected_resume: "sess_existing".into(),
                }),
                recovering: None,
                attempt: None,
                source: None,
                nonce: Arc::new(()),
                cancel,
                ticket: None,
                route: None,
                quarantined: false,
                progress: Some(progress),
            },
        );
    }
    let descriptor = f.runtime.pending_recovery(&key).unwrap();
    assert_eq!(descriptor.state, RecoveryState::Unconfirmed);
    assert_eq!(
        f.runtime
            .confirm_missing_for_next_turn(f.action(descriptor.recovery_id))
            .await,
        Err(RuntimeError::Owner(OwnerError::Uncertain))
    );
    assert!(f.events().is_empty());
    assert!(f.driver.active_ticket_for_name(&key.name).is_none());
    f.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_never_claims_stopped_while_requested_warning_io_is_pending() {
    let f = Rig::new();
    f.missing(false).await;
    let descriptor = f.runtime.pending_recovery(&f.key).unwrap();
    f.sink.hold.store(true, Ordering::Release);
    let call = f
        .runtime
        .confirm_missing_for_next_turn(f.action(descriptor.recovery_id));
    tokio::time::timeout(WAIT, f.sink.entered.notified())
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(WAIT, f.runtime.shutdown())
            .await
            .unwrap(),
        Err(RuntimeError::CleanupUnconfirmed)
    );
    assert!(f.runtime.busy(&f.key));
    assert!(f.record().get("zcodePendingInput").is_some());
    f.sink.release.add_permits(1);
    assert!(call.await.is_err());
    tokio::time::timeout(WAIT, f.runtime.wait_idle(&f.key))
        .await
        .unwrap();
    assert!(f.record().get("zcodePendingInput").is_some());
    assert!(
        !f.events()
            .iter()
            .any(|v| v["data"]["recovery"]["phase"] == "committed")
    );
    f.shutdown().await;
}
