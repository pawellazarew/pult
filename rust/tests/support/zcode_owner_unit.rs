use super::*;
use crate::journal::EventStore;
use crate::turn_driver::{Handle, Options, Started, Task, Worker, WorkerError};
use crate::turn_journal::JournalSink;
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
                sink,
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
    async fn begin(&self) -> (Handle, Attempt) {
        let snapshot = self.owner.snapshot(&self.key).unwrap();
        let (send, recv) = oneshot::channel();
        let handle = self
            .driver
            .start(
                snapshot.clone(),
                "private input never stored in marker".into(),
                Arc::new(Holding(Mutex::new(Some(send)))),
            )
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), recv)
            .await
            .unwrap()
            .unwrap();
        assert!(
            self.driver.public_turn_id(handle.ticket()).is_none(),
            "fixture must reserve during Starting"
        );
        let attempt = self
            .owner
            .reserve(
                handle.ticket().clone(),
                snapshot,
                7,
                "host-captured-turn".into(),
                std::time::Instant::now() + std::time::Duration::from_secs(30),
            )
            .unwrap();
        (handle, attempt)
    }
    async fn finish(&self, mut handle: Handle) {
        self.driver.cancel(handle.ticket());
        tokio::time::timeout(std::time::Duration::from_secs(5), handle.wait())
            .await
            .unwrap()
            .unwrap();
    }
}
#[tokio::test]
async fn starting_reservation_is_durable_private_and_does_not_pause_hot_fifo() {
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    assert!(f.record().get(MARKER).is_some());
    assert!(f.record().get("queuePaused").is_none());
    assert_eq!(f.record().scalar("lastStatus").as_deref(), Some("working"));
    assert!(
        !f.record()
            .get(MARKER)
            .unwrap()
            .get()
            .contains("private input")
    );
    assert!(!format!("{attempt:?}").contains("host-captured-turn"));
    assert!(matches!(f.owner.snapshot(&f.key), Err(Error::Uncertain)));
    assert!(attempt.cancel_before_spawn());
    assert!(
        attempt.cancel_before_spawn(),
        "NeverSent proof must be idempotent"
    );
    assert!(!f.owner.seal_spawn(&attempt));
    f.owner
        .clear_never_sent(&attempt, JoinedCleanup::from_owned_join(&attempt))
        .unwrap();
    assert!(f.record().get(MARKER).is_none());
    f.finish(handle).await;
}
#[tokio::test]
async fn native_identity_is_not_acceptance_then_turn_started_preserves_metadata() {
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    assert!(f.owner.seal_spawn(&attempt));
    f.owner
        .record_native_session(&attempt, "sess_opaque_native")
        .unwrap();
    assert!(f.record().get(MARKER).is_some());
    assert_eq!(
        f.record().scalar("providerSessionId").as_deref(),
        Some("sess_opaque_native")
    );
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |r| {
            r.set_string("title", "concurrent-title");
            r.set_string("model", "concurrent-model");
            r.set_bool("queuePaused", true);
            Ok(())
        })
        .unwrap();
    let evidence = TurnStartedEvidence::from_owned_turn_started(
        &attempt,
        "sess_opaque_native".into(),
        "turn_native".into(),
    )
    .unwrap();
    let accepted = f.owner.accept_turn_started(&attempt, evidence).unwrap();
    assert_eq!(accepted.native_turn_id(), "turn_native");
    assert!(f.record().get(MARKER).is_none());
    assert_eq!(
        f.record().scalar("title").as_deref(),
        Some("concurrent-title")
    );
    assert_eq!(
        f.record().scalar("model").as_deref(),
        Some("concurrent-model")
    );
    assert!(yes(&f.record(), "queuePaused"));
    f.owner
        .retire(&attempt, JoinedCleanup::from_owned_join(&attempt))
        .unwrap();
    f.finish(handle).await;
}
#[tokio::test]
async fn sealed_unknown_survives_cleanup_without_replay_or_never_sent_clear() {
    let f = Fixture::new(Some("sess_known"));
    let (handle, attempt) = f.begin().await;
    assert!(f.owner.seal_spawn(&attempt));
    assert!(!attempt.cancel_before_spawn());
    assert_eq!(
        f.owner
            .clear_never_sent(&attempt, JoinedCleanup::from_owned_join(&attempt)),
        Err(Error::Invalid)
    );
    f.owner
        .retire(&attempt, JoinedCleanup::from_owned_join(&attempt))
        .unwrap();
    assert!(matches!(f.owner.snapshot(&f.key), Err(Error::Uncertain)));
    assert!(f.record().get(MARKER).is_some());
    f.finish(handle).await;
}
#[tokio::test]
async fn wrong_resumed_session_or_foreign_evidence_cannot_clear_unknown() {
    let f = Fixture::new(Some("sess_known"));
    let (handle, attempt) = f.begin().await;
    f.owner.seal_spawn(&attempt);
    assert_eq!(
        f.owner.record_native_session(&attempt, "sess_new"),
        Err(Error::Uncertain)
    );
    let other = Fixture::new(None);
    let (h2, a2) = other.begin().await;
    other.owner.seal_spawn(&a2);
    let evidence =
        TurnStartedEvidence::from_owned_turn_started(&a2, "sess_known".into(), "turn".into())
            .unwrap();
    assert!(matches!(
        f.owner.accept_turn_started(&attempt, evidence),
        Err(Error::Invalid)
    ));
    assert!(f.record().get(MARKER).is_some());
    f.finish(handle).await;
    other.finish(h2).await;
}
#[tokio::test]
async fn cancellation_after_reservation_rejects_acceptance_and_stale_incarnation_write() {
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    f.owner.seal_spawn(&attempt);
    f.driver.cancel(handle.ticket());
    assert_eq!(
        f.owner.record_native_session(&attempt, "sess_id"),
        Err(Error::Unavailable)
    );
    let evidence =
        TurnStartedEvidence::from_owned_turn_started(&attempt, "sess_id".into(), "turn".into())
            .unwrap();
    assert!(matches!(
        f.owner.accept_turn_started(&attempt, evidence),
        Err(Error::Unavailable)
    ));
    assert!(f.record().get(MARKER).is_some());
    f.finish(handle).await;
}
#[tokio::test]
async fn marker_replacement_and_non_native_ids_fail_closed() {
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    f.owner.seal_spawn(&attempt);
    for sid in ["", "-resume-option", "bad\0id", "bad\nid"] {
        assert_eq!(
            f.owner.record_native_session(&attempt, sid),
            Err(Error::Invalid)
        );
    }
    assert!(
        TurnStartedEvidence::from_owned_turn_started(&attempt, "sess".into(), "".into()).is_err()
    );
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |r| {
            r.set_bool(MARKER, false);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.owner.record_native_session(&attempt, "sess"),
        Err(Error::Uncertain)
    );
    f.finish(handle).await;
}
#[tokio::test]
async fn dropped_attempt_cannot_autoclear_or_unbound_the_reservation_map() {
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    drop(attempt);
    assert_eq!(f.owner.attempts.lock().unwrap().len(), 1);
    assert!(f.record().get(MARKER).is_some());
    f.finish(handle).await;
}
#[test]
fn cold_normalization_preserves_all_opaque_marker_shapes_and_compacts_only_framing() {
    for marker in [
        "null",
        "false",
        "42",
        r#"{"future":["\ud800",1e+030],
"line":"a\nb"}"#,
    ] {
        let raw=serde_json::value::RawValue::from_string(format!(r#"{{"sessions":[{{"name":"chat","provider":"zcode","cwd":"/fixture","createdAt":"2026-11-12T00:00:00Z","lastStatus":"working","zcodePendingInput":{marker}}}]}}"#)).unwrap();
        let mut records = crate::session_model::parse(&raw).unwrap();
        assert!(
            records[0].get("queuePaused").is_none(),
            "parse is not cold recovery"
        );
        crate::session_model::recover(&mut records, 0, |_| Ok(vec![])).unwrap();
        assert_eq!(records[0].scalar("lastStatus").as_deref(), Some("failed"));
        assert!(yes(&records[0], "queuePaused"));
        assert!(!records[0].raw().unwrap().get().contains('\n'));
        assert!(records[0].get(MARKER).is_some());
    }
}
#[tokio::test]
async fn async_store_reservation_is_same_checked_owner_contract() {
    let f = Fixture::new(None);
    let snapshot = f.owner.snapshot(&f.key).unwrap();
    let (send, recv) = oneshot::channel();
    let handle = f
        .driver
        .start(
            snapshot.clone(),
            "test".into(),
            Arc::new(Holding(Mutex::new(Some(send)))),
        )
        .unwrap();
    recv.await.unwrap();
    let attempt = f
        .owner
        .store()
        .reserve(ReserveRequest::new(
            handle.ticket().clone(),
            snapshot,
            3,
            "captured".into(),
            std::time::Instant::now() + std::time::Duration::from_secs(30),
        ))
        .await
        .unwrap();
    assert_eq!(attempt.generation(), 3);
    assert_eq!(attempt.resume_session_id(), None);
    f.finish(handle).await;
}

#[tokio::test]
async fn altered_home_identity_and_stale_session_incarnation_are_rejected() {
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    f.owner.seal_spawn(&attempt);
    {
        let mut registry = f.registry.lock().unwrap();
        let mut replacement = registry.remove_checked(&f.key).unwrap();
        replacement.set_string("createdAt", "2026-11-13T00:00:00Z");
        registry.insert(replacement).unwrap();
    }
    assert_eq!(
        f.owner.record_native_session(&attempt, "sess"),
        Err(Error::Unavailable)
    );
    assert!(f.record().get(MARKER).is_some());
    f.finish(handle).await;
    let f = Fixture::new(None);
    let moved = f.home.with_extension("moved");
    std::fs::rename(&f.home, &moved).unwrap();
    std::fs::create_dir(&f.home).unwrap();
    assert!(f.owner.snapshot(&f.key).is_err());
    std::fs::remove_dir(&f.home).unwrap();
    std::fs::rename(moved, &f.home).unwrap();
}
#[tokio::test]
async fn full_consent_is_not_implicitly_widened_and_new_fault_denies_evidence() {
    let f = Fixture::new(None);
    f.registry
        .lock()
        .unwrap()
        .update_checked(&f.key, |r| {
            r.set_string("approval", "full");
            Ok(())
        })
        .unwrap();
    assert_eq!(
        f.owner.snapshot(&f.key).unwrap().settings.approval,
        crate::turn_snapshot::Approval::Ask
    );
    let (handle, attempt) = f.begin().await;
    f.owner.seal_spawn(&attempt);
    f.driver.report_storage_failure();
    assert!(f.owner.record_native_session(&attempt, "sess").is_err());
    assert!(f.record().get(MARKER).is_some());
    // Driver storage latch intentionally makes the terminal journal result an error.
    let mut handle = handle;
    tokio::time::timeout(std::time::Duration::from_secs(5), handle.wait())
        .await
        .unwrap()
        .unwrap_err();
}
#[tokio::test]
async fn foreign_provider_marker_cannot_be_reinterpreted_as_new_provider_authority() {
    let f = Fixture::new(None);
    {
        let mut registry = f.registry.lock().unwrap();
        let mut replacement = registry.remove_checked(&f.key).unwrap();
        replacement.set_string("provider", "codex");
        replacement.set_bool(MARKER, false);
        registry.insert(replacement).unwrap();
    }
    let codex = OwnerTrust::new(
        f.home.clone(),
        f.registry.clone(),
        Arc::downgrade(&f.driver),
        f.owner.trust.consent.clone(),
        Arc::new(|_, _| true),
        Provider::Codex,
        None,
    )
    .unwrap();
    assert!(matches!(codex.snapshot(&f.key), Err(OwnerError::Uncertain)));
}

#[tokio::test]
async fn failed_native_commit_faults_without_holding_registry_and_cleanup_still_retires() {
    use std::sync::atomic::AtomicBool;
    let mut f = Fixture::new(None);
    let unlocked = Arc::new(AtomicBool::new(false));
    let observed = unlocked.clone();
    let registry = f.registry.clone();
    let driver = f.driver.clone();
    f.owner = ZcodeOwner::new(
        f.home.clone(),
        f.registry.clone(),
        Arc::downgrade(&f.driver),
        f.owner.trust.consent.clone(),
        Arc::new(|_, _| true),
        Arc::new(move || {
            observed.store(
                registry.try_lock().is_ok() && driver.storage_failed(),
                Ordering::Release,
            );
        }),
    )
    .unwrap();
    let (mut handle, attempt) = f.begin().await;
    assert!(f.owner.seal_spawn(&attempt));
    let path = f.home.join("sessions.json");
    let mut bytes = std::fs::read(&path).unwrap();
    bytes.push(b'\n');
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(
        f.owner.record_native_session(&attempt, "sess_id"),
        Err(Error::Storage)
    );
    assert!(unlocked.load(Ordering::Acquire));
    assert!(f.driver.storage_failed());
    assert!(f.record().get(MARKER).is_some());
    assert!(f.record().get("providerSessionId").is_none());
    tokio::time::timeout(std::time::Duration::from_secs(5), handle.wait())
        .await
        .unwrap()
        .unwrap_err();
    f.owner
        .retire(&attempt, JoinedCleanup::from_owned_join(&attempt))
        .unwrap();
    assert_eq!(f.owner.attempts.lock().unwrap().len(), 0);
    assert!(f.record().get(MARKER).is_some());
}
#[tokio::test]
async fn malformed_known_resume_and_duplicate_attempt_do_not_mutate_or_fault() {
    let f = Fixture::new(Some("-unsafe-option"));
    let snapshot = f.owner.snapshot(&f.key).unwrap();
    let (send, recv) = oneshot::channel();
    let handle = f
        .driver
        .start(
            snapshot.clone(),
            "test".into(),
            Arc::new(Holding(Mutex::new(Some(send)))),
        )
        .unwrap();
    recv.await.unwrap();
    assert!(matches!(
        f.owner.reserve(
            handle.ticket().clone(),
            snapshot,
            1,
            "turn".into(),
            std::time::Instant::now() + std::time::Duration::from_secs(30)
        ),
        Err(Error::Invalid)
    ));
    assert!(f.record().get(MARKER).is_none());
    assert!(!f.driver.storage_failed());
    f.finish(handle).await;
    let f = Fixture::new(None);
    let (handle, attempt) = f.begin().await;
    let before = f.record().get(MARKER).unwrap().get().to_owned();
    assert!(matches!(
        f.owner.reserve(
            attempt.ticket().clone(),
            attempt.0.initial.clone(),
            8,
            "other-public-turn".into(),
            std::time::Instant::now() + std::time::Duration::from_secs(30)
        ),
        Err(Error::Uncertain)
    ));
    assert_eq!(f.record().get(MARKER).unwrap().get(), before);
    assert!(!f.driver.storage_failed());
    f.finish(handle).await;
}

#[tokio::test]
async fn past_original_deadline_cannot_seal_and_joined_never_sent_cleanup_is_exact() {
    let f = Fixture::new(None);
    let snapshot = f.owner.snapshot(&f.key).unwrap();
    let (send, recv) = oneshot::channel();
    let handle = f
        .driver
        .start(
            snapshot.clone(),
            "test".into(),
            Arc::new(Holding(Mutex::new(Some(send)))),
        )
        .unwrap();
    recv.await.unwrap();
    let attempt = f
        .owner
        .reserve(
            handle.ticket().clone(),
            snapshot,
            1,
            "turn".into(),
            std::time::Instant::now() - std::time::Duration::from_secs(1),
        )
        .unwrap();
    assert!(!f.owner.seal_spawn(&attempt));
    assert!(!attempt.spawn_action().sealed());
    assert!(attempt.cancel_before_spawn());
    assert!(attempt.spawn_action().never_sent());
    f.owner
        .clear_never_sent(&attempt, JoinedCleanup::from_owned_join(&attempt))
        .unwrap();
    assert!(f.record().get(MARKER).is_none());
    f.finish(handle).await;
}

#[tokio::test]
async fn unrepresentable_existing_native_identity_never_becomes_a_new_conversation() {
    for raw in [r#""\ud800""#, "42", "{}"] {
        let f = Fixture::new(None);
        f.registry
            .lock()
            .unwrap()
            .update_checked(&f.key, |r| {
                r.set_raw(
                    "providerSessionId",
                    serde_json::value::RawValue::from_string(raw.into())?,
                );
                Ok(())
            })
            .unwrap();
        let snapshot = f.owner.snapshot(&f.key).unwrap();
        let (send, recv) = oneshot::channel();
        let handle = f
            .driver
            .start(
                snapshot.clone(),
                "test".into(),
                Arc::new(Holding(Mutex::new(Some(send)))),
            )
            .unwrap();
        recv.await.unwrap();
        assert!(
            matches!(
                f.owner.reserve(
                    handle.ticket().clone(),
                    snapshot,
                    1,
                    "turn".into(),
                    std::time::Instant::now() + std::time::Duration::from_secs(30)
                ),
                Err(Error::Invalid)
            ),
            "existing malformed SID was treated as absent/new"
        );
        assert!(f.record().get(MARKER).is_none());
        assert_eq!(f.record().get("providerSessionId").unwrap().get(), raw);
        f.finish(handle).await;
    }
}

#[tokio::test]
async fn acceptance_receipt_is_bound_to_exact_attempt_even_with_identical_native_ids() {
    let first = Fixture::new(None);
    let second = Fixture::new(None);
    let (h1, a1) = first.begin().await;
    let (h2, a2) = second.begin().await;
    assert!(first.owner.seal_spawn(&a1));
    assert!(second.owner.seal_spawn(&a2));
    let receipt = first
        .owner
        .accept_turn_started(
            &a1,
            TurnStartedEvidence::from_owned_turn_started(&a1, "same_sid".into(), "same_tid".into())
                .unwrap(),
        )
        .unwrap();
    assert!(receipt.matches(&a1));
    assert!(!receipt.matches(&a2));
    assert_eq!(receipt.native_session_id(), "same_sid");
    assert!(second.record().get(MARKER).is_some());
    first.finish(h1).await;
    second.finish(h2).await;
}
