//! Deterministic driver interleavings for the internal execution coordinator.
//! This fake owns no process. Real adapters must prove worker shutdown and own
//! durable user/queue receipts before these transitions reach the wire API.
use pult_core::turn_coordinator::{
    Change, Coordinator, DispatchAction, ErrorCode, Limits, Outcome, Phase, StartAction, Ticket,
};
use pult_core::turn_snapshot::{
    Approval, BrowserSettings, Provider, SessionKey, TurnSettings, TurnSnapshot,
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

type Shared = Arc<Mutex<Coordinator>>;

// Cleanup watchdogs only: ordering is established by channels, never elapsed time.
async fn receive<T>(receiver: oneshot::Receiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), receiver)
        .await
        .expect("fake driver signal exceeded cleanup watchdog")
        .expect("fake driver dropped a required signal")
}
async fn join(task: JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(10), task)
        .await
        .expect("fake driver task exceeded cleanup watchdog")
        .expect("fake driver task failed");
}

fn coordinator() -> Shared {
    Arc::new(Mutex::new(Coordinator::new(Limits::default()).unwrap()))
}
fn snapshot(name: &str, created_at: &str) -> TurnSnapshot {
    TurnSnapshot {
        key: SessionKey {
            name: name.into(),
            created_at: created_at.into(),
        },
        provider: Provider::Codex,
        cwd: "/projects/pult".into(),
        settings: TurnSettings {
            model: Some("initial-model".into()),
            effort: Some("high".into()),
            approval: Approval::Workspace,
            browser: Some(BrowserSettings { headed: false }),
            ..TurnSettings::default()
        },
    }
}
fn failure() -> Outcome {
    Outcome::Failure {
        code: "provider_unavailable".into(),
        message: "Fixture rejected the turn".into(),
    }
}

#[derive(Debug)]
enum End {
    Complete(Outcome),
    Stopped,
}

/// Reservation happens synchronously, before spawning the asynchronous driver.
/// Each barrier signals a protocol boundary, not an assumed amount of time.
struct FakeDriver {
    ticket: Ticket,
    resume: oneshot::Sender<()>,
    prepared: oneshot::Receiver<Option<TurnSnapshot>>,
    start: oneshot::Sender<()>,
    accepted: oneshot::Receiver<StartAction>,
    processed: oneshot::Receiver<()>,
    end: oneshot::Sender<End>,
    task: JoinHandle<()>,
}
fn launch(shared: Shared, snapshot: TurnSnapshot, provider_id: &'static str) -> FakeDriver {
    let ticket = shared.lock().unwrap().reserve(snapshot).unwrap();
    let driver_ticket = ticket.clone();
    let (resume, resume_rx) = oneshot::channel();
    let (prepared_tx, prepared) = oneshot::channel();
    let (start, start_rx) = oneshot::channel();
    let (accepted_tx, accepted) = oneshot::channel();
    let (processed_tx, processed) = oneshot::channel();
    let (end, end_rx) = oneshot::channel();
    let task = tokio::spawn(async move {
        receive(resume_rx).await;
        let dispatched = match shared
            .lock()
            .unwrap()
            .dispatch_start(&driver_ticket)
            .unwrap()
        {
            DispatchAction::Proceed(captured) => {
                prepared_tx.send(Some(captured)).unwrap();
                true
            }
            DispatchAction::Cancelled => {
                prepared_tx.send(None).unwrap();
                false
            }
            DispatchAction::Stale => panic!("fake driver lost its reservation"),
        };
        receive(start_rx).await;
        let action = if dispatched {
            shared
                .lock()
                .unwrap()
                .provider_started(&driver_ticket, provider_id)
                .unwrap()
        } else {
            // No provider send happened. Signal cancellation to this test's
            // caller while waiting for explicit worker shutdown proof.
            StartAction::CancelProvider
        };
        // A disconnected RPC caller does not own or cancel the driver.
        let _ = accepted_tx.send(action);
        processed_tx.send(()).unwrap();
        match receive(end_rx).await {
            End::Complete(outcome) => {
                assert_eq!(
                    shared
                        .lock()
                        .unwrap()
                        .complete(&driver_ticket, outcome)
                        .unwrap(),
                    Change::Applied
                );
            }
            End::Stopped => {
                assert_eq!(
                    shared.lock().unwrap().stopped(&driver_ticket).unwrap(),
                    Change::Applied
                );
            }
        }
    });
    FakeDriver {
        ticket,
        resume,
        prepared,
        start,
        accepted,
        processed,
        end,
        task,
    }
}

