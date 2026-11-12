//! Owned per-turn Claude orchestration. No warm-process, background, question
//! or ZCode parity is implied. Shared network and daemon Broker are never owned
//! or shut down by this provider controller.
use crate::claude_host_services::{ClaudeOwner, OwnerError};
use crate::claude_settings::Settings;
use crate::claude_worker::{ClaudeWorker, Config, ScopedMcp};
use crate::consent_store::ConsentStore;
use crate::network_guard::{Check, NetworkGuard};
use crate::registry::Registry;
use crate::runtime_config::RuntimeConfig;
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{
    DispatchGate, Driver, EventSink, Handle, Input, Progress, Task, WorkerError,
};
use crate::turn_snapshot::{Provider, SessionKey, TurnSnapshot};
use crate::worker_env::{self, Environment};
use crate::worker_process::Launch;
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsString,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, OnceCell, oneshot, watch};

pub struct Dependencies {
    pub home: PathBuf,
    pub registry: Arc<Mutex<Registry>>,
    pub consent: Arc<Mutex<ConsentStore>>,
    pub driver: Arc<Driver>,
    pub sink: Arc<dyn EventSink>,
}
pub struct TrustedCommand {
    pub holder: PathBuf,
    pub program: PathBuf,
    pub prefix_args: Vec<OsString>,
}
pub struct SettingsRoots {
    pub child_home: PathBuf,
    pub managed_directory: PathBuf,
}
/// Mandatory host construction; no client-selected helper or MCP authority.
pub type McpFactory =
    Arc<dyn Fn(Arc<dyn DispatchGate>) -> Result<Arc<dyn ScopedMcp>, WorkerError> + Send + Sync>;
