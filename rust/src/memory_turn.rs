//! Trusted, exact-ticket memory authority. The separate MCP capability can read
//! data and request approval; it never inherits owner or filesystem Full rights.
use crate::{
    State,
    memory::{Context, MemoryError, Origin},
    memory_policy::{Policy, Write},
    permission_broker::{Decision, Offers, PermissionRequest, Scope},
    session_memory::{self, MemoryLease},
    turn_coordinator::Ticket,
    turn_driver::{MemoryAction, Progress, Task, WorkerError},
    turn_snapshot::{Approval, SessionKey, TurnSnapshot},
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, OnceLock, Weak,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use subtle::ConstantTimeEq;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot, watch};

pub(crate) const METHODS: [&str; 7] = [
    "memory.catalog",
    "memory.get",
    "memory.list",
    "memory.search",
    "memory.add",
    "memory.update",
    "memory.forget",
];
const MAX_TURNS: usize = 4;
const MAX_CALLS: usize = 16;
const PROPOSAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
fn failure(code: &'static str, message: &'static str) -> MemoryError {
    MemoryError {
        code,
        message: message.into(),
    }
}
fn denied() -> MemoryError {
    failure("forbidden", "memory turn authority is unavailable")
}
fn unavailable() -> MemoryError {
    failure("unavailable", "memory operation is unavailable")
}
fn worker(error: MemoryError) -> WorkerError {
    WorkerError {
        code: error.code.into(),
        message: "memory turn preparation failed".into(),
    }
}
fn public_error(error: MemoryError) -> MemoryError {
    match error.code {
        "invalid_params" => failure("invalid_params", "invalid memory arguments"),
        "not_found" => failure("not_found", "memory not found"),
        "conflict" | "command_conflict" => {
            failure(error.code, "memory conflict; read the current version")
        }
        "forbidden" | "denied" => denied(),
        _ => unavailable(),
    }
}
pub(crate) struct Prepared {
    server: Value,
    writable: bool,
}
impl Prepared {
    pub(crate) fn server(&self) -> &Value {
        &self.server
    }
    pub(crate) fn writable(&self) -> bool {
        self.writable
    }
}
/// Host-only boundary. Implementations own slow preparation and all admitted IO.
/// check/revoke are prompt synchronous operations; no model params create Ticket.
pub(crate) trait TurnMemory: Send + Sync + 'static {
    fn enabled(&self, key: SessionKey) -> Task<Result<bool, WorkerError>>;
    fn prepare(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        public_turn: String,
    ) -> Task<Result<Prepared, WorkerError>>;
    fn catalog(&self, ticket: Ticket) -> Task<Result<String, WorkerError>>;
    fn check(&self, ticket: &Ticket) -> bool;
    fn revoke(&self, ticket: &Ticket);
    fn drain(&self, ticket: Ticket) -> Task<Result<(), WorkerError>>;
}
struct Control {
    ticket: Ticket,
    snapshot: TurnSnapshot,
    public_turn: String,
    secret: String,
    writable: AtomicBool,
    valid: AtomicBool,
    gate: Mutex<()>,
    lease: OnceLock<Arc<MemoryLease>>,
    progress: watch::Receiver<Progress>,
    calls: Arc<Semaphore>,
    jobs: AtomicUsize,
    changed: Notify,
    draining: AtomicBool,
    drained: AtomicBool,
}
impl Control {
    fn revoke(&self) {
        let _gate = self
            .gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.valid.store(false, Ordering::Release);
        self.changed.notify_waiters();
    }
    fn admit(self: &Arc<Self>) -> Result<Job, MemoryError> {
        let _gate = self.gate.lock().map_err(|_| denied())?;
        if !self.valid.load(Ordering::Acquire) {
            return Err(denied());
        }
        let permit = self
            .calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("capacity", "memory operation capacity reached"))?;
        self.jobs.fetch_add(1, Ordering::AcqRel);
        Ok(Job {
            control: self.clone(),
            _permit: permit,
        })
    }
}
struct CancelAction(Arc<MemoryAction>);
impl Drop for CancelAction {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct Job {
    control: Arc<Control>,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.control.jobs.fetch_sub(1, Ordering::AcqRel);
        self.control.changed.notify_waiters();
    }
}
#[derive(Clone)]
pub(crate) struct Lease(Arc<Control>);
impl Lease {
    pub(crate) fn writable(&self) -> bool {
        self.0.writable.load(Ordering::Acquire)
    }
}