#[tokio::test]
async fn reservation_blocks_concurrent_send_before_resume_and_across_incarnations() {
    let shared = coordinator();
    let driver = launch(shared.clone(), snapshot("chat", "first"), "provider-turn");
    for created_at in ["first", "new-incarnation"] {
        assert_eq!(
            shared
                .lock()
                .unwrap()
                .reserve(snapshot("chat", created_at))
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
    }
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .active(&driver.ticket)
            .unwrap()
            .phase(),
        Phase::Starting
    );
    driver.resume.send(()).unwrap();
    receive(driver.prepared)
        .await
        .expect("dispatch should proceed");
    driver.start.send(()).unwrap();
    assert_eq!(receive(driver.accepted).await, StartAction::Proceed);
    receive(driver.processed).await;
    driver.end.send(End::Complete(Outcome::Success)).unwrap();
    join(driver.task).await;
    assert!(
        shared
            .lock()
            .unwrap()
            .reserve(snapshot("chat", "new-incarnation"))
            .is_ok()
    );
}

#[tokio::test]
async fn configuration_changed_while_resume_waits_only_affects_the_next_turn() {
    let shared = coordinator();
    let mut desired = snapshot("chat", "created");
    let driver = launch(shared.clone(), desired.clone(), "first-turn");
    desired.settings.model = Some("next-model".into());
    desired.settings.effort = Some("low".into());
    desired.settings.approval = Approval::Full;
    desired.settings.browser = None;
    driver.resume.send(()).unwrap();
    let captured = receive(driver.prepared)
        .await
        .expect("dispatch should proceed");
    assert_eq!(captured.settings.model.as_deref(), Some("initial-model"));
    assert_eq!(captured.settings.effort.as_deref(), Some("high"));
    assert_eq!(captured.settings.approval, Approval::Workspace);
    assert_eq!(
        captured.settings.browser,
        Some(BrowserSettings { headed: false })
    );
    driver.start.send(()).unwrap();
    assert_eq!(receive(driver.accepted).await, StartAction::Proceed);
    receive(driver.processed).await;
    driver.end.send(End::Complete(Outcome::Success)).unwrap();
    join(driver.task).await;
    let next = shared.lock().unwrap().reserve(desired.clone()).unwrap();
    assert_eq!(
        shared.lock().unwrap().active(&next).unwrap().snapshot(),
        &desired
    );
}

#[tokio::test]
async fn explicit_permission_narrowing_is_applied_before_send_but_never_after() {
    let shared = coordinator();
    let mut desired = snapshot("chat", "created");
    desired.settings.approval = Approval::Full;
    let driver = launch(shared.clone(), desired, "provider-turn");
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .restrict_before_start(&driver.ticket, Approval::Ask)
            .unwrap(),
        Change::Applied
    );
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .restrict_before_start(&driver.ticket, Approval::Full)
            .unwrap_err()
            .code,
        ErrorCode::Invalid
    );
    driver.resume.send(()).unwrap();
    assert_eq!(
        receive(driver.prepared)
            .await
            .expect("dispatch should proceed")
            .settings
            .approval,
        Approval::Ask
    );
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .active(&driver.ticket)
            .unwrap()
            .phase(),
        Phase::Dispatching
    );
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .restrict_before_start(&driver.ticket, Approval::ReadOnly)
            .unwrap_err()
            .code,
        ErrorCode::Transition
    );
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .active(&driver.ticket)
            .unwrap()
            .snapshot()
            .settings
            .approval,
        Approval::Ask
    );
    driver.start.send(()).unwrap();
    assert_eq!(receive(driver.accepted).await, StartAction::Proceed);
    receive(driver.processed).await;
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .restrict_before_start(&driver.ticket, Approval::ReadOnly)
            .unwrap_err()
            .code,
        ErrorCode::Transition
    );
    driver.end.send(End::Complete(Outcome::Success)).unwrap();
    join(driver.task).await;
}

