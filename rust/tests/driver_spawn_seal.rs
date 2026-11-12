//! Real Driver state/cancellation with in-memory worker/close barriers. No OS
//! spawn is performed: Process frontier/join proofs belong to Process tests.
use pult_core::{
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{
        Driver, EventSink, Handle, Options, Receipt, SpawnAction, Started, Task, Worker,
        WorkerError,
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
        .expect("spawn seal fixture watchdog")
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
fn action(ticket: &Ticket) -> SpawnAction {
    SpawnAction::new(ticket.clone(), Instant::now() + WAIT)
}

#[tokio::test]
async fn starting_cannot_seal_and_dispatching_can_seal_only_once_per_ticket() {
    let mut f = Fixture::new();
    let h = f.start();
    let early = action(h.ticket());
    assert!(!f.driver.seal_spawn(h.ticket(), &snapshot(), &early));
    assert!(!early.sealed());
    assert!(!early.never_sent());
    let call = bounded(f.starts.recv()).await.unwrap();
    assert_eq!(h.ticket(), &call.ticket);
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &early));
    assert!(early.sealed());
    assert!(!early.cancel());
    assert!(!early.never_sent());
    assert!(!f.driver.seal_spawn(&call.ticket, &call.snapshot, &early));
    let fresh = action(&call.ticket);
    assert!(!f.driver.seal_spawn(&call.ticket, &call.snapshot, &fresh));
    assert!(fresh.cancel());
    assert!(fresh.never_sent());
    f.finish(h).await;
}
#[tokio::test]
async fn deadline_and_canceled_actions_do_not_consume_an_unused_ticket_seal() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let expired = SpawnAction::new(call.ticket.clone(), Instant::now());
    assert!(!f.driver.seal_spawn(&call.ticket, &call.snapshot, &expired));
    assert!(expired.cancel());
    assert!(expired.never_sent());
    let canceled = action(&call.ticket);
    assert!(canceled.cancel());
    assert!(!canceled.cancel());
    assert!(!f.driver.seal_spawn(&call.ticket, &call.snapshot, &canceled));
    assert!(canceled.never_sent());
    assert!(!canceled.sealed());
    let valid = action(&call.ticket);
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &valid));
    f.finish(h).await;
}
#[tokio::test]
async fn exact_ticket_driver_generation_incarnation_and_full_snapshot_are_required() {
    let mut f = Fixture::new();
    let (h, call) = f.dispatching().await;
    let mut other = Fixture::new();
    let (oh, foreign) = other.dispatching().await;
    assert_ne!(call.ticket, foreign.ticket);
    let wrong_action = action(&foreign.ticket);
    assert!(
        !f.driver
            .seal_spawn(&call.ticket, &call.snapshot, &wrong_action)
    );
    let bound = action(&call.ticket);
    assert!(
        !other
            .driver
            .seal_spawn(&call.ticket, &call.snapshot, &bound)
    );
    for n in 0..5 {
        let mut wrong = call.snapshot.clone();
        match n {
            0 => wrong.key.created_at = "2000-01-01T00:00:00Z".into(),
            1 => wrong.cwd = "/different".into(),
            2 => wrong.provider = Provider::Codex,
            3 => wrong.settings.approval = Approval::Full,
            _ => wrong.settings.model = Some("different-model".into()),
        };
        assert!(!f.driver.seal_spawn(&call.ticket, &wrong, &bound));
        assert!(!bound.sealed());
    }
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &bound));
    f.finish(h).await;
    other.finish(oh).await;
}
#[tokio::test]
async fn cancel_fault_and_shutdown_before_seal_deny_without_losing_cleanup_ownership() {
    for mode in 0..3 {
        let mut f = Fixture::new();
        let (h, call) = f.dispatching().await;
        let candidate = action(&call.ticket);
        match mode {
            0 => {
                assert!(f.driver.cancel(&call.ticket));
            }
            1 => f.driver.report_storage_failure(),
            _ => f.driver.begin_shutdown(),
        };
        assert!(
            !f.driver
                .seal_spawn(&call.ticket, &call.snapshot, &candidate)
        );
        assert!(candidate.cancel());
        assert!(candidate.never_sent());
        assert!(!candidate.sealed());
        f.finish(h).await;
    }
}
#[tokio::test]
async fn running_is_not_a_new_route_a_spawn_frontier() {
    let mut f = Fixture::new();
    let (mut h, call) = f.dispatching().await;
    call.reply
        .send(Started {
            turn_id: "public-fixture".into(),
            done: Box::pin(std::future::pending()),
        })
        .unwrap_or_else(|_| panic!("fixture start lost"));
    bounded(h.accepted()).await.unwrap();
    let candidate = action(h.ticket());
    assert!(!f.driver.seal_spawn(h.ticket(), &snapshot(), &candidate));
    assert!(candidate.cancel());
    f.finish(h).await;
}
#[tokio::test]
async fn cancel_after_seal_is_irreversible_and_waits_for_actual_worker_close() {
    let mut f = Fixture::new();
    let (mut h, call) = f.dispatching().await;
    let candidate = action(&call.ticket);
    assert!(
        f.driver
            .seal_spawn(&call.ticket, &call.snapshot, &candidate)
    );
    assert!(f.driver.cancel(&call.ticket));
    bounded(f.worker.closing.notified()).await;
    assert!(!candidate.cancel());
    assert!(candidate.sealed());
    assert!(!candidate.never_sent());
    assert_eq!(f.driver.active_count(), 1);
    assert!(f.driver.snapshot_for_dispatch(&call.ticket).is_none());
    let mut waiting = Box::pin(h.wait());
    let pending =
        std::future::poll_fn(|cx| std::task::Poll::Ready(waiting.as_mut().poll(cx).is_pending()))
            .await;
    assert!(pending, "seal/cancel is not a worker cleanup receipt");
    f.worker.release.add_permits(1);
    assert_eq!(
        bounded(waiting).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert_eq!(f.driver.active_count(), 0);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_cancel_and_spawn_seal_have_a_single_driver_linearization() {
    for _ in 0..32 {
        let mut f = Fixture::new();
        let (h, call) = f.dispatching().await;
        let candidate = Arc::new(action(&call.ticket));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let canceled = Arc::new(AtomicBool::new(false));
        let result = std::thread::scope(|scope| {
            let driver = f.driver.clone();
            let ticket = call.ticket.clone();
            let start = barrier.clone();
            let done = canceled.clone();
            scope.spawn(move || {
                start.wait();
                assert!(driver.cancel(&ticket));
                done.store(true, Ordering::Release);
            });
            let driver = f.driver.clone();
            let ticket = call.ticket.clone();
            let snapshot = call.snapshot.clone();
            let gate = candidate.clone();
            let start = barrier.clone();
            let done = canceled.clone();
            scope
                .spawn(move || {
                    start.wait();
                    let already = done.load(Ordering::Acquire);
                    let sealed = driver.seal_spawn(&ticket, &snapshot, &gate);
                    assert!(
                        !already || !sealed,
                        "a completed Driver cancellation cannot grant a later seal"
                    );
                    sealed
                })
                .join()
                .unwrap()
        });
        assert_eq!(candidate.sealed(), result);
        if result {
            assert!(!candidate.cancel());
            assert!(!candidate.never_sent());
        } else {
            assert!(candidate.cancel());
            assert!(candidate.never_sent());
        }
        f.finish(h).await;
    }
}

#[tokio::test]
async fn released_ticket_cannot_seal_again_but_next_ticket_has_its_own_budget() {
    let mut f = Fixture::new();
    let (first, call) = f.dispatching().await;
    let old = action(&call.ticket);
    assert!(f.driver.seal_spawn(&call.ticket, &call.snapshot, &old));
    f.finish(first).await;
    assert!(
        !f.driver
            .seal_spawn(&call.ticket, &call.snapshot, &action(&call.ticket))
    );
    let (next, new) = f.dispatching().await;
    assert_ne!(new.ticket, call.ticket);
    assert!(!f.driver.seal_spawn(&new.ticket, &new.snapshot, &old));
    assert!(
        f.driver
            .seal_spawn(&new.ticket, &new.snapshot, &action(&new.ticket))
    );
    f.finish(next).await;
}
