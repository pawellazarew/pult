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
    let stages = stages.lock().unwrap();
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
