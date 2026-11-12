//! Real driver + durable EventStore, with explicit in-process worker barriers.
//! These fixtures do not prove OS process-tree cleanup; delayed input receipts
//! are checked against the durable journal with deterministic worker barriers.
use pult_core::journal::EventStore;
use pult_core::turn_coordinator::{Limits, Outcome, Ticket};
use pult_core::turn_driver::{
    DispatchDecision, Driver, DriverError, EventSink, Handle, Input, InputMetadata, Options,
    Receipt, SinkError, Started, Task, Worker, WorkerError,
};
use pult_core::turn_journal::JournalSink;
use pult_core::turn_snapshot::{Approval, Provider, SessionKey, TurnSettings, TurnSnapshot};
use serde_json::Value;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Waker};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("driver protocol/cleanup watchdog expired")
}
async fn receive<T>(receiver: oneshot::Receiver<T>) -> T {
    bounded(receiver)
        .await
        .expect("required fixture signal dropped")
}
async fn next<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    bounded(receiver.recv())
        .await
        .expect("fixture channel closed")
}
fn assert_pending<T>(future: Pin<&mut impl Future<Output = T>>) {
    let mut context = Context::from_waker(Waker::noop());
    assert!(
        future.poll(&mut context).is_pending(),
        "operation completed before its required acknowledgement"
    );
}
fn snapshot() -> TurnSnapshot {
    TurnSnapshot {
        key: SessionKey {
            name: "chat".into(),
            created_at: "2026-11-11T00:00:00Z".into(),
        },
        provider: Provider::Codex,
        cwd: PathBuf::from("/projects/pult"),
        settings: TurnSettings {
            approval: Approval::Ask,
            ..TurnSettings::default()
        },
    }
}
fn failure() -> WorkerError {
    WorkerError {
        code: "provider_unavailable".into(),
        message: "SECRET fixture failure".into(),
    }
}
struct Fixture {
    _home: tempfile::TempDir,
    store: Arc<Mutex<EventStore>>,
    sink: Arc<JournalSink>,
}
impl Fixture {
    fn new() -> Self {
        let home = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(
            EventStore::open(&home.path().join("events")).unwrap(),
        ));
        let sink = Arc::new(JournalSink::new(store.clone()).unwrap());
        Self {
            _home: home,
            store,
            sink,
        }
    }
    fn rows(&self) -> Vec<Value> {
        self.store
            .lock()
            .unwrap()
            .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
            .unwrap()
            .into_iter()
            .map(|row| serde_json::from_str(row.json.get()).unwrap())
            .collect()
    }
    fn driver(&self) -> Arc<Driver> {
        self.with_sink(self.sink.clone())
    }
    fn with_sink(&self, sink: Arc<dyn EventSink>) -> Arc<Driver> {
        Arc::new(
            Driver::new(
                sink,
                Arc::new(|text| text.replace("SECRET", "[REDACTED]")),
                Options::default(),
            )
            .unwrap(),
        )
    }
}
struct DropNotice(Option<oneshot::Sender<()>>);
impl Drop for DropNotice {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}
enum StartReply {
    Started(Started),
    Failed(WorkerError),
    Panic,
}
struct StartCall {
    ticket: Ticket,
    snapshot: TurnSnapshot,
    text: String,
    reply: oneshot::Sender<StartReply>,
    dropped: oneshot::Receiver<()>,
}
struct CloseCall {
    ticket: Ticket,
    reply: oneshot::Sender<Result<(), WorkerError>>,
}
struct ControlledWorker {
    starts: mpsc::UnboundedSender<StartCall>,
    closes: mpsc::UnboundedSender<CloseCall>,
}
struct WorkerControl {
    worker: Arc<ControlledWorker>,
    starts: mpsc::UnboundedReceiver<StartCall>,
    closes: mpsc::UnboundedReceiver<CloseCall>,
}
impl WorkerControl {
    fn new() -> Self {
        let (starts, start_rx) = mpsc::unbounded_channel();
        let (closes, close_rx) = mpsc::unbounded_channel();
        Self {
            worker: Arc::new(ControlledWorker { starts, closes }),
            starts: start_rx,
            closes: close_rx,
        }
    }
}
impl Worker for ControlledWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        text: String,
    ) -> Task<Result<Started, WorkerError>> {
        let (reply, reply_rx) = oneshot::channel();
        let (dropped_tx, dropped) = oneshot::channel();
        self.starts
            .send(StartCall {
                ticket,
                snapshot,
                text,
                reply,
                dropped,
            })
            .unwrap();
        let notice = DropNotice(Some(dropped_tx));
        Box::pin(async move {
            let _notice = notice;
            match reply_rx.await.expect("test must resolve or cancel start") {
                StartReply::Started(started) => Ok(started),
                StartReply::Failed(error) => Err(error),
                StartReply::Panic => panic!("fixture worker start panic"),
            }
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        let (reply, reply_rx) = oneshot::channel();
        self.closes.send(CloseCall { ticket, reply }).unwrap();
        Box::pin(async move { reply_rx.await.expect("test must resolve or cancel close") })
    }
}
fn started() -> (Started, oneshot::Sender<Outcome>, oneshot::Receiver<()>) {
    let (done, done_rx) = oneshot::channel();
    let (drop_tx, dropped) = oneshot::channel();
    let notice = DropNotice(Some(drop_tx));
    (
        Started {
            turn_id: "provider-turn".into(),
            done: Box::pin(async move {
                let _notice = notice;
                done_rx.await.expect("test must complete or cancel done")
            }),
        },
        done,
        dropped,
    )
}
async fn running(
    driver: &Driver,
    worker: &mut WorkerControl,
    text: &str,
) -> (Handle, oneshot::Sender<Outcome>, oneshot::Receiver<()>) {
    let mut handle = driver
        .start(snapshot(), text.into(), worker.worker.clone())
        .unwrap();
    let call = next(&mut worker.starts).await;
    let (reply, done, dropped) = started();
    call.reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("driver lost start reply"));
    bounded(handle.accepted()).await.unwrap();
    (handle, done, dropped)
}
fn terminal_status(rows: &[Value]) -> &str {
    rows.last().unwrap()["data"]["status"].as_str().unwrap()
}