#[tokio::test]
async fn successful_start_reply_does_not_mean_finished_or_release_the_name() {
    let shared = coordinator();
    let driver = launch(shared.clone(), snapshot("chat", "created"), "provider-turn");
    let ticket = driver.ticket.clone();
    driver.resume.send(()).unwrap();
    receive(driver.prepared)
        .await
        .expect("dispatch should proceed");
    driver.start.send(()).unwrap();
    assert_eq!(receive(driver.accepted).await, StartAction::Proceed);
    receive(driver.processed).await;
    {
        let mut state = shared.lock().unwrap();
        assert_eq!(state.active(&ticket).unwrap().phase(), Phase::Running);
        assert!(state.result(&ticket).is_none());
        assert_eq!(
            state.reserve(snapshot("chat", "created")).unwrap_err().code,
            ErrorCode::Busy
        );
    }
    driver.end.send(End::Complete(Outcome::Success)).unwrap();
    join(driver.task).await;
    let mut state = shared.lock().unwrap();
    assert_eq!(state.result(&ticket).unwrap().outcome, Outcome::Success);
    assert!(state.active(&ticket).is_none());
    assert_eq!(state.complete(&ticket, failure()).unwrap(), Change::Stale);
    assert_eq!(state.result(&ticket).unwrap().outcome, Outcome::Success);
}

