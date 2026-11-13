use super::*;
use crate::journal::EventStore;
use crate::turn_driver::{Handle, Options, Started, Task, Worker, WorkerError};
use crate::turn_journal::JournalSink;
use crate::turn_snapshot::SessionKey;
use std::os::unix::fs::PermissionsExt;
use tokio::sync::oneshot;

struct Holding(Mutex<Option<oneshot::Sender<()>>>);
impl Worker for Holding {
    fn start(&self, _: Ticket, _: TurnSnapshot, _: String) -> Task<Result<Started, WorkerError>> {
        if let Some(send) = self.0.lock().unwrap().take() {
            let _ = send.send(());
        }
        Box::pin(std::future::pending())
    }
    fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    key: SessionKey,
    registry: Arc<Mutex<Registry>>,
    driver: Arc<Driver>,
    owner: Arc<ZcodeOwner>,
}
impl Fixture {
    fn new(resume: Option<&str>) -> Self {
        crate::panic_guard::install();
        static HOOK: std::sync::Once = std::sync::Once::new();
        HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                if let Some(at) = info.location() {
                    eprintln!("ZCode owner fixture panic at {}:{}", at.file(), at.line());
                }
            }))
        });
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let key = SessionKey {
            name: "chat".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let mut rec = Record::default();
        for (k, v) in [
            ("name", "chat"),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
            ("title", "before"),
            ("lastStatus", "working"),
        ] {
            rec.set_string(k, v);
        }
        if let Some(resume) = resume {
            rec.set_string("providerSessionId", resume);
        }
        registry.insert(rec).unwrap();
        let registry = Arc::new(Mutex::new(registry));
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        let sink = Arc::new(JournalSink::new(Arc::new(Mutex::new(journal))).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Options::default(),
            )
            .unwrap(),
        );
        let owner = ZcodeOwner::new(
            home.clone(),
            registry.clone(),
            Arc::downgrade(&driver),
            consent,
            Arc::new(|_, _| true),
            Arc::new(|| {}),
        )
        .unwrap();
        Self {
            _temp: temp,
            home,
            key,
            registry,
            driver,
            owner,
        }
    }
    fn record(&self) -> Record {
        self.registry.lock().unwrap().find("chat").unwrap().clone()
    }
    async fn begin(&self) -> (Handle, AppServerAttempt) {
        self.begin_on(&self.key).await
    }
    async fn begin_on(&self, key: &SessionKey) -> (Handle, AppServerAttempt) {
        let snapshot = self.owner.snapshot(key).unwrap();
        let (send, recv) = oneshot::channel();
        let handle = self
            .driver
            .start(
                snapshot.clone(),
                "private content".into(),
                Arc::new(Holding(Mutex::new(Some(send)))),
            )
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), recv)
            .await
            .unwrap()
            .unwrap();
        let request = ReserveRequest::new(
            handle.ticket().clone(),
            snapshot,
            7,
            format!("host-{}", key.name),
            std::time::Instant::now() + std::time::Duration::from_secs(30),
        );
        let ids = HostInputIds::new(format!("input-{}", key.name), format!("query-{}", key.name))
            .unwrap();
        let attempt = self.owner.reserve_app_server(request, ids).unwrap();
        (handle, attempt)
    }
    fn identity(&self, attempt: &AppServerAttempt, sid: &str) -> NativeSessionReceipt {
        assert!(self.owner.seal_spawn(attempt.attempt()));
        self.owner.record_app_server_session(attempt, sid).unwrap()
    }
    fn observer(
        &self,
        attempt: &AppServerAttempt,
        identity: &NativeSessionReceipt,
    ) -> AppServerNativeObserver {
        let mut observer = AppServerNativeObserver::from_owned_process(attempt, 7).unwrap();
        let frontier = self
            .owner
            .prepare_app_server_input(attempt, identity)
            .unwrap();
        let seal = frontier.seal().unwrap();
        observer.bind_first_send(&seal, "rpc-send").unwrap();
        observer
    }
    async fn finish(&self, mut handle: Handle) {
        self.driver.cancel(handle.ticket());
        tokio::time::timeout(std::time::Duration::from_secs(5), handle.wait())
            .await
            .unwrap()
            .unwrap();
    }
}