#[tokio::test]
async fn durable_user_input_precedes_worker_and_public_data_is_redacted() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "say SECRET".into(), worker.worker.clone())
        .unwrap();
    let call = next(&mut worker.starts).await;
    assert_eq!(fixture.store.lock().unwrap().last_id(), 1);
    assert_eq!(fixture.rows()[0]["kind"], "message.user");
    assert_eq!(fixture.rows()[0]["data"]["text"], "say [REDACTED]");
    assert_eq!(call.text, "say SECRET");
    assert_eq!(call.snapshot, snapshot());
    assert_eq!(&call.ticket, handle.ticket());
    let (reply, done, _) = started();
    call.reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("lost start reply"));
    let accepted = bounded(handle.accepted()).await.unwrap();
    assert_eq!(accepted.user_event_id, 1);
    assert_eq!(accepted.turn_id, "provider-turn");
    assert_eq!(driver.active_count(), 1);
    assert!(driver.result(handle.ticket()).is_none());
    done.send(Outcome::Success).unwrap();
    let close = next(&mut worker.closes).await;
    assert_eq!(&close.ticket, handle.ticket());
    assert_eq!(driver.active_count(), 1);
    close.reply.send(Ok(())).unwrap();
    let terminal = bounded(handle.wait()).await.unwrap();
    assert_eq!(terminal.turn.outcome, Outcome::Success);
    assert_eq!(terminal.user_event_id, Some(1));
    assert!(terminal.terminal_event_id.is_some());
    assert_eq!(terminal_status(&fixture.rows()), "done");
    assert_eq!(driver.active_count(), 0);
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}

