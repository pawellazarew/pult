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

// Future input resource handoff uses the same State/Backend/registration as reads
// and proposals, but borrows the already-current Owner Registry record.
#[tokio::test]
async fn input_scope_rechecks_current_policy_private_fingerprint_and_archive_after_precheck() {
    for change in ["off", "private", "temporary", "approval", "archived"] {
        let mut fixture = Fixture::new().await;
        let scope = fixture
            .backend
            .input_scope(fixture.handle.ticket())
            .unwrap();
        let control = fixture.control();
        {
            let mut registry = fixture.state.registry.lock().unwrap();
            registry
                .update_checked(fixture.handle.ticket().session(), |record| {
                    match change {
                        "off" => record.set_raw(
                            "memory",
                            serde_json::value::to_raw_value(&json!({"read":false,"write":"off"}))?,
                        ),
                        "private" | "temporary" | "archived" => {
                            record.set_raw(change, serde_json::value::to_raw_value(&true)?)
                        }
                        "approval" => record.set_string("approval", "read-only"),
                        _ => unreachable!(),
                    }
                    Ok(())
                })
                .unwrap();
            // No automatic revoke callback: final current-record validation is
            // the only reason this previously preverified scope must fail.
            assert!(control.valid.load(Ordering::Acquire));
            assert!(control.lease.get().unwrap().is_valid());
            let current = registry.find("chat").unwrap();
            assert!(
                scope.enter_current(current).is_err(),
                "{change} admitted stale input memory"
            );
        }
        fixture.close().await;
    }
}

#[tokio::test]
async fn input_scope_metadata_edits_remain_usable_and_do_not_lock_contexts_or_database() {
    let mut fixture = Fixture::new().await;
    let scope = fixture
        .backend
        .input_scope(fixture.handle.ticket())
        .unwrap();
    {
        let mut registry = fixture.state.registry.lock().unwrap();
        registry
            .update_checked(fixture.handle.ticket().session(), |record| {
                record.set_string("title", "Concurrent title survives");
                Ok(())
            })
            .unwrap();
        let state = fixture.state.clone();
        let (held, observing) = mpsc::channel();
        let (finished, wait) = mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _contexts = state.session_memory.lock().unwrap();
            let _database = state.memory.lock().unwrap();
            held.send(()).unwrap();
            // Independent watchdog releases the mutexes on a regression,
            // avoiding an unbounded self-deadlock if enter ever takes them.
            wait.recv_timeout(Duration::from_secs(5)).is_ok()
        });
        observing.recv_timeout(Duration::from_secs(15)).unwrap();
        let permit = scope.enter_current(registry.find("chat").unwrap()).unwrap();
        assert!(fixture.state.execution_admission.try_lock().is_err());
        assert!(scope.control.gate.try_lock().is_err());
        drop(permit);
        finished.send(()).unwrap();
        assert!(
            holder.join().unwrap(),
            "input frontier waited on contexts/database"
        );
    }
    fixture.close().await;
}

#[tokio::test]
async fn input_scope_rejects_foreign_ticket_and_real_drained_replaced_control() {
    let mut fixture = Fixture::new().await;
    let mut foreign = Fixture::new().await;
    assert_ne!(fixture.handle.ticket(), foreign.handle.ticket());
    assert!(
        fixture
            .backend
            .input_scope(foreign.handle.ticket())
            .is_err()
    );
    let old_scope = fixture
        .backend
        .input_scope(fixture.handle.ticket())
        .unwrap();
    let old = fixture.control();
    bounded(fixture.backend.drain(fixture.handle.ticket().clone()))
        .await
        .unwrap();
    assert!(!old.valid.load(Ordering::Acquire));
    fixture
        .backend
        .prepare(
            fixture.handle.ticket().clone(),
            old.snapshot.clone(),
            old.public_turn.clone(),
        )
        .await
        .unwrap();
    let current_scope = fixture
        .backend
        .input_scope(fixture.handle.ticket())
        .unwrap();
    assert!(!Arc::ptr_eq(&old, &current_scope.control));
    {
        let registry = fixture.state.registry.lock().unwrap();
        let current = registry.find("chat").unwrap();
        assert!(old_scope.enter_current(current).is_err());
        let permit = current_scope.enter_current(current).unwrap();
        drop(permit);
    }
    fixture.close().await;
    foreign.close().await;
}