type FrontierBarrier = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
thread_local! {
    static FRONTIER_BARRIER: std::cell::RefCell<Option<FrontierBarrier>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn before_frontier_locks() {
    FRONTIER_BARRIER.with(|slot| {
        if let Some((entered, release)) = slot.borrow_mut().take() {
            entered.send(()).unwrap();
            release
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
    });
}
fn native_start(
    observer: &mut AppServerNativeObserver,
    attempt: &AppServerAttempt,
    sid: &str,
    tid: &str,
) {
    observer
        .observe_turn_started(
            sid,
            Some(tid),
            Some(attempt.host_input_id()),
            Some(attempt.host_query_id()),
        )
        .unwrap();
}

#[test]
fn host_ids_are_bounded_canonical_and_invalid_ids_cannot_reach_reservation() {
    for whitespace in [
        '\u{0009}', '\u{000d}', ' ', '\u{00a0}', '\u{1680}', '\u{2000}', '\u{200a}', '\u{2028}',
        '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ] {
        for bad in [format!("{whitespace}id"), format!("id{whitespace}")] {
            assert!(matches!(
                HostInputIds::new(bad.clone(), "query".into()),
                Err(Error::Invalid)
            ));
            assert!(matches!(
                HostInputIds::new("input".into(), bad),
                Err(Error::Invalid)
            ));
        }
    }
    for bad in [String::new(), "x".repeat(257), "é".repeat(129)] {
        assert!(HostInputIds::new(bad, "query".into()).is_err());
    }
    assert!(HostInputIds::new("x".repeat(256), "é".repeat(128)).is_ok());
    assert!(HostInputIds::new("host-input".into(), "host-query".into()).is_ok());
    let f = Fixture::new(None);
    assert!(HostInputIds::new(" leading".into(), "query".into()).is_err());
    assert!(f.record().get(MARKER).is_none());
    assert!(
        id(&"n".repeat(512)),
        "shared native SID bound remains unchanged"
    );
}

#[tokio::test]
async fn durable_v2_reservation_and_identity_do_not_accept_input_or_pause_queue() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    let raw = f.record();
    let marker: serde_json::Value = serde_json::from_str(raw.get(MARKER).unwrap().get()).unwrap();
    assert_eq!(marker["version"], 2);
    assert_eq!(marker["route"], "app-server");
    assert_eq!(marker["inputId"], a.host_input_id());
    assert!(!raw.get(MARKER).unwrap().get().contains("private content"));
    assert!(!yes(&raw, "queuePaused"));
    assert_eq!(raw.scalar("lastStatus").as_deref(), Some("working"));
    let receipt = f.identity(&a, "native-a");
    assert_eq!(receipt.native_session_id(), "native-a");
    assert!(f.record().get(MARKER).is_some());
    assert!(matches!(
        h.progress(),
        crate::turn_driver::Progress::Starting
    ));
    assert!(f.driver.public_turn_id(h.ticket()).is_none());
    assert!(!a.input_sealed());
    f.finish(h).await;
}

#[tokio::test]
async fn actual_ack_and_matching_started_in_either_order_are_both_required() {
    for event_first in [true, false] {
        let f = Fixture::new(None);
        let (h, a) = f.begin().await;
        let identity = f.identity(&a, "native-a");
        let mut observer = f.observer(&a, &identity);
        assert!(observer.take_started_evidence().is_none());
        if event_first {
            native_start(&mut observer, &a, "native-a", "turn-a");
        } else {
            observer
                .observe_send_ack("rpc-send", "native-a", true, 0)
                .unwrap();
        }
        assert!(observer.take_started_evidence().is_none());
        assert!(f.record().get(MARKER).is_some());
        if event_first {
            observer
                .observe_send_ack("rpc-send", "native-a", true, 42)
                .unwrap();
        } else {
            native_start(&mut observer, &a, "native-a", "turn-a");
        }
        assert!(observer.saw_native_started());
        let evidence = observer.take_started_evidence().unwrap();
        assert!(observer.take_started_evidence().is_none());
        let acceptance = f.owner.accept_app_server_started(&a, evidence).unwrap();
        assert!(acceptance.matches(a.attempt()));
        assert_eq!(acceptance.native_session_id(), "native-a");
        assert_eq!(acceptance.native_turn_id(), "turn-a");
        assert!(f.record().get(MARKER).is_none());
        assert_eq!(
            f.record().scalar("providerSessionId").as_deref(),
            Some("native-a")
        );
        assert!(
            matches!(h.progress(), crate::turn_driver::Progress::Starting),
            "Owner never publishes Started"
        );
        f.finish(h).await;
    }
}

#[tokio::test]
async fn wrong_ack_rpc_sid_false_or_unsafe_revision_never_accept() {
    for mode in 0..4 {
        let f = Fixture::new(None);
        let (h, a) = f.begin().await;
        let identity = f.identity(&a, "native-a");
        let mut observer = f.observer(&a, &identity);
        native_start(&mut observer, &a, "native-a", "turn-a");
        let rpc = if mode == 0 {
            "bootstrap-rpc"
        } else {
            "rpc-send"
        };
        let sid = if mode == 1 {
            "native-other"
        } else {
            "native-a"
        };
        let revision = if mode == 3 { u64::MAX } else { 1 };
        assert!(
            observer
                .observe_send_ack(rpc, sid, mode != 2, revision)
                .is_err()
        );
        assert!(observer.take_started_evidence().is_none());
        assert!(observer.saw_native_started());
        assert!(f.record().get(MARKER).is_some());
        f.finish(h).await;
    }
}

#[tokio::test]
async fn missing_tid_or_host_ids_never_manufacture_started() {
    for mode in 0..5 {
        let f = Fixture::new(None);
        let (h, a) = f.begin().await;
        let identity = f.identity(&a, "native-a");
        let mut observer = f.observer(&a, &identity);
        observer
            .observe_send_ack("rpc-send", "native-a", true, 1)
            .unwrap();
        let tid = if mode == 0 { None } else { Some("turn-a") };
        let input = match mode {
            1 => None,
            2 => Some("wrong"),
            _ => Some(a.host_input_id()),
        };
        let query = match mode {
            3 => None,
            4 => Some("wrong"),
            _ => Some(a.host_query_id()),
        };
        observer
            .observe_turn_started("native-a", tid, input, query)
            .unwrap();
        assert!(observer.saw_native_started());
        assert!(observer.take_started_evidence().is_none());
        assert!(f.record().get(MARKER).is_some());
        f.finish(h).await;
    }
}

#[tokio::test]
async fn bootstrap_native_start_is_sticky_but_not_current_input_acceptance() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    assert!(f.owner.seal_spawn(a.attempt()));
    let mut observer = AppServerNativeObserver::from_owned_process(&a, 7).unwrap();
    observer
        .observe_turn_started("native-a", Some("startup"), None, None)
        .unwrap();
    assert!(observer.saw_native_started());
    assert!(observer.take_started_evidence().is_none());
    let identity = f.owner.record_app_server_session(&a, "native-a").unwrap();
    {
        let frontier = f.owner.prepare_app_server_input(&a, &identity).unwrap();
        let seal = frontier.seal().unwrap();
        observer.bind_first_send(&seal, "rpc-send").unwrap();
    }
    observer
        .observe_send_ack("rpc-send", "native-a", true, 1)
        .unwrap();
    assert!(observer.take_started_evidence().is_none());
    assert!(f.record().get(MARKER).is_some());
    f.finish(h).await;
}