struct FaultSink {
    inner: Arc<dyn EventSink>,
    at: usize,
    after_commit: bool,
    calls: AtomicUsize,
}
impl FaultSink {
    fn new(inner: Arc<dyn EventSink>, at: usize, after_commit: bool) -> Arc<Self> {
        Arc::new(Self {
            inner,
            at,
            after_commit,
            calls: AtomicUsize::new(0),
        })
    }
}
impl EventSink for FaultSink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let fail = self.calls.fetch_add(1, Ordering::SeqCst) + 1 == self.at;
        let inner = self.inner.clone();
        let after_commit = self.after_commit;
        Box::pin(async move {
            if fail && !after_commit {
                return Err(SinkError {
                    message: "fixture write failure SECRET".into(),
                });
            }
            let receipt = inner.append(draft).await?;
            if fail {
                Err(SinkError {
                    message: "fixture unknown commit outcome SECRET".into(),
                })
            } else {
                Ok(receipt)
            }
        })
    }
}
#[tokio::test]
async fn initial_write_failure_never_launches_worker_and_latches_execution() {
    let fixture = Fixture::new();
    let driver = fixture.with_sink(FaultSink::new(fixture.sink.clone(), 1, false));
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert_eq!(
        bounded(handle.wait()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert!(worker.starts.try_recv().is_err());
    assert!(worker.closes.try_recv().is_err());
    assert!(fixture.rows().is_empty());
    assert!(driver.storage_failed());
    assert!(matches!(
        driver.start(snapshot(), "retry".into(), worker.worker.clone()),
        Err(DriverError::StorageUnavailable)
    ));
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn committed_but_unacknowledged_user_input_is_not_reported_as_success_or_retried() {
    let fixture = Fixture::new();
    let driver = fixture.with_sink(FaultSink::new(fixture.sink.clone(), 1, true));
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert_eq!(
        bounded(handle.wait()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert_eq!(fixture.rows().len(), 1);
    assert!(worker.starts.try_recv().is_err());
    assert!(driver.storage_failed());
    assert!(matches!(
        driver.start(snapshot(), "retry".into(), worker.worker.clone()),
        Err(DriverError::StorageUnavailable)
    ));
    assert_eq!(fixture.rows().len(), 1);
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn terminal_write_failure_occurs_after_cleanup_and_never_acknowledges_success() {
    let fixture = Fixture::new();
    let driver = fixture.with_sink(FaultSink::new(fixture.sink.clone(), 2, false));
    let mut worker = WorkerControl::new();
    let (mut handle, done, _) = running(&driver, &mut worker, "hello").await;
    done.send(Outcome::Success).unwrap();
    let close = next(&mut worker.closes).await;
    assert!(!driver.storage_failed());
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.wait()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert!(driver.storage_failed());
    assert_eq!(fixture.rows().len(), 1);
    assert!(matches!(
        driver.start(snapshot(), "retry".into(), worker.worker.clone()),
        Err(DriverError::StorageUnavailable)
    ));
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn rejected_start_keeps_the_user_message_and_redacts_the_failure() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    let call = next(&mut worker.starts).await;
    call.reply
        .send(StartReply::Failed(failure()))
        .unwrap_or_else(|_| panic!("lost failure reply"));
    let close = next(&mut worker.closes).await;
    assert_eq!(driver.active_count(), 1);
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::WorkerFailed)
    );
    let terminal = bounded(handle.wait()).await.unwrap();
    assert!(matches!(terminal.turn.outcome, Outcome::Failure { .. }));
    let rows = fixture.rows();
    assert_eq!(rows[0]["kind"], "message.user");
    assert_eq!(terminal_status(&rows), "failed");
    assert!(!serde_json::to_string(&rows).unwrap().contains("SECRET"));
    assert!(!format!("{:?}", terminal.turn.outcome).contains("SECRET"));
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn cancellation_aborts_and_joins_start_before_confirmed_close_releases_the_name() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    let call = next(&mut worker.starts).await;
    assert!(driver.cancel(handle.ticket()));
    let close = next(&mut worker.closes).await;
    receive(call.dropped).await;
    assert_eq!(driver.active_count(), 1);
    assert!(matches!(
        driver.start(snapshot(), "second".into(), worker.worker.clone()),
        Err(DriverError::Busy)
    ));
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::Cancelled)
    );
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert_eq!(terminal_status(&fixture.rows()), "interrupted");
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn cancellation_of_running_turn_drops_done_future_before_close_ack() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let (mut handle, _done, done_dropped) = running(&driver, &mut worker, "hello").await;
    assert!(driver.cancel(handle.ticket()));
    let close = next(&mut worker.closes).await;
    receive(done_dropped).await;
    assert_eq!(driver.active_count(), 1);
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn failed_cleanup_quarantines_until_an_explicit_retry_confirms_close() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let (mut handle, _done, _) = running(&driver, &mut worker, "hello").await;
    let ticket = handle.ticket().clone();
    driver.cancel(&ticket);
    next(&mut worker.closes)
        .await
        .reply
        .send(Err(failure()))
        .unwrap();
    assert_eq!(
        bounded(handle.wait()).await,
        Err(DriverError::CleanupUnconfirmed)
    );
    assert_eq!(driver.active_count(), 1);
    assert!(matches!(
        driver.start(snapshot(), "replacement".into(), worker.worker.clone()),
        Err(DriverError::Busy)
    ));
    assert!(driver.cancel(&ticket));
    {
        let wait = handle.wait();
        tokio::pin!(wait);
        // Poll before yielding to the driver: cancel must synchronously replace
        // the old quarantine with Closing, rather than return the old error.
        assert_pending(wait.as_mut());
        let retry = next(&mut worker.closes).await;
        assert_pending(wait.as_mut());
        retry.reply.send(Ok(())).unwrap();
        assert_eq!(
            bounded(wait).await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
    }
    assert_eq!(driver.active_count(), 0);
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn dropping_the_client_handle_does_not_drop_the_owned_worker_lifecycle() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let (handle, done, _) = running(&driver, &mut worker, "hello").await;
    let ticket = handle.ticket().clone();
    drop(handle);
    assert_eq!(driver.active_count(), 1);
    done.send(Outcome::Success).unwrap();
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
    assert_eq!(driver.result(&ticket).unwrap().outcome, Outcome::Success);
}
#[tokio::test]
async fn start_panic_is_joined_and_cleaned_before_recording_a_failure() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    next(&mut worker.starts)
        .await
        .reply
        .send(StartReply::Panic)
        .unwrap_or_else(|_| panic!("lost panic reply"));
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    assert!(matches!(
        bounded(handle.accepted()).await,
        Err(DriverError::WorkerFailed | DriverError::Internal)
    ));
    assert!(matches!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Failure { .. }
    ));
    assert_eq!(driver.active_count(), 0);
    assert_eq!(terminal_status(&fixture.rows()), "failed");
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn done_panic_is_joined_and_cleaned_without_a_success_terminal_record() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    let reply = Started {
        turn_id: "provider-turn".into(),
        done: Box::pin(async { panic!("fixture done panic") }),
    };
    next(&mut worker.starts)
        .await
        .reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("lost panic reply"));
    bounded(handle.accepted()).await.unwrap();
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    assert!(matches!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Failure { .. }
    ));
    assert_eq!(terminal_status(&fixture.rows()), "failed");
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn shutdown_cancels_running_work_and_waits_for_close_before_acknowledging() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let (mut handle, _done, _) = running(&driver, &mut worker, "hello").await;
    let shutting_down = driver.clone();
    let shutdown =
        tokio::spawn(async move { shutting_down.shutdown(Duration::from_secs(5)).await });
    let close = next(&mut worker.closes).await;
    assert!(!shutdown.is_finished());
    assert!(matches!(
        driver.start(snapshot(), "new".into(), worker.worker.clone()),
        Err(DriverError::Closed)
    ));
    close.reply.send(Ok(())).unwrap();
    bounded(shutdown).await.unwrap().unwrap();
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert_eq!(driver.active_count(), 0);
}