#[tokio::test]
async fn input_scope_final_checks_direct_cancel_driver_fault_global_fault_and_stop() {
    for change in ["cancel", "driver", "global", "stop"] {
        let mut fixture = Fixture::new().await;
        let scope = fixture
            .backend
            .input_scope(fixture.handle.ticket())
            .unwrap();
        match change {
            "cancel" => {
                fixture
                    .state
                    .driver
                    .get()
                    .unwrap()
                    .cancel(fixture.handle.ticket());
            }
            "driver" => fixture.state.driver.get().unwrap().report_storage_failure(),
            "global" => fixture.state.execution_storage_failed(),
            "stop" => crate::runtime_state::begin_shutdown(&fixture.state),
            _ => unreachable!(),
        }
        {
            let registry = fixture.state.registry.lock().unwrap();
            assert!(
                scope.enter_current(registry.find("chat").unwrap()).is_err(),
                "{change} admitted input"
            );
        }
        fixture.close().await;
    }
}

async fn input_peer(fixture: &Fixture) -> Handle {
    let snapshot = {
        let mut registry = fixture.state.registry.lock().unwrap();
        let mut peer = registry.find("chat").unwrap().clone();
        peer.set_string("name", "peer");
        let snapshot = TurnSnapshot {
            key: SessionKey {
                name: "peer".into(),
                created_at: fixture.handle.ticket().session().created_at.clone(),
            },
            provider: Provider::Codex,
            cwd: fixture.control().snapshot.cwd.clone(),
            settings: fixture.control().snapshot.settings.clone(),
        };
        registry.insert(peer).unwrap();
        snapshot
    };
    let mut handle = fixture
        .state
        .driver
        .get()
        .unwrap()
        .start(
            snapshot,
            "independent neighbor".into(),
            Arc::new(FixtureWorker(fixture.backend.clone())),
        )
        .unwrap();
    bounded(handle.accepted()).await.unwrap();
    handle
}

#[tokio::test]
async fn input_permit_holds_control_revoke_until_handoff_drop_and_neighbor_survives() {
    let mut fixture = Fixture::new().await;
    let peer = input_peer(&fixture).await;
    let peer_scope = fixture.backend.input_scope(peer.ticket()).unwrap();
    let scope = fixture
        .backend
        .input_scope(fixture.handle.ticket())
        .unwrap();
    let control = fixture.control();
    {
        let registry = fixture.state.registry.lock().unwrap();
        let permit = scope.enter_current(registry.find("chat").unwrap()).unwrap();
        let (entered, observing) = mpsc::channel();
        let revoking = control.clone();
        let revoke = std::thread::spawn(move || {
            // Establish the precise same Control gate really is pinned.
            assert!(revoking.gate.try_lock().is_err());
            entered.send(()).unwrap();
            revoking.revoke();
        });
        observing.recv_timeout(Duration::from_secs(15)).unwrap();
        assert!(control.valid.load(Ordering::Acquire));
        drop(permit);
        revoke.join().unwrap();
        assert!(!control.valid.load(Ordering::Acquire));
        assert!(scope.enter_current(registry.find("chat").unwrap()).is_err());
        let peer_permit = peer_scope
            .enter_current(registry.find("peer").unwrap())
            .unwrap();
        drop(peer_permit);
        assert!(scope.enter_current(registry.find("peer").unwrap()).is_err());
    }
    fixture.close().await;
}