#[tokio::test]
async fn cross_route_legacy_evidence_clear_and_missing_capability_are_rejected() {
    let f = Fixture::new(Some("native-a"));
    let (h, a) = f.begin().await;
    let _identity = f.identity(&a, "native-a");
    assert!(matches!(
        TurnStartedEvidence::from_owned_turn_started(
            a.attempt(),
            "native-a".into(),
            "turn-a".into()
        ),
        Err(Error::Invalid)
    ));
    assert_eq!(
        f.owner.record_native_session(a.attempt(), "native-a"),
        Err(Error::Invalid)
    );
    assert_eq!(
        f.owner
            .clear_never_sent(a.attempt(), JoinedCleanup::from_owned_join(a.attempt())),
        Err(Error::Invalid)
    );
    let fake_legacy = TurnStartedEvidence {
        attempt: a.0.clone(),
        session_id: "native-a".into(),
        turn_id: "turn-a".into(),
    };
    assert!(matches!(
        f.owner.accept_turn_started(a.attempt(), fake_legacy),
        Err(Error::Invalid)
    ));
    f.owner
        .retire(a.attempt(), JoinedCleanup::from_owned_join(a.attempt()))
        .unwrap();
    assert!(matches!(
        MissingAfterJoin::from_owned_missing_after_join(
            a.attempt(),
            JoinedCleanup::from_owned_join(a.attempt()),
            false
        ),
        Err(Error::Invalid)
    ));
    assert!(f.record().get(MARKER).is_some());
    f.finish(h).await;
}