/// Exact prepared Control identity, not permission to send input. A strong State
/// pin keeps its registration alive while a future owned adapter prepares work.
/// Never constructed from JSON, a memory key, or an independently cloned record.
#[cfg_attr(not(test), allow(dead_code))] // Future native input resource adapter, not active yet.
pub(crate) struct InputScope {
    state: Arc<State>,
    control: Arc<Control>,
}

/// Borrowed !Send short-gate pin, held only through the synchronous input handoff.
/// Field order releases inner admission first; Drop does no IO or callbacks.
#[cfg_attr(not(test), allow(dead_code))] // Future native input resource adapter, not active yet.
#[must_use = "hold the input scope permit through the actual input handoff"]
pub(crate) struct InputScopePermit<'a> {
    _lease: session_memory::MemoryLeaseAdmission<'a>,
    _control: MutexGuard<'a, ()>,
    _execution: MutexGuard<'a, ()>,
}
#[cfg_attr(not(test), allow(dead_code))] // Future native input resource adapter, not active yet.
impl InputScope {
    /// Trusted caller precondition: `record` is the already-current record from
    /// the same State's actual checked Registry/Owner frontier. Keep that guard
    /// (and caller Consent -> Registry -> RuntimeState admission) through this
    /// method and the input handoff. A standalone/cloned Record is not authority.
    ///
    /// No Registry, filesystem, DB or session-context mutex acquisition here.
    /// Lock order: execution admission -> Control gate -> lease gate -> Driver.
    /// Native dispatch still requires its own fresh Owner/Driver input seal.
    pub(crate) fn enter_current<'a>(
        &'a self,
        record: &'a crate::registry::Record,
    ) -> Result<InputScopePermit<'a>, WorkerError> {
        let execution = self
            .state
            .execution_admission
            .lock()
            .map_err(|_| worker(denied()))?;
        let control = self.control.gate.lock().map_err(|_| worker(denied()))?;
        let lease = self.control.lease.get().ok_or_else(|| worker(denied()))?;
        let lease = lease.admit().map_err(worker)?;
        Backend::verify_locked(&self.state, &self.control, record, false).map_err(worker)?;
        Ok(InputScopePermit {
            _lease: lease,
            _control: control,
            _execution: execution,
        })
    }
}