struct GateCall {
    release: oneshot::Sender<()>,
}
struct GateSink {
    inner: Arc<dyn EventSink>,
    gate: Mutex<Option<mpsc::UnboundedSender<GateCall>>>,
}
impl EventSink for GateSink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let gate = self.gate.lock().unwrap().take();
        let inner = self.inner.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                let (release, release_rx) = oneshot::channel();
                gate.send(GateCall { release }).unwrap();
                release_rx
                    .await
                    .expect("durable write must be released, not cancelled");
            }
            inner.append(draft).await
        })
    }
}
#[tokio::test]
async fn cancelling_during_user_commit_waits_for_known_write_and_never_launches_worker() {
    let fixture = Fixture::new();
    let (gate_tx, mut gate_rx) = mpsc::unbounded_channel();
    let sink = Arc::new(GateSink {
        inner: fixture.sink.clone(),
        gate: Mutex::new(Some(gate_tx)),
    });
    let driver = fixture.with_sink(sink);
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start(snapshot(), "hello".into(), worker.worker.clone())
        .unwrap();
    let gate = next(&mut gate_rx).await;
    assert!(driver.cancel(handle.ticket()));
    assert!(worker.starts.try_recv().is_err());
    assert_eq!(driver.active_count(), 1);
    assert!(fixture.rows().is_empty());
    gate.release.send(()).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::Cancelled)
    );
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert!(worker.starts.try_recv().is_err());
    assert!(worker.closes.try_recv().is_err());
    assert_eq!(fixture.rows()[0]["kind"], "message.user");
    assert_eq!(terminal_status(&fixture.rows()), "interrupted");
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}
#[tokio::test]
async fn invalid_prompt_and_capacity_rejection_have_no_extra_durable_or_worker_effects() {
    let fixture = Fixture::new();
    let options = Options {
        limits: Limits {
            active: 1,
            finished: 1,
        },
        ..Options::default()
    };
    let driver =
        Arc::new(Driver::new(fixture.sink.clone(), Arc::new(str::to_owned), options).unwrap());
    let mut worker = WorkerControl::new();
    for text in [" ".to_owned(), "x".repeat(65537)] {
        assert!(matches!(
            driver.start(snapshot(), text, worker.worker.clone()),
            Err(DriverError::Invalid)
        ));
    }
    assert!(fixture.rows().is_empty());
    let mut first = driver
        .start(snapshot(), "first".into(), worker.worker.clone())
        .unwrap();
    let mut another = snapshot();
    another.key.name = "another".into();
    assert!(matches!(
        driver.start(another, "second".into(), worker.worker.clone()),
        Err(DriverError::Capacity)
    ));
    next(&mut worker.starts)
        .await
        .reply
        .send(StartReply::Failed(failure()))
        .unwrap_or_else(|_| panic!("lost fixture rejection"));
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(first.accepted()).await,
        Err(DriverError::WorkerFailed)
    );
    bounded(first.wait()).await.unwrap();
    assert_eq!(
        fixture
            .rows()
            .iter()
            .filter(|row| row["kind"] == "message.user")
            .count(),
        1
    );
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_sibling_journal_fault_cancels_running_work_and_blocks_all_new_starts() {
    let fixture = Fixture::new();
    let driver = fixture.with_sink(FaultSink::new(fixture.sink.clone(), 2, false));
    let mut first_worker = WorkerControl::new();
    let (mut first, _done, done_dropped) = running(&driver, &mut first_worker, "first").await;
    let first_ticket = first.ticket().clone();
    let mut second_worker = WorkerControl::new();
    let mut second_snapshot = snapshot();
    second_snapshot.key.name = "sibling".into();
    let mut second = driver
        .start(
            second_snapshot,
            "second".into(),
            second_worker.worker.clone(),
        )
        .unwrap();

    let close = next(&mut first_worker.closes).await;
    assert_eq!(close.ticket, first_ticket);
    receive(done_dropped).await;
    assert_eq!(
        bounded(second.accepted()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert_eq!(
        bounded(second.wait()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert!(second_worker.starts.try_recv().is_err());
    assert!(second_worker.closes.try_recv().is_err());
    assert!(driver.storage_failed());
    assert_eq!(
        driver.active_count(),
        1,
        "the running sibling remains owned until its close acknowledgement"
    );
    assert!(matches!(
        driver.start(snapshot(), "third".into(), first_worker.worker.clone()),
        Err(DriverError::StorageUnavailable)
    ));

    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(first.wait()).await,
        Err(DriverError::StorageUnavailable)
    );
    assert_eq!(driver.active_count(), 0);
    assert_eq!(fixture.store.lock().unwrap().last_id(), 1);
    assert_eq!(fixture.rows()[0]["data"]["text"], "first");
    assert!(
        fixture
            .store
            .lock()
            .unwrap()
            .read_session(&"sibling".encode_utf16().collect::<Vec<_>>())
            .unwrap()
            .is_empty()
    );
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}

#[tokio::test]
async fn retry_requested_during_pending_close_clears_quarantine_before_the_next_close() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let (mut handle, done, _) = running(&driver, &mut worker, "hello").await;
    let ticket = handle.ticket().clone();
    done.send(Outcome::Success).unwrap();
    let first_close = next(&mut worker.closes).await;

    // The retry arrives while cleanup is still pending, before the actor has
    // published quarantine. Its version must not be mistaken for an old retry.
    assert!(driver.cancel(&ticket));
    first_close.reply.send(Err(failure())).unwrap();
    let second_close = next(&mut worker.closes).await;
    {
        let wait = handle.wait();
        tokio::pin!(wait);
        // Observing the second close is the barrier: the actor has consumed the
        // pending retry, so callers must no longer see the first close's error.
        assert_pending(wait.as_mut());
        second_close.reply.send(Ok(())).unwrap();
        assert_eq!(bounded(wait).await.unwrap().turn.outcome, Outcome::Success);
    }
    assert_eq!(driver.active_count(), 0);
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
}

#[tokio::test]
async fn checked_dispatch_refreshes_revocation_and_hold_after_blocked_user_append() {
    use pult_core::consent_store::ConsentStore;
    for set_hold in [false, true] {
        let fixture = Fixture::new();
        let mut consent = ConsentStore::open(&fixture._home.path().join("consent-home")).unwrap();
        consent
            .grant(&[Provider::Codex], chrono::Utc::now())
            .unwrap();
        let consent = Arc::new(Mutex::new(consent));
        let hold = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        let (gate_tx, mut gate_rx) = mpsc::unbounded_channel();
        let driver = fixture.with_sink(Arc::new(GateSink {
            inner: fixture.sink.clone(),
            gate: Mutex::new(Some(gate_tx)),
        }));
        let mut worker = WorkerControl::new();
        let gate_consent = consent.clone();
        let gate_hold = hold.clone();
        let gate_calls = calls.clone();
        let mut initial = snapshot();
        initial.settings.approval = Approval::Full;
        let expected = initial.clone();
        let gate_store = fixture.store.clone();
        let mut handle = driver
            .start_checked(
                initial,
                "hello".into(),
                worker.worker.clone(),
                Arc::new(move |ticket: &Ticket, initial: &TurnSnapshot| {
                    gate_calls.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(initial, &expected);
                    assert_eq!(ticket.session(), &expected.key);
                    assert_eq!(gate_store.lock().unwrap().last_id(), 1);
                    if gate_hold.load(Ordering::SeqCst)
                        || !gate_consent
                            .lock()
                            .unwrap()
                            .read()
                            .unwrap()
                            .facts()
                            .covers(Provider::Codex)
                    {
                        DispatchDecision::Deny
                    } else {
                        DispatchDecision::Allow
                    }
                }),
            )
            .unwrap();
        let pending = next(&mut gate_rx).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        if set_hold {
            hold.store(true, Ordering::SeqCst);
        } else {
            consent.lock().unwrap().revoke(chrono::Utc::now()).unwrap();
        }
        pending.release.send(()).unwrap();
        assert_eq!(
            bounded(handle.accepted()).await,
            Err(DriverError::AccessDenied)
        );
        let terminal = bounded(handle.wait()).await.unwrap();
        assert!(
            matches!(terminal.turn.outcome, Outcome::Failure { ref code, .. } if code == "access_denied")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(worker.starts.try_recv().is_err());
        assert!(worker.closes.try_recv().is_err());
        assert_eq!(driver.active_count(), 0);
        assert_eq!(terminal_status(&fixture.rows()), "failed");
    }
}

#[tokio::test]
async fn checked_dispatch_applies_narrower_snapshot_once_and_allow_preserves_settings() {
    for decision in [
        DispatchDecision::Restrict(Approval::Ask),
        DispatchDecision::Allow,
    ] {
        let fixture = Fixture::new();
        let driver = fixture.driver();
        let mut worker = WorkerControl::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let gate_calls = calls.clone();
        let mut initial = snapshot();
        initial.settings.approval = Approval::Full;
        let mut handle = driver
            .start_checked(
                initial.clone(),
                "hello".into(),
                worker.worker.clone(),
                Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
                    gate_calls.fetch_add(1, Ordering::SeqCst);
                    decision
                }),
            )
            .unwrap();
        let call = next(&mut worker.starts).await;
        let mut expected = initial;
        if let DispatchDecision::Restrict(approval) = decision {
            expected.settings.approval = approval;
        }
        assert_eq!(call.snapshot, expected);
        let (reply, done, _) = started();
        call.reply
            .send(StartReply::Started(reply))
            .unwrap_or_else(|_| panic!("lost start reply"));
        bounded(handle.accepted()).await.unwrap();
        done.send(Outcome::Success).unwrap();
        next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
        assert_eq!(
            bounded(handle.wait()).await.unwrap().turn.outcome,
            Outcome::Success
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn checked_dispatch_denies_expansion_and_gate_panic_without_start_or_secret() {
    pult_core::panic_guard::install();
    for panic in [false, true] {
        let fixture = Fixture::new();
        let driver = fixture.driver();
        let mut worker = WorkerControl::new();
        let mut handle = driver
            .start_checked(
                snapshot(),
                "hello".into(),
                worker.worker.clone(),
                Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
                    if panic {
                        panic!("PRIVATE gate failure must not leak");
                    }
                    DispatchDecision::Restrict(Approval::Full)
                }),
            )
            .unwrap();
        assert_eq!(
            bounded(handle.accepted()).await,
            Err(DriverError::AccessDenied)
        );
        bounded(handle.wait()).await.unwrap();
        assert!(worker.starts.try_recv().is_err());
        assert!(worker.closes.try_recv().is_err());
        assert!(
            !serde_json::to_string(&fixture.rows())
                .unwrap()
                .contains("PRIVATE")
        );
        assert_eq!(fixture.rows()[1]["data"]["errorCode"], "access_denied");
        // A callback panic must not poison driver state or retain the slot.
        assert_eq!(driver.active_count(), 0);
    }
}

#[tokio::test]
async fn checked_dispatch_cancel_during_user_append_skips_gate_and_worker() {
    let fixture = Fixture::new();
    let (gate_tx, mut gate_rx) = mpsc::unbounded_channel();
    let driver = fixture.with_sink(Arc::new(GateSink {
        inner: fixture.sink.clone(),
        gate: Mutex::new(Some(gate_tx)),
    }));
    let mut worker = WorkerControl::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let gate_calls = calls.clone();
    let mut handle = driver
        .start_checked(
            snapshot(),
            "hello".into(),
            worker.worker.clone(),
            Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
                gate_calls.fetch_add(1, Ordering::SeqCst);
                DispatchDecision::Allow
            }),
        )
        .unwrap();
    let pending = next(&mut gate_rx).await;
    driver.cancel(handle.ticket());
    pending.release.send(()).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::Cancelled)
    );
    assert_eq!(
        bounded(handle.wait()).await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(worker.starts.try_recv().is_err());
    assert!(worker.closes.try_recv().is_err());
}