#[tokio::test]
async fn never_bootstrapped_clear_requires_exact_join_and_both_cancellations() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    assert!(a.attempt().cancel_before_spawn());
    assert!(matches!(
        f.owner
            .clear_app_server_before_bootstrap(&a, JoinedCleanup::from_owned_join(a.attempt())),
        Err(Error::Invalid)
    ));
    assert!(a.cancel_before_input());
    assert!(a.cancel_before_input());
    f.owner
        .clear_app_server_before_bootstrap(&a, JoinedCleanup::from_owned_join(a.attempt()))
        .unwrap();
    assert!(f.record().get(MARKER).is_none());
    assert!(!yes(&f.record(), "queuePaused"));
    f.finish(h).await;
}

#[tokio::test]
async fn spawned_bootstrap_with_no_current_input_keeps_uncertainty_after_retire() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    let identity = f.identity(&a, "native-a");
    assert!(a.cancel_before_input());
    assert!(a.never_enqueued());
    assert!(
        f.owner
            .prepare_app_server_input(&a, &identity)
            .unwrap()
            .seal()
            .is_none()
    );
    assert!(matches!(
        f.owner
            .clear_app_server_before_bootstrap(&a, JoinedCleanup::from_owned_join(a.attempt())),
        Err(Error::Invalid)
    ));
    f.owner
        .retire(a.attempt(), JoinedCleanup::from_owned_join(a.attempt()))
        .unwrap();
    assert!(f.record().get(MARKER).is_some());
    f.finish(h).await;
}

#[tokio::test]
async fn distinct_native_sid_resume_mismatch_and_wrong_generation_are_rejected() {
    let f = Fixture::new(Some("native-a"));
    let (h, a) = f.begin().await;
    assert!(f.owner.seal_spawn(a.attempt()));
    assert!(matches!(
        f.owner.record_app_server_session(&a, "native-other"),
        Err(Error::Uncertain)
    ));
    let first = f.owner.record_app_server_session(&a, "native-a").unwrap();
    assert!(f.owner.record_app_server_session(&a, "native-a").is_ok());
    assert!(matches!(
        f.owner.record_app_server_session(&a, "second"),
        Err(Error::Uncertain)
    ));
    assert!(matches!(
        AppServerNativeObserver::from_owned_process(&a, 8),
        Err(Error::Invalid)
    ));
    assert!(f.owner.prepare_app_server_input(&a, &first).is_ok());
    f.finish(h).await;
}