#[derive(Clone, Copy)]
pub struct Limits {
    pub turns: usize,
    pub start_timeout: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            turns: 64,
            start_timeout: Duration::from_secs(30),
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
    Storage,
    Cancelled,
    CleanupUnconfirmed,
    Owner(OwnerError),
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
            Self::Storage => "storage_unavailable",
            Self::Cancelled => "cancelled",
            Self::CleanupUnconfirmed => "cleanup_unconfirmed",
            Self::Owner(error) => error.code(),
        }
    }
}
impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Owner(error) => error.fmt(f),
            _ => f.write_str(self.code()),
        }
    }
}
impl std::error::Error for RuntimeError {}
struct Entry {
    nonce: Arc<()>,
    cancel: watch::Sender<bool>,
    ticket: Option<Ticket>,
    route: Option<(Check, Environment)>,
    quarantined: bool,
}
struct Shared {
    state: Mutex<HashMap<SessionKey, Entry>>,
    closed: watch::Sender<bool>,
    changed: Notify,
    guard: Arc<NetworkGuard>,
    parent: Environment,
    driver: Arc<Driver>,
}
impl Shared {
    fn route(&self, ticket: &Ticket, snapshot: &TurnSnapshot) -> bool {
        if *self.closed.borrow()
            || self.driver.snapshot_for_dispatch(ticket).as_ref() != Some(snapshot)
        {
            return false;
        }
        let route = {
            let mut entries = self.state.lock().expect("Claude runtime");
            let Some(entry) = entries.get_mut(ticket.session()) else {
                return false;
            };
            if *entry.cancel.borrow() || entry.ticket.as_ref().is_some_and(|bound| bound != ticket)
            {
                return false;
            }
            // Only a live Driver ticket may bind the reservation. Never a native
            // payload, a session-name lookup, or the last ticket of another turn.
            entry.ticket = Some(ticket.clone());
            entry.route.clone()
        };
        let Some((check, environment)) = route else {
            return false;
        };
        self.guard.is_current(&check)
            && self
                .guard
                .worker_environment(&check, &self.parent, &Environment::new())
                .is_ok_and(|fresh| fresh == environment)
            && !*self.closed.borrow()
            && self.driver.snapshot_for_dispatch(ticket).as_ref() == Some(snapshot)
            && self
                .state
                .lock()
                .expect("Claude runtime")
                .get(ticket.session())
                .is_some_and(|entry| {
                    entry.ticket.as_ref() == Some(ticket) && !*entry.cancel.borrow()
                })
    }
}
struct Inner {
    deps: Dependencies,
    command: TrustedCommand,
    config: RuntimeConfig,
    settings: Arc<Settings>,
    factory: McpFactory,
    limits: Limits,
    shared: Arc<Shared>,
    owner: OnceCell<Arc<ClaudeOwner>>,
    runtime: tokio::runtime::Handle,
}
pub struct ClaudeRuntime {
    inner: Arc<Inner>,
}
impl ClaudeRuntime {
    /// Pure shape validation. Filesystem identity/settings work belongs to the
    /// owned preparation, not a caller or Tokio worker blocked on Registry IO.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        deps: Dependencies,
        command: TrustedCommand,
        config: RuntimeConfig,
        parent: Environment,
        roots: SettingsRoots,
        guard: Arc<NetworkGuard>,
        factory: McpFactory,
        limits: Limits,
    ) -> Result<Self, RuntimeError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| RuntimeError::Invalid)?;
        if !deps.home.is_absolute()
            || limits.turns == 0
            || limits.turns > 256
            || limits.start_timeout.is_zero()
            || limits.start_timeout > Duration::from_secs(120)
            || parent.get(std::ffi::OsStr::new("HOME"))
                != Some(&roots.child_home.as_os_str().to_owned())
            || parent.contains_key(std::ffi::OsStr::new("PULT_MEMORY_KEY"))
        {
            return Err(RuntimeError::Invalid);
        }
        let settings = Arc::new(
            Settings::new(&roots.child_home, roots.managed_directory)
                .map_err(|_| RuntimeError::Invalid)?,
        );
        let parent = worker_env::from_parent(&parent, &Environment::new())
            .map_err(|_| RuntimeError::Invalid)?;
        Launch {
            holder: command.holder.clone(),
            program: command.program.clone(),
            args: command.prefix_args.clone(),
            cwd: deps.home.clone(),
            env: parent.clone(),
        }
        .validate_shape()
        .map_err(|_| RuntimeError::Invalid)?;
        let shared = Arc::new(Shared {
            state: Mutex::new(HashMap::new()),
            closed: watch::channel(false).0,
            changed: Notify::new(),
            guard,
            parent,
            driver: deps.driver.clone(),
        });
        Ok(Self {
            inner: Arc::new(Inner {
                deps,
                command,
                config,
                settings,
                factory,
                limits,
                shared,
                owner: OnceCell::new(),
                runtime,
            }),
        })
    }
    pub fn execute(&self, key: SessionKey, input: Input) -> Task<Result<Handle, RuntimeError>> {
        self.submit(key, input, false)
    }
    /// For the host queue owner only: queue identity must already be verified
    /// against its durable selected item. No question protocol is inferred.
    pub fn execute_queued(
        &self,
        key: SessionKey,
        input: Input,
    ) -> Task<Result<Handle, RuntimeError>> {
        self.submit(key, input, true)
    }
    fn submit(
        &self,
        key: SessionKey,
        input: Input,
        queued: bool,
    ) -> Task<Result<Handle, RuntimeError>> {
        let admission = reserve(&self.inner, &key, &input, queued);
        let (sender, receiver) = oneshot::channel();
        if let Ok(reservation) = admission {
            let inner = self.inner.clone();
            self.inner.runtime.spawn(async move {
                // Owned task panics are not cleanup receipts. Conservatively
                // retain the reservation and fault admission; external probe
                // implementations must never turn unwinding into a free slot.
                let mut panic = PreparationPanic {
                    shared: inner.shared.clone(),
                    key: key.clone(),
                    armed: true,
                };
                let result = prepare(inner.clone(), key, input, &reservation).await;
                panic.armed = false;
                // Success transfers the entry to the progress owner. Failure
                // has joined every blocking operation before releasing capacity.
                if matches!(
                    result,
                    Err(RuntimeError::Storage | RuntimeError::Owner(OwnerError::Storage))
                ) {
                    inner.deps.driver.report_storage_failure();
                }
                if result.is_err() {
                    remove(&inner.shared, &reservation.key, &reservation.nonce);
                }
                let _ = sender.send(result);
            });
        } else {
            let _ = sender.send(Err(admission.err().expect("admission error")));
        }
        Box::pin(async move { receiver.await.unwrap_or(Err(RuntimeError::Storage)) })
    }
    pub fn busy(&self, key: &SessionKey) -> bool {
        self.inner
            .shared
            .state
            .lock()
            .expect("Claude runtime")
            .contains_key(key)
    }
    pub async fn wait_idle(&self, key: &SessionKey) {
        loop {
            let changed = self.inner.shared.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !self.busy(key) {
                return;
            }
            changed.await;
        }
    }
    pub fn stop(
        &self,
        key: &SessionKey,
        public_turn_id: Option<&str>,
    ) -> Result<bool, RuntimeError> {
        let mut entries = self.inner.shared.state.lock().expect("Claude runtime");
        let Some(entry) = entries.get_mut(key) else {
            return Ok(false);
        };
        if public_turn_id.is_some_and(|id| {
            entry
                .ticket
                .as_ref()
                .and_then(|ticket| self.inner.deps.driver.public_turn_id(ticket))
                .as_deref()
                != Some(id)
        }) {
            return Ok(false);
        }
        entry.cancel.send_replace(true);
        let ticket = entry.ticket.clone();
        drop(entries);
        if let Some(ticket) = ticket {
            self.inner.deps.driver.cancel(&ticket);
        }
        self.inner.shared.changed.notify_waiters();
        Ok(true)
    }
    pub fn stop_name(&self, name: &str) -> Result<bool, RuntimeError> {
        let keys: Vec<_> = self
            .inner
            .shared
            .state
            .lock()
            .expect("Claude runtime")
            .keys()
            .filter(|key| key.name == name)
            .cloned()
            .collect();
        let mut stopped = false;
        for key in keys {
            stopped |= self.stop(&key, None)?;
        }
        Ok(stopped)
    }
    /// Closes only this provider's admission and tickets. Shared network probes,
    /// daemon Broker and other providers remain under the outer owner's lease.
    /// Dropping this waiter does not cancel preparations or Driver cleanup.
    pub fn shutdown(&self) -> Task<Result<(), RuntimeError>> {
        close(&self.inner.shared);
        let shared = self.inner.shared.clone();
        Box::pin(async move {
            loop {
                let changed = shared.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                {
                    let entries = shared.state.lock().expect("Claude runtime");
                    if entries.is_empty() {
                        return Ok(());
                    }
                    if entries.values().any(|entry| entry.quarantined) {
                        return Err(RuntimeError::CleanupUnconfirmed);
                    }
                }
                changed.await;
            }
        })
    }
}
impl Drop for ClaudeRuntime {
    fn drop(&mut self) {
        close(&self.inner.shared);
    }
}
fn close(shared: &Shared) {
    shared.closed.send_replace(true);
    let tickets: Vec<_> = {
        let entries = shared.state.lock().expect("Claude runtime");
        entries
            .values()
            .filter_map(|entry| {
                entry.cancel.send_replace(true);
                entry.ticket.clone()
            })
            .collect()
    };
    for ticket in tickets {
        shared.driver.cancel(&ticket);
    }
    shared.changed.notify_waiters();
}
struct PreparationPanic {
    shared: Arc<Shared>,
    key: SessionKey,
    armed: bool,
}
impl Drop for PreparationPanic {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let ticket = {
            let mut entries = self.shared.state.lock().expect("Claude runtime");
            entries.get_mut(&self.key).and_then(|entry| {
                entry.quarantined = true;
                entry.cancel.send_replace(true);
                entry.ticket.clone()
            })
        };
        self.shared.driver.report_storage_failure();
        if let Some(ticket) = ticket {
            self.shared.driver.cancel(&ticket);
        }
        self.shared.changed.notify_waiters();
    }
}
struct Reservation {
    key: SessionKey,
    nonce: Arc<()>,
    cancel: watch::Receiver<bool>,
}
fn remove(shared: &Shared, key: &SessionKey, nonce: &Arc<()>) {
    let mut entries = shared.state.lock().expect("Claude runtime");
    if entries
        .get(key)
        .is_some_and(|entry| Arc::ptr_eq(&entry.nonce, nonce))
    {
        entries.remove(key);
    }
    drop(entries);
    shared.changed.notify_waiters();
}
fn reserve(
    inner: &Inner,
    key: &SessionKey,
    input: &Input,
    queued: bool,
) -> Result<Reservation, RuntimeError> {
    key.validate().map_err(|_| RuntimeError::Invalid)?;
    if input.text.len() > if queued { 200_000 } else { 65_536 }
        || (input.text.chars().all(crate::claude_launch::js_whitespace)
            && input.metadata.attachments.is_empty())
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
    if inner.deps.driver.storage_failed() {
        return Err(RuntimeError::Storage);
    }
    let mut entries = inner.shared.state.lock().expect("Claude runtime");
    if *inner.shared.closed.borrow() {
        return Err(RuntimeError::Closed);
    }
    if entries.keys().any(|other| other.name == key.name)
        || inner.deps.driver.active_ticket(key).is_some()
    {
        return Err(RuntimeError::Busy);
    }
    if entries.len() >= inner.limits.turns {
        return Err(RuntimeError::Capacity);
    }
    let (cancel, receiver) = watch::channel(false);
    let nonce = Arc::new(());
    entries.insert(
        key.clone(),
        Entry {
            nonce: nonce.clone(),
            cancel,
            ticket: None,
            route: None,
            quarantined: false,
        },
    );
    Ok(Reservation {
        key: key.clone(),
        nonce,
        cancel: receiver,
    })
}
fn alive(inner: &Inner, reservation: &Reservation) -> Result<(), RuntimeError> {
    if inner.deps.driver.storage_failed() {
        Err(RuntimeError::Storage)
    } else if *inner.shared.closed.borrow() {
        Err(RuntimeError::Closed)
    } else if *reservation.cancel.borrow() {
        Err(RuntimeError::Cancelled)
    } else {
        Ok(())
    }
}
async fn owner(inner: &Arc<Inner>) -> Result<Arc<ClaudeOwner>, RuntimeError> {
    let owner = inner
        .owner
        .get_or_try_init(|| async {
            let creating = inner.clone();
            tokio::task::spawn_blocking(move || {
                let weak = Arc::downgrade(&creating.shared);
                let driver = Arc::downgrade(&creating.deps.driver);
                let fatal = driver.clone();
                let settings = creating.settings.clone();
                ClaudeOwner::new(
                    creating.deps.home.clone(),
                    creating.deps.registry.clone(),
                    driver,
                    creating.deps.consent.clone(),
                    Arc::new(move |ticket, snapshot| {
                        weak.upgrade()
                            .is_some_and(|shared| shared.route(ticket, snapshot))
                    }),
                    Arc::new(move |context| {
                        settings
                            .effective_mode(&context.cwd, context.setting_sources.as_deref())
                            .map_err(|_| OwnerError::Unavailable)
                    }),
                    Arc::new(move || {
                        if let Some(driver) = fatal.upgrade() {
                            driver.report_storage_failure();
                        }
                    }),
                )
                .map_err(RuntimeError::Owner)
            })
            .await
            .map_err(|_| RuntimeError::Storage)?
        })
        .await?;
    Ok(owner.clone())
}
async fn prepare(
    inner: Arc<Inner>,
    key: SessionKey,
    mut input: Input,
    reservation: &Reservation,
) -> Result<Handle, RuntimeError> {
    alive(&inner, reservation)?;
    let owner = owner(&inner).await?;
    let reading = inner.clone();
    let checking = key.clone();
    let authority = owner.clone();
    let metadata = input.metadata.attachments.clone();
    let (snapshot, record, attachments) = tokio::task::spawn_blocking(move || {
        let before = reading
            .deps
            .registry
            .lock()
            .map_err(|_| RuntimeError::Storage)?
            .find(&checking.name)
            .cloned()
            .ok_or(RuntimeError::Owner(OwnerError::InvalidSession))?;
        let snapshot = authority.snapshot(&checking).map_err(RuntimeError::Owner)?;
        if snapshot.provider != Provider::Claude
            || snapshot.settings.browser.is_some()
            || !reading.config.mcp.servers.is_empty()
        {
            return Err(RuntimeError::Unsupported);
        }
        let after = reading
            .deps
            .registry
            .lock()
            .map_err(|_| RuntimeError::Storage)?
            .find(&checking.name)
            .cloned()
            .ok_or(RuntimeError::Owner(OwnerError::InvalidSession))?;
        // Native identity/config are selected coherently; concurrent changes
        // cause a pre-input rejection, never a fallback to a new conversation.
        for field in [
            "createdAt",
            "provider",
            "cwd",
            "providerSessionId",
            "forkOnResume",
            "settingSources",
            "approval",
            "scope",
            "grant",
            "archived",
            "browser",
            "model",
            "effort",
            "serviceTier",
            "claudeReservedSessionId",
        ] {
            if before.get(field).map(|v| v.get()) != after.get(field).map(|v| v.get()) {
                return Err(RuntimeError::Owner(OwnerError::InvalidSession));
            }
        }
        for field in ["providerSessionId", "settingSources"] {
            if after.get(field).is_some() && after.scalar(field).is_none() {
                return Err(RuntimeError::Invalid);
            }
        }
        let values = Value::Array(metadata.iter().map(|a| a.value()).collect());
        let attachments = crate::prompt_attachments::validate_owned_prompt_attachments(
            &reading.deps.home,
            &checking.name,
            Some(&values),
        )
        .map_err(|_| RuntimeError::Invalid)?;
        Ok((snapshot, after, attachments))
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    input.metadata.attachments = attachments;
    alive(&inner, reservation)?;
    let mut closed = inner.shared.closed.subscribe();
    let mut cancelled = reservation.cancel.clone();
    let rule = inner.config.guard.as_network_rule();
    let check = tokio::select! {
        result=inner.shared.guard.check(Provider::Claude,&inner.config.network.claude,&rule,false)=>result.map_err(|_|RuntimeError::NetworkDenied)?,
        _=closed.changed()=>return Err(RuntimeError::Closed),
        _=cancelled.changed()=>return Err(RuntimeError::Cancelled),
        _=inner.deps.driver.wait_for_storage_failure()=>return Err(RuntimeError::Storage),
    };
    let env = inner
        .shared
        .guard
        .worker_environment(&check, &inner.shared.parent, &Environment::new())
        .map_err(|_| RuntimeError::NetworkDenied)?;
    alive(&inner, reservation)?;
    {
        let mut entries = inner.shared.state.lock().expect("Claude runtime");
        let entry = entries.get_mut(&key).ok_or(RuntimeError::Cancelled)?;
        if !Arc::ptr_eq(&entry.nonce, &reservation.nonce)
            || *entry.cancel.borrow()
            || *inner.shared.closed.borrow()
        {
            return Err(RuntimeError::Cancelled);
        }
        entry.route = Some((check, env.clone()));
    }
    let building = inner.clone();
    let key_for_build = key.clone();
    let snapshot_for_build = snapshot.clone();
    let cancellation = reservation.cancel.clone();
    let handle = tokio::task::spawn_blocking(move || {
        let _runtime = building.runtime.enter();
        if *cancellation.borrow() || *building.shared.closed.borrow() {
            return Err(RuntimeError::Cancelled);
        }
        let mut services = owner.services(building.deps.sink.clone(), None);
        // Untrusted extension code runs outside all runtime/Registry locks.
        let mcp =
            (building.factory)(services.gate.clone()).map_err(|_| RuntimeError::Unsupported)?;
        services.mcp = Some(mcp);
        let gate = services.gate.clone();
        let native = record.scalar("providerSessionId");
        let worker = ClaudeWorker::new(
            Config {
                session: key_for_build,
                home: building.deps.home.clone(),
                launch: Launch {
                    holder: building.command.holder.clone(),
                    program: building.command.program.clone(),
                    args: building.command.prefix_args.clone(),
                    cwd: snapshot_for_build.cwd.clone(),
                    env,
                },
                provider_session_id: native.clone(),
                initialized: native.is_some(),
                fork_on_resume: crate::owner_trust::yes(&record, "forkOnResume"),
                broker: true,
                setting_sources: record.scalar("settingSources"),
                protect_dirs: vec![
                    building
                        .deps
                        .home
                        .to_str()
                        .ok_or(RuntimeError::Invalid)?
                        .into(),
                ],
                add_dirs: vec![],
                add_dir_roots: vec![],
                start_timeout: building.limits.start_timeout,
                attachments: input.metadata.attachments.clone(),
            },
            services,
        )
        .map_err(|_| RuntimeError::Invalid)?;
        if *cancellation.borrow() || *building.shared.closed.borrow() {
            return Err(RuntimeError::Cancelled);
        }
        building
            .deps
            .driver
            .start_input(snapshot_for_build, input, worker, gate)
            .map_err(|error| match error {
                crate::turn_driver::DriverError::Busy => RuntimeError::Busy,
                crate::turn_driver::DriverError::Capacity => RuntimeError::Capacity,
                crate::turn_driver::DriverError::StorageUnavailable => RuntimeError::Storage,
                _ => RuntimeError::Closed,
            })
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    let ticket = handle.ticket().clone();
    let cancel_now = {
        let mut entries = inner.shared.state.lock().expect("Claude runtime");
        let entry = entries.get_mut(&key).expect("owned preparation");
        let conflict = entry.ticket.as_ref().is_some_and(|bound| bound != &ticket);
        entry.ticket = Some(ticket.clone());
        conflict || *entry.cancel.borrow() || *inner.shared.closed.borrow()
    };
    if cancel_now {
        inner.deps.driver.cancel(&ticket);
    }
    let mut progress = handle.subscribe_progress();
    let shared = inner.shared.clone();
    let nonce = reservation.nonce.clone();
    inner.runtime.spawn(async move {
        loop {
            let current = progress.borrow_and_update().clone();
            if matches!(current, Progress::Finished(_)) {
                remove(&shared, &key, &nonce);
                return;
            }
            if let Some(entry) = shared.state.lock().expect("Claude runtime").get_mut(&key) {
                entry.quarantined = matches!(current, Progress::Quarantined(_));
            }
            shared.changed.notify_waiters();
            if progress.changed().await.is_err() {
                if let Some(entry) = shared.state.lock().expect("Claude runtime").get_mut(&key) {
                    entry.quarantined = true;
                }
                shared.changed.notify_waiters();
                return; // Keep uncertain entry; never claim cleanup.
            }
        }
    });
    Ok(handle)
}
