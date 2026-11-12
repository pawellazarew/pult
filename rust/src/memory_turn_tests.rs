//! Deterministic barriers exercise the real SQLite transaction, real Driver,
//! and daemon-owned IO; the fixture worker never launches a model/process.
use super::*;
use crate::{
    memory::MemoryStore,
    turn_driver::{Accepted, Handle, Started, Worker},
    turn_snapshot::{Provider, TurnSettings},
};
use std::{future::Future, sync::mpsc, time::Duration};

#[derive(Default)]
pub(super) struct Hooks {
    read: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    before: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    after: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl Hooks {
    fn take(hook: &Mutex<Option<Box<dyn FnOnce() + Send>>>) {
        let callback = hook.lock().unwrap().take();
        if let Some(callback) = callback {
            callback();
        }
    }
    pub(super) fn before_read(&self) {
        Self::take(&self.read);
    }
    pub(super) fn before_seal(&self) {
        Self::take(&self.before);
    }
    pub(super) fn after_seal(&self) {
        Self::take(&self.after);
    }
}
struct Barrier {
    entered: Arc<Notify>,
    release: Option<mpsc::Sender<()>>,
}
impl Barrier {
    fn install(slot: &Mutex<Option<Box<dyn FnOnce() + Send>>>) -> Self {
        let entered = Arc::new(Notify::new());
        let signal = entered.clone();
        let (release, receive) = mpsc::channel();
        *slot.lock().unwrap() = Some(Box::new(move || {
            signal.notify_one();
            receive
                .recv_timeout(Duration::from_secs(15))
                .expect("memory barrier release watchdog");
        }));
        Self {
            entered,
            release: Some(release),
        }
    }
    async fn entered(&self) {
        bounded(self.entered.notified()).await;
    }
    fn release(mut self) {
        self.release.take().unwrap().send(()).unwrap();
    }
}
impl Drop for Barrier {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("memory test watchdog")
}
struct FixtureWorker(Arc<Backend>);
impl Worker for FixtureWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        _text: String,
    ) -> Task<Result<Started, WorkerError>> {
        let backend = self.0.clone();
        Box::pin(async move {
            backend
                .prepare(ticket, snapshot, "fixture-turn".into())
                .await?;
            Ok(Started {
                turn_id: "fixture-turn".into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        self.0.revoke(&ticket);
        self.0.drain(ticket)
    }
}
struct Fixture {
    _home: tempfile::TempDir,
    _project: tempfile::TempDir,
    state: Arc<State>,
    backend: Arc<Backend>,
    handle: Handle,
    accepted: Accepted,
    context: Context,
    note: Value,
}
impl Fixture {
    async fn new() -> Self {
        let (home, state, _sink) = crate::runtime_journal::tests::fixture();
        let project = tempfile::tempdir().unwrap();
        let cwd = project.path().canonicalize().unwrap();
        *state.memory.lock().unwrap() = Ok(MemoryStore::open(&state.home).unwrap());
        let key = SessionKey {
            name: "chat".into(),
            created_at: "2026-11-12T12:00:00Z".into(),
        };
        let mut record = crate::registry::Record::default();
        for (field, value) in [
            ("name", key.name.as_str()),
            ("createdAt", key.created_at.as_str()),
            ("provider", "codex"),
            ("cwd", cwd.to_str().unwrap()),
            ("scope", "project"),
            ("approval", "full"),
            ("status", "cold"),
        ] {
            record.set_string(field, value);
        }
        record.set_raw(
            "memory",
            serde_json::value::to_raw_value(&json!({"read":true,"write":"ask"})).unwrap(),
        );
        state.registry.lock().unwrap().insert(record).unwrap();
        let backend = Backend::new(Arc::downgrade(&state), state.home.join("unused-mcp"));
        assert!(state.memory_turns.set(backend.clone()).is_ok());
        let snapshot = TurnSnapshot {
            key,
            provider: Provider::Codex,
            cwd,
            settings: TurnSettings {
                approval: Approval::Full,
                ..Default::default()
            },
        };
        let mut handle = state
            .driver
            .get()
            .unwrap()
            .start(
                snapshot,
                "remember convention".into(),
                Arc::new(FixtureWorker(backend.clone())),
            )
            .unwrap();
        let accepted = bounded(handle.accepted()).await.unwrap();
        let control = backend.control(handle.ticket()).unwrap();
        let context = Backend::verify(&state, &control, true).unwrap();
        let note=state.memory.lock().unwrap().as_mut().unwrap().execute("memory.add",&json!({"commandId":"seed","name":"Convention","summary":"Original","details":"Original details","reason":"Owner confirmed"}),&context).unwrap();
        Self {
            _home: home,
            _project: project,
            state,
            backend,
            handle,
            accepted,
            context,
            note,
        }
    }
    fn control(&self) -> Arc<Control> {
        self.backend.control(self.handle.ticket()).unwrap()
    }
    fn update(&self) -> Value {
        json!({"commandId":"agent-edit","id":self.note["id"],"expectedVersion":1,"summary":"Agent revised","reason":"Confirmed human proposal"})
    }
    fn origin(&self) -> Origin {
        Origin {
            session: self.handle.ticket().session().clone(),
            provider: Provider::Codex,
            user_event_id: self.accepted.user_event_id,
            turn_id: self.accepted.turn_id.clone(),
        }
    }
    fn commit(&self) -> tokio::task::JoinHandle<Result<Value, MemoryError>> {
        tokio::spawn(self.backend.clone().commit(
            self.state.clone(),
            self.control(),
            "memory.update".into(),
            self.update(),
            self.origin(),
            std::time::Instant::now() + PROPOSAL_TIMEOUT,
        ))
    }
    fn record(&self) -> Value {
        self.state
            .memory
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .execute("memory.get", &json!({"id":self.note["id"]}), &self.context)
            .unwrap()
    }
    fn history(&self) -> Value {
        self.state
            .memory
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .execute(
                "memory.history",
                &json!({"id":self.note["id"]}),
                &self.context,
            )
            .unwrap()
    }
    async fn close(&mut self) {
        let driver = self.state.driver.get().unwrap();
        driver.cancel(self.handle.ticket());
        bounded(self.handle.wait()).await.ok();
        bounded(driver.shutdown(Duration::from_secs(5)))
            .await
            .unwrap();
        bounded(self.state.host_jobs.wait()).await;
        assert_eq!(driver.active_count(), 0);
        assert!(self.backend.controls.lock().unwrap().is_empty());
    }
    fn assert_owned(&self) {
        let driver = self.state.driver.get().unwrap();
        assert_eq!(
            driver.active_count(),
            1,
            "blocked database operation lost its Driver slot"
        );
        assert!(driver.execution_snapshot(self.handle.ticket()).is_some());
        assert!(
            self.state.host_jobs.active() > 0,
            "blocking IO lost daemon ownership"
        );
    }
}

#[tokio::test]
async fn read_waiting_for_database_rechecks_global_and_direct_driver_fault() {
    for direct in [false, true] {
        let mut fixture = Fixture::new().await;
        // Hold the actual database mutex in an unrelated owned thread. The
        // read hook signals immediately before its real acquisition attempt.
        let held = Arc::new(Notify::new());
        let holder_ready = held.clone();
        let holding_state = fixture.state.clone();
        let (release, waiting) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _database = holding_state.memory.lock().unwrap();
            holder_ready.notify_one();
            waiting.recv_timeout(Duration::from_secs(15)).unwrap();
        });
        bounded(held.notified()).await;
        let entered = Arc::new(Notify::new());
        let read_entered = entered.clone();
        *fixture.backend.hooks.read.lock().unwrap() =
            Some(Box::new(move || read_entered.notify_one()));
        let call = fixture.backend.call(
            Lease(fixture.control()),
            "memory.get".into(),
            json!({"id":fixture.note["id"]}),
        );
        bounded(entered.notified()).await;
        if direct {
            fixture.state.driver.get().unwrap().report_storage_failure();
        } else {
            fixture.state.execution_storage_failed();
        }
        fixture.assert_owned();
        release.send(()).unwrap();
        holder.join().unwrap();
        assert!(bounded(call).await.is_err(), "faulted read published data");
        fixture.close().await;
    }
}

#[tokio::test]
async fn cancellation_global_fault_direct_fault_and_shutdown_before_seal_rollback() {
    for reason in ["cancel", "global", "driver", "shutdown"] {
        let mut fixture = Fixture::new().await;
        let barrier = Barrier::install(&fixture.backend.hooks.before);
        let commit = fixture.commit();
        barrier.entered().await;
        match reason {
            "cancel" => {
                fixture
                    .state
                    .driver
                    .get()
                    .unwrap()
                    .cancel(fixture.handle.ticket());
            }
            "global" => fixture.state.execution_storage_failed(),
            "driver" => fixture.state.driver.get().unwrap().report_storage_failure(),
            "shutdown" => {
                crate::runtime_state::begin_shutdown(&fixture.state);
            }
            _ => unreachable!(),
        }
        fixture.assert_owned();
        barrier.release();
        assert!(
            bounded(commit).await.unwrap().is_err(),
            "{reason} admitted write"
        );
        assert_eq!(fixture.record()["version"], 1);
        assert_eq!(fixture.record()["author"], "owner");
        assert_eq!(fixture.history()["versions"].as_array().unwrap().len(), 1);
        fixture.close().await;
    }
}

#[tokio::test]
async fn dropping_commit_future_before_seal_cancels_action_but_retains_blocking_io() {
    let mut fixture = Fixture::new().await;
    let barrier = Barrier::install(&fixture.backend.hooks.before);
    let commit = fixture.commit();
    barrier.entered().await;
    commit.abort();
    assert!(commit.await.unwrap_err().is_cancelled());
    fixture.assert_owned();
    fixture
        .state
        .driver
        .get()
        .unwrap()
        .cancel(fixture.handle.ticket());
    barrier.release();
    fixture.close().await;
    assert_eq!(fixture.record()["version"], 1);
}

#[tokio::test]
async fn admitted_commit_after_cancel_finishes_owned_before_driver_slot_release() {
    let mut fixture = Fixture::new().await;
    let barrier = Barrier::install(&fixture.backend.hooks.after);
    let commit = fixture.commit();
    barrier.entered().await;
    fixture
        .state
        .driver
        .get()
        .unwrap()
        .cancel(fixture.handle.ticket());
    fixture.assert_owned();
    assert!(
        fixture
            .state
            .driver
            .get()
            .unwrap()
            .snapshot_for_dispatch(fixture.handle.ticket())
            .is_none()
    );
    barrier.release();
    assert!(bounded(commit).await.unwrap().is_err());
    fixture.close().await;
    let record = fixture.record();
    assert_eq!(record["version"], 2);
    assert_eq!(record["author"], "codex");
    assert_eq!(record["sourceEventId"], fixture.accepted.user_event_id);
    assert_eq!(record["sourceTurnId"], fixture.accepted.turn_id);
    assert_eq!(
        record["sourceCreatedAt"],
        fixture.handle.ticket().session().created_at
    );
}

#[tokio::test]
async fn driver_seal_requires_exact_accepted_receipt_and_one_shot_live_action() {
    let mut fixture = Fixture::new().await;
    let driver = fixture.state.driver.get().unwrap();
    let action = MemoryAction::new(std::time::Instant::now() + PROPOSAL_TIMEOUT);
    let wrong = Accepted {
        user_event_id: fixture.accepted.user_event_id + 1,
        turn_id: fixture.accepted.turn_id.clone(),
    };
    assert!(
        driver
            .seal_memory_action(fixture.handle.ticket(), &action, &wrong)
            .is_none()
    );
    assert_eq!(
        driver.seal_memory_action(fixture.handle.ticket(), &action, &fixture.accepted),
        Some(fixture.accepted.clone())
    );
    assert!(
        driver
            .seal_memory_action(fixture.handle.ticket(), &action, &fixture.accepted)
            .is_none()
    );
    let expired = MemoryAction::new(std::time::Instant::now());
    assert!(
        driver
            .seal_memory_action(fixture.handle.ticket(), &expired, &fixture.accepted)
            .is_none()
    );
    let cancelled = MemoryAction::new(std::time::Instant::now() + PROPOSAL_TIMEOUT);
    cancelled.cancel();
    assert!(
        driver
            .seal_memory_action(fixture.handle.ticket(), &cancelled, &fixture.accepted)
            .is_none()
    );
    driver.cancel(fixture.handle.ticket());
    assert!(
        driver
            .seal_memory_action(
                fixture.handle.ticket(),
                &MemoryAction::new(std::time::Instant::now() + PROPOSAL_TIMEOUT),
                &fixture.accepted
            )
            .is_none()
    );
    fixture.close().await;
}

#[tokio::test]
async fn approved_proposal_still_checks_version_inside_commit_and_keeps_owner_revision() {
    let mut fixture = Fixture::new().await;
    let owner = json!({"commandId":"owner-newer","id":fixture.note["id"],"expectedVersion":1,"summary":"Owner newer","reason":"Independent edit"});
    fixture
        .state
        .memory
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .execute("memory.update", &owner, &fixture.context)
        .unwrap();
    let error = bounded(fixture.commit()).await.unwrap().unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(fixture.record()["version"], 2);
    assert_eq!(fixture.record()["author"], "owner");
    assert_eq!(fixture.history()["versions"].as_array().unwrap().len(), 2);
    fixture.close().await;
}

#[tokio::test]
async fn policy_repair_is_explicit_and_private_or_disabled_never_auto_bind() {
    let mut fixture = Fixture::new().await;
    fixture
        .state
        .registry
        .lock()
        .unwrap()
        .update_checked(fixture.handle.ticket().session(), |record| {
            record.set_raw(
                "memory",
                serde_json::value::to_raw_value(&json!({"future":"keep"}))?,
            );
            Ok(())
        })
        .unwrap();
    let listed = crate::session_runtime_api::execute(
        fixture.state.clone(),
        "agent.list",
        json!({}),
        crate::host_policy::ClientKind::Other,
        "fixture#1",
    )
    .await
    .unwrap_or_else(|_| panic!("fixture list unavailable"));
    let listed: Value = serde_json::from_str(listed.get()).unwrap();
    assert_eq!(listed["sessions"][0]["memory"], json!({"future":"keep"}));
    assert!(
        crate::memory_policy::configure(fixture.state.clone(), json!({"session":"chat"}))
            .await
            .is_err()
    );
    let value = crate::memory_policy::configure(
        fixture.state.clone(),
        json!({"session":"chat","memory":{"read":false,"write":"off"}}),
    )
    .await
    .unwrap();
    assert_eq!(value["memory"], json!({"read":false,"write":"off"}));
    assert!(!fixture.control().valid.load(Ordering::Acquire));
    assert!(fixture.backend.lookup(&fixture.control().secret).is_none());
    fixture
        .state
        .registry
        .lock()
        .unwrap()
        .update_checked(fixture.handle.ticket().session(), |record| {
            record.set_raw("private", serde_json::value::to_raw_value(&true)?);
            Ok(())
        })
        .unwrap();
    assert_eq!(
        crate::memory_policy::configure(
            fixture.state.clone(),
            json!({"session":"chat","memory":{"read":true}})
        )
        .await
        .unwrap_err()
        .code,
        "forbidden"
    );
    fixture.close().await;
}

#[test]
fn redaction_preserves_identity_provenance_and_visible_email_without_secret_content() {
    let id = "a".repeat(32);
    let token = ["sk", "proj", "abcdefghijklmnop12345678"].join("-");
    let value = public_memory(
        json!({"id":id,"sourceTurnId":"b".repeat(32),"sourceEventId":42,"name":"Contact owner@example.com","summary":token,"details":"ordinary"}),
    );
    assert_eq!(value["id"], id);
    assert_eq!(value["sourceTurnId"], "b".repeat(32));
    assert_eq!(value["sourceEventId"], 42);
    assert_eq!(value["name"], "Contact owner@example.com");
    assert!(
        !value["summary"]
            .as_str()
            .unwrap()
            .contains("abcdefghijklmnop")
    );
}

#[tokio::test]
async fn exact_receipt_retry_keeps_provenance_and_different_source_cannot_reuse_command() {
    let mut fixture = Fixture::new().await;
    let first = bounded(fixture.commit()).await.unwrap().unwrap();
    let retried = bounded(fixture.commit()).await.unwrap().unwrap();
    assert_eq!(first, retried);
    assert_eq!(fixture.history()["versions"].as_array().unwrap().len(), 2);
    let mut origin = fixture.origin();
    origin.user_event_id += 1;
    let error = fixture
        .state
        .memory
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .execute_as_checked(
            "memory.update",
            &fixture.update(),
            &fixture.context,
            &origin,
            || panic!("receipt mismatch reached commit"),
        )
        .unwrap_err();
    assert_eq!(error.code, "command_conflict");
    let owner = json!({"commandId":"owner-after-agent","id":fixture.note["id"],"expectedVersion":2,"reason":"Owner corrected","summary":"Owner final"});
    let changed = fixture
        .state
        .memory
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .execute("memory.update", &owner, &fixture.context)
        .unwrap();
    assert_eq!(changed["author"], "owner");
    for key in ["sourceEventId", "sourceTurnId", "sourceCreatedAt"] {
        assert!(changed.get(key).is_none(), "owner inherited {key}");
    }
    fixture.close().await;
}

#[test]
fn policy_defaults_and_malformed_or_private_markers_do_not_enable_memory() {
    assert_eq!(Policy::parse(None).unwrap(), Policy::default());
    assert_eq!(Policy::parse(Some(&json!({}))).unwrap(), Policy::default());
    assert_eq!(
        Policy::parse(Some(&json!({"read":true}))).unwrap(),
        Policy {
            read: true,
            write: Write::Off
        }
    );
    for bad in [
        Value::Null,
        json!(true),
        json!([]),
        json!({"read":"true"}),
        json!({"write":"ask"}),
        json!({"read":true,"write":"allow"}),
        json!({"read":true,"extra":true}),
    ] {
        assert!(Policy::parse(Some(&bad)).is_err(), "{bad}");
    }
    for key in ["private", "temporary"] {
        for marker in [json!(true), Value::Null, json!("future")] {
            let mut record = crate::registry::Record::default();
            record.set_raw(
                "memory",
                serde_json::value::to_raw_value(&json!({"read":true,"write":"ask"})).unwrap(),
            );
            record.set_raw(key, serde_json::value::to_raw_value(&marker).unwrap());
            assert_eq!(Policy::record(&record).unwrap(), Policy::default());
        }
    }
}

#[test]
fn proposal_rejects_authority_overrides_secrets_and_wrong_scope_before_question() {
    let context = Context {
        project_id: Some("fixture-project".into()),
        session: Some("chat".into()),
    };
    let good = json!({"commandId":"new","name":"Contact","summary":"owner@example.com","details":"A stable decision","reason":"Human reviewed"});
    crate::memory::validate_proposal("memory.add", &good, &context).unwrap();
    for key in [
        "session",
        "projectId",
        "author",
        "sourceEventId",
        "sourceTurnId",
        "sourceCreatedAt",
    ] {
        let mut bad = good.clone();
        bad[key] = json!("foreign");
        assert!(
            crate::memory::validate_proposal("memory.add", &bad, &context).is_err(),
            "{key}"
        );
    }
    let mut secret = good.clone();
    secret["details"] = json!(["sk", "proj", "abcdefghijklmnop12345678"].join("-"));
    assert!(crate::memory::validate_proposal("memory.add", &secret, &context).is_err());
    assert!(crate::memory::validate_proposal("memory.add", &good, &Context::default()).is_err());
    let mut global = good;
    global["scope"] = json!("global");
    crate::memory::validate_proposal("memory.add", &global, &Context::default()).unwrap();
}

#[tokio::test]
async fn policy_commit_uncertainty_faults_execution_but_precommit_error_does_not() {
    for uncertain in [false, true] {
        let mut fixture = Fixture::new().await;
        fixture
            .state
            .registry
            .lock()
            .unwrap()
            .fail_next_commit_for_test(uncertain);
        let error = crate::memory_policy::configure(
            fixture.state.clone(),
            json!({"session":"chat","memory":{"read":false,"write":"off"}}),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "storage_unavailable");
        assert_eq!(
            fixture.state.registry.lock().unwrap().write_poisoned(),
            uncertain
        );
        assert_eq!(
            fixture
                .state
                .execution_storage_failed
                .load(Ordering::Acquire),
            uncertain
        );
        assert_eq!(
            fixture.state.driver.get().unwrap().storage_failed(),
            uncertain
        );
        assert_eq!(fixture.backend.check(fixture.handle.ticket()), !uncertain);
        fixture.close().await;
    }
}

#[tokio::test]
async fn expired_proposal_cannot_seal_even_if_timer_task_has_not_been_polled() {
    let mut fixture = Fixture::new().await;
    let result = fixture
        .backend
        .clone()
        .commit(
            fixture.state.clone(),
            fixture.control(),
            "memory.update".into(),
            fixture.update(),
            fixture.origin(),
            std::time::Instant::now(),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(fixture.record()["version"], 1);
    assert_eq!(fixture.history()["versions"].as_array().unwrap().len(), 1);
    fixture.close().await;
}

#[test]
fn memory_capability_format_is_never_public_memory_content() {
    let key = format!("mt_{}", "a".repeat(64));
    // The global policy must recognize this new purpose; generic hex-word
    // filtering alone misses its underscore prefix.
    assert_eq!(crate::redaction::redact_string(&key), "<token>");
    let value = public_memory(
        json!({"name":key,"summary":"Contact owner@example.com","id":"b".repeat(32)}),
    );
    assert!(!value.to_string().contains(&key));
    assert_eq!(value["id"], "b".repeat(32));
    assert_eq!(value["summary"], "Contact owner@example.com");
}

// Deterministic regression for request-scoped permission journal ownership.
struct AuditProbe;
impl crate::network_guard::Probe for AuditProbe {
    fn probe<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: Duration,
    ) -> crate::network_guard::ProbeFuture<'a> {
        Box::pin(async { panic!("audit never probes a network") })
    }
}
struct AuditResolvedSink {
    inner: Arc<dyn crate::turn_driver::EventSink>,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
    finished: Arc<Notify>,
    blocked_once: Arc<AtomicBool>,
}
impl crate::turn_driver::EventSink for AuditResolvedSink {
    fn append(
        &self,
        draft: Value,
    ) -> Task<Result<crate::turn_driver::Receipt, crate::turn_driver::SinkError>> {
        let inner = self.inner.clone();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let finished = self.finished.clone();
        let blocked_once = self.blocked_once.clone();
        Box::pin(async move {
            let blocked = draft["kind"] == "permission.resolved"
                && !blocked_once.swap(true, Ordering::SeqCst);
            if blocked {
                entered.notify_one();
                release.acquire_owned().await.unwrap().forget();
            }
            let result = inner.append(draft).await;
            if blocked {
                finished.notify_one();
            }
            result
        })
    }
}
async fn audit_memory_permission_drain(timeout: bool, drop_caller: bool) {
    use crate::codex_runtime::{CodexRuntime, Dependencies, Network, TrustedCommand};
    let mut fixture = Fixture::new().await;
    let state = fixture.state.clone();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    struct Release(Arc<Semaphore>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }
    let release_on_exit = Release(release.clone());
    let finished = Arc::new(Notify::new());
    let sink = Arc::new(AuditResolvedSink {
        inner: state.execution_sink(),
        entered: entered.clone(),
        release,
        finished: finished.clone(),
        blocked_once: Arc::new(AtomicBool::new(false)),
    });
    let runtime = CodexRuntime::new(
        Dependencies {
            home: state.home.clone(),
            registry: state.registry.clone(),
            consent: Arc::new(Mutex::new(
                crate::consent_store::ConsentStore::open(&state.home).unwrap(),
            )),
            driver: state.driver.get().unwrap().clone(),
            sink,
        },
        crate::runtime_config::RuntimeConfig::default(),
        TrustedCommand {
            holder: "/bin/echo".into(),
            program: "/bin/echo".into(),
            prefix_args: vec![],
        },
        crate::worker_env::Environment::new(),
        Network::Shared(Arc::new(crate::network_guard::NetworkGuard::new(Arc::new(
            AuditProbe,
        )))),
        Default::default(),
    )
    .unwrap();
    assert!(state.native_runtime.set(runtime.clone()).is_ok());
    let control = fixture.control();
    let proposal = if timeout {
        let backend = fixture.backend.clone();
        let state = state.clone();
        let params = fixture.update();
        let job = control.admit().unwrap();
        let tracked = state.host_jobs.track();
        tokio::spawn(async move {
            let _job = job;
            let _tracked = tracked;
            backend
                .propose(
                    state,
                    control,
                    "memory.update".into(),
                    params,
                    std::time::Instant::now() + Duration::from_millis(100),
                )
                .await
        })
    } else {
        tokio::spawn(
            fixture
                .backend
                .call(Lease(control), "memory.update".into(), fixture.update()),
        )
    };
    bounded(async {
        while runtime.list_permissions(None).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let old_id = runtime.list_permissions(None)[0]["id"].clone();
    let proposal = if drop_caller {
        proposal.abort();
        assert!(proposal.await.unwrap_err().is_cancelled());
        None
    } else {
        Some(proposal)
    };
    if !timeout {
        state.driver.get().unwrap().cancel(fixture.handle.ticket());
    }
    bounded(entered.notified()).await;
    assert!(
        proposal
            .as_ref()
            .is_none_or(|proposal| !proposal.is_finished()),
        "owned memory Job ended before resolved IO"
    );
    assert_eq!(state.driver.get().unwrap().active_count(), 1);
    let drain = fixture.backend.drain(fixture.handle.ticket().clone());
    tokio::pin!(drain);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(drain.as_mut().poll(cx).is_pending()))
            .await
    );
    assert!(
        state
            .driver
            .get()
            .unwrap()
            .execution_snapshot(fixture.handle.ticket())
            .is_some()
    );
    assert!(state.host_jobs.active() > 0);
    drop(release_on_exit);
    bounded(finished.notified()).await;
    if let Some(proposal) = proposal {
        assert!(bounded(proposal).await.unwrap().is_err());
    }
    if timeout {
        state.driver.get().unwrap().cancel(fixture.handle.ticket());
    }
    bounded(drain).await.unwrap();
    bounded(fixture.handle.wait()).await.unwrap();
    assert_eq!(state.driver.get().unwrap().active_count(), 0);
    let key = fixture.handle.ticket().session().clone();
    let snapshot = TurnSnapshot {
        key: key.clone(),
        provider: Provider::Codex,
        cwd: fixture._project.path().canonicalize().unwrap(),
        settings: TurnSettings {
            approval: Approval::Full,
            ..Default::default()
        },
    };
    let mut next = state
        .driver
        .get()
        .unwrap()
        .start(
            snapshot,
            "next turn".into(),
            Arc::new(FixtureWorker(fixture.backend.clone())),
        )
        .unwrap();
    bounded(next.accepted()).await.unwrap();
    let cursor = state.last_event_id.load(Ordering::Acquire);
    state
        .live_sessions
        .lock()
        .unwrap()
        .seed(key.clone(), crate::session_live::Status::Working, cursor)
        .unwrap();
    let mut next_params = fixture.update();
    next_params["commandId"] = json!("new-ticket-proposal");
    let next_control = fixture.backend.control(next.ticket()).unwrap();
    let next_proposal = tokio::spawn(fixture.backend.call(
        Lease(next_control),
        "memory.update".into(),
        next_params,
    ));
    bounded(async {
        while runtime.list_permissions(None).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_ne!(old_id, runtime.list_permissions(None)[0]["id"]);
    assert_eq!(
        state
            .live_sessions
            .lock()
            .unwrap()
            .view(&key)
            .unwrap()
            .status,
        crate::session_live::Status::BlockedPermission
    );
    assert_eq!(runtime.list_permissions(None).len(), 1);
    state.driver.get().unwrap().cancel(next.ticket());
    bounded(next.wait()).await.unwrap();
    assert!(bounded(next_proposal).await.unwrap().is_err());
    bounded(runtime.shutdown()).await.unwrap();
}
#[tokio::test]
async fn audit_memory_cancel_must_hold_ticket_until_resolution_known() {
    audit_memory_permission_drain(false, false).await;
}

#[tokio::test]
async fn memory_proposal_timeout_holds_owned_job_through_scoped_journal_drain() {
    audit_memory_permission_drain(true, false).await;
}
#[tokio::test]
async fn dropped_memory_caller_cannot_lose_scoped_journal_cleanup() {
    audit_memory_permission_drain(false, true).await;
}