#[tokio::test]
async fn foreign_or_recreated_owner_and_foreign_identity_reject_before_callback() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    let identity = f.identity(&a, "native-a");
    let mut observer = f.observer(&a, &identity);
    native_start(&mut observer, &a, "native-a", "turn-a");
    observer
        .observe_send_ack("rpc-send", "native-a", true, 1)
        .unwrap();
    let called = Arc::new(AtomicBool::new(false));
    let callback = called.clone();
    let another = ZcodeOwner::new(
        f.home.clone(),
        f.registry.clone(),
        Arc::downgrade(&f.driver),
        f.owner.trust.consent.clone(),
        Arc::new(move |_, _| {
            callback.store(true, Ordering::Release);
            true
        }),
        Arc::new(|| {}),
    )
    .unwrap();
    assert!(matches!(
        another.record_app_server_session(&a, "native-a"),
        Err(Error::Invalid)
    ));
    assert!(matches!(
        another.prepare_app_server_input(&a, &identity),
        Err(Error::Invalid)
    ));
    assert!(matches!(
        another.accept_app_server_started(&a, observer.take_started_evidence().unwrap()),
        Err(Error::Invalid)
    ));
    assert!(!called.load(Ordering::Acquire));
    assert!(f.record().get(MARKER).is_some());
    f.finish(h).await;
}

#[tokio::test]
async fn input_acceptance_preserves_concurrent_metadata_and_raw_queue() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    let identity = f.identity(&a, "native-a");
    let mut observer = f.observer(&a, &identity);
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |r| {
            r.set_string("title", "concurrent-title");
            r.set_string("model", "next-model");
            r.set_bool("queuePaused", true);
            r.set_raw(
                "queue",
                serde_json::value::RawValue::from_string("[{\"text\":\"\\ud800\"}]".into())?,
            );
            Ok(())
        })
        .unwrap();
    native_start(&mut observer, &a, "native-a", "turn-a");
    observer
        .observe_send_ack("rpc-send", "native-a", true, 1)
        .unwrap();
    f.owner
        .accept_app_server_started(&a, observer.take_started_evidence().unwrap())
        .unwrap();
    let r = f.record();
    assert_eq!(r.scalar("title").as_deref(), Some("concurrent-title"));
    assert_eq!(r.scalar("model").as_deref(), Some("next-model"));
    assert!(yes(&r, "queuePaused"));
    assert!(r.get("queue").unwrap().get().contains("\\ud800"));
    f.finish(h).await;
}