#[tokio::test]
async fn input_permit_holds_context_lease_revoke_without_context_mutex_and_neighbor_survives() {
    let mut fixture = Fixture::new().await;
    let peer = input_peer(&fixture).await;
    let peer_scope = fixture.backend.input_scope(peer.ticket()).unwrap();
    let scope = fixture
        .backend
        .input_scope(fixture.handle.ticket())
        .unwrap();
    let control = fixture.control();
    let lease = control.lease.get().unwrap().clone();
    {
        let registry = fixture.state.registry.lock().unwrap();
        let permit = scope.enter_current(registry.find("chat").unwrap()).unwrap();
        let (entered, observing) = mpsc::channel();
        let state = fixture.state.clone();
        let revoke = std::thread::spawn(move || {
            let mut contexts = state.session_memory.lock().unwrap();
            entered.send(()).unwrap();
            contexts.revoke("chat")
        });
        observing.recv_timeout(Duration::from_secs(15)).unwrap();
        assert!(fixture.state.session_memory.try_lock().is_err());
        assert!(lease.is_valid());
        assert!(control.valid.load(Ordering::Acquire));
        drop(permit);
        assert_eq!(revoke.join().unwrap(), json!({"revoked":true}));
        assert!(!lease.is_valid());
        assert!(control.valid.load(Ordering::Acquire));
        assert!(scope.enter_current(registry.find("chat").unwrap()).is_err());
        let peer_permit = peer_scope
            .enter_current(registry.find("peer").unwrap())
            .unwrap();
        drop(peer_permit);
    }
    fixture.close().await;
}