pub(crate) struct Backend {
    state: Weak<State>,
    myself: Weak<Backend>,
    program: PathBuf,
    controls: Mutex<Vec<Arc<Control>>>,
    #[cfg(test)]
    hooks: Arc<tests::Hooks>,
}
impl Backend {
    pub(crate) fn new(state: Weak<State>, program: PathBuf) -> Arc<Self> {
        Arc::new_cyclic(|myself| Self {
            state,
            myself: myself.clone(),
            program,
            controls: Mutex::new(Vec::new()),
            #[cfg(test)]
            hooks: Arc::new(tests::Hooks::default()),
        })
    }
    /// Slow full verification belongs in the owned blocking preparation phase,
    /// before the caller enters its Registry/Runtime input frontier. Capturing
    /// this identity never authorizes a later input; enter_current must recheck.
    #[cfg_attr(not(test), allow(dead_code))] // Future native input resource adapter, not active yet.
    pub(crate) fn input_scope(&self, ticket: &Ticket) -> Result<InputScope, WorkerError> {
        let state = self.state.upgrade().ok_or_else(|| worker(unavailable()))?;
        let control = self.control(ticket).ok_or_else(|| worker(denied()))?;
        Self::verify(&state, &control, false).map_err(worker)?;
        Ok(InputScope { state, control })
    }
    /// Claude host adapter: snapshot is selected only by the exact trusted Ticket.
    /// The captured effective approval may narrow, never widen Driver authority.
    pub(crate) fn prepare_current(
        &self,
        ticket: Ticket,
        public_turn: String,
        approval: Approval,
    ) -> Task<Result<Prepared, WorkerError>> {
        let snapshot = self.state.upgrade().and_then(|state| {
            let driver = state.driver.get()?;
            if public_turn.is_empty()
                || public_turn.len() > 512
                || public_turn.chars().any(char::is_control)
                || driver
                    .public_turn_id(&ticket)
                    .is_some_and(|known| known != public_turn)
            {
                return None;
            }
            driver.snapshot_for_dispatch(&ticket)
        });
        let Some(mut snapshot) = snapshot else {
            return Box::pin(async { Err(worker(denied())) });
        };
        fn rank(approval: Approval) -> u8 {
            match approval {
                Approval::ReadOnly => 0,
                Approval::Ask => 1,
                Approval::Workspace => 2,
                Approval::Full => 3,
                Approval::Inherit => 4,
            }
        }
        if snapshot.key != *ticket.session()
            || snapshot.provider != crate::turn_snapshot::Provider::Claude
            || rank(approval) > rank(snapshot.settings.approval)
        {
            return Box::pin(async { Err(worker(denied())) });
        }
        snapshot.settings.approval = approval;
        <Self as TurnMemory>::prepare(self, ticket, snapshot, public_turn)
    }
    fn control(&self, ticket: &Ticket) -> Option<Arc<Control>> {
        self.controls
            .lock()
            .ok()?
            .iter()
            .find(|control| &control.ticket == ticket)
            .cloned()
    }
    pub(crate) fn lookup(&self, key: &str) -> Option<Lease> {
        if !valid_key(key) {
            return None;
        }
        let controls = self.controls.lock().ok()?;
        let mut matched = None;
        for control in controls.iter() {
            if bool::from(control.secret.as_bytes().ct_eq(key.as_bytes()))
                && control.valid.load(Ordering::Acquire)
            {
                matched = Some(Lease(control.clone()));
            }
        }
        matched
    }
    pub(crate) fn revoke_session(&self, name: &str) {
        let controls: Vec<_> = self
            .controls
            .lock()
            .map(|controls| {
                controls
                    .iter()
                    .filter(|c| c.ticket.session().name == name)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        for control in controls {
            control.revoke();
        }
    }
    fn verify_locked(
        state: &State,
        control: &Control,
        record: &crate::registry::Record,
        writing: bool,
    ) -> Result<Context, MemoryError> {
        if *state.stop.borrow()
            || crate::runtime_state::unavailable(state)
            || state.session_memory.is_poisoned()
            || !control.valid.load(Ordering::Acquire)
        {
            return Err(denied());
        }
        let lease = control.lease.get().ok_or_else(denied)?;
        session_memory::validate_record(record, lease)?;
        let policy = Policy::record(record).map_err(|_| denied())?;
        if !policy.read {
            return Err(denied());
        }
        let current = state
            .driver
            .get()
            .and_then(|driver| driver.snapshot_for_dispatch(&control.ticket))
            .ok_or_else(denied)?;
        if current.key != control.snapshot.key
            || current.provider != control.snapshot.provider
            || current.cwd != control.snapshot.cwd
        {
            return Err(denied());
        }
        if writing
            && (!control.writable.load(Ordering::Acquire)
                || policy.write != Write::Ask
                || current.settings.approval == Approval::ReadOnly
                || record.scalar("approval").as_deref() == Some("read-only"))
        {
            return Err(denied());
        }
        Ok(Context {
            project_id: lease.project_id.clone(),
            session: Some(lease.session.clone()),
        })
    }
    fn verify(state: &State, control: &Control, writing: bool) -> Result<Context, MemoryError> {
        let registry = state.registry.lock().map_err(|_| denied())?;
        if registry.write_poisoned() {
            return Err(denied());
        }
        let record = registry
            .find(&control.ticket.session().name)
            .ok_or_else(denied)?;
        Self::verify_locked(state, control, record, writing)
    }
    async fn begin(
        self: Arc<Self>,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        public_turn: String,
    ) -> Result<Prepared, MemoryError> {
        let state = self.state.upgrade().ok_or_else(unavailable)?;
        let progress = state
            .driver
            .get()
            .and_then(|driver| driver.progress_for_ticket(&ticket))
            .ok_or_else(denied)?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| unavailable())?;
        let secret = format!(
            "mt_{}",
            random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let control = Arc::new(Control {
            ticket: ticket.clone(),
            snapshot,
            public_turn,
            secret,
            writable: AtomicBool::new(false),
            valid: AtomicBool::new(true),
            gate: Mutex::new(()),
            lease: OnceLock::new(),
            progress,
            calls: Arc::new(Semaphore::new(MAX_CALLS)),
            jobs: AtomicUsize::new(0),
            changed: Notify::new(),
            draining: AtomicBool::new(false),
            drained: AtomicBool::new(false),
        });
        {
            let mut controls = self.controls.lock().map_err(|_| unavailable())?;
            if controls.len() >= MAX_TURNS || controls.iter().any(|c| c.ticket == ticket) {
                return Err(failure("capacity", "memory turn capacity reached"));
            }
            controls.push(control.clone());
        }
        let job = control.admit()?;
        let tracked = state.host_jobs.track();
        let preparing = control.clone();
        let result = tokio::task::spawn_blocking(move || {
            let _tracked = tracked;
            let _job = job;
            let lease = crate::session_memory_api::ensure_registered(
                &state,
                &preparing.ticket.session().name,
            )?;
            preparing.lease.set(lease).map_err(|_| denied())?;
            let mut memory = state.memory.lock().map_err(|_| unavailable())?;
            let context = Self::verify(&state, &preparing, false)?;
            let policy = {
                let registry = state.registry.lock().map_err(|_| denied())?;
                Policy::record(
                    registry
                        .find(&preparing.ticket.session().name)
                        .ok_or_else(denied)?,
                )
                .map_err(|_| denied())?
            };
            let _context = context;
            memory.as_mut().map_err(|_| unavailable())?;
            Self::verify(&state, &preparing, false)?;
            let writable = policy.write == Write::Ask
                && preparing.snapshot.settings.approval != Approval::ReadOnly;
            preparing.writable.store(writable, Ordering::Release);
            Ok::<_, MemoryError>(())
        })
        .await
        .map_err(|_| unavailable())
        .and_then(|result| result);
        match result {
            Ok(()) => {
                let state = self.state.upgrade().ok_or_else(unavailable)?;
                Self::verify(&state, &control, false)?;
                Ok(Prepared {
                    writable: control.writable.load(Ordering::Acquire),
                    server: json!({"command":self.program,"args":["--home",state.home],"env":{"PULT_MEMORY_TURN_KEY":control.secret},"default_tools_approval_mode":"approve"}),
                })
            }
            Err(error) => {
                control.revoke();
                self.wait_drain(control).await;
                Err(error)
            }
        }
    }
    async fn wait_drain(&self, control: Arc<Control>) {
        loop {
            let changed = control.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if control.jobs.load(Ordering::Acquire) == 0 {
                break;
            }
            changed.await;
        }
        if let Ok(mut controls) = self.controls.lock() {
            controls.retain(|current| !Arc::ptr_eq(current, &control));
        }
        control.drained.store(true, Ordering::Release);
        control.changed.notify_waiters();
    }
    pub(crate) fn call(
        self: &Arc<Self>,
        lease: Lease,
        method: String,
        params: Value,
    ) -> Task<Result<Value, MemoryError>> {
        let control = lease.0;
        let job = match control.admit() {
            Ok(job) => job,
            Err(error) => return Box::pin(async { Err(error) }),
        };
        let Some(state) = self.state.upgrade() else {
            return Box::pin(async { Err(unavailable()) });
        };
        let backend = self.clone();
        let tracked = state.host_jobs.track();
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let _tracked = tracked;
            let _job = job;
            let result = if crate::session_memory_api::READ_METHODS.contains(&method.as_str()) {
                backend.read(state, control, method, params).await
            } else if matches!(
                method.as_str(),
                "memory.add" | "memory.update" | "memory.forget"
            ) {
                // The owned Job includes per-question journal cleanup. Never
                // timeout/drop the whole scope while broker IO is still owned.
                backend
                    .propose(
                        state,
                        control,
                        method,
                        params,
                        std::time::Instant::now() + PROPOSAL_TIMEOUT,
                    )
                    .await
            } else {
                Err(denied())
            };
            let _ = send.send(result);
        });
        Box::pin(async { receive.await.unwrap_or_else(|_| Err(unavailable())) })
    }
    async fn read(
        self: Arc<Self>,
        state: Arc<State>,
        control: Arc<Control>,
        method: String,
        params: Value,
    ) -> Result<Value, MemoryError> {
        #[cfg(test)]
        let hooks = self.hooks.clone();
        if !params.is_object()
            || params.get("session").is_some()
            || params.get("projectId").is_some()
        {
            return Err(denied());
        }
        tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            hooks.before_read();
            let mut memory = state.memory.lock().map_err(|_| unavailable())?;
            let context = Self::verify(&state, &control, false)?;
            let store = memory.as_mut().map_err(|_| unavailable())?;
            let result = if method == "memory.catalog" {
                if params.as_object().is_none_or(|p| !p.is_empty()) {
                    return Err(denied());
                }
                let page = store
                    .execute("memory.list", &json!({"limit":50}), &context)
                    .map_err(public_error)?;
                crate::memory_catalog::build(
                    public_memory(page),
                    control.lease.get().ok_or_else(denied)?.public_context(),
                )
                .map_err(public_error)?
            } else {
                public_memory(
                    store
                        .execute(&method, &params, &context)
                        .map_err(public_error)?,
                )
            };
            Self::verify(&state, &control, false)?;
            Ok(result)
        })
        .await
        .map_err(|_| unavailable())?
    }
    async fn accepted(control: &Control) -> Result<crate::turn_driver::Accepted, MemoryError> {
        let mut progress = control.progress.clone();
        loop {
            let changed = control.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !control.valid.load(Ordering::Acquire) {
                return Err(denied());
            }
            match progress.borrow_and_update().clone() {
                Progress::Running(accepted)
                    if accepted.user_event_id > 0 && accepted.turn_id == control.public_turn =>
                {
                    return Ok(accepted);
                }
                Progress::Starting => {}
                _ => return Err(denied()),
            }
            tokio::select! { _ = changed => {}, result = progress.changed() => { result.map_err(|_| denied())?; } }
        }
    }
    async fn propose(
        self: Arc<Self>,
        state: Arc<State>,
        control: Arc<Control>,
        method: String,
        params: Value,
        deadline: std::time::Instant,
    ) -> Result<Value, MemoryError> {
        let accepted = tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline),
            Self::accepted(&control),
        )
        .await
        .map_err(|_| denied())??;
        let checking_state = state.clone();
        let checking = control.clone();
        let arguments = params.clone();
        let operation = method.clone();
        let preflight_job = control.admit()?;
        let preflight_tracked = state.host_jobs.track();
        let context = tokio::task::spawn_blocking(move || {
            let _job = preflight_job;
            let _tracked = preflight_tracked;
            let context = Self::verify(&checking_state, &checking, true)?;
            crate::memory::validate_proposal(&operation, &arguments, &context)?;
            Ok::<_, MemoryError>(context)
        })
        .await
        .map_err(|_| unavailable())??;
        let scope = params
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or("project");
        let request = PermissionRequest {
            session_id: control.ticket.session().name.clone(),
            tool_name: "pult_memory.propose".into(),
            tool_use_id: None,
            input: json!({"operation":method,"scope":scope,"projectId":context.project_id,"proposal":params,"sourceEventId":accepted.user_event_id,"sourceTurnId":accepted.turn_id}),
            offers: Offers::default(),
            concealed: false,
        };
        let expected_input = request.input.clone();
        let mut question =
            crate::permission_state::request(&state, request).map_err(|_| denied())?;
        // Pin one waiter: dropping/recreating decision() on a control wake
        // cancels the request through DecisionWait's Drop implementation.
        let decision = {
            let decision = question.decision();
            tokio::pin!(decision);
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), async {
                loop {
                    let changed = control.changed.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    if !control.valid.load(Ordering::Acquire) {
                        return None;
                    }
                    tokio::select! { result = &mut decision => return Some(result), _ = changed => {} }
                }
            })
            .await
            .ok()
            .flatten()
        };
        // This await is deliberately outside the decision timeout/cancellation
        // scope, inside the owned memory Job. Never wait on other sessions.
        question.cancel();
        question.drained().await;
        let decision = decision.ok_or_else(denied)?;
        // Broker returns the approved raw input even when the resolver supplied
        // no override. Accept only that exact payload; never execute a changed
        // input or a wider scope, and retain the original immutable params.
        if !matches!(decision, Decision::Allow { scope: Scope::Once, updated_input: Some(ref approved), answers: None } if approved == &expected_input)
        {
            return Err(failure("denied", "memory proposal was denied"));
        }
        let origin = Origin {
            session: control.ticket.session().clone(),
            provider: control.snapshot.provider,
            user_event_id: accepted.user_event_id,
            turn_id: accepted.turn_id,
        };
        self.commit(state, control, method, params, origin, deadline)
            .await
    }
    async fn commit(
        self: Arc<Self>,
        state: Arc<State>,
        control: Arc<Control>,
        method: String,
        params: Value,
        origin: Origin,
        deadline: std::time::Instant,
    ) -> Result<Value, MemoryError> {
        #[cfg(test)]
        let hooks = self.hooks.clone();
        let action = Arc::new(MemoryAction::new(deadline));
        let _cancel_unsealed = CancelAction(action.clone());
        let commit_job = control.admit()?;
        let commit_tracked = state.host_jobs.track();
        tokio::task::spawn_blocking(move || {
            let _job = commit_job;
            let _tracked = commit_tracked;
            let mut memory = state.memory.lock().map_err(|_| unavailable())?;
            let context = Self::verify(&state, &control, true)?;
            let outcome = memory
                .as_mut()
                .map_err(|_| unavailable())?
                .execute_as_checked(&method, &params, &context, &origin, || {
                    let registry = state.registry.lock().map_err(|_| denied())?;
                    if registry.write_poisoned() {
                        return Err(denied());
                    }
                    let record = registry
                        .find(&control.ticket.session().name)
                        .ok_or_else(denied)?;
                    Self::verify_locked(&state, &control, record, true)?;
                    #[cfg(test)]
                    hooks.before_seal();
                    // Every wait on filesystem/database/registry happens before
                    // this gate. Publication of stop/fault and the seal CAS share
                    // one bounded in-memory critical section.
                    let admission = state.execution_admission.lock().map_err(|_| denied())?;
                    let gate = control.gate.lock().map_err(|_| denied())?;
                    if *state.stop.borrow()
                        || state.execution_storage_failed.load(Ordering::Acquire)
                        || !control.valid.load(Ordering::Acquire)
                        || !control.lease.get().is_some_and(|lease| lease.is_valid())
                    {
                        return Err(denied());
                    }
                    let expected = crate::turn_driver::Accepted {
                        user_event_id: origin.user_event_id,
                        turn_id: origin.turn_id.clone(),
                    };
                    state
                        .driver
                        .get()
                        .and_then(|driver| {
                            driver.seal_memory_action(&control.ticket, &action, &expected)
                        })
                        .ok_or_else(denied)?;
                    drop(gate);
                    drop(admission);
                    drop(registry);
                    #[cfg(test)]
                    hooks.after_seal();
                    Ok(())
                })
                .map_err(public_error);
            action.cancel();
            let result = outcome?;
            Self::verify(&state, &control, true).map_err(|_| unavailable())?;
            Ok(public_memory(result))
        })
        .await
        .map_err(|_| unavailable())?
    }
}
impl TurnMemory for Backend {
    fn enabled(&self, key: SessionKey) -> Task<Result<bool, WorkerError>> {
        let state = self.state.upgrade();
        Box::pin(async move {
            let state = state.ok_or_else(|| worker(unavailable()))?;
            let tracked = state.host_jobs.track();
            tokio::task::spawn_blocking(move || {
                let _tracked = tracked;
                let registry = state.registry.lock().map_err(|_| worker(denied()))?;
                if registry.write_poisoned()
                    || *state.stop.borrow()
                    || crate::runtime_state::unavailable(&state)
                {
                    return Err(worker(denied()));
                }
                let record = registry
                    .find(&key.name)
                    .filter(|record| record.scalar("createdAt").as_deref() == Some(&key.created_at))
                    .ok_or_else(|| worker(denied()))?;
                Policy::record(record)
                    .map(|policy| policy.read)
                    .map_err(|_| worker(denied()))
            })
            .await
            .unwrap_or_else(|_| Err(worker(unavailable())))
        })
    }
    fn prepare(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        public_turn: String,
    ) -> Task<Result<Prepared, WorkerError>> {
        let backend = self.myself.upgrade();
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let result = match backend {
                Some(backend) => {
                    let result = backend
                        .clone()
                        .begin(ticket.clone(), snapshot, public_turn)
                        .await;
                    if result.is_err()
                        && let Some(control) = backend.control(&ticket)
                    {
                        control.revoke();
                        backend.wait_drain(control).await;
                    }
                    result.map_err(worker)
                }
                None => Err(worker(unavailable())),
            };
            let _ = send.send(result);
        });
        Box::pin(async { receive.await.unwrap_or_else(|_| Err(worker(unavailable()))) })
    }
    fn catalog(&self, ticket: Ticket) -> Task<Result<String, WorkerError>> {
        let backend = self.myself.upgrade();
        let control = self.control(&ticket);
        Box::pin(async move {
            let (backend, control) = backend.zip(control).ok_or_else(|| worker(denied()))?;
            let value = backend
                .call(Lease(control), "memory.catalog".into(), json!({}))
                .await
                .map_err(worker)?;
            value["text"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| worker(unavailable()))
        })
    }
    fn check(&self, ticket: &Ticket) -> bool {
        self.state
            .upgrade()
            .zip(self.control(ticket))
            .is_some_and(|(state, control)| Self::verify(&state, &control, false).is_ok())
    }
    fn revoke(&self, ticket: &Ticket) {
        if let Some(control) = self.control(ticket) {
            control.revoke();
        }
    }
    fn drain(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        let Some(control) = self.control(&ticket) else {
            return Box::pin(async { Ok(()) });
        };
        control.revoke();
        if !control.draining.swap(true, Ordering::AcqRel) {
            let backend = self.myself.upgrade();
            let owned = control.clone();
            tokio::spawn(async move {
                if let Some(backend) = backend {
                    backend.wait_drain(owned).await;
                }
            });
        }
        Box::pin(async move {
            loop {
                let changed = control.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if control.drained.load(Ordering::Acquire) {
                    return Ok(());
                }
                changed.await;
            }
        })
    }
}
pub(crate) fn valid_key(key: &str) -> bool {
    key.len() == 67
        && key.starts_with("mt_")
        && key.as_bytes()[3..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}
fn public_memory(value: Value) -> Value {
    crate::redaction::redact_memory_capabilities(&public_memory_content(value))
}
fn public_memory_content(mut value: Value) -> Value {
    match &mut value {
        Value::Object(object) => {
            for (key, value) in object {
                if matches!(key.as_str(), "name" | "summary" | "details" | "reason") {
                    if let Value::String(text) = value {
                        *text = crate::redaction::redact_string(text);
                    }
                } else {
                    *value = public_memory_content(std::mem::take(value));
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                *value = public_memory_content(std::mem::take(value));
            }
        }
        _ => {}
    }
    value
}

#[cfg(test)]
#[path = "memory_turn_tests.rs"]
mod tests;
