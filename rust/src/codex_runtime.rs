//! Ordinary Codex orchestration with optional exact-ticket memory MCP. General
//! user MCP, legacy approvals, background/subagent parity and persistent rules
//! remain separate. Queue/question integration is a separate delivery step.
//! Stale generation hosts retain bounded slots until shutdown; no idle eviction.
use crate::codex_host_services::CodexOwner;
use crate::codex_permissions::{self, Capabilities, TrustedOwner};
use crate::codex_worker::{self, ApprovalContext, ApprovalHandler, CodexHost, SessionSpec};
use crate::consent_store::ConsentStore;
use crate::network_guard::{Check, CurlProbe, NetworkGuard};
use crate::permission_broker::{self, Broker, Decision, Resolution};
use crate::registry::Registry;
use crate::runtime_config::RuntimeConfig;
use crate::turn_driver::{
    self, DispatchGate, Driver, EventSink, Handle, Input, Progress, Receipt, SinkError, Task,
};
use crate::turn_snapshot::{Provider, SessionKey, TurnSnapshot};
use crate::worker_env::{self, Environment};
use crate::worker_process::Launch;
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot, watch};

pub struct Dependencies {
    pub home: PathBuf,
    pub registry: Arc<Mutex<Registry>>,
    pub consent: Arc<Mutex<ConsentStore>>,
    pub driver: Arc<Driver>,
    pub sink: Arc<dyn EventSink>,
}
/// Host-selected executable and fixed prefix, never populated from RPC JSON.
pub struct TrustedCommand {
    pub holder: PathBuf,
    pub program: PathBuf,
    pub prefix_args: Vec<OsString>,
}
pub enum Network {
    Shared(Arc<NetworkGuard>),
    OwnedCurl(Arc<CurlProbe>),
}
pub struct Limits {
    pub hosts: usize,
    pub preparing: usize,
    pub host: codex_worker::Limits,
    pub timeouts: codex_worker::Timeouts,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            hosts: 4,
            preparing: 64,
            host: Default::default(),
            timeouts: Default::default(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Invalid,
    Closed,
    Busy,
    Capacity,
    NetworkDenied,
    Unsupported,
    Session,
    Storage,
    CleanupUnconfirmed,
    Cancelled,
}
impl RuntimeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid_params",
            Self::Closed => "closed",
            Self::Busy => "busy",
            Self::Capacity => "capacity",
            Self::NetworkDenied => "network_denied",
            Self::Unsupported => "unsupported",
            Self::Session => "invalid_session",
            Self::Storage => "storage_unavailable",
            Self::CleanupUnconfirmed => "cleanup_unconfirmed",
            Self::Cancelled => "cancelled",
        }
    }
}
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for RuntimeError {}
#[derive(Clone, PartialEq, Eq)]
struct PoolKey {
    generation: u64,
    mode: crate::network_guard::Mode,
    path: crate::network_guard::NetPath,
    proxy: Option<String>,
    no_proxy: Vec<String>,
    guard: crate::network_guard::GuardRule,
    env: Environment,
}
impl PoolKey {
    fn new(check: &Check, env: Environment) -> Self {
        Self {
            generation: check.generation,
            mode: check.mode,
            path: check.path,
            proxy: check.proxy.clone(),
            no_proxy: check.no_proxy.clone(),
            guard: check.guard.clone(),
            env,
        }
    }
}
struct Lease {
    ticket: Option<crate::turn_coordinator::Ticket>,
    host: Weak<CodexHost>,
    nonce: Arc<()>,
    check: Check,
    key: PoolKey,
    cancelled: watch::Receiver<bool>,
}
struct Entry {
    key: PoolKey,
    host: Arc<CodexHost>,
}
struct Dedicated {
    host: Arc<CodexHost>,
    _slot: OwnedSemaphorePermit,
    retiring: AtomicBool,
}
struct DedicatedGuard {
    shared: Weak<Shared>,
    entry: Arc<Dedicated>,
    runtime: tokio::runtime::Handle,
}
impl Drop for DedicatedGuard {
    fn drop(&mut self) {
        if self.entry.retiring.swap(true, Ordering::AcqRel) {
            return;
        }
        let shared = self.shared.clone();
        let entry = self.entry.clone();
        self.runtime.spawn(async move {
            entry.host.retry_cleanup();
            if entry.host.shutdown().await.is_ok()
                && let Some(shared) = shared.upgrade()
            {
                shared
                    .state
                    .lock()
                    .expect("Codex runtime")
                    .dedicated
                    .retain(|current| !Arc::ptr_eq(current, &entry));
                shared.changed.notify_waiters();
            }
        });
    }
}
struct State {
    pool: Vec<Entry>,
    dedicated: Vec<Arc<Dedicated>>,
    preparing: HashMap<SessionKey, watch::Sender<bool>>,
    leases: HashMap<SessionKey, Lease>,
}
struct Shared {
    state: Mutex<State>,
    closed: watch::Sender<bool>,
    changed: Notify,
    guard: Arc<NetworkGuard>,
    parent: Environment,
    memory_slots: Arc<Semaphore>,
    shutdown: Mutex<ShutdownPhase>,
    retry: Notify,
    finished: watch::Sender<Option<Result<(), RuntimeError>>>,
}
enum ShutdownPhase {
    Idle,
    Running,
    WaitingRetry,
    Complete,
}
impl Shared {
    fn route(&self, ticket: &crate::turn_coordinator::Ticket, _: &TurnSnapshot) -> bool {
        if *self.closed.borrow() {
            return false;
        }
        let lease = {
            let state = self.state.lock().expect("Codex runtime");
            state
                .leases
                .get(ticket.session())
                .filter(|l| {
                    !*l.cancelled.borrow()
                        && l.host.upgrade().is_some()
                        && l.ticket.as_ref().is_none_or(|owned| owned == ticket)
                })
                .map(|l| (l.check.clone(), l.key.clone()))
        };
        lease.is_some_and(|(check, key)| {
            self.guard.is_current(&check)
                && self
                    .guard
                    .worker_environment(&check, &self.parent, &Environment::new())
                    .is_ok_and(|env| PoolKey::new(&check, env) == key)
        })
    }
}
struct Inner {
    deps: Dependencies,
    config: RuntimeConfig,
    command: TrustedCommand,
    limits: Limits,
    shared: Arc<Shared>,
    owner: Arc<CodexOwner>,
    broker: Broker,
    owns_globals: bool,
    memory: Option<Arc<dyn crate::memory_turn::TurnMemory>>,
    owned_curl: Option<Arc<CurlProbe>>,
    runtime: tokio::runtime::Handle,
}
pub struct CodexRuntime {
    inner: Arc<Inner>,
}
impl CodexRuntime {
    pub fn new(
        deps: Dependencies,
        config: RuntimeConfig,
        command: TrustedCommand,
        parent: Environment,
        network: Network,
        limits: Limits,
    ) -> Result<Arc<Self>, RuntimeError> {
        Self::new_with_memory(deps, config, command, parent, network, limits, None)
    }
    /// Host-selected optional memory service. Memory turns use bounded fresh
    /// dedicated hosts; shared memory-off hosts retain their existing behavior.
    pub(crate) fn new_with_memory(
        deps: Dependencies,
        config: RuntimeConfig,
        command: TrustedCommand,
        parent: Environment,
        network: Network,
        limits: Limits,
        memory: Option<Arc<dyn crate::memory_turn::TurnMemory>>,
    ) -> Result<Arc<Self>, RuntimeError> {
        Self::construct(deps, config, command, parent, network, limits, memory, None)
    }
    /// Daemon-owned Driver/Broker/SharedNetwork outlive this provider runtime.
    #[allow(dead_code)] // State integration follows this isolated lifecycle slice.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_daemon(
        deps: Dependencies,
        config: RuntimeConfig,
        command: TrustedCommand,
        parent: Environment,
        network: Network,
        limits: Limits,
        memory: Option<Arc<dyn crate::memory_turn::TurnMemory>>,
        broker: Broker,
    ) -> Result<Arc<Self>, RuntimeError> {
        Self::construct(
            deps,
            config,
            command,
            parent,
            network,
            limits,
            memory,
            Some(broker),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn construct(
        deps: Dependencies,
        config: RuntimeConfig,
        command: TrustedCommand,
        parent: Environment,
        network: Network,
        limits: Limits,
        memory: Option<Arc<dyn crate::memory_turn::TurnMemory>>,
        broker: Option<Broker>,
    ) -> Result<Arc<Self>, RuntimeError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| RuntimeError::Invalid)?;
        if limits.hosts == 0 || limits.hosts > 16 || limits.preparing == 0 || limits.preparing > 256
        {
            return Err(RuntimeError::Invalid);
        }
        if !config.mcp.servers.is_empty() {
            return Err(RuntimeError::Unsupported);
        }
        let parent = worker_env::from_parent(&parent, &Environment::new())
            .map_err(|_| RuntimeError::Invalid)?;
        let deps = Dependencies {
            home: deps
                .home
                .canonicalize()
                .map_err(|_| RuntimeError::Invalid)?,
            ..deps
        };
        Launch {
            holder: command.holder.clone(),
            program: command.program.clone(),
            args: command.prefix_args.clone(),
            cwd: deps.home.clone(),
            env: parent.clone(),
        }
        .validate()
        .map_err(|_| RuntimeError::Invalid)?;
        let (guard, owned_curl) = match network {
            Network::Shared(g) => (g, None),
            Network::OwnedCurl(c) => (Arc::new(NetworkGuard::new(c.clone())), Some(c)),
        };
        let (closed, _) = watch::channel(false);
        let (finished, _) = watch::channel(None);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                pool: vec![],
                dedicated: vec![],
                preparing: HashMap::new(),
                leases: HashMap::new(),
            }),
            closed,
            changed: Notify::new(),
            guard,
            parent,
            memory_slots: Arc::new(Semaphore::new(2)),
            shutdown: Mutex::new(ShutdownPhase::Idle),
            retry: Notify::new(),
            finished,
        });
        let weak = Arc::downgrade(&shared);
        let owner = CodexOwner::new(
            deps.home.clone(),
            deps.registry.clone(),
            Arc::downgrade(&deps.driver),
            deps.consent.clone(),
            Arc::new(move |ticket, snapshot| {
                weak.upgrade().is_some_and(|s| s.route(ticket, snapshot))
            }),
        )
        .map_err(|_| RuntimeError::Session)?;
        let deps = Dependencies {
            sink: Arc::new(FaultSink {
                sink: deps.sink.clone(),
                driver: Arc::downgrade(&deps.driver),
                shared: Arc::downgrade(&shared),
            }),
            ..deps
        };
        let owns_globals = broker.is_none();
        let broker = match broker {
            Some(broker) => broker,
            None => Broker::new(
                deps.sink.clone(),
                permission_broker::Redactors {
                    value: Arc::new(crate::redaction::redact),
                    string: Arc::new(crate::redaction::redact_string),
                },
                permission_broker::Options::from_timeout_ms(config.perm_timeout_ms)
                    .map_err(|_| RuntimeError::Invalid)?,
            )
            .map_err(|_| RuntimeError::Invalid)?,
        };
        Ok(Arc::new(Self {
            inner: Arc::new(Inner {
                deps,
                config,
                command,
                limits,
                shared,
                owner,
                broker,
                owns_globals,
                memory,
                owned_curl,
                runtime,
            }),
        }))
    }
    /// Starts bounded owned preparation immediately. Dropping this caller's
    /// future does not abandon an authorized ordinary turn or owned probe IO.
    pub fn execute(&self, key: SessionKey, input: Input) -> Task<Result<Handle, RuntimeError>> {
        self.execute_impl(key, input, false)
    }
    fn execute_impl(
        &self,
        key: SessionKey,
        input: Input,
        queued: bool,
    ) -> Task<Result<Handle, RuntimeError>> {
        let inner = self.inner.clone();
        let admission = reserve(&inner, &key, &input, queued);
        let (sender, receiver) = oneshot::channel();
        match admission {
            Ok(guard) => {
                self.inner.runtime.spawn(async move {
                    let cancelled = guard.cancelled.clone();
                    let result = execute(inner, key, input, cancelled).await;
                    drop(guard);
                    let _ = sender.send(result);
                });
            }
            Err(error) => {
                let _ = sender.send(Err(error));
            }
        }
        Box::pin(async move { receiver.await.unwrap_or(Err(RuntimeError::Closed)) })
    }
    /// Trusted queue execution; queue identity comes from the owner registry,
    /// never arbitrary prompt JSON. Uses the same owned admission as ordinary IO.
    pub(crate) fn execute_queued(
        &self,
        key: SessionKey,
        input: Input,
    ) -> Task<Result<Handle, RuntimeError>> {
        self.execute_impl(key, input, true)
    }
    pub fn steer(
        &self,
        key: &SessionKey,
        input: Input,
    ) -> Task<Result<String, crate::turn_driver::WorkerError>> {
        if input.metadata.question_id.is_some()
            || input.metadata.queue_item_id.is_some()
            || input.metadata.queue_item_at.is_some()
        {
            return Box::pin(async {
                Err(crate::turn_driver::WorkerError {
                    code: "invalid_params".into(),
                    message: "steering receipt identities must be owner-derived".into(),
                })
            });
        }
        self.steer_guarded(key, input, None)
    }
    pub(crate) fn steer_guarded(
        &self,
        key: &SessionKey,
        input: Input,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Task<Result<String, crate::turn_driver::WorkerError>> {
        if input.metadata.question_id.is_some() {
            return Box::pin(async {
                Err(crate::turn_driver::WorkerError {
                    code: "unsupported".into(),
                    message: "question-answer protocol is not ported".into(),
                })
            });
        }
        let inner = &self.inner;
        let ticket = inner.deps.driver.active_ticket(key);
        let selection = ticket.and_then(|ticket| {
            let snapshot = inner.deps.driver.snapshot_for_dispatch(&ticket)?;
            let state = inner.shared.state.lock().expect("Codex runtime");
            let lease = state.leases.get(key)?;
            if lease.ticket.as_ref() != Some(&ticket) {
                return None;
            }
            let host = lease.host.upgrade()?;
            Some((ticket, snapshot, host))
        });
        if inner.broker.list(Some(&key.name)).is_empty()
            && !*inner.shared.closed.borrow()
            && let Some((ticket, snapshot, host)) = selection
        {
            let _context = inner.runtime.enter();
            return host.steer(ticket, snapshot, inner.deps.home.clone(), input, cancel);
        }
        Box::pin(async {
            Err(crate::turn_driver::WorkerError {
                code: "invalid_params".into(),
                message: "no steerable Codex turn".into(),
            })
        })
    }
    #[allow(dead_code)] // Used by the daemon's shared permission-state transition.
    pub(crate) fn permission_broker(&self) -> Broker {
        self.inner.broker.clone()
    }
    pub fn list_permissions(&self, session: Option<&str>) -> Vec<Value> {
        self.inner.broker.list(session)
    }
    pub fn resolve_permission(
        &self,
        id: &str,
        decision: Decision,
        by: &str,
    ) -> Result<Resolution, permission_broker::BrokerError> {
        self.inner.broker.resolve(id, decision, by)
    }
    pub(crate) fn busy(&self, key: &SessionKey) -> bool {
        self.inner.deps.driver.active_ticket(key).is_some()
            || self
                .inner
                .shared
                .state
                .lock()
                .expect("Codex runtime")
                .preparing
                .contains_key(key)
    }
    pub(crate) async fn wait_idle(&self, key: &SessionKey) {
        loop {
            let changed = self.inner.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !self.busy(key) {
                return;
            }
            if let Some(ticket) = self.inner.deps.driver.active_ticket(key) {
                tokio::select! {_=self.inner.deps.driver.wait_ticket(&ticket)=>{},_=changed=>{}}
            } else {
                changed.await;
            }
        }
    }
    pub fn stop(
        &self,
        key: &SessionKey,
        public_turn_id: Option<&str>,
    ) -> Result<bool, RuntimeError> {
        if !self.inner.owns_globals {
            let (ticket, preparing) = {
                let state = self.inner.shared.state.lock().expect("Codex runtime");
                (
                    state.leases.get(key).and_then(|lease| lease.ticket.clone()),
                    state.preparing.get(key).cloned(),
                )
            };
            if let Some(ticket) = ticket {
                if public_turn_id.is_some_and(|id| {
                    self.inner.deps.driver.public_turn_id(&ticket).as_deref() != Some(id)
                }) {
                    return Ok(false);
                }
                return Ok(self.inner.deps.driver.cancel(&ticket));
            }
            if public_turn_id.is_none()
                && let Some(preparing) = preparing
            {
                preparing.send_replace(true);
                return Ok(true);
            }
            return Ok(false);
        }
        let ticket = self.inner.deps.driver.active_ticket(key);
        let Some(ticket) = ticket else {
            if public_turn_id.is_some() {
                return Ok(false);
            }
            let preparing = {
                self.inner
                    .shared
                    .state
                    .lock()
                    .expect("Codex runtime")
                    .preparing
                    .get(key)
                    .cloned()
            };
            if let Some(preparing) = preparing {
                preparing.send_replace(true);
                return Ok(true);
            }
            return Ok(false);
        };
        if public_turn_id
            .is_some_and(|id| self.inner.deps.driver.public_turn_id(&ticket).as_deref() != Some(id))
        {
            return Ok(false);
        }
        Ok(self.inner.deps.driver.cancel(&ticket))
    }
    /// Unconditional owner stop across the preparing -> Driver handoff.
    pub fn stop_name(&self, name: &str) -> Result<bool, RuntimeError> {
        let mut stopped = false;
        if let Some(ticket) = self.inner.deps.driver.active_ticket_for_name(name) {
            stopped |= self.stop(ticket.session(), None)?;
        }
        {
            let state = self.inner.shared.state.lock().expect("Codex runtime");
            for (key, cancelled) in &state.preparing {
                if key.name == name {
                    cancelled.send_replace(true);
                    stopped = true;
                }
            }
        }
        // A preparation could have become active and left the preparing map.
        if let Some(ticket) = self.inner.deps.driver.active_ticket_for_name(name) {
            stopped |= self.stop(ticket.session(), None)?;
        }
        Ok(stopped)
    }
    /// Owned shutdown continues if this waiting future is dropped. Repeating
    /// shutdown requests a retry of any unconfirmed process cleanup.
    pub fn shutdown(&self) -> Task<Result<(), RuntimeError>> {
        begin_shutdown(self.inner.clone());
        wait_shutdown(&self.inner.shared)
    }
    pub fn host_count(&self) -> usize {
        let state = self.inner.shared.state.lock().expect("Codex runtime");
        state.pool.len() + state.dedicated.len()
    }
}
impl Drop for CodexRuntime {
    fn drop(&mut self) {
        begin_shutdown(self.inner.clone());
    }
}
struct Reservation {
    shared: Arc<Shared>,
    key: SessionKey,
    cancelled: watch::Receiver<bool>,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.shared
            .state
            .lock()
            .expect("Codex runtime")
            .preparing
            .remove(&self.key);
        self.shared.changed.notify_waiters();
    }
}
fn reserve(
    inner: &Inner,
    key: &SessionKey,
    input: &Input,
    queued: bool,
) -> Result<Reservation, RuntimeError> {
    if input.text.len() > if queued { 200_000 } else { 65536 }
        || (input.text.chars().all(js_space) && input.metadata.attachments.is_empty())
        || input.metadata.attachments.len() > crate::prompt_attachments::MAX_PROMPT_ATTACHMENTS
        || input
            .metadata
            .attachments
            .iter()
            .any(|a| a.path.len() > 65536 || a.name.len() > 2048 || a.mime.len() > 512)
    {
        return Err(RuntimeError::Invalid);
    }
    if input.metadata.question_id.is_some()
        || (!queued
            && (input.metadata.queue_item_id.is_some() || input.metadata.queue_item_at.is_some()))
    {
        return Err(RuntimeError::Unsupported);
    }
    key.validate().map_err(|_| RuntimeError::Invalid)?;
    if inner.deps.driver.storage_failed() || inner.broker.storage_failed() {
        inner.deps.driver.report_storage_failure();
        return Err(RuntimeError::Storage);
    }
    if *inner.shared.closed.borrow() {
        return Err(RuntimeError::Closed);
    }
    if inner.deps.driver.active_ticket(key).is_some() {
        return Err(RuntimeError::Busy);
    }
    let mut state = inner.shared.state.lock().expect("Codex runtime");
    // Shutdown observes this same state lock before proving preparation quiet.
    // Recheck after acquiring it so no late reservation can escape that proof.
    if *inner.shared.closed.borrow() {
        return Err(RuntimeError::Closed);
    }
    if state.preparing.contains_key(key) {
        return Err(RuntimeError::Busy);
    }
    if state.preparing.len() >= inner.limits.preparing {
        return Err(RuntimeError::Capacity);
    }
    let (sender, cancelled) = watch::channel(false);
    state.preparing.insert(key.clone(), sender);
    Ok(Reservation {
        shared: inner.shared.clone(),
        key: key.clone(),
        cancelled,
    })
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
async fn execute(
    inner: Arc<Inner>,
    key: SessionKey,
    mut input: Input,
    mut cancelled: watch::Receiver<bool>,
) -> Result<Handle, RuntimeError> {
    let preparing = inner.clone();
    let checking = key.clone();
    let cancellation = cancelled.clone();
    // Reservation ownership remains on this task until the blocking read and
    // attachment validation finish, even if stop or caller cancellation arrives.
    let (snapshot, attachments) = tokio::task::spawn_blocking(move || {
        if *cancellation.borrow() {
            return Err(RuntimeError::Cancelled);
        }
        if *preparing.shared.closed.borrow() {
            return Err(RuntimeError::Closed);
        }
        let snapshot = preparing
            .owner
            .snapshot(&checking)
            .map_err(|_| RuntimeError::Session)?;
        if snapshot.settings.browser.is_some() {
            return Err(RuntimeError::Unsupported);
        }
        let values = Value::Array(
            input
                .metadata
                .attachments
                .iter()
                .map(|a| a.value())
                .collect(),
        );
        let attachments = crate::prompt_attachments::validate_owned_prompt_attachments(
            &preparing.deps.home,
            &checking.name,
            Some(&values),
        )
        .map_err(|_| RuntimeError::Invalid)?;
        Ok((snapshot, attachments))
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    input.metadata.attachments = attachments;
    let mut closed = inner.shared.closed.subscribe();
    if *cancelled.borrow() {
        return Err(RuntimeError::Cancelled);
    }
    if *closed.borrow() {
        return Err(RuntimeError::Closed);
    }
    let memory_enabled = match &inner.memory {
        Some(memory) => memory
            .enabled(key.clone())
            .await
            .map_err(|_| RuntimeError::Session)?,
        None => false,
    };
    let memory_slot = if memory_enabled {
        Some(tokio::select! {
            permit=inner.shared.memory_slots.clone().acquire_owned()=>permit.map_err(|_|RuntimeError::Closed)?,
            _=closed.changed()=>return Err(RuntimeError::Closed),
            _=cancelled.changed()=>return Err(RuntimeError::Cancelled),
            _=inner.deps.driver.wait_for_storage_failure()=>return Err(RuntimeError::Storage),
        })
    } else {
        None
    };
    let rule = inner.config.guard.as_network_rule();
    let check = tokio::select! {
        check=inner.shared.guard.check(Provider::Codex,&inner.config.network.codex,&rule,false)=>check.map_err(|_|RuntimeError::NetworkDenied)?,
        _=closed.changed()=>return Err(RuntimeError::Closed),
        _=cancelled.changed()=>return Err(RuntimeError::Cancelled),
    };
    let env = inner
        .shared
        .guard
        .worker_environment(&check, &inner.shared.parent, &Environment::new())
        .map_err(|_| RuntimeError::NetworkDenied)?;
    if *cancelled.borrow() {
        return Err(RuntimeError::Cancelled);
    }
    if *closed.borrow() || inner.deps.driver.storage_failed() {
        return Err(RuntimeError::Closed);
    }
    let pool_key = PoolKey::new(&check, env);
    let (host, dedicated_guard) = if let Some(slot) = memory_slot {
        let building = inner.clone();
        let environment = pool_key.env.clone();
        let runtime = inner.runtime.clone();
        let entry = tokio::task::spawn_blocking(move || {
            let _context = runtime.enter();
            let mut services = building.owner.services(building.deps.sink.clone(), None);
            services.approval = Some(Arc::new(Approvals {
                inner: Arc::downgrade(&building),
                gate: services.fresh_gate.clone(),
            }));
            let mut limits = building.limits.host;
            limits.sessions = 1;
            limits.jobs = 1;
            let host = CodexHost::start_with_memory(
                codex_worker::HostConfig {
                    launch: Launch {
                        holder: building.command.holder.clone(),
                        program: building.command.program.clone(),
                        args: building.command.prefix_args.clone(),
                        cwd: building.deps.home.clone(),
                        env: environment,
                    },
                    fingerprint: "codex-memory-dedicated".into(),
                    limits,
                    timeouts: building.limits.timeouts,
                },
                services,
                building.memory.clone().ok_or(RuntimeError::Invalid)?,
            )
            .map_err(|_| RuntimeError::Invalid)?;
            Ok::<_, RuntimeError>(Arc::new(Dedicated {
                host,
                _slot: slot,
                retiring: AtomicBool::new(false),
            }))
        })
        .await
        .map_err(|_| RuntimeError::Invalid)??;
        inner
            .shared
            .state
            .lock()
            .expect("Codex runtime")
            .dedicated
            .push(entry.clone());
        let host = entry.host.clone();
        let guard = DedicatedGuard {
            shared: Arc::downgrade(&inner.shared),
            entry,
            runtime: inner.runtime.clone(),
        };
        if *cancelled.borrow() || *closed.borrow() {
            return Err(RuntimeError::Cancelled);
        }
        (host, Some(guard))
    } else {
        let mut state = inner.shared.state.lock().expect("Codex runtime");
        if *closed.borrow() {
            return Err(RuntimeError::Closed);
        }
        let host = if let Some(entry) = state.pool.iter().find(|entry| {
            entry.key == pool_key
                && matches!(
                    entry.host.status(),
                    codex_worker::HostStatus::Starting | codex_worker::HostStatus::Ready
                )
        }) {
            entry.host.clone()
        } else {
            if state.pool.len() >= inner.limits.hosts {
                return Err(RuntimeError::Capacity);
            }
            let mut services = inner.owner.services(inner.deps.sink.clone(), None);
            services.approval = Some(Arc::new(Approvals {
                inner: Arc::downgrade(&inner),
                gate: services.fresh_gate.clone(),
            }));
            let host = CodexHost::start(
                codex_worker::HostConfig {
                    launch: Launch {
                        holder: inner.command.holder.clone(),
                        program: inner.command.program.clone(),
                        args: inner.command.prefix_args.clone(),
                        cwd: inner.deps.home.clone(),
                        env: pool_key.env.clone(),
                    },
                    fingerprint: "codex-runtime-exact-route".into(),
                    limits: inner.limits.host,
                    timeouts: inner.limits.timeouts,
                },
                services,
            )
            .map_err(|_| RuntimeError::Invalid)?;
            state.pool.push(Entry {
                key: pool_key.clone(),
                host: host.clone(),
            });
            host
        };
        (host, None)
    };
    let reading = inner.clone();
    let session = key.clone();
    let resume_id = tokio::task::spawn_blocking(move || {
        let registry = reading
            .deps
            .registry
            .lock()
            .map_err(|_| RuntimeError::Storage)?;
        Ok::<_, RuntimeError>(
            registry
                .find(&session.name)
                .and_then(|r| r.scalar("providerSessionId")),
        )
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    let worker = host
        .worker(SessionSpec {
            key: key.clone(),
            home: inner.deps.home.clone(),
            cwd: snapshot.cwd.clone(),
            resume_id,
            broker: true,
            attachments: input.metadata.attachments.clone(),
        })
        .map_err(|_| RuntimeError::Session)?;
    let nonce = Arc::new(());
    {
        let mut state = inner.shared.state.lock().expect("Codex runtime");
        if *closed.borrow() {
            return Err(RuntimeError::Closed);
        }
        state.leases.insert(
            key.clone(),
            Lease {
                ticket: None,
                host: Arc::downgrade(&host),
                nonce: nonce.clone(),
                check,
                key: pool_key,
                cancelled: cancelled.clone(),
            },
        );
    }
    // No runtime guard spans Driver's injected redactor or synchronous calls.
    let gate = inner
        .owner
        .services(inner.deps.sink.clone(), None)
        .fresh_gate;
    let driver = inner.deps.driver.clone();
    let handle = match tokio::task::spawn_blocking(move || {
        driver.start_input(snapshot, input, worker, gate)
    })
    .await
    {
        Ok(Ok(handle)) => handle,
        result => {
            remove_lease(&inner.shared, &key, &nonce);
            return Err(match result {
                Ok(Err(turn_driver::DriverError::Busy)) => RuntimeError::Busy,
                Ok(Err(turn_driver::DriverError::StorageUnavailable)) => RuntimeError::Storage,
                _ => RuntimeError::Invalid,
            });
        }
    };
    {
        let mut state = inner.shared.state.lock().expect("Codex runtime");
        if let Some(lease) = state
            .leases
            .get_mut(&key)
            .filter(|lease| Arc::ptr_eq(&lease.nonce, &nonce))
        {
            lease.ticket = Some(handle.ticket().clone());
        }
    }
    // A synchronous Driver redactor can reenter stop/shutdown before the
    // ticket becomes visible. Reconcile cancellation after reservation.
    if *cancelled.borrow() || *closed.borrow() {
        inner.deps.driver.cancel(handle.ticket());
    }
    let mut progress = handle.subscribe_progress();
    let shared = Arc::downgrade(&inner.shared);
    inner.runtime.spawn(async move {
        let _dedicated = dedicated_guard;
        loop {
            if matches!(*progress.borrow_and_update(), Progress::Finished(_)) {
                break;
            }
            if progress.changed().await.is_err() {
                // Lost progress is not proof of Finished. Retain the lease.
                return;
            }
        }
        if let Some(shared) = shared.upgrade() {
            remove_lease(&shared, &key, &nonce);
        }
    });
    Ok(handle)
}
fn remove_lease(shared: &Shared, key: &SessionKey, nonce: &Arc<()>) {
    let mut state = shared.state.lock().expect("Codex runtime");
    if state
        .leases
        .get(key)
        .is_some_and(|l| Arc::ptr_eq(&l.nonce, nonce))
    {
        state.leases.remove(key);
    }
    drop(state);
    shared.changed.notify_waiters();
}
struct Approvals {
    inner: Weak<Inner>,
    gate: Arc<dyn DispatchGate>,
}
/// Dropping the caller cancels only its exact question. The owned task retains
/// response and policy-IO guards until the Broker's journal work is drained.
struct ApprovalCancel(watch::Sender<bool>);
impl Drop for ApprovalCancel {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}
impl ApprovalHandler for Approvals {
    fn handle(&self, context: ApprovalContext) -> Task<()> {
        let Some(inner) = self.inner.upgrade() else {
            return Box::pin(async {});
        };
        let gate = self.gate.clone();
        let (cancelled, mut cancellation) = watch::channel(false);
        let cancel_on_drop = ApprovalCancel(cancelled);
        // Registration happens before the caller can drop/abort even an
        // unpolled handler future. Holding only the responder count is not
        // sufficient: process retirement can bypass that bounded wait.
        let policy_io = context.responder.retain_policy_io();
        let runtime = inner.runtime.clone();
        let owned = runtime.spawn(async move {
            let _policy_io = policy_io;
            if *cancellation.borrow()
                || !matches!(
                    context.method.as_str(),
                    "item/commandExecution/requestApproval"
                        | "item/fileChange/requestApproval"
                        | "item/tool/requestUserInput"
                )
            {
                return;
            }
            let owner = TrustedOwner {
                session: context.session.clone(),
                ticket: context.ticket.clone(),
                thread_id: context.thread_id.clone(),
                provider_turn_id: context.native_turn_id.clone(),
            };
            let prepared = match codex_permissions::prepare(
                &context.method,
                &context.params,
                owner.clone(),
                Capabilities::default(),
            ) {
                Ok(prepared) => prepared,
                Err(error) => {
                    if !*cancellation.borrow() {
                        let _ = context.responder.respond(Err(error.response_error())).await;
                    }
                    return;
                }
            };
            if *cancellation.borrow() {
                return;
            }
            let mut request = match inner.broker.request(prepared.request()) {
                Ok(request) => request,
                Err(_) => {
                    if inner.broker.storage_failed() {
                        inner.deps.driver.report_storage_failure();
                    }
                    return;
                }
            };
            let decision = {
                // One waiter only: dropping/recreating DecisionWait on another
                // notification would itself cancel the question.
                let decision = request.decision();
                tokio::pin!(decision);
                if *cancellation.borrow() {
                    None
                } else {
                    tokio::select! { biased;
                        _ = cancellation.changed() => None,
                        decision = &mut decision => Some(decision),
                    }
                }
            };
            request.cancel();
            // This owner is not the outer cancellable handler. A hung requested
            // or resolved append keeps policy_io and the exact Ticket alive.
            request.drained().await;
            if inner.broker.storage_failed() {
                inner.deps.driver.report_storage_failure();
                return;
            }
            if *cancellation.borrow() || *inner.shared.closed.borrow() {
                return;
            }
            let Some(decision) = decision else {
                return;
            };
            let Some(snapshot) = inner.deps.driver.snapshot_for_dispatch(&context.ticket) else {
                return;
            };
            let answer = prepared
                .resolve(&owner, decision)
                .map_err(|error| error.response_error());
            let response_cancellation = cancellation.clone();
            let gate = Arc::new(
                move |ticket: &crate::turn_coordinator::Ticket, snapshot: &TurnSnapshot| {
                    if *response_cancellation.borrow() {
                        return turn_driver::DispatchDecision::Deny;
                    }
                    let decision = gate.check(ticket, snapshot);
                    if *response_cancellation.borrow() {
                        turn_driver::DispatchDecision::Deny
                    } else {
                        decision
                    }
                },
            );
            let _ = context
                .responder
                .respond_checked(gate, snapshot, context.effective_approval, answer)
                .await;
        });
        Box::pin(async move {
            let _cancel_on_drop = cancel_on_drop;
            let _ = owned.await;
        })
    }
}

fn begin_shutdown(inner: Arc<Inner>) {
    inner.shared.closed.send_replace(true);
    if !inner.owns_globals {
        begin_daemon_shutdown(inner);
        return;
    }
    inner.broker.shutdown();
    inner.deps.driver.begin_shutdown();
    let hosts = {
        inner
            .shared
            .state
            .lock()
            .expect("Codex runtime")
            .pool
            .iter()
            .map(|entry| entry.host.clone())
            .collect::<Vec<_>>()
    };
    // Seal and request all available interrupts/process stops before waiting
    // for owned host IO. A blocked preparation must not keep warm hosts alive.
    for host in hosts {
        drop(host.shutdown());
    }
    {
        // Serialize admission/retry with terminal publication. Successful
        // completion is monotonic; nobody can reset an exited cleanup owner.
        let mut phase = inner.shared.shutdown.lock().expect("Codex shutdown");
        match *phase {
            ShutdownPhase::Idle => *phase = ShutdownPhase::Running,
            ShutdownPhase::Running | ShutdownPhase::Complete => return,
            ShutdownPhase::WaitingRetry => {
                *phase = ShutdownPhase::Running;
                inner.shared.finished.send_replace(None);
                inner.shared.retry.notify_one();
                return;
            }
        }
    }
    inner.runtime.clone().spawn(async move {
        loop {
            if let Some(curl) = &inner.owned_curl {
                curl.shutdown().await;
            }
            loop {
                let changed = inner.shared.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if inner
                    .shared
                    .state
                    .lock()
                    .expect("Codex runtime")
                    .preparing
                    .is_empty()
                {
                    break;
                }
                changed.await;
            }
            let _ = inner.deps.driver.shutdown(Duration::from_secs(1)).await;
            let hosts = {
                let state = inner.shared.state.lock().expect("Codex runtime");
                state
                    .pool
                    .iter()
                    .map(|entry| entry.host.clone())
                    .chain(state.dedicated.iter().map(|entry| entry.host.clone()))
                    .collect::<Vec<_>>()
            };
            let mut good = true;
            for host in hosts {
                host.retry_cleanup();
                if host.shutdown().await.is_err() {
                    good = false;
                } else {
                    inner
                        .shared
                        .state
                        .lock()
                        .expect("Codex runtime")
                        .dedicated
                        .retain(|entry| !Arc::ptr_eq(&entry.host, &host));
                }
            }
            if inner
                .deps
                .driver
                .shutdown(Duration::from_secs(1))
                .await
                .is_err()
            {
                good = false;
            }
            inner.broker.shutdown();
            inner.broker.drain().await;
            let result = if good {
                Ok(())
            } else {
                Err(RuntimeError::CleanupUnconfirmed)
            };
            {
                let mut phase = inner.shared.shutdown.lock().expect("Codex shutdown");
                *phase = if good {
                    ShutdownPhase::Complete
                } else {
                    ShutdownPhase::WaitingRetry
                };
                inner.shared.finished.send_replace(Some(result));
            }
            if good {
                break;
            }
            inner.shared.retry.notified().await;
        }
    });
}
// Snapshot identities under the runtime lock, then invoke Driver/hosts outside
// it. No name/latest-session lookup establishes shutdown ownership.
fn cancel_daemon_work(
    inner: &Inner,
) -> (Vec<crate::turn_coordinator::Ticket>, Vec<Arc<CodexHost>>) {
    let (tickets, hosts) = {
        let state = inner.shared.state.lock().expect("Codex runtime");
        for preparing in state.preparing.values() {
            preparing.send_replace(true);
        }
        (
            state
                .leases
                .values()
                .filter_map(|lease| lease.ticket.clone())
                .collect::<Vec<_>>(),
            state
                .pool
                .iter()
                .map(|entry| entry.host.clone())
                .chain(state.dedicated.iter().map(|entry| entry.host.clone()))
                .collect::<Vec<_>>(),
        )
    };
    for ticket in &tickets {
        inner.deps.driver.cancel(ticket);
    }
    for host in &hosts {
        host.retry_cleanup();
        drop(host.shutdown());
    }
    (tickets, hosts)
}
async fn daemon_checkpoint(inner: &Inner) -> Result<(), RuntimeError> {
    if let Some(curl) = &inner.owned_curl {
        curl.shutdown().await;
    }
    loop {
        let changed = inner.shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if inner
            .shared
            .state
            .lock()
            .expect("Codex runtime")
            .preparing
            .is_empty()
        {
            break;
        }
        changed.await;
    }
    let (tickets, hosts) = cancel_daemon_work(inner);
    for host in hosts {
        host.shutdown()
            .await
            .map_err(|_| RuntimeError::CleanupUnconfirmed)?;
        inner
            .shared
            .state
            .lock()
            .expect("Codex runtime")
            .dedicated
            .retain(|entry| !Arc::ptr_eq(&entry.host, &host));
    }
    for ticket in tickets {
        inner.deps.driver.wait_ticket(&ticket).await;
    }
    loop {
        let changed = inner.shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let quiet = {
            let state = inner.shared.state.lock().expect("Codex runtime");
            state.preparing.is_empty() && state.leases.is_empty()
        };
        if quiet {
            return Ok(());
        }
        changed.await;
    }
}
fn begin_daemon_shutdown(inner: Arc<Inner>) {
    cancel_daemon_work(&inner);
    {
        let mut phase = inner.shared.shutdown.lock().expect("Codex shutdown");
        match *phase {
            ShutdownPhase::Idle => *phase = ShutdownPhase::Running,
            ShutdownPhase::Running | ShutdownPhase::Complete => return,
            ShutdownPhase::WaitingRetry => {
                *phase = ShutdownPhase::Running;
                inner.shared.finished.send_replace(None);
                inner.shared.retry.notify_one();
                return;
            }
        }
    }
    inner.runtime.clone().spawn(async move {
        loop {
            // Dropping checkpoint waiters aborts no owned preparation/process IO.
            // Unknown cleanup retains leases and can be retried by shutdown().
            let result = tokio::time::timeout(Duration::from_secs(1), daemon_checkpoint(&inner))
                .await
                .unwrap_or(Err(RuntimeError::CleanupUnconfirmed));
            let good = result.is_ok();
            {
                let mut phase = inner.shared.shutdown.lock().expect("Codex shutdown");
                *phase = if good {
                    ShutdownPhase::Complete
                } else {
                    ShutdownPhase::WaitingRetry
                };
                inner.shared.finished.send_replace(Some(result));
            }
            if good {
                break;
            }
            inner.shared.retry.notified().await;
        }
    });
}

struct FaultSink {
    sink: Arc<dyn EventSink>,
    driver: Weak<Driver>,
    shared: Weak<Shared>,
}
impl EventSink for FaultSink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let sink = self.sink.clone();
        let driver = self.driver.clone();
        let shared = self.shared.clone();
        Box::pin(async move {
            match tokio::spawn(async move { sink.append(draft).await }).await {
                Ok(Ok(receipt))
                    if receipt.id > 0
                        && receipt.id <= 9_007_199_254_740_991
                        && !receipt.ts.is_empty()
                        && receipt.ts.len() <= 128 =>
                {
                    Ok(receipt)
                }
                _ => {
                    if let Some(shared) = shared.upgrade() {
                        shared.closed.send_replace(true);
                    }
                    if let Some(driver) = driver.upgrade() {
                        driver.report_storage_failure();
                    }
                    Err(SinkError {
                        message: "Codex storage outcome is unconfirmed".into(),
                    })
                }
            }
        })
    }
}
fn wait_shutdown(shared: &Shared) -> Task<Result<(), RuntimeError>> {
    let mut result = shared.finished.subscribe();
    Box::pin(async move {
        loop {
            if let Some(value) = *result.borrow_and_update() {
                return value;
            }
            if result.changed().await.is_err() {
                return Err(RuntimeError::CleanupUnconfirmed);
            }
        }
    })
}

#[cfg(test)]
#[path = "codex_runtime_daemon_tests.rs"]
mod daemon_tests;
