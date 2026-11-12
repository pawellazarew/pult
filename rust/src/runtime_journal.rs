//! Execution events share the daemon's authoritative journal and commit cursor.
//! The sink keeps only a weak host reference; an owned append keeps the host
//! alive until its blocking commit and publication finish, even if RPC is gone.
use crate::State;
use crate::turn_driver::{Driver, EventSink, Receipt, SinkError, Task};
use serde_json::Value;
use std::sync::{Arc, Weak, atomic::Ordering};

struct HostSink(Weak<State>);

impl State {
    pub(crate) fn execution_sink(self: &Arc<Self>) -> Arc<dyn EventSink> {
        Arc::new(HostSink(Arc::downgrade(self)))
    }
    pub(crate) fn publish_commit(&self, last: u64, degraded: bool) {
        // An older writer can finish publishing after a newer writer has
        // released the journal mutex. Neither public cursor may go backwards.
        self.last_event_id.fetch_max(last, Ordering::AcqRel);
        self.committed.send_if_modified(|current| {
            if last > *current {
                *current = last;
                true
            } else {
                false
            }
        });
        if degraded && !self.projection_degraded.swap(true, Ordering::AcqRel) {
            eprintln!("journal is committed but a session projection needs repair");
        }
    }

    pub(crate) fn execution_storage_failed(&self) {
        // Shared with memory's bounded precommit seal; no IO/callback is held
        // inside this gate. Direct Driver faults serialize on Driver itself.
        let _admission = self
            .execution_admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.execution_storage_failed.store(true, Ordering::Release);
        if let Some(driver) = self.driver.get() {
            driver.report_storage_failure();
        }
    }
}

pub(crate) fn initialize(state: &Arc<State>) -> anyhow::Result<()> {
    let driver = Driver::new(
        state.execution_sink(),
        Arc::new(crate::redaction::redact_string),
        crate::turn_driver::Options::default(),
    )?;
    state
        .driver
        .set(Arc::new(driver))
        .map_err(|_| anyhow::anyhow!("execution driver already initialized"))?;
    if state.execution_storage_failed.load(Ordering::Acquire) {
        state
            .driver
            .get()
            .expect("driver initialized")
            .report_storage_failure();
    }
    Ok(())
}