fn queued_input() -> Input {
    Input {
        text: "say SECRET".into(),
        metadata: InputMetadata {
            question_id: Some(42),
            queue_item_id: Some("queue-one".into()),
            queue_item_at: Some(String::new()),
            ..InputMetadata::default()
        },
    }
}
fn allow_gate() -> Arc<dyn pult_core::turn_driver::DispatchGate> {
    Arc::new(|_: &Ticket, _: &TurnSnapshot| DispatchDecision::Allow)
}
#[tokio::test]
async fn deferred_input_has_no_early_receipt_and_keeps_both_receipt_identities_exactly() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let gate_calls = calls.clone();
    let gate_store = fixture.store.clone();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            Arc::new(move |_: &Ticket, _: &TurnSnapshot| {
                gate_calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(gate_store.lock().unwrap().last_id(), 0);
                DispatchDecision::Allow
            }),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    assert!(fixture.rows().is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(call.text, "say SECRET");
    {
        let accepted = handle.accepted();
        tokio::pin!(accepted);
        assert_pending(accepted.as_mut());
        let (reply, done, _) = started();
        call.reply
            .send(StartReply::Started(reply))
            .unwrap_or_else(|_| panic!("lost start"));
        let accepted = bounded(accepted).await.unwrap();
        assert_eq!(accepted.user_event_id, 1);
        let rows = fixture.rows();
        assert_eq!(rows[0]["data"]["text"], "say [REDACTED]");
        assert_eq!(rows[0]["data"]["questionId"], 42);
        assert_eq!(rows[0]["data"]["queueItemId"], "queue-one");
        assert_eq!(rows[0]["data"]["queueItemAt"], "");
        done.send(Outcome::Success).unwrap();
    }
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    assert_eq!(bounded(handle.wait()).await.unwrap().user_event_id, Some(1));
}
#[tokio::test]
async fn immediate_deferred_failure_or_panic_does_not_receipt_and_retry_remains_possible() {
    pult_core::panic_guard::install();
    for panic in [false, true] {
        let fixture = Fixture::new();
        let driver = fixture.driver();
        let mut worker = WorkerControl::new();
        let mut handle = driver
            .start_input(
                snapshot(),
                queued_input(),
                worker.worker.clone(),
                allow_gate(),
            )
            .unwrap();
        let call = next(&mut worker.starts).await;
        let done: Task<Outcome> = if panic {
            Box::pin(async { panic!("SECRET completion panic") })
        } else {
            Box::pin(async {
                Outcome::Failure {
                    code: "rejected".into(),
                    message: "SECRET rejected".into(),
                }
            })
        };
        call.reply
            .send(StartReply::Started(Started {
                turn_id: "provider-turn".into(),
                done,
            }))
            .unwrap_or_else(|_| panic!("lost start"));
        let close = next(&mut worker.closes).await;
        assert!(fixture.rows().is_empty());
        close.reply.send(Ok(())).unwrap();
        assert_eq!(
            bounded(handle.accepted()).await,
            Err(DriverError::WorkerFailed)
        );
        let terminal = bounded(handle.wait()).await.unwrap();
        assert_eq!(terminal.user_event_id, None);
        assert!(matches!(terminal.turn.outcome, Outcome::Failure { .. }));
        let rows = fixture.rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["kind"], "status.changed");
        assert!(!rows[0].to_string().contains("SECRET"));
        let mut retry = driver
            .start_input(
                snapshot(),
                queued_input(),
                worker.worker.clone(),
                allow_gate(),
            )
            .unwrap();
        let call = next(&mut worker.starts).await;
        call.reply
            .send(StartReply::Started(Started {
                turn_id: "retry".into(),
                done: Box::pin(async { Outcome::Success }),
            }))
            .unwrap_or_else(|_| panic!("lost retry"));
        assert_eq!(bounded(retry.accepted()).await.unwrap().user_event_id, 2);
        next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
        bounded(retry.wait()).await.unwrap();
    }
}
#[tokio::test]
async fn pending_deferred_completion_accepts_then_later_failure_keeps_the_receipt() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    let (reply, done, _) = started();
    call.reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("lost start"));
    assert_eq!(bounded(handle.accepted()).await.unwrap().user_event_id, 1);
    done.send(Outcome::Failure {
        code: "later".into(),
        message: "SECRET later".into(),
    })
    .unwrap();
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    let terminal = bounded(handle.wait()).await.unwrap();
    assert_eq!(terminal.user_event_id, Some(1));
    assert_eq!(fixture.rows()[0]["kind"], "message.user");
    assert_eq!(terminal_status(&fixture.rows()), "failed");
    assert!(worker.starts.try_recv().is_err());
}
#[tokio::test]
async fn failed_deferred_append_latches_all_jobs_and_joins_completion_before_cleanup() {
    for after_commit in [false, true] {
        let fixture = Fixture::new();
        let driver = fixture.with_sink(FaultSink::new(fixture.sink.clone(), 2, after_commit));
        let mut sibling = WorkerControl::new();
        let mut queued = WorkerControl::new();
        let (mut first, _first_done, first_dropped) =
            running(&driver, &mut sibling, "ordinary").await;
        let mut second_snapshot = snapshot();
        second_snapshot.key.name = "queued".into();
        let mut second = driver
            .start_input(
                second_snapshot,
                queued_input(),
                queued.worker.clone(),
                allow_gate(),
            )
            .unwrap();
        let call = next(&mut queued.starts).await;
        let (reply, _done, dropped) = started();
        call.reply
            .send(StartReply::Started(reply))
            .unwrap_or_else(|_| panic!("lost start"));
        let queued_close = next(&mut queued.closes).await;
        receive(dropped).await;
        let sibling_close = next(&mut sibling.closes).await;
        receive(first_dropped).await;
        assert!(driver.storage_failed());
        assert_eq!(driver.active_count(), 2);
        queued_close.reply.send(Ok(())).unwrap();
        sibling_close.reply.send(Ok(())).unwrap();
        assert_eq!(
            bounded(second.accepted()).await,
            Err(DriverError::StorageUnavailable)
        );
        assert_eq!(
            bounded(second.wait()).await,
            Err(DriverError::StorageUnavailable)
        );
        assert_eq!(
            bounded(first.wait()).await,
            Err(DriverError::StorageUnavailable)
        );
        assert_eq!(driver.active_count(), 0);
        assert!(matches!(
            driver.start_input(
                snapshot(),
                queued_input(),
                queued.worker.clone(),
                allow_gate()
            ),
            Err(DriverError::StorageUnavailable)
        ));
    }
}
#[tokio::test]
async fn cancel_blocked_deferred_start_never_receipts() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    assert!(driver.cancel(handle.ticket()));
    receive(call.dropped).await;
    let close = next(&mut worker.closes).await;
    assert!(fixture.rows().is_empty());
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::Cancelled)
    );
    assert_eq!(bounded(handle.wait()).await.unwrap().user_event_id, None);
    assert_eq!(fixture.rows()[0]["kind"], "status.changed");
}
#[tokio::test]
async fn cancel_during_deferred_append_keeps_the_owned_write_but_never_accepts() {
    let fixture = Fixture::new();
    let (gate_tx, mut gate_rx) = mpsc::unbounded_channel();
    let driver = fixture.with_sink(Arc::new(GateSink {
        inner: fixture.sink.clone(),
        gate: Mutex::new(Some(gate_tx)),
    }));
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    let (reply, _done, dropped) = started();
    call.reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("lost start"));
    let pending = next(&mut gate_rx).await;
    assert!(fixture.rows().is_empty());
    assert!(driver.cancel(handle.ticket()));
    assert!(worker.closes.try_recv().is_err());
    pending.release.send(()).unwrap();
    let close = next(&mut worker.closes).await;
    receive(dropped).await;
    assert_eq!(fixture.rows()[0]["kind"], "message.user");
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::Cancelled)
    );
    let terminal = bounded(handle.wait()).await.unwrap();
    assert_eq!(terminal.user_event_id, Some(1));
    assert_eq!(terminal.turn.outcome, Outcome::Interrupted);
}
#[tokio::test]
async fn cancel_in_initial_completion_poll_skips_deferred_receipt_and_joins_before_close() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    let ticket = call.ticket.clone();
    let cancelling = driver.clone();
    let (drop_tx, dropped) = oneshot::channel();
    let notice = DropNotice(Some(drop_tx));
    call.reply
        .send(StartReply::Started(Started {
            turn_id: "provider-turn".into(),
            done: Box::pin(async move {
                let _notice = notice;
                std::future::poll_fn(move |_| {
                    cancelling.cancel(&ticket);
                    std::task::Poll::<Outcome>::Pending
                })
                .await
            }),
        }))
        .unwrap_or_else(|_| panic!("lost start"));
    let close = next(&mut worker.closes).await;
    receive(dropped).await;
    assert!(fixture.rows().is_empty());
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::Cancelled)
    );
    assert_eq!(bounded(handle.wait()).await.unwrap().user_event_id, None);
}
#[tokio::test]
async fn dropped_deferred_client_does_not_cancel_owned_start_append_or_terminal() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    drop(handle);
    let call = next(&mut worker.starts).await;
    call.reply
        .send(StartReply::Started(Started {
            turn_id: "provider-turn".into(),
            done: Box::pin(async { Outcome::Success }),
        }))
        .unwrap_or_else(|_| panic!("lost start"));
    let close = next(&mut worker.closes).await;
    assert_eq!(fixture.rows()[0]["kind"], "message.user");
    close.reply.send(Ok(())).unwrap();
    bounded(driver.shutdown(Duration::from_secs(5)))
        .await
        .unwrap();
    let rows = fixture.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["data"]["questionId"], 42);
    assert_eq!(terminal_status(&rows), "done");
}
#[tokio::test]
async fn attachments_only_input_persists_exact_validated_metadata_without_native_bytes() {
    use pult_core::prompt_attachments::validate_owned_prompt_attachments;
    let fixture = Fixture::new();
    let path = fixture._home.path().join("attachments/chat/day/image.png");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).unwrap();
    let raw = serde_json::json!([{"path":path,"name":"image.png","bytes":8,"mime":"image/png","kind":"file"}]);
    let attachments =
        validate_owned_prompt_attachments(fixture._home.path(), "chat", Some(&raw)).unwrap();
    let exact = attachments[0].value();
    let input = Input {
        text: String::new(),
        metadata: InputMetadata {
            attachments: attachments.clone(),
            ..InputMetadata::default()
        },
    };
    assert!(!format!("{input:?}").contains("image.png"));
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(snapshot(), input, worker.worker.clone(), allow_gate())
        .unwrap();
    let call = next(&mut worker.starts).await;
    assert!(call.text.is_empty());
    assert_eq!(fixture.rows()[0]["data"]["attachments"][0], exact);
    assert_eq!(fixture.rows()[0]["data"]["text"], "");
    assert!(!fixture.rows()[0].to_string().contains("iVBORw0KGgo="));
    let (reply, done, _) = started();
    call.reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("lost start"));
    bounded(handle.accepted()).await.unwrap();
    done.send(Outcome::Success).unwrap();
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    bounded(handle.wait()).await.unwrap();
}
#[tokio::test]
async fn invalid_metadata_and_oversized_serialized_draft_never_reserve_or_start_worker() {
    use pult_core::prompt_attachments::{AttachmentKind, PromptAttachment};
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut invalid = vec![];
    for id in [0, 9_007_199_254_740_992] {
        invalid.push(Input {
            text: "hello".into(),
            metadata: InputMetadata {
                question_id: Some(id),
                ..InputMetadata::default()
            },
        });
    }
    for (id, at) in [
        (Some("id".into()), None),
        (None, Some("at".into())),
        (Some(String::new()), Some(String::new())),
        (Some("x".repeat(1025)), Some(String::new())),
        (Some("id".into()), Some("x".repeat(1025))),
    ] {
        invalid.push(Input {
            text: "hello".into(),
            metadata: InputMetadata {
                queue_item_id: id,
                queue_item_at: at,
                ..InputMetadata::default()
            },
        });
    }
    let big = PromptAttachment {
        path: format!("/{}", "\u{0800}".repeat(16_383)),
        name: "\u{0800}".repeat(512),
        bytes: 1,
        mime: "\u{0800}".repeat(128),
        kind: AttachmentKind::File,
    };
    invalid.push(Input {
        text: "x".repeat(65536),
        metadata: InputMetadata {
            attachments: vec![big; 20],
            ..InputMetadata::default()
        },
    });
    invalid.push(Input {
        text: String::new(),
        metadata: InputMetadata::default(),
    });
    for input in invalid {
        assert!(matches!(
            driver.start_input(snapshot(), input, worker.worker.clone(), allow_gate()),
            Err(DriverError::Invalid)
        ));
    }
    assert_eq!(driver.active_count(), 0);
    assert!(worker.starts.try_recv().is_err());
    assert!(fixture.rows().is_empty());
}

