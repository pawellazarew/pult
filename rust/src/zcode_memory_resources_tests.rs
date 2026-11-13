use super::*;
use crate::{
    memory::{Context, MemoryStore},
    permission_broker::{Decision, Scope},
    turn_driver::{Handle, Progress, Started, Worker},
    turn_snapshot::{Approval, TurnSnapshot},
    zcode_appserver_protocol::{OutboundRequest, RequestId, Workspace},
    zcode_host_services::{
        AppServerAttempt, HostInputIds, NativeSessionReceipt, ReserveRequest, ZcodeOwner,
    },
};
use serde_json::json;
use std::{
    future::Future,
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};
use tokio::sync::Notify;
const GENERATION: u64 = 7;
const PUBLIC_TURN: &str = "zcode-memory-fixture-turn";
const WATCHDOG: Duration = Duration::from_secs(15);
struct Pause {
    entered: Arc<Notify>,
    release: oneshot::Receiver<()>,
}
#[derive(Default)]
pub(super) struct Hooks {
    backend: Mutex<Option<Pause>>,
    catalog: Mutex<Option<Pause>>,
    panic_after_construct: AtomicBool,
}
impl Hooks {
    async fn fire(slot: &Mutex<Option<Pause>>) {
        let pause = slot.lock().unwrap().take();
        if let Some(pause) = pause {
            pause.entered.notify_one();
            let _ = pause.release.await;
        }
    }
    pub(super) async fn before_backend(&self) {
        Self::fire(&self.backend).await;
    }
    pub(super) async fn before_catalog(&self) {
        Self::fire(&self.catalog).await;
    }
    pub(super) fn after_backend_construct(&self) {
        assert!(
            !self.panic_after_construct.swap(false, Ordering::AcqRel),
            "synthetic factory preparation panic after real Backend call"
        );
    }
}
struct Barrier {
    entered: Arc<Notify>,
    release: Option<oneshot::Sender<()>>,
}
impl Barrier {
    fn new(slot: &Mutex<Option<Pause>>) -> Self {
        let entered = Arc::new(Notify::new());
        let (send, receive) = oneshot::channel();
        *slot.lock().unwrap() = Some(Pause {
            entered: entered.clone(),
            release: receive,
        });
        Self {
            entered,
            release: Some(send),
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
        if let Some(send) = self.release.take() {
            let _ = send.send(());
        }
    }
}
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(WATCHDOG, future)
        .await
        .expect("ZCode memory factory watchdog")
}
struct Holding {
    factory: Arc<Factory>,
    started: Mutex<Option<oneshot::Sender<(Ticket, TurnSnapshot)>>>,
    accepted: Mutex<Option<oneshot::Receiver<()>>>,
}
impl Worker for Holding {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        _: String,
    ) -> Task<Result<Started, WorkerError>> {
        self.started
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send((ticket, snapshot))
            .ok();
        let accepted = self.accepted.lock().unwrap().take().unwrap();
        Box::pin(async move {
            accepted.await.map_err(|_| unavailable())?;
            Ok(Started {
                turn_id: PUBLIC_TURN.into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        self.factory.revoke(&ticket, GENERATION);
        self.factory.drain(ticket, GENERATION)
    }
}
struct Fixture {
    _home: tempfile::TempDir,
    state: Arc<crate::State>,
    memory: Arc<Backend>,
    factory: Arc<Factory>,
    owner: Arc<ZcodeOwner>,
    handle: Handle,
    context: ResourceContext,
    accept: Option<oneshot::Sender<()>>,
    note: Value,
    memory_context: Context,
}
impl Fixture {
    async fn new(approval: Approval, policy: Option<Value>) -> Self {
        Self::with_helper(approval, policy, "/synthetic/pult-memory-mcp".into()).await
    }
    async fn with_helper(approval: Approval, policy: Option<Value>, helper: PathBuf) -> Self {
        let (home, state, _sink) = crate::runtime_journal::tests::fixture();
        crate::panic_guard::install();
        let project = state.home.join("project");
        std::fs::create_dir(&project).unwrap();
        let cwd = project.canonicalize().unwrap();
        *state.memory.lock().unwrap() = Ok(MemoryStore::open(&state.home).unwrap());
        let key = SessionKey {
            name: "chat".into(),
            created_at: "2026-11-13T00:00:00Z".into(),
        };
        let mut record = crate::registry::Record::default();
        for (field, value) in [
            ("name", key.name.as_str()),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("cwd", cwd.to_str().unwrap()),
            ("scope", "project"),
            ("approval", approval.as_str()),
            ("status", "cold"),
        ] {
            record.set_string(field, value);
        }
        if let Some(policy) = policy {
            record.set_raw("memory", serde_json::value::to_raw_value(&policy).unwrap());
        }
        state.registry.lock().unwrap().insert(record).unwrap();
        let memory = Backend::new(Arc::downgrade(&state), helper);
        state.memory_turns.set(memory.clone()).ok().unwrap();
        let factory = Factory::new(memory.clone(), key.clone()).unwrap();
        let mut consent = crate::consent_store::ConsentStore::open(&state.home).unwrap();
        consent
            .grant(&[Provider::Zcode], chrono::Utc::now())
            .unwrap();
        let consent = Arc::new(Mutex::new(consent));
        let owner = ZcodeOwner::new(
            state.home.clone(),
            state.registry.clone(),
            Arc::downgrade(state.driver.get().unwrap()),
            consent,
            Arc::new(|_, _| true),
            Arc::new(|| {}),
        )
        .unwrap();
        let (started, waiting) = oneshot::channel();
        let (accept, accepted) = oneshot::channel();
        let snapshot = owner.snapshot(&key).unwrap();
        let handle = state
            .driver
            .get()
            .unwrap()
            .start(
                snapshot,
                "fixture user task".into(),
                Arc::new(Holding {
                    factory: factory.clone(),
                    started: Mutex::new(Some(started)),
                    accepted: Mutex::new(Some(accepted)),
                }),
            )
            .unwrap();
        let (ticket, snapshot) = bounded(waiting).await.unwrap();
        assert_eq!(ticket, *handle.ticket());
        let context = ResourceContext {
            ticket,
            snapshot,
            generation: GENERATION,
            public_turn: PUBLIC_TURN.into(),
        };
        let memory_context = Context {
            project_id: Some(crate::memory_project::resolve(&cwd).unwrap()),
            session: Some(key.name),
        };
        let note=state.memory.lock().unwrap().as_mut().unwrap().execute("memory.add",&json!({"commandId":"owner-seed","name":"Shared convention","summary":"Native data only","details":"Keep this shared across providers","reason":"Owner seeded fixture"}),&memory_context).unwrap();
        Self {
            _home: home,
            state,
            memory,
            factory,
            owner,
            handle,
            context,
            accept: Some(accept),
            note,
            memory_context,
        }
    }
    async fn prepare(&self) {
        bounded(self.factory.prepare(self.context.clone()))
            .await
            .unwrap();
    }
    fn key(&self) -> String {
        self.factory.entry.get().unwrap().server.get().unwrap()["env"]["PULT_MEMORY_TURN_KEY"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn binding(&self) -> (AppServerAttempt, NativeSessionReceipt) {
        let attempt = self
            .owner
            .reserve_app_server(
                ReserveRequest::new(
                    self.context.ticket.clone(),
                    self.context.snapshot.clone(),
                    GENERATION,
                    PUBLIC_TURN.into(),
                    Instant::now() + Duration::from_secs(30),
                ),
                HostInputIds::new("fixture-input".into(), "fixture-query".into()).unwrap(),
            )
            .unwrap();
        // Owner contract only: no native process is claimed to have launched.
        assert!(self.owner.seal_spawn(attempt.attempt()));
        let identity = self
            .owner
            .record_app_server_session(&attempt, "fixture-native-session")
            .unwrap();
        (attempt, identity)
    }
    async fn accepted(&mut self) {
        self.accept.take().unwrap().send(()).unwrap();
        bounded(self.handle.accepted()).await.unwrap();
    }
    fn record(&self) -> Value {
        self.state
            .memory
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .execute(
                "memory.get",
                &json!({"id":self.note["id"]}),
                &self.memory_context,
            )
            .unwrap()
    }
    async fn finish(&mut self) {
        self.state
            .driver
            .get()
            .unwrap()
            .cancel(self.handle.ticket());
        bounded(self.handle.wait()).await.unwrap();
        bounded(self.state.host_jobs.wait()).await;
        assert_eq!(self.state.driver.get().unwrap().active_count(), 0);
    }
}
fn on() -> Option<Value> {
    Some(json!({"read":true,"write":"ask"}))
}

#[tokio::test]
async fn shared_backend_catalog_and_private_native_stdio_shape_without_owner_or_ask_keys() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    f.prepare().await;
    let key = f.key();
    assert!(crate::memory_turn::valid_key(&key));
    assert!(f.memory.lookup(&key).is_some());
    assert!(Arc::ptr_eq(
        &f.factory.memory,
        f.state.memory_turns.get().unwrap()
    ));
    let catalog = bounded(f.factory.catalog(f.context.ticket.clone(), GENERATION))
        .await
        .unwrap()
        .unwrap();
    assert!(catalog.contains("Shared convention") && catalog.contains("Native data only"));
    assert!(!catalog.contains(&key));
    let entry = f.factory.entry.get().unwrap();
    let typed = native_server(entry.server.get().unwrap(), &f.context).unwrap();
    let frame = OutboundRequest::create(
        RequestId::string("fixture-create").unwrap(),
        "fixture-native-session",
        Workspace::new(f.context.snapshot.cwd.to_str().unwrap(), "workspace-key").unwrap(),
        vec![typed],
    )
    .unwrap()
    .encode()
    .unwrap();
    let value: Value = serde_json::from_slice(&frame).unwrap();
    let server = &value["params"]["mcpServers"][0];
    assert_eq!(server["name"], "pult-memory");
    assert_eq!(server["isolation"], "session");
    assert_eq!(server["cwd"], f.context.snapshot.cwd.to_str().unwrap());
    assert_eq!(server["env"].as_array().unwrap().len(), 1);
    assert_eq!(server["env"][0]["name"], "PULT_MEMORY_TURN_KEY");
    assert!(server["env"][0]["value"].as_str() == Some(key.as_str()));
    assert!(server.get("default_tools_approval_mode").is_none());
    assert!(server["env"].as_array().unwrap().iter().all(|v| !matches!(
        v["name"].as_str(),
        Some("HOME" | "PULT_ASK_KEY" | "PULT_TOKEN")
    )));
    assert!(f.state.claude_asks.get().is_none());
    let raw = f
        .state
        .store
        .lock()
        .unwrap()
        .read_from(0, None, usize::MAX, crate::MAX_LINE)
        .unwrap()
        .into_iter()
        .map(|e| e.json.get().to_owned())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!raw.contains(&key));
    f.finish().await;
    assert!(f.memory.lookup(&key).is_none());
}

#[tokio::test]
async fn off_policy_is_unavailable_without_dummy_servers_or_backend_registration() {
    let mut f = Fixture::new(Approval::Ask, None).await;
    assert!(bounded(f.factory.prepare(f.context.clone())).await.is_err());
    assert!(f.factory.entry.get().unwrap().scope.get().is_none());
    assert!(!f.memory.check(f.handle.ticket()));
    assert!(
        f.state.session_memory.lock().unwrap().status(None)["contexts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    bounded(f.factory.drain(f.context.ticket.clone(), GENERATION))
        .await
        .unwrap();
    f.finish().await;
}

#[tokio::test]
async fn invalid_context_and_duplicate_prepare_cannot_revoke_an_existing_generation() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    let mut invalid = f.context.clone();
    invalid.snapshot.provider = Provider::Claude;
    assert!(bounded(f.factory.prepare(invalid)).await.is_err());
    assert!(f.factory.entry.get().is_none());
    f.prepare().await;
    let key = f.key();
    let mut wrong = f.context.clone();
    wrong.generation += 1;
    for context in [f.context.clone(), wrong] {
        assert!(bounded(f.factory.prepare(context)).await.is_err());
    }
    f.factory.revoke(&f.context.ticket, GENERATION + 1);
    bounded(f.factory.drain(f.context.ticket.clone(), GENERATION + 1))
        .await
        .unwrap();
    assert!(f.memory.lookup(&key).is_some());
    assert!(
        bounded(f.factory.catalog(f.context.ticket.clone(), GENERATION))
            .await
            .is_ok()
    );
    f.finish().await;
}

#[tokio::test]
async fn early_exact_tombstone_prevents_late_prepare_but_wrong_generation_does_not() {
    for exact in [false, true] {
        let mut f = Fixture::new(Approval::Ask, on()).await;
        let generation = GENERATION + u64::from(!exact);
        bounded(f.factory.drain(f.context.ticket.clone(), generation))
            .await
            .unwrap();
        if exact {
            assert!(bounded(f.factory.prepare(f.context.clone())).await.is_err());
            assert!(f.factory.entry.get().is_none());
            assert!(!f.memory.check(f.handle.ticket()));
            assert!(
                f.state.session_memory.lock().unwrap().status(None)["contexts"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
        } else {
            f.prepare().await;
            assert!(f.memory.lookup(&f.key()).is_some());
        }
        f.finish().await;
    }
}

#[tokio::test]
async fn early_tombstones_have_a_fixed_bound_and_overflow_never_starts_backend() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    // Exclude the legitimate generation: overflow, not an exact tombstone,
    // must be the only reason its later preparation is denied.
    for generation in GENERATION + 1..=GENERATION + MAX_EARLY_REVOKES as u64 + 1 {
        f.factory.revoke(&f.context.ticket, generation);
    }
    assert!(f.factory.install.lock().unwrap().exhausted);
    assert_eq!(
        f.factory.install.lock().unwrap().early.len(),
        MAX_EARLY_REVOKES
    );
    assert!(bounded(f.factory.prepare(f.context.clone())).await.is_err());
    assert!(f.factory.entry.get().is_none());
    assert!(!f.memory.check(f.handle.ticket()));
    f.finish().await;
}

#[tokio::test]
async fn dropped_prepare_waiter_and_drain_retain_late_backend_issuance_until_joined() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    let barrier = Barrier::new(&f.factory.hooks.backend);
    let pending = f.factory.prepare(f.context.clone());
    barrier.entered().await;
    drop(pending);
    // Assert before calling drain: drain must not mask a missing Drop guard.
    assert!(!f.factory.entry.get().unwrap().valid.load(Ordering::Acquire));
    let mut draining = f.factory.drain(f.context.ticket.clone(), GENERATION);
    use std::task::{Context as PollContext, Waker};
    assert!(
        draining
            .as_mut()
            .poll(&mut PollContext::from_waker(Waker::noop()))
            .is_pending()
    );
    assert!(!f.factory.entry.get().unwrap().valid.load(Ordering::Acquire));
    assert!(
        f.state.session_memory.lock().unwrap().status(None)["contexts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(f.state.driver.get().unwrap().active_count(), 1);
    barrier.release();
    bounded(draining).await.unwrap();
    let key = f.key();
    assert!(f.memory.lookup(&key).is_none());
    assert!(!f.memory.check(f.handle.ticket()));
    f.finish().await;
}

#[tokio::test]
async fn cancelled_catalog_keeps_actual_database_io_owned_until_its_release() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    let barrier = Barrier::new(&f.factory.hooks.catalog);
    let pending = f.factory.prepare(f.context.clone());
    barrier.entered().await;
    let key = f.key();
    let state = f.state.clone();
    let (held, observed) = mpsc::channel();
    let (release, waiting) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _db = state.memory.lock().unwrap();
        held.send(()).unwrap();
        waiting.recv_timeout(WATCHDOG).unwrap();
    });
    observed.recv_timeout(WATCHDOG).unwrap();
    barrier.release();
    bounded(async {
        while f.state.host_jobs.active() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await;
    drop(pending);
    // Assert before calling drain: drain must not mask a missing Drop guard.
    assert!(!f.factory.entry.get().unwrap().valid.load(Ordering::Acquire));
    let mut draining = f.factory.drain(f.context.ticket.clone(), GENERATION);
    use std::task::{Context as PollContext, Waker};
    assert!(
        draining
            .as_mut()
            .poll(&mut PollContext::from_waker(Waker::noop()))
            .is_pending()
    );
    assert!(f.state.host_jobs.active() > 0);
    assert!(f.memory.lookup(&key).is_none());
    release.send(()).unwrap();
    holder.join().unwrap();
    bounded(draining).await.unwrap();
    assert_eq!(f.state.host_jobs.active(), 0);
    f.finish().await;
}

#[tokio::test]
async fn ordinary_backend_error_drains_clean_but_owned_preparation_panic_stays_unconfirmed() {
    let mut normal = Fixture::new(Approval::Ask, on()).await;
    let barrier = Barrier::new(&normal.factory.hooks.backend);
    let pending = normal.factory.prepare(normal.context.clone());
    barrier.entered().await;
    normal
        .state
        .registry
        .lock()
        .unwrap()
        .update_checked(normal.context.ticket.session(), |r| {
            r.set_raw(
                "memory",
                serde_json::value::to_raw_value(&json!({"read":false,"write":"off"}))?,
            );
            Ok(())
        })
        .unwrap();
    barrier.release();
    assert!(bounded(pending).await.is_err());
    bounded(
        normal
            .factory
            .drain(normal.context.ticket.clone(), GENERATION),
    )
    .await
    .unwrap();
    normal.finish().await;

    let mut f = Fixture::new(Approval::Ask, on()).await;
    f.factory
        .hooks
        .panic_after_construct
        .store(true, Ordering::Release);
    let failure = bounded(f.factory.prepare(f.context.clone()))
        .await
        .err()
        .unwrap();
    assert_eq!(failure.code, "cleanup_unconfirmed");
    assert!(
        bounded(f.factory.drain(f.context.ticket.clone(), GENERATION))
            .await
            .is_err()
    );
    assert!(
        f.factory
            .entry
            .get()
            .unwrap()
            .uncertain
            .load(Ordering::Acquire)
    );
    // The real Backend's late inner preparation is queued by the synthetic
    // panic after construction. Wait for its actual registration/IO, then
    // perform test-harness cleanup; Factory must still never claim confirmed.
    bounded(async {
        loop {
            let registered = !f.state.session_memory.lock().unwrap().status(None)["contexts"]
                .as_array()
                .unwrap()
                .is_empty();
            if registered && f.state.host_jobs.active() == 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    f.memory.revoke(&f.context.ticket);
    bounded(f.memory.drain(f.context.ticket.clone()))
        .await
        .unwrap();
    assert!(
        bounded(f.factory.drain(f.context.ticket.clone(), GENERATION))
            .await
            .is_err()
    );
    f.state.driver.get().unwrap().cancel(f.handle.ticket());
    assert!(bounded(f.handle.wait()).await.is_err());
    assert!(matches!(f.handle.progress(), Progress::Quarantined(_)));
    assert_eq!(f.state.driver.get().unwrap().active_count(), 1);
    // A quarantined attempt is intentionally not certified clean. Await the
    // actual backend jobs before this synthetic fixture's runtime goes away.
    bounded(f.state.host_jobs.wait()).await;
}

#[tokio::test]
async fn final_check_borrows_actual_owner_frontier_and_rechecks_policy_context_and_cancel() {
    for changed in ["none", "off", "context", "cancel"] {
        let mut f = Fixture::new(Approval::Ask, on()).await;
        f.prepare().await;
        let (attempt, identity) = f.binding();
        if changed == "off" {
            f.state
                .registry
                .lock()
                .unwrap()
                .update_checked(f.context.ticket.session(), |r| {
                    r.set_raw(
                        "memory",
                        serde_json::value::to_raw_value(&json!({"read":false,"write":"off"}))?,
                    );
                    Ok(())
                })
                .unwrap();
        }
        if changed == "context" {
            f.state.session_memory.lock().unwrap().revoke("chat");
        }
        {
            let frontier = f
                .owner
                .prepare_app_server_input(&attempt, &identity)
                .unwrap();
            if changed == "cancel" {
                f.state.driver.get().unwrap().cancel(f.handle.ticket());
            }
            let result = f.factory.check(&frontier, &f.context.ticket, GENERATION);
            assert_eq!(result.is_ok(), changed == "none");
            drop(result);
        }
        f.finish().await;
    }
}

#[tokio::test]
async fn readonly_has_no_write_authority_and_full_still_waits_for_separate_human_approval() {
    for approval in [Approval::ReadOnly, Approval::Full] {
        let mut f = Fixture::new(approval, on()).await;
        f.prepare().await;
        f.accepted().await;
        let broker = {
            let _initializing = f.state.runtime_init.lock().unwrap();
            crate::permission_state::ensure_locked(&f.state, &Default::default()).unwrap()
        };
        let key = f.key();
        let lease = f.memory.lookup(&key).unwrap();
        assert_eq!(lease.writable(), approval == Approval::Full);
        let params = json!({"commandId":"zcode-edit","id":f.note["id"],"expectedVersion":1,"summary":"ZCode proposal","reason":"Explicit owner choice"});
        let proposal = tokio::spawn(f.memory.call(lease, "memory.update".into(), params));
        if approval == Approval::ReadOnly {
            assert!(bounded(proposal).await.unwrap().is_err());
            assert!(broker.list(None).is_empty());
        } else {
            let card = bounded(async {
                loop {
                    if let Some(card) = broker.list(Some("chat")).into_iter().next() {
                        break card;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await;
            assert_eq!(f.record()["version"], 1);
            let id = card["id"].as_str().unwrap();
            assert!(
                bounded(
                    broker
                        .resolve(id, Decision::allow(Scope::Once), "fixture-owner")
                        .unwrap()
                        .wait()
                )
                .await
                .unwrap()
            );
            assert!(bounded(proposal).await.unwrap().is_ok());
            assert_eq!(f.record()["version"], 2);
            assert_eq!(f.record()["author"], "zcode");
            assert_eq!(f.record()["sourceTurnId"], PUBLIC_TURN);
            let Progress::Running(accepted) = f.handle.progress() else {
                panic!("missing actual accepted receipt");
            };
            assert_eq!(f.record()["sourceEventId"], accepted.user_event_id);
        }
        f.finish().await;
        broker.shutdown();
        bounded(broker.drain()).await;
    }
}

#[tokio::test]
async fn real_rust_mcp_helper_reads_same_backend_and_revocation_denies_without_owner_fallback() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let helper = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("pult-memory-mcp");
    assert!(
        helper.is_file(),
        "build Rust binaries before module-only tests"
    );
    let mut f = Fixture::with_helper(Approval::ReadOnly, on(), helper).await;
    // The synthetic State fixture predates executable scratch-home validation.
    crate::initialize_scratch(&f.state.home).unwrap();
    crate::checked_home(&f.state.home).unwrap();
    f.prepare().await;
    let key = f.key();
    let run = f.state.home.join("run");
    std::fs::create_dir(&run).unwrap();
    std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = tokio::net::UnixListener::bind(run.join("pultd.sock")).unwrap();
    let state = f.state.clone();
    let (stop, mut stopping) = watch::channel(false);
    let server = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _=stopping.changed()=>break,
                accepted=listener.accept()=> {
                    let (socket,_)=accepted.unwrap();
                    connections.spawn(crate::connection(socket,state.clone(),stopping.clone()));
                }
            }
        }
        while let Some(result) = connections.join_next().await {
            assert!(result.is_ok(), "memory connection task panic");
        }
    });
    let raw = f.factory.entry.get().unwrap().server.get().unwrap();
    let mut command = tokio::process::Command::new(raw["command"].as_str().unwrap());
    command
        .args(
            raw["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap()),
        )
        .current_dir(&f.context.snapshot.cwd)
        .env_clear()
        .env("PULT_MEMORY_TURN_KEY", &key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap());
    async fn rpc(
        input: &mut tokio::process::ChildStdin,
        output: &mut tokio::io::BufReader<tokio::process::ChildStdout>,
        id: u64,
        method: &str,
        params: Value,
    ) -> Value {
        let mut frame =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .unwrap();
        frame.push(b'\n');
        input.write_all(&frame).await.unwrap();
        input.flush().await.unwrap();
        let frame = bounded(crate::read_line(output)).await.unwrap().unwrap();
        let value: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(value["id"], id);
        value
    }
    let initialized=rpc(&mut input,&mut output,1,"initialize",json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"zcode-resources-fixture","version":"1"}})).await;
    assert_eq!(initialized["result"]["serverInfo"]["name"], "pult-memory");
    let tools = rpc(&mut input, &mut output, 2, "tools/list", json!({})).await;
    assert!(
        tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["name"] != "memory_propose")
    );
    let note = rpc(
        &mut input,
        &mut output,
        3,
        "tools/call",
        json!({"name":"memory_get","arguments":{"id":f.note["id"]}}),
    )
    .await;
    assert!(note["result"].get("isError").is_none());
    let content: Value =
        serde_json::from_str(note["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(content["summary"], "Native data only");
    assert!(!note.to_string().contains(&key));
    f.factory.revoke(&f.context.ticket, GENERATION);
    assert!(
        child.try_wait().unwrap().is_none(),
        "old helper ended before revocation check"
    );
    let denied = rpc(
        &mut input,
        &mut output,
        4,
        "tools/call",
        json!({"name":"memory_get","arguments":{"id":f.note["id"]}}),
    )
    .await;
    assert_eq!(denied["result"]["isError"], true);
    assert!(!denied.to_string().contains(&key));
    drop(input);
    assert!(bounded(child.wait()).await.unwrap().success());
    stop.send_replace(true);
    bounded(server).await.unwrap();
    assert_eq!(f.state.clients.load(Ordering::Relaxed), 0);
    f.finish().await;
}

#[tokio::test]
async fn private_conversion_rejects_other_purposes_and_errors_never_echo_capabilities() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    f.prepare().await;
    let original = f.factory.entry.get().unwrap().server.get().unwrap();
    let key = f.key();
    for change in ["ask-env", "owner-env", "wrong-purpose", "extra-field"] {
        let mut server = original.clone();
        match change {
            "ask-env" => {
                server["env"]["PULT_ASK_KEY"] = json!("pa_private");
            }
            "owner-env" => {
                server["env"]["PULT_TOKEN"] = json!("owner-private");
            }
            "wrong-purpose" => {
                server["env"]["PULT_MEMORY_TURN_KEY"] = json!(format!("mem_{}", "a".repeat(64)));
            }
            "extra-field" => {
                server["owner"] = json!("not-native-config");
            }
            _ => unreachable!(),
        }
        let failure = native_server(&server, &f.context)
            .err()
            .expect("invalid private profile accepted");
        assert_eq!(failure.code, "provider_unavailable");
        assert!(!format!("{failure:?}").contains(&key));
    }
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
    not_impl!(Factory, std::fmt::Debug);
    not_impl!(Entry, std::fmt::Debug);
    not_impl!(Data, std::fmt::Debug);
    not_impl!(Factory, serde::Serialize);
    f.finish().await;
}

#[tokio::test]
async fn aborting_owned_preparation_revokes_and_marks_uncertainty_without_thread_panic() {
    let mut f = Fixture::new(Approval::Ask, on()).await;
    let barrier = Barrier::new(&f.factory.hooks.catalog);
    let pending = f.factory.prepare(f.context.clone());
    barrier.entered().await;
    let key = f.key();
    f.factory
        .entry
        .get()
        .unwrap()
        .preparation
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .abort();
    assert!(bounded(pending).await.is_err());
    assert!(
        f.factory
            .entry
            .get()
            .unwrap()
            .uncertain
            .load(Ordering::Acquire)
    );
    assert!(f.memory.lookup(&key).is_none());
    assert!(
        bounded(f.factory.drain(f.context.ticket.clone(), GENERATION))
            .await
            .is_err()
    );
    f.state.driver.get().unwrap().cancel(f.handle.ticket());
    assert!(bounded(f.handle.wait()).await.is_err());
    assert!(matches!(f.handle.progress(), Progress::Quarantined(_)));
    assert_eq!(f.state.driver.get().unwrap().active_count(), 1);
    bounded(f.state.host_jobs.wait()).await;
    drop(barrier);
}