pub(crate) async fn shutdown(state: &Arc<State>, owner: crate::Ownership) {
    crate::runtime_state::await_initialization(state).await;
    if let Some(runtime) = state.native_runtime.get() {
        while runtime.shutdown().await.is_err() {
            eprintln!("native runtime cleanup is unconfirmed; daemon ownership retained");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    retain_owner_until_stopped(
        state.driver.get().expect("driver initialized"),
        &state.host_jobs,
        owner,
        std::time::Duration::from_secs(10),
    )
    .await;
}

async fn retain_owner_until_stopped(
    driver: &Driver,
    host_jobs: &crate::host_jobs::Tracker,
    owner: crate::Ownership,
    checkpoint: std::time::Duration,
) {
    let mut reported = false;
    while driver.shutdown(checkpoint).await.is_err() {
        if !reported {
            eprintln!("execution cleanup is unconfirmed; daemon ownership retained");
            reported = true;
        }
        // shutdown closes admission and requests another cleanup attempt. The
        // ownership guard remains on this stack until every job proves closure.
    }
    host_jobs.wait().await;
    drop(owner);
}

fn unavailable() -> SinkError {
    SinkError {
        message: "execution journal unavailable".into(),
    }
}

impl EventSink for HostSink {
    fn before_release(
        &self,
        completion: crate::turn_driver::Completion,
    ) -> Task<Result<(), SinkError>> {
        let weak = self.0.clone();
        Box::pin(async move {
            let state = weak.upgrade().ok_or_else(unavailable)?;
            crate::session_queue::before_release(state, completion).await
        })
    }
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let weak = self.0.clone();
        Box::pin(async move {
            let state = weak.upgrade().ok_or_else(unavailable)?;
            let failed = Arc::downgrade(&state);
            // Keep commit publication inside the owned blocking job. Dropping
            // this future must not lose a successfully committed event notice.
            let host_job = state.host_jobs.track();
            let result = tokio::task::spawn_blocking(move || {
                let _host_job = host_job;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    // Cover even a credential forged into typed metadata,
                    // without generic redaction of legitimate opaque IDs.
                    let draft = crate::redaction::redact_memory_capabilities(&draft);
                    let mut store = state.store.lock().map_err(|_| unavailable())?;
                    let event = store.append(draft).map_err(|_| unavailable())?;
                    let receipt = Receipt {
                        id: event["id"].as_u64().ok_or_else(unavailable)?,
                        ts: event["ts"].as_str().ok_or_else(unavailable)?.to_owned(),
                    };
                    let projected = crate::runtime_state::project(&state, &event);
                    let last = store.last_id();
                    let degraded = store.projection_error().is_some();
                    drop(store);
                    state.publish_commit(last, degraded);
                    projected.map_err(|_| unavailable())?;
                    Ok(receipt)
                }))
                .unwrap_or_else(|_| Err(unavailable()));
                if result.is_err() {
                    // Never call the driver while holding the journal mutex.
                    state.execution_storage_failed();
                }
                result
            })
            .await;
            match result {
                Ok(result) => result,
                Err(_) => {
                    if let Some(state) = failed.upgrade() {
                        state.execution_storage_failed();
                    }
                    Err(unavailable())
                }
            }
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
    use std::sync::{Mutex, OnceLock};
    use std::task::{Context, Waker};
    use std::time::{Duration, Instant};
    use tokio::sync::watch;

    pub(crate) fn fixture() -> (tempfile::TempDir, Arc<State>, Arc<dyn EventSink>) {
        let home = tempfile::tempdir().unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut store = crate::journal::EventStore::open(&home.path().join("events")).unwrap();
        let registry = crate::registry::Registry::open(home.path(), &mut store).unwrap();
        let (stop, _) = watch::channel(false);
        let (committed, _) = watch::channel(store.last_id());
        let state = Arc::new(State {
            home: home.path().into(),
            started_at: "fixture".into(),
            started: Instant::now(),
            token: "fixture".into(),
            clients: AtomicUsize::new(0),
            stop,
            store: Mutex::new(store),
            history: Mutex::new(Default::default()),
            registry: Arc::new(Mutex::new(registry)),
            memory: Mutex::new(Err("fixture disabled".into())),
            session_memory: Mutex::new(Default::default()),
            last_event_id: AtomicU64::new(0),
            test_mode: true,
            projection_degraded: AtomicBool::new(false),
            subscriptions: AtomicUsize::new(0),
            committed,
            live_id: AtomicU64::new(1),
            connection_id: AtomicU64::new(1),
            driver: OnceLock::new(),
            execution_storage_failed: AtomicBool::new(false),
            execution_admission: Mutex::new(()),
            host_jobs: Arc::default(),
            session_commands: Arc::default(),
            native_runtime: OnceLock::new(),
            memory_turns: OnceLock::new(),
            runtime_init: Mutex::new(()),
            consent: Mutex::new(None),
            live_sessions: Mutex::new(crate::session_live::Cache::new(65536).unwrap()),
        });
        initialize(&state).unwrap();
        let sink: Arc<dyn EventSink> = Arc::new(HostSink(Arc::downgrade(&state)));
        (home, state, sink)
    }
    fn draft() -> Value {
        json!({"sessionId":"chat","provider":"codex","kind":"message.user","data":{"text":"fixture"}})
    }
    #[tokio::test]
    async fn execution_events_update_the_same_daemon_cursor_and_subscription() {
        let (_home, state, sink) = fixture();
        let mut cursor = state.committed.subscribe();
        let receipt = sink.append(draft()).await.unwrap();
        assert_eq!(receipt.id, 1);
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 1);
        assert_eq!(*cursor.borrow_and_update(), 1);
        state.publish_commit(0, true);
        assert_eq!(*cursor.borrow(), 1);
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 1);
        assert!(state.projection_degraded.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn disconnected_caller_cannot_lose_commit_publication() {
        let (_home, state, sink) = fixture();
        let mut cursor = state.committed.subscribe();
        {
            let guard = state.store.lock().unwrap();
            let mut append = sink.append(draft());
            let mut context = Context::from_waker(Waker::noop());
            assert!(append.as_mut().poll(&mut context).is_pending());
            drop(append);
            drop(guard);
        }
        tokio::time::timeout(Duration::from_secs(5), cursor.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(*cursor.borrow(), 1);
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 1);
    }
    #[tokio::test]
    async fn driver_and_sink_do_not_keep_the_host_alive() {
        let (_home, state, sink) = fixture();
        let driver = state.driver.get().unwrap().clone();
        let weak = Arc::downgrade(&state);
        drop(state);
        assert!(weak.upgrade().is_none());
        assert_eq!(
            sink.append(draft()).await.unwrap_err().message,
            "execution journal unavailable"
        );
        drop(driver);
    }
    #[tokio::test]
    async fn journal_failure_latches_global_execution_admission() {
        let (_home, state, sink) = fixture();
        assert!(sink.append(json!({"sessionId":"chat"})).await.is_err());
        assert!(state.execution_storage_failed.load(Ordering::Acquire));
        assert!(state.driver.get().unwrap().storage_failed());
        assert_eq!(state.store.lock().unwrap().last_id(), 0);
        // A later successful append cannot clear the global execution latch.
        sink.append(draft()).await.unwrap();
        assert!(state.execution_storage_failed.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn dropped_journal_caller_keeps_owner_until_blocked_io_commits() {
        let (_home, state, _sink) = fixture();
        let owner = crate::Ownership::acquire(&state.home, "fixture").unwrap();
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let blocked = state.clone();
        let holder = std::thread::spawn(move || {
            let _store = blocked.store.lock().unwrap();
            entered.send(()).unwrap();
            let _ = release_rx.recv();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut request = Box::pin(crate::journal_request(
            state.clone(),
            "events.emit".into(),
            json!({"kind":"message.user"}),
        ));
        let mut context = Context::from_waker(Waker::noop());
        assert!(request.as_mut().poll(&mut context).is_pending());
        drop(request);
        assert_eq!(state.host_jobs.active(), 1);
        crate::runtime_state::begin_shutdown(&state);
        let mut stopping = Box::pin(shutdown(&state, owner));
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                biased;
                _ = &mut stopping => true,
                _ = state.host_jobs.draining.notified() => false,
            }
        })
        .await;
        let retained = crate::Ownership::acquire(&state.home, "replacement").is_err();
        release.send(()).unwrap();
        holder.join().unwrap();
        let stopped_early = observed.expect("shutdown neither completed nor entered host drain");
        if !stopped_early {
            tokio::time::timeout(Duration::from_secs(5), stopping)
                .await
                .unwrap();
        }
        assert!(
            !stopped_early,
            "ownership released before detached IO finished"
        );
        assert!(retained, "replacement daemon acquired ownership during IO");
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 1);
        assert_eq!(state.host_jobs.active(), 0);
        let replacement = crate::Ownership::acquire(&state.home, "replacement")
            .unwrap_or_else(|error| panic!("replacement acquisition after IO shutdown: {error:#}"));
        drop(replacement);
    }

    #[tokio::test]
    async fn stop_barrier_seals_initialization_before_response_or_cleanup_is_polled() {
        let (_home, state, _sink) = fixture();
        crate::runtime_state::begin_shutdown(&state);
        assert!(
            *state.stop.borrow(),
            "stop admission was not sealed synchronously"
        );
        let error = crate::runtime_state::instance(&state).await.err().unwrap();
        assert_eq!(error.to_string(), "native execution is unavailable");
        assert!(state.native_runtime.get().is_none());
        assert!(state.consent.lock().unwrap().is_none());
        assert!(!state.home.join("consent.json").exists());
    }
    #[tokio::test]
    async fn shutdown_retains_ownership_until_runtime_initialization_quiesces() {
        let (_home, state, _sink) = fixture();
        let owner = crate::Ownership::acquire(&state.home, "fixture").unwrap();
        state.stop.send_replace(true);
        let (entered, started) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let initializing = state.clone();
        let initializer = std::thread::spawn(move || {
            let _initialization = initializing.runtime_init.lock().unwrap();
            entered.send(()).unwrap();
            let _ = released.recv();
        });
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut stopping = Box::pin(shutdown(&state, owner));
        let mut context = Context::from_waker(Waker::noop());
        assert!(
            stopping.as_mut().poll(&mut context).is_pending(),
            "ownership released during initialization"
        );
        assert!(crate::Ownership::acquire(&state.home, "fixture").is_err());
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), stopping)
            .await
            .unwrap();
        initializer.join().unwrap();
        assert!(crate::Ownership::acquire(&state.home, "fixture").is_ok());
    }
    #[tokio::test]
    async fn shutdown_retains_daemon_ownership_through_unconfirmed_cleanup() {
        use crate::turn_coordinator::Ticket;
        use crate::turn_driver::{Started, Worker, WorkerError};
        use crate::turn_snapshot::{Provider, SessionKey, TurnSettings, TurnSnapshot};
        struct Quarantine {
            allow: Arc<AtomicBool>,
            attempts: tokio::sync::mpsc::UnboundedSender<()>,
        }
        impl Worker for Quarantine {
            fn start(
                &self,
                _: Ticket,
                _: TurnSnapshot,
                _: String,
            ) -> Task<Result<Started, WorkerError>> {
                Box::pin(async {
                    Ok(Started {
                        turn_id: "fixture-turn".into(),
                        done: Box::pin(std::future::pending()),
                    })
                })
            }
            fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
                let allow = self.allow.clone();
                let attempts = self.attempts.clone();
                Box::pin(async move {
                    let _ = attempts.send(());
                    if allow.load(Ordering::Acquire) {
                        Ok(())
                    } else {
                        Err(WorkerError {
                            code: "cleanup_unconfirmed".into(),
                            message: "fixture".into(),
                        })
                    }
                })
            }
        }
        let (_home, state, _sink) = fixture();
        let driver = state.driver.get().unwrap().clone();
        let allow = Arc::new(AtomicBool::new(false));
        let (attempts, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let mut handle = driver
            .start(
                TurnSnapshot {
                    key: SessionKey {
                        name: "chat".into(),
                        created_at: "fixture-created".into(),
                    },
                    provider: Provider::Codex,
                    cwd: state.home.clone(),
                    settings: TurnSettings::default(),
                },
                "fixture".into(),
                Arc::new(Quarantine {
                    allow: allow.clone(),
                    attempts,
                }),
            )
            .unwrap();
        handle.accepted().await.unwrap();
        let owner = crate::Ownership::acquire(&state.home, "fixture").unwrap();
        let host_jobs = state.host_jobs.clone();
        let stopping = tokio::spawn(async move {
            retain_owner_until_stopped(&driver, &host_jobs, owner, Duration::from_millis(10)).await;
        });
        // A second attempt proves a shutdown checkpoint expired and cleanup
        // was retried, rather than assuming it from an arbitrary sleep.
        for _ in 0..2 {
            tokio::time::timeout(Duration::from_secs(5), observed.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(!stopping.is_finished());
        assert!(crate::Ownership::acquire(&state.home, "replacement").is_err());
        allow.store(true, Ordering::Release);
        tokio::time::timeout(Duration::from_secs(5), stopping)
            .await
            .unwrap()
            .unwrap();
        let replacement = crate::Ownership::acquire(&state.home, "replacement").unwrap();
        drop(replacement);
    }
    #[tokio::test]
    async fn poisoned_journal_emit_latches_execution_before_any_append() {
        let (_home, state, _sink) = fixture();
        let poisoned = state.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = poisoned.store.lock().unwrap();
            panic!("fixture poison");
        }));
        assert!(
            crate::journal_request(
                state.clone(),
                "events.emit".into(),
                json!({"kind":"message.user"})
            )
            .await
            .is_err()
        );
        assert!(state.execution_storage_failed.load(Ordering::Acquire));
        assert!(state.driver.get().unwrap().storage_failed());
    }
    #[tokio::test]
    async fn foundation_emit_and_execution_append_share_one_cursor() {
        let (_home, state, sink) = fixture();
        let result = crate::journal_request(
            state.clone(),
            "events.emit".into(),
            json!({"kind":"message.user","count":2}),
        )
        .await
        .unwrap();
        let result: Value = serde_json::from_str(result.get()).unwrap();
        assert_eq!(result["ids"], json!([1, 2]));
        let receipt = sink.append(draft()).await.unwrap();
        assert_eq!(receipt.id, 3);
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 3);
        assert_eq!(*state.committed.borrow(), 3);
    }
    #[tokio::test]
    async fn cancelling_serve_caller_still_completes_owned_daemon_shutdown() {
        let home = tempfile::tempdir().unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = home.path().to_owned();
        let first_home = path.clone();
        let first = tokio::spawn(async move { crate::serve(first_home).await });
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if crate::request(&path, "daemon.status").await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(10), async {
            while path.join("run/pultd.lock").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        // Reopen the real registry/journal and acquire the same daemon lease,
        // proving the detached supervisor released all of its owned resources.
        let second_home = path.clone();
        let second = tokio::spawn(async move { crate::serve(second_home).await });
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if crate::request(&path, "daemon.status").await.is_ok() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        crate::request(&path, "daemon.stop").await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
