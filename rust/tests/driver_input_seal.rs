//! Real Driver first-input frontier with controlled Worker/close barriers.
//! No OS/provider IO: a seal is neither native acceptance nor cleanup proof.
use pult_core::{
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{
        Driver, EventSink, Handle, InputAction, Options, Progress, Receipt, SpawnAction, Started,
        Task, Worker, WorkerError,
    },
    turn_snapshot::{Approval, Provider, SessionKey, TurnSettings, TurnSnapshot},
};
use serde_json::Value;
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, Semaphore, mpsc, oneshot};
const WAIT: Duration = Duration::from_secs(10);
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, future)
        .await
        .expect("input seal fixture watchdog")
}
#[derive(Default)]
struct Sink(AtomicU64);
impl EventSink for Sink {
    fn append(&self, _: Value) -> Task<Result<Receipt, pult_core::turn_driver::SinkError>> {
        let id = self.0.fetch_add(1, Ordering::AcqRel) + 1;
        Box::pin(async move {
            Ok(Receipt {
                id,
                ts: "2026-11-12T00:00:00Z".into(),
            })
        })
    }
}
struct Start {
    ticket: Ticket,
    snapshot: TurnSnapshot,
    reply: oneshot::Sender<Started>,
}
struct Controlled {
    starts: mpsc::UnboundedSender<Start>,
    release: Arc<Semaphore>,
    closing: Arc<Notify>,
}
impl Worker for Controlled {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        _: String,
    ) -> Task<Result<Started, WorkerError>> {
        let (tx, rx) = oneshot::channel();
        self.starts
            .send(Start {
                ticket,
                snapshot,
                reply: tx,
            })
            .unwrap();
        Box::pin(async move {
            rx.await.map_err(|_| WorkerError {
                code: "fixture_closed".into(),
                message: "fixture".into(),
            })
        })
    }
    fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
        let release = self.release.clone();
        let closing = self.closing.clone();
        Box::pin(async move {
            closing.notify_one();
            release.acquire().await.unwrap().forget();
            Ok(())
        })
    }
}
struct Fixture {
    driver: Arc<Driver>,
    worker: Arc<Controlled>,
    starts: mpsc::UnboundedReceiver<Start>,
}
impl Fixture {
    fn new() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            driver: Arc::new(
                Driver::new(
                    Arc::new(Sink::default()),
                    Arc::new(str::to_owned),
                    Options::default(),
                )
                .unwrap(),
            ),
            worker: Arc::new(Controlled {
                starts: tx,
                release: Arc::new(Semaphore::new(0)),
                closing: Arc::new(Notify::new()),
            }),
            starts: rx,
        }
    }
    fn start(&self) -> Handle {
        self.driver
            .start(snapshot(), "literal fixture".into(), self.worker.clone())
            .unwrap()
    }
    async fn dispatching(&mut self) -> (Handle, Start) {
        let h = self.start();
        let start = bounded(self.starts.recv()).await.unwrap();
        (h, start)
    }
    async fn finish(&self, mut handle: Handle) {
        self.driver.cancel(handle.ticket());
        self.worker.release.add_permits(1);
        let _ = bounded(handle.wait()).await;
        assert_eq!(self.driver.active_count(), 0);
    }
}
fn snapshot() -> TurnSnapshot {
    TurnSnapshot {
        key: SessionKey {
            name: "seal-fixture".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        },
        provider: Provider::Zcode,
        cwd: "/projects/fixture".into(),
        settings: TurnSettings {
            approval: Approval::Ask,
            ..Default::default()
        },
    }
}
fn process_action(ticket: &Ticket) -> Arc<SpawnAction> {
    Arc::new(SpawnAction::new(ticket.clone(), Instant::now() + WAIT))
}
fn spawn(f: &Fixture, call: &Start) -> Arc<SpawnAction> {
    let process = process_action(&call.ticket);
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &process));
    process
}

#[tokio::test]
async fn construction_is_pure_and_input_requires_dispatching_and_parent_spawn_seal() {
    let mut f = Fixture::new();
    let h = f.start();
    let process = process_action(h.ticket());
    let input = InputAction::new(process.clone());
    assert!(!input.sealed());
    assert!(!input.never_enqueued());
    assert!(!process.sealed());
    assert!(matches!(h.progress(), Progress::Starting));
    assert!(!f.driver.seal_input(h.ticket(), &snapshot(), &input));
    let call = bounded(f.starts.recv()).await.unwrap();
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &input));
    assert!(!input.sealed());
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &process));
    assert!(f.driver.seal_input(&call.ticket, &call.snapshot, &input));
    assert!(input.sealed());
    assert!(!input.never_enqueued());
    assert!(matches!(h.progress(), Progress::Starting));
    f.finish(h).await;
}