#[tokio::test]
async fn direct_cancel_fault_and_shutdown_while_frontier_held_deny_seal() {
    for mode in 0..3 {
        let f = Fixture::new(None);
        let (h, a) = f.begin().await;
        let identity = f.identity(&a, "native-a");
        {
            let frontier = f.owner.prepare_app_server_input(&a, &identity).unwrap();
            match mode {
                0 => {
                    assert!(f.driver.cancel(h.ticket()));
                }
                1 => f.driver.report_storage_failure(),
                _ => f.driver.begin_shutdown(),
            };
            assert!(frontier.seal().is_none());
            assert!(!a.input_sealed());
        }
        assert!(f.record().get(MARKER).is_some());
        f.driver.cancel(h.ticket());
        let mut h = h;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), h.wait())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn cancel_after_seal_never_claims_no_input_and_denies_late_acceptance() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    let identity = f.identity(&a, "native-a");
    let mut observer = f.observer(&a, &identity);
    assert!(f.driver.cancel(h.ticket()));
    assert!(!a.cancel_before_input());
    assert!(!a.never_enqueued());
    native_start(&mut observer, &a, "native-a", "turn-a");
    observer
        .observe_send_ack("rpc-send", "native-a", true, 1)
        .unwrap();
    assert!(
        f.owner
            .accept_app_server_started(&a, observer.take_started_evidence().unwrap())
            .is_err()
    );
    assert!(f.record().get(MARKER).is_some());
    f.finish(h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn registry_is_locked_until_the_first_bounded_handoff_not_merely_until_seal() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    let identity = f.identity(&a, "native-a");
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (go_tx, go_rx) = std::sync::mpsc::channel();
    let (handoff_tx, handoff_rx) = std::sync::mpsc::sync_channel(1);
    let owner = f.owner.clone();
    let attempt = a.clone();
    let updated = Arc::new(AtomicBool::new(false));
    let check = updated.clone();
    let frontier = std::thread::spawn(move || {
        let frontier = owner.prepare_app_server_input(&attempt, &identity).unwrap();
        ready_tx.send(()).unwrap();
        go_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let _runtime_state = Mutex::new(()); // actual Runtime gate is a later integration
        let _admission = _runtime_state.lock().unwrap();
        let seal = frontier.seal().unwrap();
        assert!(!check.load(Ordering::Acquire));
        assert_eq!(seal.native_session_id(), "native-a");
        handoff_tx.try_send(()).unwrap();
        assert!(
            !check.load(Ordering::Acquire),
            "mutation crossed borrowed first handoff"
        );
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    assert!(matches!(
        f.registry.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    let registry = f.registry.clone();
    let key = f.key.clone();
    let (attempted_tx, attempted_rx) = std::sync::mpsc::channel();
    let mutation = std::thread::spawn(move || {
        attempted_tx.send(()).unwrap();
        registry
            .lock()
            .unwrap()
            .update_checked(&key, |r| {
                r.set_string("title", "after-handoff");
                Ok(())
            })
            .unwrap();
        updated.store(true, Ordering::Release);
    });
    attempted_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    go_tx.send(()).unwrap();
    handoff_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    frontier.join().unwrap();
    mutation.join().unwrap();
    assert_eq!(f.record().scalar("title").as_deref(), Some("after-handoff"));
    assert!(f.record().get(MARKER).is_some());
    f.finish(h).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn frontier_refreshes_marker_sid_incarnation_and_policy_after_preflight_and_lock_wait() {
    for mode in 0..5 {
        let f = Fixture::new(None);
        let (h, a) = f.begin().await;
        let identity = f.identity(&a, "native-a");
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let owner = f.owner.clone();
        let attempt = a.clone();
        let preparing = std::thread::spawn(move || {
            FRONTIER_BARRIER.with(|s| *s.borrow_mut() = Some((entered_tx, release_rx)));
            owner
                .prepare_app_server_input(&attempt, &identity)
                .map(|_| ())
                .err()
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        {
            let mut registry = f.registry.lock().unwrap();
            release_tx.send(()).unwrap();
            if mode == 2 {
                let mut replacement = registry.remove_checked(&f.key).unwrap();
                replacement.set_string("createdAt", "2030-01-01T00:00:00Z");
                registry.insert(replacement).unwrap();
            } else {
                registry
                    .update_checked(&f.key, |r| {
                        match mode {
                            0 => r.set_string(MARKER, "replacement"),
                            1 => r.set_string("providerSessionId", "neighbor-sid"),
                            3 => r.set_string("approval", "read-only"),
                            _ => r.set_bool("archived", true),
                        }
                        Ok(())
                    })
                    .unwrap();
            }
        }
        assert!(preparing.join().unwrap().is_some());
        assert!(!a.input_sealed());
        assert!(f.record().get(MARKER).is_some());
        f.finish(h).await;
    }
}

#[tokio::test]
async fn two_native_sessions_wrong_identity_and_stale_observer_cannot_touch_neighbor() {
    let f = Fixture::new(None);
    let mut neighbor = f.record();
    neighbor.set_string("name", "neighbor");
    f.registry.lock().unwrap().insert(neighbor).unwrap();
    let neighbor = SessionKey {
        name: "neighbor".into(),
        created_at: f.key.created_at.clone(),
    };
    let (ha, a) = f.begin().await;
    let ia = f.identity(&a, "native-a");
    let (hb, b) = f.begin_on(&neighbor).await;
    let ib = f.identity(&b, "native-b");
    assert!(matches!(
        f.owner.prepare_app_server_input(&a, &ib),
        Err(Error::Invalid)
    ));
    let mut oa = f.observer(&a, &ia);
    let mut ob = f.observer(&b, &ib);
    native_start(&mut oa, &a, "native-a", "turn-a");
    oa.observe_send_ack("rpc-send", "native-a", true, 1)
        .unwrap();
    assert!(matches!(
        f.owner
            .accept_app_server_started(&b, oa.take_started_evidence().unwrap()),
        Err(Error::Invalid)
    ));
    f.driver.cancel(ha.ticket());
    native_start(&mut ob, &b, "native-b", "turn-b");
    ob.observe_send_ack("rpc-send", "native-b", true, 1)
        .unwrap();
    let accepted = f
        .owner
        .accept_app_server_started(&b, ob.take_started_evidence().unwrap())
        .unwrap();
    assert!(accepted.matches(b.attempt()));
    assert!(f.record().get(MARKER).is_some());
    assert!(
        f.registry
            .lock()
            .unwrap()
            .find("neighbor")
            .unwrap()
            .get(MARKER)
            .is_none()
    );
    f.finish(ha).await;
    f.finish(hb).await;
}

#[tokio::test]
async fn store_adapter_uses_owned_reserve_identity_acceptance_and_cleanup_work() {
    let f = Fixture::new(None);
    let snapshot = f.owner.snapshot(&f.key).unwrap();
    let (send, recv) = oneshot::channel();
    let h = f
        .driver
        .start(
            snapshot.clone(),
            "private".into(),
            Arc::new(Holding(Mutex::new(Some(send)))),
        )
        .unwrap();
    recv.await.unwrap();
    let store = f.owner.app_server_store();
    let request = ReserveRequest::new(
        h.ticket().clone(),
        snapshot,
        7,
        "host-store".into(),
        std::time::Instant::now() + std::time::Duration::from_secs(30),
    );
    let a = store
        .reserve(
            request,
            HostInputIds::new("input-store".into(), "query-store".into()).unwrap(),
        )
        .await
        .unwrap();
    assert!(f.owner.seal_spawn(a.attempt()));
    let identity = store
        .record_session(a.clone(), "native-a".into())
        .await
        .unwrap();
    let mut observer = f.observer(&a, &identity);
    native_start(&mut observer, &a, "native-a", "turn-a");
    observer
        .observe_send_ack("rpc-send", "native-a", true, 1)
        .unwrap();
    store
        .accept_started(a.clone(), observer.take_started_evidence().unwrap())
        .await
        .unwrap();
    store
        .retire(a.clone(), JoinedCleanup::from_owned_join(a.attempt()))
        .await
        .unwrap();
    assert!(f.record().get(MARKER).is_none());
    f.finish(h).await;
}

#[tokio::test]
async fn failed_identity_io_faults_outside_guards_and_cannot_seal_or_accept() {
    let f = Fixture::new(None);
    let (h, a) = f.begin().await;
    assert!(f.owner.seal_spawn(a.attempt()));
    f.registry.lock().unwrap().fail_next_commit_for_test(true);
    assert!(matches!(
        f.owner.record_app_server_session(&a, "native-a"),
        Err(Error::Storage)
    ));
    assert!(f.driver.storage_failed());
    assert!(!a.input_sealed());
    assert!(f.record().get(MARKER).is_some());
    f.owner
        .retire(a.attempt(), JoinedCleanup::from_owned_join(a.attempt()))
        .unwrap();
    let mut h = h;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), h.wait())
        .await
        .unwrap();
}