#[tokio::test]
async fn question_only_and_queue_only_each_defer_their_receipt_until_started() {
    for question in [false, true] {
        let fixture = Fixture::new();
        let driver = fixture.driver();
        let mut worker = WorkerControl::new();
        let mut input = queued_input();
        if question {
            input.metadata.queue_item_id = None;
            input.metadata.queue_item_at = None;
        } else {
            input.metadata.question_id = None;
            input.metadata.queue_item_at = Some("legacy opaque identity".into());
        }
        let mut handle = driver
            .start_input(snapshot(), input, worker.worker.clone(), allow_gate())
            .unwrap();
        let call = next(&mut worker.starts).await;
        assert!(fixture.rows().is_empty());
        call.reply
            .send(StartReply::Started(Started {
                turn_id: "provider-turn".into(),
                done: Box::pin(async { Outcome::Success }),
            }))
            .unwrap_or_else(|_| panic!("lost start"));
        bounded(handle.accepted()).await.unwrap();
        let rows = fixture.rows();
        assert_eq!(rows[0]["data"].get("questionId").is_some(), question);
        assert_eq!(rows[0]["data"].get("queueItemId").is_some(), !question);
        if !question {
            assert_eq!(rows[0]["data"]["queueItemAt"], "legacy opaque identity");
        }
        next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
        bounded(handle.wait()).await.unwrap();
    }
}
#[tokio::test]
async fn unknown_native_send_failure_never_receipts_or_automatically_retries() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    call.reply
        .send(StartReply::Failed(WorkerError {
            code: "delivery_unknown".into(),
            message: "SECRET native send result unknown".into(),
        }))
        .unwrap_or_else(|_| panic!("lost start"));
    let close = next(&mut worker.closes).await;
    assert!(fixture.rows().is_empty());
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::WorkerFailed)
    );
    let terminal = bounded(handle.wait()).await.unwrap();
    assert_eq!(terminal.user_event_id, None);
    assert!(
        matches!(terminal.turn.outcome,Outcome::Failure{ref code,..} if code=="delivery_unknown")
    );
    assert_eq!(fixture.rows().len(), 1);
    assert_eq!(fixture.rows()[0]["kind"], "status.changed");
    assert!(worker.starts.try_recv().is_err());
    assert!(!fixture.rows()[0].to_string().contains("SECRET"));
}