#[tokio::test]
async fn action_cancel_does_not_cancel_driver_or_consume_the_control_input_budget() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let process = spawn(&f, &call);
    let canceled = InputAction::new(process.clone());
    assert!(canceled.cancel());
    assert!(!canceled.cancel());
    assert!(canceled.never_enqueued());
    assert!(!canceled.sealed());
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &canceled));
    assert!(f.driver.snapshot_for_dispatch(&call.ticket).is_some());
    let valid = InputAction::new(process);
    assert!(f.driver.seal_input(&call.ticket, &call.snapshot, &valid));
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &valid));
    assert!(!valid.cancel());
    assert!(!valid.never_enqueued());
    f.finish(h).await;
}

#[tokio::test]
async fn parent_action_cancellation_prevents_any_input_seal() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let process = process_action(&call.ticket);
    let input = InputAction::new(process.clone());
    assert!(process.cancel());
    assert!(!f.driver.seal_spawn(&call.ticket, &call.snapshot, &process));
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &input));
    assert!(!input.sealed());
    assert!(!input.never_enqueued());
    assert!(input.cancel());
    assert!(input.never_enqueued());
    f.finish(h).await;
}

#[tokio::test]
async fn exact_ticket_driver_incarnation_and_full_snapshot_are_required() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let process = spawn(&f, &call);
    let input = InputAction::new(process);
    let mut other = Fixture::new();
    let (oh, foreign) = other.dispatching().await;
    let foreign_input = InputAction::new(spawn(&other, &foreign));
    assert_ne!(call.ticket, foreign.ticket);
    assert!(
        !f.driver
            .seal_input(&call.ticket, &call.snapshot, &foreign_input)
    );
    assert!(
        !other
            .driver
            .seal_input(&call.ticket, &call.snapshot, &input)
    );
    for n in 0..6 {
        let mut wrong = call.snapshot.clone();
        match n {
            0 => wrong.key.created_at = "2000-01-01T00:00:00Z".into(),
            1 => wrong.key.name = "neighbor".into(),
            2 => wrong.cwd = "/different".into(),
            3 => wrong.provider = Provider::Codex,
            4 => wrong.settings.approval = Approval::Full,
            _ => wrong.settings.model = Some("different-model".into()),
        };
        assert!(!f.driver.seal_input(&call.ticket, &wrong, &input));
        assert!(!input.sealed());
    }
    assert!(f.driver.seal_input(&call.ticket, &call.snapshot, &input));
    assert!(
        other
            .driver
            .seal_input(&foreign.ticket, &foreign.snapshot, &foreign_input)
    );
    f.finish(h).await;
    other.finish(oh).await;
}

#[tokio::test]
async fn a_new_unsealed_parent_cannot_borrow_the_control_spawn_seal() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let process = spawn(&f, &call);
    let wrong_parent = process_action(&call.ticket);
    let wrong = InputAction::new(wrong_parent.clone());
    assert!(
        !f.driver
            .seal_spawn(&call.ticket, &call.snapshot, &wrong_parent)
    );
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &wrong));
    assert!(!wrong.sealed());
    assert!(
        f.driver
            .seal_input(&call.ticket, &call.snapshot, &InputAction::new(process))
    );
    f.finish(h).await;
}

#[tokio::test]
async fn input_inherits_absolute_parent_deadline_even_when_constructed_late() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let deadline = Instant::now() + Duration::from_millis(100);
    let process = Arc::new(SpawnAction::new(call.ticket.clone(), deadline));
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &process));
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    assert!(Instant::now() >= deadline);
    let late = InputAction::new(process);
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &late));
    assert!(!late.sealed());
    assert!(late.cancel());
    assert!(late.never_enqueued());
    f.finish(h).await;
}

#[tokio::test]
async fn direct_driver_cancel_fault_and_shutdown_deny_input_and_retain_cleanup() {
    for mode in 0..3 {
        let mut f = Fixture::new();
        let (h, call) = f.dispatching().await;
        let input = InputAction::new(spawn(&f, &call));
        match mode {
            0 => assert!(f.driver.cancel(&call.ticket)),
            1 => f.driver.report_storage_failure(),
            _ => f.driver.begin_shutdown(),
        };
        assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &input));
        assert_eq!(f.driver.active_count(), 1);
        assert!(!input.sealed());
        // Driver denial does not silently manufacture a local cancellation proof.
        assert!(!input.never_enqueued());
        assert!(input.cancel());
        assert!(input.never_enqueued());
        f.finish(h).await;
    }
}

#[tokio::test]
async fn running_is_not_a_new_input_frontier() {
    let mut f = Fixture::new();
    let (mut h, call) = f.dispatching().await;
    let input = InputAction::new(spawn(&f, &call));
    call.reply
        .send(Started {
            turn_id: "public-fixture".into(),
            done: Box::pin(std::future::pending()),
        })
        .unwrap_or_else(|_| panic!("fixture start lost"));
    bounded(h.accepted()).await.unwrap();
    assert!(!f.driver.seal_input(h.ticket(), &snapshot(), &input));
    assert!(!input.sealed());
    f.finish(h).await;
}