#[test]
fn input_scope_permits_have_no_send_debug_clone_or_serialization_surface() {
    // Ambiguity becomes a compile error if a forbidden trait is introduced.
    macro_rules! not_impl {
        ($ty:ty, $bound:path) => {{
            trait AmbiguousIfImplemented<A> {
                fn check() {}
            }
            impl<T: ?Sized> AmbiguousIfImplemented<()> for T {}
            impl<T: ?Sized + $bound> AmbiguousIfImplemented<u8> for T {}
            let _ = <$ty as AmbiguousIfImplemented<_>>::check;
        }};
    }
    not_impl!(InputScope, std::fmt::Debug);
    not_impl!(InputScope, Clone);
    not_impl!(InputScope, serde::Serialize);
    not_impl!(InputScopePermit<'static>, Send);
    not_impl!(InputScopePermit<'static>, std::fmt::Debug);
    not_impl!(InputScopePermit<'static>, Clone);
    not_impl!(InputScopePermit<'static>, serde::Serialize);
    not_impl!(session_memory::MemoryLeaseAdmission<'static>, Send);
    not_impl!(
        session_memory::MemoryLeaseAdmission<'static>,
        std::fmt::Debug
    );
    not_impl!(session_memory::MemoryLeaseAdmission<'static>, Clone);
    not_impl!(
        session_memory::MemoryLeaseAdmission<'static>,
        serde::Serialize
    );
}

#[tokio::test]
async fn input_scope_gate_and_context_poison_fail_closed_without_payloads() {
    for change in ["execution", "control", "contexts"] {
        let mut fixture = Fixture::new().await;
        let scope = fixture
            .backend
            .input_scope(fixture.handle.ticket())
            .unwrap();
        let state = fixture.state.clone();
        let control = fixture.control();
        crate::panic_guard::install();
        let poisoned = std::thread::spawn(move || match change {
            "execution" => {
                let _guard = state.execution_admission.lock().unwrap();
                panic!("synthetic private execution poison");
            }
            "control" => {
                let _guard = control.gate.lock().unwrap();
                panic!("synthetic private control poison");
            }
            "contexts" => {
                let _guard = state.session_memory.lock().unwrap();
                panic!("synthetic private context poison");
            }
            _ => unreachable!(),
        });
        assert!(poisoned.join().is_err());
        {
            let registry = fixture.state.registry.lock().unwrap();
            let failure = scope
                .enter_current(registry.find("chat").unwrap())
                .err()
                .expect("poisoned admission allowed");
            assert_eq!(failure.code, "forbidden");
            assert_eq!(failure.message, "memory turn preparation failed");
        }
        fixture.close().await;
    }
}

fn bridge_fixture(
    f: &Fixture,
) -> (
    Arc<crate::codex_memory::Registration>,
    Arc<crate::codex_memory::Turn>,
) {
    let registration = f
        .backend
        .bridge()
        .register(f.handle.ticket().session().clone(), "fixture-host-epoch")
        .unwrap();
    let turn = registration
        .turn(
            f.handle.ticket().clone(),
            Some(crate::codex_memory::Handle::test(
                f.backend.clone(),
                f.handle.ticket().clone(),
                Lease(f.control()),
            )),
        )
        .unwrap();
    registration.bind("fixture-native-thread").unwrap();
    (registration, turn)
}
fn bridge_envelope(native: &str, call: &str) -> Value {
    json!({"name":"memory_list","arguments":{},"meta":{"threadId":"fixture-native-thread","callId":call,"x-codex-turn-metadata":{"thread_id":"fixture-native-thread","turn_id":native}}})
}
fn bridge_started(turn: &crate::codex_memory::Turn, native: &str, call: &str) {
    turn.native(native, true, true).unwrap();
    turn.ledger(
        native,
        &json!({"id":call,"server":"pult_memory","tool":"memory_list","arguments":{}}),
    )
    .unwrap();
}
#[tokio::test]
async fn persistent_bridge_requires_native_started_ack_and_ledger_then_consumes_once() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    let request = registration
        .clone()
        .call(bridge_envelope("native-A", "call-A"));
    tokio::pin!(request);
    assert!(matches!(
        request
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    turn.native("native-A", true, false).unwrap();
    turn.ledger(
        "native-A",
        &json!({"id":"call-A","server":"pult_memory","tool":"memory_list","arguments":{}}),
    )
    .unwrap();
    assert!(matches!(
        request
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    turn.native("native-A", false, true).unwrap();
    assert!(bounded(request).await.unwrap()["memories"].is_array());
    assert_eq!(
        registration
            .clone()
            .call(bridge_envelope("native-A", "call-A"))
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_forged_metadata_without_ledger_and_dropped_waiter_do_no_io() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    turn.native("native-A", true, true).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let read = reads.clone();
    *f.backend.hooks.read.lock().unwrap() = Some(Box::new(move || {
        read.fetch_add(1, Ordering::AcqRel);
    }));
    let mut request = Box::pin(
        registration
            .clone()
            .call(bridge_envelope("native-A", "forged-call")),
    );
    assert!(matches!(
        request
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    drop(request);
    turn.ledger(
        "native-A",
        &json!({"id":"forged-call","server":"pult_memory","tool":"memory_list","arguments":{}}),
    )
    .unwrap();
    assert_eq!(reads.load(Ordering::Acquire), 0);
    let mut no_ledger = Box::pin(
        registration
            .clone()
            .call(bridge_envelope("native-A", "direct-public-rpc")),
    );
    assert!(matches!(
        no_ledger
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    turn.close();
    assert_eq!(bounded(no_ledger).await.unwrap_err().code, "forbidden");
    assert_eq!(reads.load(Ordering::Acquire), 0);
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_rejects_foreign_thread_turn_tool_and_argument_meta_authority() {
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    bridge_started(&turn, "native-A", "call-A");
    for mutation in 0..5 {
        let mut envelope = bridge_envelope("native-A", "call-A");
        match mutation {
            0 => envelope["meta"]["threadId"] = json!("child-thread"),
            1 => envelope["meta"]["x-codex-turn-metadata"]["thread_id"] = json!("child-thread"),
            2 => envelope["meta"]["x-codex-turn-metadata"]["turn_id"] = json!("native-B"),
            3 => envelope["name"] = json!("memory_catalog"),
            _ => {
                envelope["arguments"]["_meta"] = envelope["meta"].take();
            }
        }
        assert_eq!(
            bounded(registration.clone().call(envelope))
                .await
                .unwrap_err()
                .code,
            "forbidden"
        );
    }
    assert!(
        bounded(
            registration
                .clone()
                .call(bridge_envelope("native-A", "call-A"))
        )
        .await
        .is_ok()
    );
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_caller_drop_after_admission_keeps_real_read_until_driver_drain() {
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    bridge_started(&turn, "native-A", "call-A");
    let barrier = Barrier::install(&f.backend.hooks.read);
    let request = tokio::spawn(registration.call(bridge_envelope("native-A", "call-A")));
    barrier.entered().await;
    request.abort();
    let _ = request.await;
    turn.close();
    let closing = f.backend.drain(f.handle.ticket().clone());
    tokio::pin!(closing);
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    assert!(matches!(
        closing
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    assert!(f.control().jobs.load(Ordering::Acquire) > 0);
    barrier.release();
    bounded(closing).await.unwrap();
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_late_a_stays_denied_before_and_after_b_on_same_registration() {
    let mut f = Fixture::new().await;
    let (registration, a) = bridge_fixture(&f);
    bridge_started(&a, "native-A", "call-A");
    let snapshot = f.control().snapshot.clone();
    a.close();
    f.state.driver.get().unwrap().cancel(f.handle.ticket());
    bounded(f.handle.wait()).await.unwrap();
    assert!(
        registration
            .clone()
            .call(bridge_envelope("native-A", "call-A"))
            .await
            .is_err()
    );
    let mut handle = f
        .state
        .driver
        .get()
        .unwrap()
        .start(
            snapshot,
            "second".into(),
            Arc::new(FixtureWorker(f.backend.clone())),
        )
        .unwrap();
    bounded(handle.accepted()).await.unwrap();
    let b = registration
        .turn(
            handle.ticket().clone(),
            Some(crate::codex_memory::Handle::test(
                f.backend.clone(),
                handle.ticket().clone(),
                Lease(f.backend.control(handle.ticket()).unwrap()),
            )),
        )
        .unwrap();
    bridge_started(&b, "native-B", "call-B");
    assert!(
        registration
            .clone()
            .call(bridge_envelope("native-A", "call-A"))
            .await
            .is_err()
    );
    assert!(
        registration
            .clone()
            .call(bridge_envelope("native-B", "call-B"))
            .await
            .is_ok()
    );
    b.close();
    f.state.driver.get().unwrap().cancel(handle.ticket());
    bounded(handle.wait()).await.unwrap();
    f.close().await;
}

#[tokio::test]
async fn persistent_bridge_changed_arguments_do_not_consume_a_legitimate_call() {
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    bridge_started(&turn, "native-A", "call-A");
    let mut forged = bridge_envelope("native-A", "call-A");
    forged["arguments"] = json!({"scope":"global"});
    assert_eq!(
        registration.clone().call(forged).await.unwrap_err().code,
        "forbidden"
    );
    assert!(
        registration
            .call(bridge_envelope("native-A", "call-A"))
            .await
            .is_ok()
    );
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_readonly_proposal_is_rejected_before_backend_and_broker() {
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    turn.native("native-A", true, true).unwrap();
    f.control().writable.store(false, Ordering::Release);
    let calls = f.control().jobs.load(Ordering::Acquire);
    let mut envelope = bridge_envelope("native-A", "write-call");
    envelope["name"] = json!("memory_propose");
    envelope["arguments"] = f.update();
    envelope["arguments"]["operation"] = json!("update");
    assert_eq!(
        registration.call(envelope).await.unwrap_err().code,
        "forbidden"
    );
    assert_eq!(f.control().jobs.load(Ordering::Acquire), calls);
    assert_eq!(f.record()["version"], 1);
    f.close().await;
}
struct BeforeAcceptedBridgeWorker {
    backend: Arc<Backend>,
    prepared: Arc<Notify>,
    release: Arc<Notify>,
}
impl Worker for BeforeAcceptedBridgeWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        _text: String,
    ) -> Task<Result<Started, WorkerError>> {
        let backend = self.backend.clone();
        let prepared = self.prepared.clone();
        let release = self.release.clone();
        Box::pin(async move {
            backend
                .prepare(ticket, snapshot, "pending-driver-turn".into())
                .await?;
            prepared.notify_one();
            release.notified().await;
            Ok(Started {
                turn_id: "pending-driver-turn".into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        self.backend.revoke(&ticket);
        self.backend.drain(ticket)
    }
}
#[tokio::test]
async fn persistent_bridge_native_ack_and_started_cannot_substitute_for_actual_driver_accepted() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let mut f = Fixture::new().await;
    let snapshot = f.control().snapshot.clone();
    f.state.driver.get().unwrap().cancel(f.handle.ticket());
    bounded(f.handle.wait()).await.unwrap();
    let prepared = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut handle = f
        .state
        .driver
        .get()
        .unwrap()
        .start(
            snapshot,
            "new".into(),
            Arc::new(BeforeAcceptedBridgeWorker {
                backend: f.backend.clone(),
                prepared: prepared.clone(),
                release: release.clone(),
            }),
        )
        .unwrap();
    bounded(prepared.notified()).await;
    let registration = f
        .backend
        .bridge()
        .register(handle.ticket().session().clone(), "accepted-test-host")
        .unwrap();
    registration.bind("fixture-native-thread").unwrap();
    let turn = registration
        .turn(
            handle.ticket().clone(),
            Some(crate::codex_memory::Handle::test(
                f.backend.clone(),
                handle.ticket().clone(),
                Lease(f.backend.control(handle.ticket()).unwrap()),
            )),
        )
        .unwrap();
    bridge_started(&turn, "native-A", "call-A");
    let reads = Arc::new(AtomicUsize::new(0));
    let read = reads.clone();
    *f.backend.hooks.read.lock().unwrap() = Some(Box::new(move || {
        read.fetch_add(1, Ordering::AcqRel);
    }));
    let mut request = Box::pin(registration.call(bridge_envelope("native-A", "call-A")));
    assert!(matches!(
        request
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    assert_eq!(reads.load(Ordering::Acquire), 0);
    release.notify_one();
    bounded(handle.accepted()).await.unwrap();
    assert!(bounded(request).await.is_ok());
    assert_eq!(reads.load(Ordering::Acquire), 1);
    turn.close();
    f.state.driver.get().unwrap().cancel(handle.ticket());
    bounded(handle.wait()).await.unwrap();
    f.close().await;
}

#[tokio::test]
async fn persistent_bridge_pending_waiters_are_bounded_and_released_on_caller_drop() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    turn.native("native-A", true, true).unwrap();
    let mut requests = Vec::new();
    for n in 0..16 {
        let mut request = Box::pin(
            registration
                .clone()
                .call(bridge_envelope("native-A", &format!("pending-{n}"))),
        );
        assert!(matches!(
            request
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop())),
            Poll::Pending
        ));
        requests.push(request);
    }
    assert_eq!(
        registration
            .clone()
            .call(bridge_envelope("native-A", "overflow"))
            .await
            .unwrap_err()
            .code,
        "capacity"
    );
    requests.pop();
    let mut replacement = Box::pin(
        registration
            .clone()
            .call(bridge_envelope("native-A", "replacement")),
    );
    assert!(matches!(
        replacement
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    turn.close();
    assert_eq!(bounded(replacement).await.unwrap_err().code, "forbidden");
    for request in requests {
        assert_eq!(bounded(request).await.unwrap_err().code, "forbidden");
    }
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_missing_ack_and_immediate_off_revoke_never_admit_io() {
    use std::{
        future::Future,
        task::{Context, Poll, Waker},
    };
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    turn.native("native-A", false, true).unwrap();
    turn.ledger(
        "native-A",
        &json!({"id":"call-A","server":"pult_memory","tool":"memory_list","arguments":{}}),
    )
    .unwrap();
    let mut request = Box::pin(
        registration
            .clone()
            .call(bridge_envelope("native-A", "call-A")),
    );
    assert!(matches!(
        request
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    let jobs = f.control().jobs.load(Ordering::Acquire);
    f.backend.revoke_session("chat");
    assert_eq!(bounded(request).await.unwrap_err().code, "forbidden");
    assert_eq!(f.control().jobs.load(Ordering::Acquire), jobs);
    f.close().await;
}

#[tokio::test]
async fn persistent_bridge_closed_native_id_cannot_be_rebound_to_b_before_first_native_binding() {
    let mut f = Fixture::new().await;
    let (registration, a) = bridge_fixture(&f);
    bridge_started(&a, "native-A", "call-A");
    let snapshot = f.control().snapshot.clone();
    a.close();
    f.state.driver.get().unwrap().cancel(f.handle.ticket());
    bounded(f.handle.wait()).await.unwrap();
    let mut handle = f
        .state
        .driver
        .get()
        .unwrap()
        .start(
            snapshot,
            "second".into(),
            Arc::new(FixtureWorker(f.backend.clone())),
        )
        .unwrap();
    bounded(handle.accepted()).await.unwrap();
    let b = registration
        .turn(
            handle.ticket().clone(),
            Some(crate::codex_memory::Handle::test(
                f.backend.clone(),
                handle.ticket().clone(),
                Lease(f.backend.control(handle.ticket()).unwrap()),
            )),
        )
        .unwrap();
    assert_eq!(
        b.native("native-A", true, true).unwrap_err().code,
        "forbidden"
    );
    assert!(!registration.available());
    assert!(
        registration
            .clone()
            .call(bridge_envelope("native-A", "call-A"))
            .await
            .is_err()
    );
    assert!(b.native("native-B", true, true).is_err());
    f.state.driver.get().unwrap().cancel(handle.ticket());
    bounded(handle.wait()).await.unwrap();
    f.close().await;
}

#[tokio::test]
async fn persistent_bridge_ledger_overflow_closes_before_pending_calls_can_admit() {
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    turn.native("native-A", true, true).unwrap();
    for n in 0..256 {
        turn.ledger("native-A",&json!({"id":format!("call-{n}"),"server":"pult_memory","tool":"memory_list","arguments":{}})).unwrap();
    }
    assert_eq!(
        turn.ledger(
            "native-A",
            &json!({"id":"overflow","server":"pult_memory","tool":"memory_list","arguments":{}})
        )
        .unwrap_err()
        .code,
        "capacity"
    );
    assert_eq!(
        registration
            .call(bridge_envelope("native-A", "call-0"))
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    assert_eq!(f.control().jobs.load(Ordering::Acquire), 0);
    assert_eq!(f.record()["version"], 1);
    f.close().await;
}
#[tokio::test]
async fn persistent_bridge_missing_or_oversize_native_arguments_close_without_io() {
    for arguments in [None, Some(json!({"payload":"x".repeat(64*1024)}))] {
        let mut f = Fixture::new().await;
        let (registration, turn) = bridge_fixture(&f);
        turn.native("native-A", true, true).unwrap();
        let mut item = json!({"id":"call-A","server":"pult_memory","tool":"memory_list"});
        if let Some(arguments) = arguments {
            item["arguments"] = arguments;
        }
        assert!(turn.ledger("native-A", &item).is_err());
        assert!(
            registration
                .call(bridge_envelope("native-A", "call-A"))
                .await
                .is_err()
        );
        assert_eq!(f.control().jobs.load(Ordering::Acquire), 0);
        f.close().await;
    }
}

#[tokio::test]
async fn persistent_bridge_unpolled_tasks_already_own_count_and_aggregate_byte_budget() {
    let mut f = Fixture::new().await;
    let (registration, turn) = bridge_fixture(&f);
    turn.native("native-A", true, true).unwrap();
    let mut tasks = Vec::new();
    for n in 0..16 {
        tasks.push(
            registration
                .clone()
                .call(bridge_envelope("native-A", &format!("unpolled-{n}"))),
        );
    }
    assert_eq!(
        registration
            .clone()
            .call(bridge_envelope("native-A", "overflow"))
            .await
            .unwrap_err()
            .code,
        "capacity"
    );
    drop(tasks);
    let mut tasks = Vec::new();
    for n in 0..8 {
        let mut envelope = bridge_envelope("native-A", &format!("large-{n}"));
        envelope["name"] = json!("memory_search");
        envelope["arguments"] = json!({"query":"x".repeat(60*1024)});
        tasks.push(registration.clone().call(envelope));
    }
    let mut extra = bridge_envelope("native-A", "byte-overflow");
    extra["name"] = json!("memory_search");
    extra["arguments"] = json!({"query":"x".repeat(60*1024)});
    assert_eq!(
        registration.clone().call(extra).await.unwrap_err().code,
        "capacity"
    );
    drop(tasks);
    let mut oversized = bridge_envelope("native-A", "oversized");
    oversized["arguments"] = json!({"query":"x".repeat(64*1024)});
    assert_eq!(
        registration.clone().call(oversized).await.unwrap_err().code,
        "capacity"
    );
    turn.ledger(
        "native-A",
        &json!({"id":"legitimate","server":"pult_memory","tool":"memory_list","arguments":{}}),
    )
    .unwrap();
    assert!(
        registration
            .call(bridge_envelope("native-A", "legitimate"))
            .await
            .is_ok()
    );
    f.close().await;
}