#[tokio::test]
async fn cancelling_start_keeps_reservation_through_a_crossing_provider_ack() {
    let shared = coordinator();
    let driver = launch(shared.clone(), snapshot("chat", "created"), "late-turn");
    let ticket = driver.ticket.clone();
    driver.resume.send(()).unwrap();
    receive(driver.prepared)
        .await
        .expect("dispatch should proceed");
    assert_eq!(
        shared.lock().unwrap().request_cancel(&ticket),
        Change::Applied
    );
    assert_eq!(
        shared.lock().unwrap().request_cancel(&ticket),
        Change::Unchanged
    );
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .reserve(snapshot("chat", "replacement"))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    driver.start.send(()).unwrap();
    assert_eq!(receive(driver.accepted).await, StartAction::CancelProvider);
    receive(driver.processed).await;
    {
        let mut state = shared.lock().unwrap();
        let current = state.active(&ticket).unwrap();
        assert_eq!(current.phase(), Phase::Cancelling);
        assert_eq!(current.provider_turn_id(), Some("late-turn"));
        assert!(state.result(&ticket).is_none());
        assert_eq!(
            state
                .reserve(snapshot("chat", "replacement"))
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
    }
    driver.end.send(End::Stopped).unwrap();
    join(driver.task).await;
    let mut state = shared.lock().unwrap();
    assert_eq!(state.result(&ticket).unwrap().outcome, Outcome::Interrupted);
    assert!(state.result(&ticket).unwrap().cancel_requested);
    assert_eq!(
        state.provider_started(&ticket, "too-late").unwrap(),
        StartAction::Stale
    );
    assert!(state.reserve(snapshot("chat", "replacement")).is_ok());
}

#[test]
fn starting_cancel_requires_explicit_quiescence_even_without_a_provider_turn_id() {
    let mut state = Coordinator::new(Limits::default()).unwrap();
    let ticket = state.reserve(snapshot("chat", "created")).unwrap();
    assert_eq!(
        state.stopped(&ticket).unwrap_err().code,
        ErrorCode::Transition
    );
    state.request_cancel(&ticket);
    assert!(matches!(
        state.dispatch_start(&ticket).unwrap(),
        DispatchAction::Cancelled
    ));
    assert_eq!(state.active(&ticket).unwrap().phase(), Phase::Cancelling);
    assert!(state.active(&ticket).unwrap().provider_turn_id().is_none());
    assert_eq!(
        state
            .reserve(snapshot("chat", "replacement"))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    assert_eq!(state.stopped(&ticket).unwrap(), Change::Applied);
    assert_eq!(state.stopped(&ticket).unwrap(), Change::Stale);
    assert!(state.reserve(snapshot("chat", "replacement")).is_ok());
}

#[tokio::test]
async fn cancelling_running_turn_stays_busy_until_its_terminal_outcome() {
    let shared = coordinator();
    let driver = launch(shared.clone(), snapshot("chat", "created"), "provider-turn");
    let ticket = driver.ticket.clone();
    driver.resume.send(()).unwrap();
    receive(driver.prepared)
        .await
        .expect("dispatch should proceed");
    driver.start.send(()).unwrap();
    receive(driver.accepted).await;
    receive(driver.processed).await;
    shared.lock().unwrap().request_cancel(&ticket);
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .reserve(snapshot("chat", "created"))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    // Natural completion can win the race against a requested interruption.
    driver.end.send(End::Complete(Outcome::Success)).unwrap();
    join(driver.task).await;
    let state = shared.lock().unwrap();
    let result = state.result(&ticket).unwrap();
    assert_eq!(result.outcome, Outcome::Success);
    assert!(result.cancel_requested);
    assert!(state.active(&ticket).is_none());
}

#[tokio::test]
async fn disconnected_start_caller_does_not_drop_the_owned_driver_or_reservation() {
    let shared = coordinator();
    let driver = launch(shared.clone(), snapshot("chat", "created"), "provider-turn");
    let ticket = driver.ticket.clone();
    drop(driver.accepted);
    driver.resume.send(()).unwrap();
    receive(driver.prepared)
        .await
        .expect("dispatch should proceed");
    driver.start.send(()).unwrap();
    receive(driver.processed).await;
    assert_eq!(
        shared.lock().unwrap().active(&ticket).unwrap().phase(),
        Phase::Running
    );
    assert_eq!(
        shared
            .lock()
            .unwrap()
            .reserve(snapshot("chat", "created"))
            .unwrap_err()
            .code,
        ErrorCode::Busy
    );
    driver.end.send(End::Complete(Outcome::Success)).unwrap();
    join(driver.task).await;
    assert_eq!(
        shared.lock().unwrap().result(&ticket).unwrap().outcome,
        Outcome::Success
    );
}

#[test]
fn stale_callbacks_cannot_change_same_name_or_new_incarnation_even_with_reused_provider_id() {
    for new_incarnation in ["first", "replacement"] {
        let mut state = Coordinator::new(Limits::default()).unwrap();
        let old = state.reserve(snapshot("chat", "first")).unwrap();
        assert!(matches!(
            state.dispatch_start(&old).unwrap(),
            DispatchAction::Proceed(_)
        ));
        state.provider_started(&old, "reused-id").unwrap();
        state.complete(&old, Outcome::Success).unwrap();
        let new = state.reserve(snapshot("chat", new_incarnation)).unwrap();
        assert!(matches!(
            state.dispatch_start(&new).unwrap(),
            DispatchAction::Proceed(_)
        ));
        state.provider_started(&new, "reused-id").unwrap();
        assert_ne!(old, new);
        assert_eq!(state.complete(&old, failure()).unwrap(), Change::Stale);
        assert_eq!(state.request_cancel(&old), Change::Stale);
        assert_eq!(state.stopped(&old).unwrap(), Change::Stale);
        assert_eq!(state.start_failed(&old, failure()).unwrap(), Change::Stale);
        assert_eq!(
            state.provider_started(&old, "reused-id").unwrap(),
            StartAction::Stale
        );
        assert_eq!(state.active(&new).unwrap().phase(), Phase::Running);
        assert!(!state.active(&new).unwrap().cancel_requested());
        assert_eq!(state.result(&old).unwrap().outcome, Outcome::Success);
        state.complete(&new, Outcome::Success).unwrap();
    }
}

#[test]
fn tickets_from_another_coordinator_cannot_replay_the_same_first_attempt() {
    let mut first = Coordinator::new(Limits::default()).unwrap();
    let old = first.reserve(snapshot("chat", "created")).unwrap();
    let mut second = Coordinator::new(Limits::default()).unwrap();
    let current = second.reserve(snapshot("chat", "created")).unwrap();
    assert_eq!(old.attempt(), current.attempt());
    assert_eq!(old.session(), current.session());
    assert_ne!(old, current);
    assert_eq!(
        second.provider_started(&old, "reused-id").unwrap(),
        StartAction::Stale
    );
    assert_eq!(second.request_cancel(&old), Change::Stale);
    assert_eq!(second.start_failed(&old, failure()).unwrap(), Change::Stale);
    assert_eq!(second.active(&current).unwrap().phase(), Phase::Starting);
    assert!(first.active(&old).is_some());
}

#[test]
fn immediate_start_failure_is_retained_without_claiming_provider_acceptance() {
    let mut state = Coordinator::new(Limits::default()).unwrap();
    let ticket = state.reserve(snapshot("chat", "created")).unwrap();
    assert_eq!(
        state.complete(&ticket, Outcome::Success).unwrap_err().code,
        ErrorCode::Transition
    );
    assert_eq!(
        state.start_failed(&ticket, failure()).unwrap(),
        Change::Applied
    );
    let result = state.result(&ticket).unwrap();
    assert_eq!(result.provider_turn_id, None);
    assert_eq!(result.outcome, failure());
    assert!(!result.cancel_requested);
    assert!(state.reserve(snapshot("chat", "created")).is_ok());
}

#[test]
fn capacity_and_finished_eviction_never_displace_a_live_or_cancelling_turn() {
    let mut state = Coordinator::new(Limits {
        active: 2,
        finished: 1,
    })
    .unwrap();
    let live = state.reserve(snapshot("live", "created")).unwrap();
    assert!(matches!(
        state.dispatch_start(&live).unwrap(),
        DispatchAction::Proceed(_)
    ));
    state.provider_started(&live, "live-id").unwrap();
    state.request_cancel(&live);
    let first = state.reserve(snapshot("chat", "first")).unwrap();
    assert_eq!(
        state
            .reserve(snapshot("third", "created"))
            .unwrap_err()
            .code,
        ErrorCode::Capacity
    );
    state.start_failed(&first, failure()).unwrap();
    let second = state.reserve(snapshot("chat", "second")).unwrap();
    assert!(matches!(
        state.dispatch_start(&second).unwrap(),
        DispatchAction::Proceed(_)
    ));
    state.provider_started(&second, "second-id").unwrap();
    state.complete(&second, Outcome::Success).unwrap();
    assert!(state.result(&first).is_none());
    assert_eq!(state.result(&second).unwrap().outcome, Outcome::Success);
    assert_eq!(state.finished_count(), 1);
    assert_eq!(state.active_count(), 1);
    assert_eq!(state.active(&live).unwrap().phase(), Phase::Cancelling);
    assert_eq!(
        state.active(&live).unwrap().provider_turn_id(),
        Some("live-id")
    );
    assert_eq!(
        state.reserve(snapshot("live", "new")).unwrap_err().code,
        ErrorCode::Busy
    );
    state.stopped(&live).unwrap();
}

#[test]
fn retention_can_be_disabled_without_weakening_active_ownership() {
    let mut state = Coordinator::new(Limits {
        active: 1,
        finished: 0,
    })
    .unwrap();
    let ticket = state.reserve(snapshot("chat", "created")).unwrap();
    state.request_cancel(&ticket);
    assert_eq!(
        state
            .reserve(snapshot("other", "created"))
            .unwrap_err()
            .code,
        ErrorCode::Capacity
    );
    state.stopped(&ticket).unwrap();
    assert_eq!(state.finished_count(), 0);
    assert!(state.result(&ticket).is_none());
    assert_eq!(
        state.complete(&ticket, Outcome::Success).unwrap(),
        Change::Stale
    );
    assert!(state.reserve(snapshot("other", "created")).is_ok());
}

#[test]
fn unknown_inherit_policy_cannot_be_assumed_to_narrow_to_another_mode() {
    let mut state = Coordinator::new(Limits::default()).unwrap();
    let mut desired = snapshot("chat", "created");
    desired.provider = Provider::Claude;
    desired.settings.approval = Approval::Inherit;
    let ticket = state.reserve(desired).unwrap();
    assert_eq!(
        state
            .restrict_before_start(&ticket, Approval::Inherit)
            .unwrap(),
        Change::Unchanged
    );
    for target in [
        Approval::Full,
        Approval::Workspace,
        Approval::Ask,
        Approval::ReadOnly,
    ] {
        assert_eq!(
            state
                .restrict_before_start(&ticket, target)
                .unwrap_err()
                .code,
            ErrorCode::Invalid
        );
        assert_eq!(
            state.active(&ticket).unwrap().snapshot().settings.approval,
            Approval::Inherit
        );
    }
    state.start_failed(&ticket, failure()).unwrap();
}
