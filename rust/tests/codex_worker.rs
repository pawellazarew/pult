use pult_core::codex_events::{RedactionError, Redactor};
use pult_core::codex_worker::{
    CodexHost, HostConfig, HostStatus, Limits, Services, SessionSpec, Timeouts,
};
use pult_core::turn_coordinator::{Coordinator, Limits as CoordinatorLimits, Outcome, Ticket};
use pult_core::turn_driver::{self, DispatchDecision, EventSink, Receipt, SinkError, Task, Worker};
use pult_core::turn_snapshot::{
    Approval, Provider, ServiceTier, SessionKey, TurnSettings, TurnSnapshot,
};
use pult_core::worker_process::Launch;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;
const WAIT: Duration = Duration::from_secs(20);
macro_rules! case {($name:ident,$body:block)=>{#[tokio::test]async fn $name(){pult_core::panic_guard::install();tokio::time::timeout(WAIT,async $body).await.expect("worker watchdog");}};}
#[derive(Default)]
struct MemorySink {
    events: Mutex<Vec<Value>>,
    sequence: AtomicU64,
    fail: AtomicBool,
}
impl EventSink for MemorySink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        if self.fail.load(Ordering::Acquire) && draft["kind"] == "message.done" {
            return Box::pin(async {
                Err(SinkError {
                    message: "SECRET storage error".into(),
                })
            });
        }
        self.events.lock().unwrap().push(draft);
        let id = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
        Box::pin(async move {
            Ok(Receipt {
                id,
                ts: "2026-11-12T00:00:00Z".into(),
            })
        })
    }
}
struct Identity;
impl Redactor for Identity {
    fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
        Ok(value.clone())
    }
}
struct ReenterRedactor {
    callback: Arc<dyn Fn() + Send + Sync>,
}
impl Redactor for ReenterRedactor {
    fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
        if value.is_string() || value.get("text").is_some() {
            (self.callback)();
        }
        Ok(value.clone())
    }
}
fn python() -> PathBuf {
    let primary = PathBuf::from("/usr/bin/python3");
    if primary.is_file() {
        return primary;
    }
    let output = std::process::Command::new("/usr/bin/which")
        .arg("python3")
        .output()
        .unwrap();
    assert!(output.status.success());
    PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
}
fn config(home: &Path) -> HostConfig {
    HostConfig {
        launch: Launch {
            holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
            program: python(),
            args: vec![
                "-B".into(),
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/codex_worker.py")
                    .into_os_string(),
                home.as_os_str().to_owned(),
            ],
            cwd: home.into(),
            env: BTreeMap::from([
                ("HOME".into(), home.as_os_str().to_owned()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("LANG".into(), "C.UTF-8".into()),
            ]),
        },
        fingerprint: "trusted-network-v1".into(),
        limits: Limits::default(),
        timeouts: Timeouts {
            control: Duration::from_secs(2),
            interrupt: Duration::from_millis(300),
            ..Timeouts::default()
        },
    }
}
fn services(
    sink: Arc<dyn EventSink>,
    gate: Arc<dyn turn_driver::DispatchGate>,
    fatal: Arc<dyn Fn() + Send + Sync>,
) -> Services {
    Services {
        sink,
        redactors: Arc::new(|| Box::new(Identity)),
        fresh_gate: gate,
        approval: None,
        fatal_storage: fatal,
    }
}
fn host(home: &Path, sink: Arc<MemorySink>) -> Arc<CodexHost> {
    CodexHost::start(
        config(home),
        services(
            sink,
            Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            Arc::new(|| {}),
        ),
    )
    .unwrap()
}
fn snapshot(home: &Path, name: &str, approval: Approval) -> TurnSnapshot {
    TurnSnapshot {
        key: SessionKey {
            name: name.into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        },
        provider: Provider::Codex,
        cwd: home.into(),
        settings: TurnSettings {
            model: Some("fixture-model".into()),
            effort: Some("high".into()),
            approval,
            service_tier: Some(ServiceTier::Fast),
            ..TurnSettings::default()
        },
    }
}
fn ticket(snapshot: &TurnSnapshot) -> Ticket {
    Coordinator::new(CoordinatorLimits::default())
        .unwrap()
        .reserve(snapshot.clone())
        .unwrap()
}
fn worker(
    host: &Arc<CodexHost>,
    home: &Path,
    snapshot: &TurnSnapshot,
    resume: Option<&str>,
    broker: bool,
) -> Arc<pult_core::codex_worker::CodexWorker> {
    host.worker(SessionSpec {
        key: snapshot.key.clone(),
        home: home.into(),
        cwd: snapshot.cwd.clone(),
        resume_id: resume.map(str::to_owned),
        broker,
        attachments: vec![],
    })
    .unwrap()
}
fn logs(home: &Path) -> Vec<Value> {
    std::fs::read_to_string(home.join("messages.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}
async fn until(check: impl Fn() -> bool) {
    loop {
        if check() {
            return;
        }
        tokio::task::yield_now().await;
    }
}
fn running(pid: u32) -> bool {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}
fn assert_gone(home: &Path) {
    let pids: Vec<u32> =
        serde_json::from_slice(&std::fs::read(home.join("pids.json")).unwrap()).unwrap();
    for pid in pids {
        assert!(!running(pid));
    }
}
case!(redactor_can_reenter_close_and_host_shutdown, {
    let home = tempfile::tempdir().unwrap();
    let called = Arc::new(AtomicBool::new(false));
    let slot = Arc::new(Mutex::new(
        None::<(
            std::sync::Weak<CodexHost>,
            std::sync::Weak<pult_core::codex_worker::CodexWorker>,
            Ticket,
        )>,
    ));
    let mut service = services(
        Arc::new(MemorySink::default()),
        Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
        Arc::new(|| {}),
    );
    let mark = called.clone();
    let reference = slot.clone();
    let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        if !mark.swap(true, Ordering::AcqRel) {
            let (host, worker, ticket) = reference.lock().unwrap().clone().unwrap();
            drop(worker.upgrade().unwrap().close(ticket));
            drop(host.upgrade().unwrap().shutdown());
        }
    });
    service.redactors = Arc::new(move || {
        Box::new(ReenterRedactor {
            callback: callback.clone(),
        })
    });
    let host = CodexHost::start(config(home.path()), service).unwrap();
    let snapshot = snapshot(home.path(), "reenter", Approval::ReadOnly);
    let worker = worker(&host, home.path(), &snapshot, None, true);
    let ticket = ticket(&snapshot);
    *slot.lock().unwrap() = Some((
        Arc::downgrade(&host),
        Arc::downgrade(&worker),
        ticket.clone(),
    ));
    let started = worker
        .start(ticket.clone(), snapshot, "normal".into())
        .await;
    until(|| called.load(Ordering::Acquire)).await;
    worker.close(ticket).await.unwrap();
    if let Ok(started) = started {
        let _ = started.done.await;
    }
    host.shutdown().await.unwrap();
    assert_gone(home.path());
});

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn storage_fault_blocks_dispatch_before_external_callback_returns() {
    pult_core::panic_guard::install();
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        sink.fail.store(true, Ordering::Release);
        let entered = Arc::new(tokio::sync::Notify::new());
        let mark = entered.clone();
        let (release, wait) = std::sync::mpsc::channel();
        let wait = Mutex::new(wait);
        let host = CodexHost::start(
            config(home.path()),
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(move || {
                    mark.notify_one();
                    wait.lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }),
            ),
        )
        .unwrap();
        let one = snapshot(home.path(), "fault", Approval::ReadOnly);
        let two = snapshot(home.path(), "later", Approval::ReadOnly);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let first = a.start(ta.clone(), one, "normal".into()).await;
        entered.notified().await;
        let status = host.status();
        let second = b.start(tb.clone(), two, "normal".into()).await;
        release.send(()).unwrap();
        assert_ne!(status, HostStatus::Ready);
        assert!(second.is_err());
        a.close(ta).await.unwrap();
        b.close(tb).await.unwrap();
        if let Ok(started) = first {
            let _ = started.done.await;
        }
        host.shutdown().await.unwrap();
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|v| v["method"] == "turn/start")
                .count(),
            1
        );
        assert_gone(home.path());
    })
    .await
    .expect("worker watchdog");
}

