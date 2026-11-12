//! Scope/latch unit proofs with real Driver/Owner storage, no OS spawn claimed.
use super::*;
use crate::{
    journal::EventStore,
    registry::Record,
    turn_driver::{Options, Started, Worker},
    turn_journal::JournalSink,
};
use std::os::unix::fs::PermissionsExt;
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
struct Holding {
    entered: Mutex<Option<oneshot::Sender<()>>>,
    unknown: bool,
    recovery: Option<Arc<AtomicBool>>,
}
impl Worker for Holding {
    fn start(&self, _: Ticket, _: TurnSnapshot, _: String) -> Task<Result<Started, WorkerError>> {
        if let Some(send) = self.entered.lock().unwrap().take() {
            let _ = send.send(());
        }
        Box::pin(std::future::pending())
    }
    fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
        let unknown = self.unknown
            && !self
                .recovery
                .as_ref()
                .is_some_and(|ready| ready.load(Ordering::Acquire));
        Box::pin(async move {
            if unknown {
                Err(WorkerError {
                    code: "cleanup_unconfirmed".into(),
                    message: "synthetic unknown cleanup".into(),
                })
            } else {
                Ok(())
            }
        })
    }
}
struct Unit {
    _temp: tempfile::TempDir,
    runtime: ZcodeRuntime,
    owner: Arc<ZcodeOwner>,
    key: SessionKey,
}
impl Unit {
    fn new() -> Self {
        crate::panic_guard::install();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let key = SessionKey {
            name: "unit".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let mut record = Record::default();
        for (k, v) in [
            ("name", "unit"),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
        ] {
            record.set_string(k, v);
        }
        registry.insert(record).unwrap();
        let registry = Arc::new(Mutex::new(registry));
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        let sink = Arc::new(JournalSink::new(Arc::new(Mutex::new(journal))).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Options {
                    close_timeout: Duration::from_millis(200),
                    ..Default::default()
                },
            )
            .unwrap(),
        );
        let owner = ZcodeOwner::new(
            home.clone(),
            registry.clone(),
            Arc::downgrade(&driver),
            consent.clone(),
            Arc::new(|_, _| true),
            Arc::new(|| {}),
        )
        .unwrap();
        let runtime = ZcodeRuntime::new(
            Dependencies {
                home: home.clone(),
                registry,
                consent,
                driver,
                sink,
            },
            TrustedCommand {
                holder: home.join("unused-holder"),
                program: home.join("unused-program"),
                prefix_args: vec![],
            },
            RuntimeConfig::default(),
            Environment::from([
                ("HOME".into(), home.into_os_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
            Environment::new(),
            Arc::new(NetworkGuard::new(Arc::new(Probe))),
            Limits::default(),
        )
        .unwrap();
        Self {
            _temp: temp,
            runtime,
            owner,
            key,
        }
    }
    async fn holding(&self, unknown: bool) -> Handle {
        let (send, recv) = oneshot::channel();
        let h = self
            .runtime
            .inner
            .deps
            .driver
            .start(
                self.owner.snapshot(&self.key).unwrap(),
                "unit".into(),
                Arc::new(Holding {
                    entered: Mutex::new(Some(send)),
                    unknown,
                    recovery: None,
                }),
            )
            .unwrap();
        recv.await.unwrap();
        h
    }
    fn install(&self, h: &Handle, source: Arc<Source>, attempt: Option<Attempt>) {
        let (cancel, _) = watch::channel(false);
        self.runtime.inner.shared.state.lock().unwrap().insert(
            self.key.clone(),
            Entry {
                source: Some(source.clone()),
                attempt,
                nonce: source.nonce.clone(),
                cancel,
                ticket: Some(h.ticket().clone()),
                route: None,
                quarantined: false,
                progress: Some(h.subscribe_progress()),
            },
        );
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_auth_source_cannot_block_replacement_or_relatched_after_reset() {
    let f = Unit::new();
    let mut h = f.holding(false).await;
    let attempt = f
        .owner
        .reserve(
            h.ticket().clone(),
            f.owner.snapshot(&f.key).unwrap(),
            17,
            "unit-public".into(),
            std::time::Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
    assert!(f.owner.seal_spawn(&attempt));
    let source = Arc::new(Source {
        key: f.key.clone(),
        nonce: Arc::new(()),
        attempt: OnceLock::new(),
    });
    assert!(source.attempt.set(attempt.clone()).is_ok());
    f.install(&h, source.clone(), Some(attempt));
    observe_signal(
        &f.runtime.inner.shared,
        &source,
        ProviderSignal::Authentication,
    );
    assert!(f.runtime.blocked());
    assert_eq!(f.runtime.reset_auth().unwrap_err(), RuntimeError::Busy);
    assert!(!f.runtime.inner.deps.driver.storage_failed());
    f.runtime.inner.deps.driver.cancel(h.ticket());
    h.wait().await.unwrap();
    assert!(f.runtime.reset_auth().unwrap());
    // A replacement reservation already exists; no old source/identity is adopted.
    let new_source = Arc::new(Source {
        key: f.key.clone(),
        nonce: Arc::new(()),
        attempt: OnceLock::new(),
    });
    let (cancel, _) = watch::channel(false);
    f.runtime.inner.shared.state.lock().unwrap().insert(
        f.key.clone(),
        Entry {
            source: Some(new_source.clone()),
            attempt: None,
            nonce: new_source.nonce.clone(),
            cancel,
            ticket: None,
            route: None,
            quarantined: false,
            progress: None,
        },
    );
    observe_signal(
        &f.runtime.inner.shared,
        &source,
        ProviderSignal::Authentication,
    );
    assert!(!f.runtime.blocked());
    assert!(f.runtime.busy(&f.key));
    f.runtime.inner.shared.state.lock().unwrap().clear();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_driver_quarantine_cannot_be_reaped_or_auth_reset() {
    let f = Unit::new();
    let mut h = f.holding(true).await;
    let source = Arc::new(Source {
        key: f.key.clone(),
        nonce: Arc::new(()),
        attempt: OnceLock::new(),
    });
    f.install(&h, source, None);
    f.runtime
        .inner
        .shared
        .blocked
        .store(true, Ordering::Release);
    f.runtime.inner.deps.driver.cancel(h.ticket());
    assert_eq!(
        h.wait().await.unwrap_err(),
        crate::turn_driver::DriverError::CleanupUnconfirmed
    );
    assert!(f.runtime.busy(&f.key));
    assert_eq!(f.runtime.reset_auth().unwrap_err(), RuntimeError::Busy);
    assert_eq!(f.runtime.inner.deps.driver.active_count(), 1);
    // Synthetic Worker has no process; this tests the controller's typed slot proof.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_driver_retry_is_reaped_by_shutdown_without_busy_poll() {
    let f = Unit::new();
    let ready = Arc::new(AtomicBool::new(false));
    let (send, recv) = oneshot::channel();
    let mut h = f
        .runtime
        .inner
        .deps
        .driver
        .start(
            f.owner.snapshot(&f.key).unwrap(),
            "unit".into(),
            Arc::new(Holding {
                entered: Mutex::new(Some(send)),
                unknown: true,
                recovery: Some(ready.clone()),
            }),
        )
        .unwrap();
    recv.await.unwrap();
    let source = Arc::new(Source {
        key: f.key.clone(),
        nonce: Arc::new(()),
        attempt: OnceLock::new(),
    });
    f.install(&h, source, None);
    f.runtime.inner.deps.driver.cancel(h.ticket());
    assert_eq!(
        h.wait().await.unwrap_err(),
        crate::turn_driver::DriverError::CleanupUnconfirmed
    );
    f.runtime
        .inner
        .shared
        .state
        .lock()
        .unwrap()
        .get_mut(&f.key)
        .unwrap()
        .quarantined = true;
    ready.store(true, Ordering::Release);
    f.runtime.inner.deps.driver.cancel(h.ticket());
    h.wait().await.unwrap();
    assert!(matches!(h.progress(), Progress::Finished(_)));
    // Model a delayed progress watcher: no busy()/reserve()/watcher poll
    // may clean the stale cached flag before shutdown reads Finished directly.
    f.runtime.shutdown().await.unwrap();
    assert_eq!(f.runtime.inner.deps.driver.active_count(), 0);
}