#[tokio::test]
async fn cancel_after_input_seal_is_unknown_delivery_and_waits_for_worker_close() {
    let mut f = Fixture::new();
    let (mut h, call) = f.dispatching().await;
    let input = InputAction::new(spawn(&f, &call));
    assert!(f.driver.seal_input(&call.ticket, &call.snapshot, &input));
    assert!(f.driver.cancel(&call.ticket));
    bounded(f.worker.closing.notified()).await;
    assert!(!input.cancel());
    assert!(input.sealed());
    assert!(!input.never_enqueued());
    assert!(!f.driver.seal_input(&call.ticket, &call.snapshot, &input));
    assert_eq!(f.driver.active_count(), 1);
    assert!(f.driver.snapshot_for_dispatch(&call.ticket).is_none());
    let mut waiting = Box::pin(h.wait());
    let pending =
        std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx).is_pending()))
            .await;
    assert!(pending, "input seal/cancel is not a cleanup receipt");
    f.worker.release.add_permits(1);
    assert_eq!(
        bounded(waiting).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert_eq!(f.driver.active_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_distinct_actions_have_one_control_input_budget() {
    for _ in 0..32 {
        let mut f = Fixture::new();
        let (h, call) = f.dispatching().await;
        let process = spawn(&f, &call);
        let first = Arc::new(InputAction::new(process.clone()));
        let second = Arc::new(InputAction::new(process));
        let barrier = std::sync::Barrier::new(2);
        let results = std::thread::scope(|scope| {
            let one = scope.spawn(|| {
                barrier.wait();
                f.driver.seal_input(&call.ticket, &call.snapshot, &first)
            });
            let two = scope.spawn(|| {
                barrier.wait();
                f.driver.seal_input(&call.ticket, &call.snapshot, &second)
            });
            [one.join().unwrap(), two.join().unwrap()]
        });
        assert_eq!(results.into_iter().filter(|v| *v).count(), 1);
        for (input, sealed) in [(first, results[0]), (second, results[1])] {
            assert_eq!(input.sealed(), sealed);
            assert_eq!(input.cancel(), !sealed);
            assert_eq!(input.never_enqueued(), !sealed);
        }
        f.finish(h).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_action_cancel_and_input_seal_choose_one_cas_outcome() {
    for _ in 0..32 {
        let mut f = Fixture::new();
        let (h, call) = f.dispatching().await;
        let input = InputAction::new(spawn(&f, &call));
        let barrier = std::sync::Barrier::new(2);
        let (canceled, sealed) = std::thread::scope(|scope| {
            let cancel = scope.spawn(|| {
                barrier.wait();
                input.cancel()
            });
            let seal = scope.spawn(|| {
                barrier.wait();
                f.driver.seal_input(&call.ticket, &call.snapshot, &input)
            });
            (cancel.join().unwrap(), seal.join().unwrap())
        });
        assert_ne!(canceled, sealed);
        assert_eq!(input.sealed(), sealed);
        assert_eq!(input.never_enqueued(), canceled);
        f.finish(h).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_direct_driver_cancel_and_input_seal_share_driver_linearization() {
    for _ in 0..32 {
        let mut f = Fixture::new();
        let (h, call) = f.dispatching().await;
        let input = InputAction::new(spawn(&f, &call));
        let barrier = std::sync::Barrier::new(2);
        let completed_cancel = AtomicBool::new(false);
        let sealed = std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                assert!(f.driver.cancel(&call.ticket));
                completed_cancel.store(true, Ordering::Release);
            });
            scope
                .spawn(|| {
                    barrier.wait();
                    let already_canceled = completed_cancel.load(Ordering::Acquire);
                    let sealed = f.driver.seal_input(&call.ticket, &call.snapshot, &input);
                    assert!(!already_canceled || !sealed);
                    sealed
                })
                .join()
                .unwrap()
        });
        assert_eq!(input.sealed(), sealed);
        assert_eq!(input.cancel(), !sealed);
        assert_eq!(input.never_enqueued(), !sealed);
        f.finish(h).await;
    }
}

#[tokio::test]
async fn retired_input_cannot_seal_but_a_new_ticket_has_its_own_budget() {
    let mut f = Fixture::new();
    let (first, old) = f.dispatching().await;
    let process = spawn(&f, &old);
    let retired = InputAction::new(process);
    f.finish(first).await;
    assert!(!f.driver.seal_input(&old.ticket, &old.snapshot, &retired));
    let (next, new) = f.dispatching().await;
    assert_ne!(new.ticket, old.ticket);
    assert!(!f.driver.seal_input(&new.ticket, &new.snapshot, &retired));
    let fresh = InputAction::new(spawn(&f, &new));
    assert!(f.driver.seal_input(&new.ticket, &new.snapshot, &fresh));
    f.finish(next).await;
}