case!(worker_empty_text_matches_javascript_trim, {
    let home = tempfile::tempdir().unwrap();
    let host = host(home.path(), Arc::new(MemorySink::default()));
    let snapshot = snapshot(home.path(), "unicode", Approval::ReadOnly);
    let worker = worker(&host, home.path(), &snapshot, None, true);
    assert!(
        worker
            .start(ticket(&snapshot), snapshot.clone(), "\u{feff}".into())
            .await
            .is_err()
    );
    assert!(
        logs(home.path())
            .iter()
            .all(|v| v["method"] != "turn/start")
    );
    let ticket = ticket(&snapshot);
    let started = worker
        .start(ticket.clone(), snapshot, "\u{0085}".into())
        .await
        .unwrap();
    assert_eq!(started.done.await, Outcome::Success);
    worker.close(ticket).await.unwrap();
    let turns: Vec<_> = logs(home.path())
        .into_iter()
        .filter(|v| v["method"] == "turn/start")
        .collect();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["params"]["input"][0]["text"], "\u{0085}");
    host.shutdown().await.unwrap();
});
case!(
    ordinary_turn_commits_content_before_done_and_keeps_warm_thread,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink.clone());
        let snapshot = snapshot(home.path(), "one", Approval::Ask);
        let worker = worker(&host, home.path(), &snapshot, None, true);
        let first = ticket(&snapshot);
        let started = worker
            .start(first.clone(), snapshot.clone(), "normal".into())
            .await
            .unwrap();
        assert!(started.turn_id.starts_with("pult-"));
        assert!(!started.turn_id.starts_with("native-turn"));
        // Match Node redactString's long-hex token rule: public IDs must survive it.
        let token_rule = regex::Regex::new(r"(?i)\b[0-9a-f]{32,}\b").unwrap();
        assert_eq!(
            token_rule.replace_all(&started.turn_id, "<token>"),
            started.turn_id
        );
        assert_eq!(started.done.await, Outcome::Success);
        worker.close(first).await.unwrap();
        assert!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "message.done" && e["data"]["text"] == "done")
        );
        assert!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .all(|e| e["kind"] != "status.changed")
        );
        let next = ticket(&snapshot);
        let started = worker
            .start(next.clone(), snapshot, "normal".into())
            .await
            .unwrap();
        assert_eq!(started.done.await, Outcome::Success);
        worker.close(next).await.unwrap();
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|v| v["method"] == "thread/start")
                .count(),
            1
        );
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|v| v["method"] == "turn/start")
                .count(),
            2
        );
        assert_eq!(host.status(), HostStatus::Ready);
        host.shutdown().await.unwrap();
        assert_gone(home.path());
    }
);
case!(
    early_notifications_before_start_reply_preserve_terminal_and_text,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink.clone());
        let snapshot = snapshot(home.path(), "one", Approval::ReadOnly);
        let worker = worker(&host, home.path(), &snapshot, None, true);
        let ticket = ticket(&snapshot);
        let started = worker
            .start(ticket.clone(), snapshot, "early".into())
            .await
            .unwrap();
        assert_eq!(started.done.await, Outcome::Success);
        worker.close(ticket).await.unwrap();
        {
            let events = sink.events.lock().unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e["kind"] == "message.done")
                    .count(),
                1
            );
            assert!(events.iter().any(|e| e["data"]["text"] == "early text"));
        }
        host.shutdown().await.unwrap();
    }
);
case!(
    two_sessions_share_one_process_and_close_interrupts_only_its_exact_turn,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let one = snapshot(home.path(), "one", Approval::Ask);
        let two = snapshot(home.path(), "two", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let sa = a.start(ta.clone(), one, "hold".into()).await.unwrap();
        let sb = b.start(tb.clone(), two, "hold".into()).await.unwrap();
        a.close(ta).await.unwrap();
        assert_eq!(sa.done.await, Outcome::Interrupted);
        assert_eq!(host.status(), HostStatus::Ready);
        let mut other = tokio::spawn(sb.done);
        assert!(!other.is_finished());
        std::fs::write(home.path().join("release"), "yes").unwrap();
        assert_eq!((&mut other).await.unwrap(), Outcome::Success);
        b.close(tb).await.unwrap();
        let interrupts: Vec<_> = logs(home.path())
            .into_iter()
            .filter(|v| v["method"] == "turn/interrupt")
            .collect();
        assert_eq!(interrupts.len(), 1);
        assert!(
            interrupts[0]["params"]["turnId"]
                .as_str()
                .unwrap()
                .starts_with("native-turn-")
        );
        host.shutdown().await.unwrap();
        assert_gone(home.path());
    }
);
case!(default_approval_handler_drops_permission_as_denial, {
    let home = tempfile::tempdir().unwrap();
    let sink = Arc::new(MemorySink::default());
    let host = host(home.path(), sink.clone());
    let snapshot = snapshot(home.path(), "one", Approval::Ask);
    let worker = worker(&host, home.path(), &snapshot, None, true);
    let ticket = ticket(&snapshot);
    let started = worker
        .start(ticket.clone(), snapshot, "permit".into())
        .await
        .unwrap();
    assert_eq!(started.done.await, Outcome::Success);
    worker.close(ticket).await.unwrap();
    assert!(
        sink.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["data"]["text"] == "denied")
    );
    let frames = logs(home.path());
    assert!(
        frames
            .iter()
            .any(|f| f.get("method").is_none() && f["error"]["code"] == -32000)
    );
    host.shutdown().await.unwrap();
});
case!(
    settings_and_owner_workspace_policy_are_copied_to_wire_without_prompt_argv,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        for (index, mode, broker, sandbox, approval) in [
            (0, Approval::ReadOnly, true, "read-only", "on-request"),
            (1, Approval::Ask, false, "workspace-write", "never"),
            (2, Approval::Workspace, true, "workspace-write", "never"),
            (3, Approval::Full, true, "danger-full-access", "never"),
        ] {
            let s = snapshot(home.path(), &format!("s{index}"), mode);
            let w = worker(&host, home.path(), &s, None, broker);
            let ticket = ticket(&s);
            let started = w.start(ticket.clone(), s, "normal".into()).await.unwrap();
            assert_eq!(started.done.await, Outcome::Success);
            w.close(ticket).await.unwrap();
            let frames = logs(home.path());
            let thread = frames
                .iter()
                .rev()
                .find(|f| f["method"] == "thread/start")
                .unwrap();
            assert_eq!(thread["params"]["sandbox"], sandbox);
            assert_eq!(thread["params"]["approvalPolicy"], approval);
            let turn = frames
                .iter()
                .rev()
                .find(|f| f["method"] == "turn/start")
                .unwrap();
            assert_eq!(turn["params"]["effort"], "high");
            assert_eq!(turn["params"]["model"], "fixture-model");
            assert_eq!(turn["params"]["serviceTier"], "fast");
            assert_eq!(turn["params"]["approvalPolicy"], approval);
            if matches!(mode, Approval::Ask | Approval::Workspace) {
                assert_eq!(turn["params"]["sandboxPolicy"]["networkAccess"], true);
                assert_eq!(
                    turn["params"]["sandboxPolicy"]["writableRoots"],
                    json!([home.path().join("owner-root")])
                );
            }
        }
        host.shutdown().await.unwrap();
    }
);
case!(
    fresh_gate_after_async_preparation_can_only_narrow_and_snapshot_stays_immutable,
    {
        for expand in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let sink = Arc::new(MemorySink::default());
            let called = Arc::new(AtomicUsize::new(0));
            let mark = called.clone();
            let path = home.path().to_owned();
            let gate = Arc::new(move |_: &Ticket, snapshot: &TurnSnapshot| {
                assert!(logs(&path).iter().any(|f| f["method"] == "config/read"));
                mark.fetch_add(1, Ordering::AcqRel);
                assert_eq!(
                    snapshot.settings.approval,
                    if expand {
                        Approval::ReadOnly
                    } else {
                        Approval::Full
                    }
                );
                DispatchDecision::Restrict(if expand {
                    Approval::Full
                } else {
                    Approval::ReadOnly
                })
            });
            let host = CodexHost::start(config(home.path()), services(sink, gate, Arc::new(|| {})))
                .unwrap();
            let original = snapshot(
                home.path(),
                "one",
                if expand {
                    Approval::ReadOnly
                } else {
                    Approval::Full
                },
            );
            let worker = worker(&host, home.path(), &original, None, true);
            let ticket = ticket(&original);
            let started = worker
                .start(ticket.clone(), original.clone(), "normal".into())
                .await;
            if expand {
                assert!(started.is_err());
                assert!(
                    !logs(home.path())
                        .iter()
                        .any(|f| f["method"] == "turn/start")
                );
            } else {
                assert_eq!(started.unwrap().done.await, Outcome::Success);
                let frames = logs(home.path());
                let turn = frames.iter().find(|f| f["method"] == "turn/start").unwrap();
                assert_eq!(turn["params"]["sandboxPolicy"], json!({"type":"readOnly"}));
                assert_eq!(turn["params"]["approvalPolicy"], "on-request");
            }
            worker.close(ticket).await.unwrap();
            assert_eq!(called.load(Ordering::Acquire), 1);
            assert_eq!(
                original.settings.approval,
                if expand {
                    Approval::ReadOnly
                } else {
                    Approval::Full
                }
            );
            host.shutdown().await.unwrap();
        }
    }
);
case!(
    trusted_resume_is_reused_and_foreign_ticket_or_snapshot_is_rejected,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let snapshot = snapshot(home.path(), "one", Approval::Ask);
        let worker = worker(&host, home.path(), &snapshot, Some("trusted-resume"), true);
        let key = ticket(&snapshot);
        let started = worker
            .start(key.clone(), snapshot.clone(), "normal".into())
            .await
            .unwrap();
        assert_eq!(started.done.await, Outcome::Success);
        worker.close(key).await.unwrap();
        let frames = logs(home.path());
        let resumed = frames
            .iter()
            .find(|f| f["method"] == "thread/resume")
            .unwrap();
        assert_eq!(resumed["params"]["threadId"], "trusted-resume");
        assert_eq!(resumed["params"]["excludeTurns"], true);
        assert!(!frames.iter().any(|f| f["method"] == "thread/start"));
        let mut foreign = snapshot.clone();
        foreign.key.name = "foreign".into();
        assert!(
            worker
                .start(ticket(&foreign), snapshot.clone(), "not sent".into())
                .await
                .is_err()
        );
        foreign = snapshot.clone();
        foreign.cwd = home.path().join("other");
        assert!(
            worker
                .start(ticket(&foreign), foreign, "not sent".into())
                .await
                .is_err()
        );
        host.shutdown().await.unwrap();
    }
);
case!(
    unknown_turn_start_never_retries_and_waits_for_other_session_before_retirement,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let mut selected = config(home.path());
        selected.timeouts.control = Duration::from_millis(200);
        let host = CodexHost::start(
            selected,
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(|| {}),
            ),
        )
        .unwrap();
        let one = snapshot(home.path(), "one", Approval::Ask);
        let two = snapshot(home.path(), "two", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let held = b.start(tb.clone(), two, "hold".into()).await.unwrap();
        let unknown = a.start(ta.clone(), one, "unknown".into()).await;
        assert!(unknown.is_err());
        until(|| host.status() == HostStatus::Retiring).await;
        let held = tokio::spawn(held.done);
        assert!(!held.is_finished());
        let pids: Vec<u32> =
            serde_json::from_slice(&std::fs::read(home.path().join("pids.json")).unwrap()).unwrap();
        assert!(running(pids[1]));
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(
                    |f| f["method"] == "turn/start" && f["params"]["input"][0]["text"] == "unknown"
                )
                .count(),
            1
        );
        std::fs::write(home.path().join("release"), "yes").unwrap();
        assert_eq!(held.await.unwrap(), Outcome::Success);
        b.close(tb).await.unwrap();
        a.close(ta).await.unwrap();
        until(|| host.status() == HostStatus::Stopped).await;
        assert_gone(home.path());
    }
);
case!(
    cancel_during_start_uses_early_native_identity_and_leaves_other_session_running,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink.clone());
        let one = snapshot(home.path(), "one", Approval::Ask);
        let two = snapshot(home.path(), "two", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let held = b.start(tb.clone(), two, "hold".into()).await.unwrap();
        let task = {
            let a = a.clone();
            let ta = ta.clone();
            tokio::spawn(async move { a.start(ta, one, "cancel-start".into()).await })
        };
        until(|| {
            logs(home.path()).iter().any(|f| {
                f["method"] == "turn/start" && f["params"]["input"][0]["text"] == "cancel-start"
            })
        })
        .await;
        // A later completed turn on the same ordered event stream is a barrier
        // proving that the early native identity was routed, without exposing
        // or authorizing any pre-ack content/permission callback.
        let barrier = snapshot(home.path(), "barrier", Approval::Ask);
        let c = worker(&host, home.path(), &barrier, None, true);
        let tc = ticket(&barrier);
        let sc = c.start(tc.clone(), barrier, "normal".into()).await.unwrap();
        assert_eq!(sc.done.await, Outcome::Success);
        c.close(tc).await.unwrap();
        assert!(
            !sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["sessionId"] == "one")
        );
        a.close(ta).await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(host.status(), HostStatus::Ready);
        let held = tokio::spawn(held.done);
        assert!(!held.is_finished());
        std::fs::write(home.path().join("release"), "yes").unwrap();
        assert_eq!(held.await.unwrap(), Outcome::Success);
        b.close(tb).await.unwrap();
        host.shutdown().await.unwrap();
    }
);
case!(
    unconfirmed_interrupt_quarantines_without_killing_other_active_turn,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let one = snapshot(home.path(), "one", Approval::Ask);
        let two = snapshot(home.path(), "two", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let active = b.start(tb.clone(), two, "hold".into()).await.unwrap();
        let unknown = a
            .start(ta.clone(), one, "never-interrupt".into())
            .await
            .unwrap();
        let close = {
            let a = a.clone();
            tokio::spawn(async move { a.close(ta).await })
        };
        until(|| host.status() == HostStatus::Retiring).await;
        assert!(!close.is_finished());
        let active = tokio::spawn(active.done);
        assert!(!active.is_finished());
        std::fs::write(home.path().join("release"), "yes").unwrap();
        assert_eq!(active.await.unwrap(), Outcome::Success);
        b.close(tb).await.unwrap();
        close.await.unwrap().unwrap();
        assert!(matches!(
            unknown.done.await,
            Outcome::Interrupted | Outcome::Failure { .. }
        ));
        assert_gone(home.path());
    }
);
case!(
    storage_failure_cancels_all_owned_turns_and_calls_global_latch_once,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let faults = Arc::new(AtomicUsize::new(0));
        let mark = faults.clone();
        let host = CodexHost::start(
            config(home.path()),
            services(
                sink.clone(),
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(move || {
                    mark.fetch_add(1, Ordering::AcqRel);
                }),
            ),
        )
        .unwrap();
        let one = snapshot(home.path(), "one", Approval::Ask);
        let two = snapshot(home.path(), "two", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let sa = a.start(ta.clone(), one, "hold".into()).await.unwrap();
        let sb = b.start(tb.clone(), two, "hold".into()).await.unwrap();
        sink.fail.store(true, Ordering::Release);
        let three = snapshot(home.path(), "three", Approval::Ask);
        let c = worker(&host, home.path(), &three, None, true);
        let tc = ticket(&three);
        if let Ok(started) = c.start(tc.clone(), three, "normal".into()).await {
            assert!(matches!(
                started.done.await,
                Outcome::Failure { .. } | Outcome::Interrupted
            ));
        }
        until(|| faults.load(Ordering::Acquire) > 0).await;
        a.close(ta).await.unwrap();
        b.close(tb).await.unwrap();
        c.close(tc).await.unwrap();
        assert!(!matches!(sa.done.await, Outcome::Success));
        assert!(!matches!(sb.done.await, Outcome::Success));
        assert_eq!(faults.load(Ordering::Acquire), 1);
        host.shutdown().await.unwrap();
        assert_gone(home.path());
    }
);
case!(
    actual_driver_and_journal_sink_write_one_public_terminal_after_cleanup,
    {
        let home = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(
            pult_core::journal::EventStore::open(&home.path().join("events")).unwrap(),
        ));
        let sink = Arc::new(pult_core::turn_journal::JournalSink::new(store.clone()).unwrap());
        let driver = Arc::new(
            turn_driver::Driver::new(
                sink.clone(),
                Arc::new(str::to_owned),
                turn_driver::Options::default(),
            )
            .unwrap(),
        );
        let weak = Arc::downgrade(&driver);
        let host = CodexHost::start(
            config(home.path()),
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(move || {
                    if let Some(driver) = weak.upgrade() {
                        driver.report_storage_failure();
                    }
                }),
            ),
        )
        .unwrap();
        let snapshot = snapshot(home.path(), "one", Approval::Ask);
        let worker = worker(&host, home.path(), &snapshot, None, true);
        let mut handle = driver.start(snapshot, "normal".into(), worker).unwrap();
        let accepted = handle.accepted().await.unwrap();
        assert!(accepted.turn_id.starts_with("pult-"));
        let terminal = handle.wait().await.unwrap();
        assert_eq!(terminal.turn.outcome, Outcome::Success);
        let records: Vec<Value> = std::fs::read_to_string(home.path().join("events/journal.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let done: Vec<_> = records
            .iter()
            .filter(|e| e["kind"] == "status.changed" && e["data"]["status"] == "done")
            .collect();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["data"]["turnId"], accepted.turn_id);
        let content = records
            .iter()
            .position(|e| e["kind"] == "message.done")
            .unwrap();
        let result = records
            .iter()
            .position(|e| e["kind"] == "usage.updated" && e["data"]["source"] == "result")
            .unwrap();
        let final_index = records
            .iter()
            .position(|e| e["kind"] == "status.changed" && e["data"]["status"] == "done")
            .unwrap();
        assert!(content < result && result < final_index);
        host.shutdown().await.unwrap();
    }
);
case!(
    late_completed_turn_callbacks_are_ignored_and_no_prompt_is_put_in_argv,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink.clone());
        let snapshot = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &snapshot, None, true);
        for text in ["normal", "late"] {
            let key = ticket(&snapshot);
            let started = w
                .start(key.clone(), snapshot.clone(), text.into())
                .await
                .unwrap();
            assert_eq!(started.done.await, Outcome::Success);
            w.close(key).await.unwrap();
        }
        assert_eq!(
            sink.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["kind"] == "message.done")
                .count(),
            2
        );
        assert!(
            !serde_json::to_string(&*sink.events.lock().unwrap())
                .unwrap()
                .contains("STALE_SECRET")
        );
        let key = ticket(&snapshot);
        let started = w
            .start(key.clone(), snapshot, "hold SECRET_PROMPT_NOT_ARGV".into())
            .await
            .unwrap();
        let pids: Vec<u32> =
            serde_json::from_slice(&std::fs::read(home.path().join("pids.json")).unwrap()).unwrap();
        let args = std::process::Command::new("/bin/ps")
            .args(["-o", "command=", "-p", &pids[1].to_string()])
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&args.stdout).contains("SECRET_PROMPT_NOT_ARGV"));
        w.close(key).await.unwrap();
        assert_eq!(started.done.await, Outcome::Interrupted);
        host.shutdown().await.unwrap();
    }
);
case!(
    definite_missing_rollout_can_create_a_thread_but_wider_actual_policy_is_rejected,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, Some("missing-resume"), true);
        let key = ticket(&s);
        let started = w.start(key.clone(), s, "normal".into()).await.unwrap();
        assert_eq!(started.done.await, Outcome::Success);
        w.close(key).await.unwrap();
        let frames = logs(home.path());
        assert_eq!(
            frames
                .iter()
                .filter(|f| f["method"] == "thread/resume")
                .count(),
            1
        );
        assert_eq!(
            frames
                .iter()
                .filter(|f| f["method"] == "thread/start")
                .count(),
            1
        );
        host.shutdown().await.unwrap();
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let mut selected = config(home.path());
        selected.launch.args.push("wide".into());
        let host = CodexHost::start(
            selected,
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(|| {}),
            ),
        )
        .unwrap();
        let s = snapshot(home.path(), "one", Approval::ReadOnly);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        assert!(w.start(key.clone(), s, "not sent".into()).await.is_err());
        w.close(key).await.unwrap();
        assert!(
            !logs(home.path())
                .iter()
                .any(|f| f["method"] == "turn/start")
        );
        until(|| host.status() == HostStatus::Stopped).await;
    }
);
case!(
    background_outliving_turn_is_explicitly_unsupported_and_retires_host,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        let start = w.start(key.clone(), s, "background".into()).await;
        if let Ok(started) = start {
            assert!(
                matches!(started.done.await,Outcome::Failure{code,..} if code=="unsupported_background")
            );
        }
        w.close(key).await.unwrap();
        until(|| host.status() == HostStatus::Stopped).await;
        assert_gone(home.path());
    }
);
struct Stash(Arc<Mutex<Option<pult_core::codex_worker::ScopedResponder>>>);
impl pult_core::codex_worker::ApprovalHandler for Stash {
    fn handle(&self, context: pult_core::codex_worker::ApprovalContext) -> Task<()> {
        assert_eq!(context.session, context.ticket.session().clone());
        assert!(context.native_turn_id.starts_with("native-turn-"));
        assert_eq!(context.effective_approval, Approval::Ask);
        *self.0.lock().unwrap() = Some(context.responder);
        Box::pin(async {})
    }
}
case!(
    stashed_responder_is_revoked_by_cancel_and_by_native_terminal,
    {
        for terminal in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let sink = Arc::new(MemorySink::default());
            let stash = Arc::new(Mutex::new(None));
            let mut service = services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(|| {}),
            );
            service.approval = Some(Arc::new(Stash(stash.clone())));
            let host = CodexHost::start(config(home.path()), service).unwrap();
            let s = snapshot(home.path(), "one", Approval::Ask);
            let w = worker(&host, home.path(), &s, None, true);
            let key = ticket(&s);
            let started = w
                .start(
                    key.clone(),
                    s,
                    if terminal {
                        "permit-terminal"
                    } else {
                        "permit"
                    }
                    .into(),
                )
                .await
                .unwrap();
            until(|| stash.lock().unwrap().is_some()).await;
            if terminal {
                std::fs::write(home.path().join("terminal"), "yes").unwrap();
                assert_eq!(started.done.await, Outcome::Success);
                let reply = stash.lock().unwrap().take().unwrap();
                assert!(
                    reply
                        .respond(Ok(json!({"decision":"accept"})))
                        .await
                        .is_err()
                );
                w.close(key).await.unwrap();
                assert_eq!(host.status(), HostStatus::Ready);
            } else {
                let close = {
                    let w = w.clone();
                    tokio::spawn(async move { w.close(key).await })
                };
                until(|| host.status() == HostStatus::Retiring).await;
                let reply = stash.lock().unwrap().take().unwrap();
                assert!(
                    reply
                        .respond(Ok(json!({"decision":"accept"})))
                        .await
                        .is_err()
                );
                close.await.unwrap().unwrap();
                assert!(!matches!(started.done.await, Outcome::Success));
            }
            assert!(
                !logs(home.path())
                    .iter()
                    .any(|f| f.get("method").is_none() && f["result"]["decision"] == "accept")
            );
            host.shutdown().await.unwrap();
        }
    }
);
struct Reenter {
    host: Mutex<std::sync::Weak<CodexHost>>,
    called: AtomicBool,
}
impl pult_core::codex_worker::ApprovalHandler for Reenter {
    fn handle(&self, context: pult_core::codex_worker::ApprovalContext) -> Task<()> {
        self.called.store(true, Ordering::Release);
        if let Some(host) = self.host.lock().unwrap().upgrade() {
            drop(host.shutdown());
        }
        Box::pin(async move {
            drop(context.responder);
        })
    }
}
case!(
    approval_callback_can_synchronously_reenter_host_shutdown_without_deadlock,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let handler = Arc::new(Reenter {
            host: Mutex::new(std::sync::Weak::new()),
            called: AtomicBool::new(false),
        });
        let mut service = services(
            sink,
            Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            Arc::new(|| {}),
        );
        service.approval = Some(handler.clone());
        let host = CodexHost::start(config(home.path()), service).unwrap();
        *handler.host.lock().unwrap() = Arc::downgrade(&host);
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        let started = w.start(key.clone(), s, "permit".into()).await;
        until(|| handler.called.load(Ordering::Acquire)).await;
        w.close(key).await.unwrap();
        if let Ok(started) = started {
            let _ = started.done.await;
        }
        host.shutdown().await.unwrap();
        assert_gone(home.path());
    }
);
case!(
    unknown_thread_start_is_not_retried_and_cancelled_waiter_cannot_abandon_ownership,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let mut selected = config(home.path());
        selected.launch.args.push("thread-timeout".into());
        selected.timeouts.control = Duration::from_millis(200);
        let host = CodexHost::start(
            selected,
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(|| {}),
            ),
        )
        .unwrap();
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        assert!(w.start(key.clone(), s, "not sent".into()).await.is_err());
        w.close(key).await.unwrap();
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|f| f["method"] == "thread/start")
                .count(),
            1
        );
        assert!(
            !logs(home.path())
                .iter()
                .any(|f| f["method"] == "turn/start")
        );
        until(|| host.status() == HostStatus::Stopped).await;
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = CodexHost::start(
            config(home.path()),
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(|| {}),
            ),
        )
        .unwrap();
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        drop(w.start(key.clone(), s, "hold".into()));
        w.close(key).await.unwrap();
        host.shutdown().await.unwrap();
    }
);
case!(
    attachments_only_frozen_png_is_native_input_with_runtime_context,
    {
        use base64::Engine;
        use pult_core::prompt_attachments::{AttachmentKind, PromptAttachment};
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let s = snapshot(home.path(), "one", Approval::ReadOnly);
        let first = worker(&host, home.path(), &s, None, true);
        let first_key = ticket(&s);
        let first_started = first
            .start(first_key.clone(), s.clone(), "normal".into())
            .await
            .unwrap();
        assert_eq!(first_started.done.await, Outcome::Success);
        first.close(first_key).await.unwrap();
        let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jt0AAAAASUVORK5CYII=").unwrap();
        let path = home.path().join("attachments/one/day/image.png");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &png).unwrap();
        let image = PromptAttachment {
            path: path.to_str().unwrap().into(),
            name: "image.png".into(),
            bytes: png.len() as u64,
            mime: "image/png".into(),
            kind: AttachmentKind::File,
        };
        let w = host
            .worker(SessionSpec {
                key: s.key.clone(),
                home: home.path().into(),
                cwd: s.cwd.clone(),
                resume_id: None,
                broker: true,
                attachments: vec![image],
            })
            .unwrap();
        let key = ticket(&s);
        let started = w.start(key.clone(), s, String::new()).await.unwrap();
        assert_eq!(started.done.await, Outcome::Success);
        w.close(key).await.unwrap();
        let frames = logs(home.path());
        let turn = frames
            .iter()
            .rev()
            .find(|f| f["method"] == "turn/start")
            .unwrap();
        assert_eq!(
            frames
                .iter()
                .filter(|f| f["method"] == "thread/start")
                .count(),
            1
        );
        assert_eq!(
            turn["params"]["input"][0],
            json!({"type":"localImage","path":path})
        );
        assert!(
            turn["params"]["input"][1]["text"]
                .as_str()
                .unwrap()
                .contains("<pult_runtime_context>")
        );
        assert!(!turn.to_string().contains("iVBOR"));
        host.shutdown().await.unwrap();
    }
);
struct AnswerOnce;
impl pult_core::codex_worker::ApprovalHandler for AnswerOnce {
    fn handle(&self, context: pult_core::codex_worker::ApprovalContext) -> Task<()> {
        Box::pin(async move {
            context
                .responder
                .respond(Ok(json!({"decision":"accept"})))
                .await
                .unwrap();
        })
    }
}
case!(
    live_scoped_responder_enqueues_one_reply_without_exposing_unscoped_client,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let mut service = services(
            sink,
            Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            Arc::new(|| {}),
        );
        service.approval = Some(Arc::new(AnswerOnce));
        let host = CodexHost::start(config(home.path()), service).unwrap();
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        let started = w.start(key.clone(), s, "permit".into()).await.unwrap();
        assert_eq!(started.done.await, Outcome::Success);
        w.close(key).await.unwrap();
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|f| f.get("method").is_none() && f["result"]["decision"] == "accept")
                .count(),
            1
        );
        assert_eq!(host.status(), HostStatus::Ready);
        host.shutdown().await.unwrap();
    }
);
case!(
    known_idle_thread_autoturn_retires_without_fabricating_ticket_or_killing_others,
    {
        for leave_route in [false, true] {
            let home = tempfile::tempdir().unwrap();
            let sink = Arc::new(MemorySink::default());
            let host = host(home.path(), sink.clone());
            let one = snapshot(home.path(), "one", Approval::Ask);
            let two = snapshot(home.path(), "two", Approval::Ask);
            let a = worker(&host, home.path(), &one, None, true);
            let b = worker(&host, home.path(), &two, None, true);
            let ta = ticket(&one);
            let tb = ticket(&two);
            let completed = a
                .start(ta.clone(), one.clone(), "normal".into())
                .await
                .unwrap();
            assert_eq!(completed.done.await, Outcome::Success);
            if !leave_route {
                a.close(ta.clone()).await.unwrap();
            }
            let held = b.start(tb.clone(), two, "hold".into()).await.unwrap();
            let thread = sink
                .events
                .lock()
                .unwrap()
                .iter()
                .find(|e| e["sessionId"] == "one" && e["kind"] == "session.started")
                .unwrap()["data"]["providerSessionId"]
                .as_str()
                .unwrap()
                .to_owned();
            std::fs::write(home.path().join("autoturn"), thread).unwrap();
            until(|| host.status() == HostStatus::Retiring).await;
            assert!(host.unsupported_background());
            assert!(a.start(ticket(&one), one, "not sent".into()).await.is_err());
            let held = tokio::spawn(held.done);
            assert!(!held.is_finished());
            let pids: Vec<u32> =
                serde_json::from_slice(&std::fs::read(home.path().join("pids.json")).unwrap())
                    .unwrap();
            assert!(running(pids[1]));
            std::fs::write(home.path().join("release"), "yes").unwrap();
            assert_eq!(held.await.unwrap(), Outcome::Success);
            b.close(tb).await.unwrap();
            a.close(ta).await.unwrap();
            until(|| host.status() == HostStatus::Stopped).await;
            assert_gone(home.path());
        }
    }
);
case!(
    shared_host_rejects_session_memory_environment_before_spawning,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let mut selected = config(home.path());
        selected.launch.env.insert(
            "PULT_MEMORY_KEY".into(),
            format!("mem_{}", "a".repeat(64)).into(),
        );
        let result = CodexHost::start(
            selected,
            services(
                sink,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
                Arc::new(|| {}),
            ),
        );
        assert!(result.is_err());
        assert!(!home.path().join("pids.json").exists());
    }
);
case!(
    third_retry_commits_one_network_block_then_interrupts_only_its_owned_turn,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink.clone());
        let one = snapshot(home.path(), "one", Approval::Ask);
        let two = snapshot(home.path(), "two", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let b = worker(&host, home.path(), &two, None, true);
        let ta = ticket(&one);
        let tb = ticket(&two);
        let held = b.start(tb.clone(), two, "hold".into()).await.unwrap();
        let storm = a.start(ta.clone(), one, "storm".into()).await.unwrap();
        let public = storm.turn_id.clone();
        assert!(matches!(storm.done.await,Outcome::Failure{code,..} if code=="blocked_network"));
        a.close(ta).await.unwrap();
        assert_eq!(host.status(), HostStatus::Ready);
        {
            let rows = sink.events.lock().unwrap();
            let blocked: Vec<_> = rows
                .iter()
                .enumerate()
                .filter(|(_, e)| e["kind"] == "net.blocked")
                .collect();
            assert_eq!(blocked.len(), 1);
            assert_eq!(
                blocked[0].1["data"],
                json!({"reason":"error_retry_storm","retries":3,"turnId":public,"message":"Reconnecting 3"})
            );
            assert!(rows.iter().enumerate().any(|(i, e)| i > blocked[0].0
                && e["sessionId"] == "one"
                && e["kind"] == "usage.updated"));
        }
        let held = tokio::spawn(held.done);
        assert!(!held.is_finished());
        std::fs::write(home.path().join("release"), "yes").unwrap();
        assert_eq!(held.await.unwrap(), Outcome::Success);
        b.close(tb).await.unwrap();
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|f| f["method"] == "turn/interrupt")
                .count(),
            1
        );
        host.shutdown().await.unwrap();
    }
);
case!(
    conflicting_native_reply_is_unknown_and_cannot_claim_warm_per_thread_cleanup,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let host = host(home.path(), sink);
        let s = snapshot(home.path(), "one", Approval::Ask);
        let w = worker(&host, home.path(), &s, None, true);
        let key = ticket(&s);
        let result = w.start(key.clone(), s, "conflict".into()).await;
        match result {
            Err(error) => assert_eq!(error.code, "start_unknown"),
            Ok(started) => assert!(
                matches!(started.done.await,Outcome::Failure{code,..} if code=="start_unknown")
            ),
        }
        w.close(key).await.unwrap();
        until(|| host.status() == HostStatus::Stopped).await;
        assert_eq!(
            logs(home.path())
                .iter()
                .filter(|f| f["method"] == "turn/start")
                .count(),
            1
        );
        assert_gone(home.path());
    }
);
struct CountApproval(Arc<AtomicUsize>);
impl pult_core::codex_worker::ApprovalHandler for CountApproval {
    fn handle(&self, context: pult_core::codex_worker::ApprovalContext) -> Task<()> {
        self.0.fetch_add(1, Ordering::AcqRel);
        Box::pin(async move {
            let _ = context
                .responder
                .respond(Err(pult_core::codex_rpc::ResponseError::denied()))
                .await;
        })
    }
}
case!(
    early_content_and_approval_are_held_until_ack_and_rejected_reply_never_authorizes_them,
    {
        let home = tempfile::tempdir().unwrap();
        let sink = Arc::new(MemorySink::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let mut service = services(
            sink.clone(),
            Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            Arc::new(|| {}),
        );
        service.approval = Some(Arc::new(CountApproval(calls.clone())));
        let mut selected = config(home.path());
        selected.timeouts.control = Duration::from_secs(10);
        let host = CodexHost::start(selected, service).unwrap();
        let one = snapshot(home.path(), "one", Approval::Ask);
        let a = worker(&host, home.path(), &one, None, true);
        let ta = ticket(&one);
        let request = {
            let a = a.clone();
            let ta = ta.clone();
            tokio::spawn(async move { a.start(ta, one, "early-permit-reject".into()).await })
        };
        until(|| home.path().join("early-permit").exists()).await;
        let barrier = snapshot(home.path(), "barrier", Approval::Ask);
        let b = worker(&host, home.path(), &barrier, None, true);
        let tb = ticket(&barrier);
        let done = b.start(tb.clone(), barrier, "normal".into()).await.unwrap();
        assert_eq!(done.done.await, Outcome::Success);
        b.close(tb).await.unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 0);
        assert!(
            !sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["sessionId"] == "one")
        );
        assert!(!request.is_finished());
        std::fs::write(home.path().join("reject-ack"), "yes").unwrap();
        assert!(matches!(request.await.unwrap(),Err(error) if error.code=="start_unknown"));
        a.close(ta).await.unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 0);
        assert!(
            !sink
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["sessionId"] == "one")
        );
        until(|| host.status() == HostStatus::Stopped).await;
        assert_gone(home.path());
    }
);