#[tokio::test]
async fn immediately_interrupted_deferred_turn_keeps_the_fact_without_a_user_receipt() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let mut handle = driver
        .start_input(
            snapshot(),
            queued_input(),
            worker.worker.clone(),
            allow_gate(),
        )
        .unwrap();
    let call = next(&mut worker.starts).await;
    call.reply
        .send(StartReply::Started(Started {
            turn_id: "interrupted-turn".into(),
            done: Box::pin(async { Outcome::Interrupted }),
        }))
        .unwrap_or_else(|_| panic!("lost start"));
    let close = next(&mut worker.closes).await;
    assert!(fixture.rows().is_empty());
    close.reply.send(Ok(())).unwrap();
    assert_eq!(
        bounded(handle.accepted()).await,
        Err(DriverError::WorkerFailed)
    );
    let terminal = bounded(handle.wait()).await.unwrap();
    assert_eq!(terminal.user_event_id, None);
    assert_eq!(terminal.turn.outcome, Outcome::Interrupted);
    let rows = fixture.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["kind"], "status.changed");
    assert_eq!(terminal_status(&rows), "interrupted");
}

#[tokio::test]
async fn javascript_trim_rejects_bom_only_text_before_any_worker_or_receipt() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let input = Input {
        text: "\u{feff}".into(),
        metadata: InputMetadata::default(),
    };
    assert!(matches!(
        driver.start_input(snapshot(), input, worker.worker.clone(), allow_gate()),
        Err(DriverError::Invalid)
    ));
    assert!(worker.starts.try_recv().is_err());
    assert!(fixture.rows().is_empty());
    assert_eq!(driver.active_count(), 0);
}
#[tokio::test]
async fn javascript_trim_preserves_next_line_character_as_nonempty_text() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    let input = Input {
        text: "\u{85}".into(),
        metadata: InputMetadata::default(),
    };
    let mut handle = driver
        .start_input(snapshot(), input, worker.worker.clone(), allow_gate())
        .unwrap();
    let call = next(&mut worker.starts).await;
    assert_eq!(call.text, "\u{85}");
    assert_eq!(fixture.rows()[0]["data"]["text"], "\u{85}");
    let (reply, done, _) = started();
    call.reply
        .send(StartReply::Started(reply))
        .unwrap_or_else(|_| panic!("lost start"));
    bounded(handle.accepted()).await.unwrap();
    done.send(Outcome::Success).unwrap();
    next(&mut worker.closes).await.reply.send(Ok(())).unwrap();
    bounded(handle.wait()).await.unwrap();
}

#[tokio::test]
async fn synchronous_stop_barrier_prevents_dispatch_before_async_cleanup_is_polled() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let mut worker = WorkerControl::new();
    driver.begin_shutdown();
    assert!(matches!(
        driver.start(snapshot(), "fixture".into(), worker.worker.clone()),
        Err(DriverError::Closed)
    ));
    assert_eq!(fixture.store.lock().unwrap().last_id(), 0);
    assert!(worker.starts.try_recv().is_err());
    assert!(!driver.storage_failed());
    bounded(driver.shutdown(Duration::from_secs(1)))
        .await
        .unwrap();
}

#[tokio::test]
async fn storage_fault_wakes_the_daemon_observer_without_a_job_completion() {
    let fixture = Fixture::new();
    let driver = fixture.driver();
    let waiting = driver.wait_for_storage_failure();
    tokio::pin!(waiting);
    assert_pending(waiting.as_mut());
    driver.report_storage_failure();
    bounded(waiting).await;
}
