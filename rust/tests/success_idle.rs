//! Driver outcome parity. No provider executable, SDK, account or network call.
use pult_core::{
    journal::EventStore,
    registry::{Record, Registry},
    session_live::{Cache, Status},
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{DispatchDecision, Driver, Input, Options, Started, Task, Worker, WorkerError},
    turn_journal::JournalSink,
    turn_snapshot::TurnSnapshot,
};
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore, oneshot};
struct Controlled {
    done: Mutex<Option<oneshot::Receiver<Outcome>>>,
    close_entered: Arc<Notify>,
    close_release: Arc<Semaphore>,
    close_count: Arc<AtomicUsize>,
    turn: String,
}
impl Worker for Controlled {
    fn start(&self, _: Ticket, _: TurnSnapshot, _: String) -> Task<Result<Started, WorkerError>> {
        let done = self.done.lock().unwrap().take().unwrap();
        let turn = self.turn.clone();
        Box::pin(async move {
            Ok(Started {
                turn_id: turn,
                done: Box::pin(async move { done.await.unwrap() }),
            })
        })
    }
    fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
        let entered = self.close_entered.clone();
        let release = self.close_release.clone();
        let count = self.close_count.clone();
        Box::pin(async move {
            count.fetch_add(1, Ordering::SeqCst);
            entered.notify_one();
            release.acquire().await.unwrap().forget();
            Ok(())
        })
    }
}
async fn bounded<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), f)
        .await
        .expect("driver receipt/cleanup deadline")
}
fn record(home: &std::path::Path, provider: &str) -> Record {
    let cwd = home.join("project");
    std::fs::create_dir(&cwd).unwrap();
    let mut r = Record::default();
    for (k, v) in [
        ("name", "success"),
        ("createdAt", "2026-11-13T00:00:00Z"),
        ("provider", provider),
        ("cwd", cwd.to_str().unwrap()),
        ("approval", "ask"),
    ] {
        r.set_string(k, v);
    }
    r
}
#[tokio::test]
async fn all_three_provider_successes_publish_idle_only_after_actual_driver_cleanup() {
    for provider in ["claude", "codex", "zcode"] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let registered = registry.insert(record(&home, provider)).unwrap();
        let snapshot = TurnSnapshot::try_from(&registered).unwrap();
        let key = snapshot.key.clone();
        let store = Arc::new(Mutex::new(journal));
        let driver = Driver::new(
            Arc::new(JournalSink::new(store).unwrap()),
            Arc::new(pult_core::redaction::redact_string),
            Options::default(),
        )
        .unwrap();
        let (send, done) = oneshot::channel();
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Semaphore::new(0));
        let count = Arc::new(AtomicUsize::new(0));
        let turn = format!("fixture-turn-{provider}");
        let worker = Arc::new(Controlled {
            done: Mutex::new(Some(done)),
            close_entered: entered.clone(),
            close_release: release.clone(),
            close_count: count.clone(),
            turn: turn.clone(),
        });
        let mut handle = driver
            .start_input(
                snapshot,
                Input {
                    text: "literal successful input".into(),
                    metadata: Default::default(),
                },
                worker,
                Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow),
            )
            .unwrap();
        let accepted = bounded(handle.accepted()).await.unwrap();
        assert_eq!(accepted.turn_id, turn);
        assert!(accepted.user_event_id > 0);
        send.send(Outcome::Success).unwrap();
        bounded(entered.notified()).await;
        assert_eq!(
            driver.active_count(),
            1,
            "cleanup retains its exact Driver slot"
        );
        let read = || {
            std::fs::read_to_string(home.join("events/journal.jsonl"))
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<Value>(l).unwrap())
                .collect::<Vec<_>>()
        };
        assert!(
            !read().iter().any(|e| e["kind"] == "status.changed"
                && matches!(e["data"]["status"].as_str(), Some("idle" | "done"))),
            "no successful availability before cleanup ACK"
        );
        release.add_permits(1);
        let terminal = bounded(handle.wait()).await.unwrap();
        assert_eq!(terminal.turn.ticket, *handle.ticket());
        assert_eq!(
            terminal.turn.provider_turn_id.as_deref(),
            Some(turn.as_str())
        );
        assert_eq!(terminal.turn.outcome, Outcome::Success);
        assert!(!terminal.turn.cancel_requested);
        assert_eq!(terminal.user_event_id, Some(accepted.user_event_id));
        assert_eq!(driver.active_count(), 0);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let rows = read();
        let status = rows
            .iter()
            .filter(|e| e["kind"] == "status.changed")
            .collect::<Vec<_>>();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0]["data"]["status"], "idle");
        assert_eq!(status[0]["data"]["turnId"], turn);
        assert_eq!(terminal.terminal_event_id, status[0]["id"].as_u64());
        assert_eq!(
            rows.iter().filter(|e| e["kind"] == "message.user").count(),
            1
        );
        assert_eq!(rows[0]["id"].as_u64(), Some(accepted.user_event_id));
        let mut cache = Cache::new(1).unwrap();
        cache.seed(key.clone(), Status::Cold, 0).unwrap();
        for e in &rows {
            cache.note(
                "success",
                e["id"].as_u64().unwrap(),
                e["kind"].as_str().unwrap(),
                &e["data"],
            );
        }
        assert_eq!(cache.view(&key).unwrap().status, Status::Idle);
        registry
            .update_checked(&key, |r| {
                r.set_string("lastStatus", "idle");
                Ok(())
            })
            .unwrap();
        assert_eq!(
            registry
                .find("success")
                .unwrap()
                .scalar("lastStatus")
                .as_deref(),
            Some("idle")
        );
        bounded(driver.shutdown(Duration::from_secs(5)))
            .await
            .unwrap();
    }
}
#[test]
fn explicit_done_and_archived_recovered_done_are_not_success_rewritten() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut journal = EventStore::open(&home.join("events")).unwrap();
    let mut registry = Registry::open(&home, &mut journal).unwrap();
    let mut saved = record(&home, "zcode");
    saved.set_string("lastStatus", "done");
    saved.set_bool("archived", true);
    let saved = registry.insert(saved).unwrap();
    let key = TurnSnapshot::try_from(&saved).unwrap().key;
    let mut cache = Cache::new(1).unwrap();
    cache.seed(key.clone(), Status::Idle, 0).unwrap();
    cache.note("success", 1, "status.changed", &json!({"status":"done"}));
    assert_eq!(cache.view(&key).unwrap().status, Status::Done);
    cache.seed(key.clone(), Status::Idle, 1).unwrap();
    cache.note(
        "success",
        2,
        "session.ended",
        &json!({"reason":"explicit_close"}),
    );
    assert_eq!(cache.view(&key).unwrap().status, Status::Done);
    drop(registry);
    let reopened = Registry::open(&home, &mut journal).unwrap();
    assert_eq!(
        reopened
            .find("success")
            .unwrap()
            .scalar("lastStatus")
            .as_deref(),
        Some("done")
    );
    assert_eq!(
        reopened
            .find("success")
            .unwrap()
            .get("archived")
            .unwrap()
            .get(),
        "true"
    );
}
