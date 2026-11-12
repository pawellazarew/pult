//! Owned ordinary ZCode Route A controller. One process per explicit input.
//! Shared NetworkGuard and daemon Broker are never owned/shut down here.
//! Missing-native recovery remains explicitly blocked pending typed confirmation.
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
use crate::worker_process::{Launch, SpawnDenied, SpawnGate, SpawnPermit};
use crate::zcode_host_services::{Attempt, Error as OwnerError, ZcodeOwner};
use crate::zcode_launch::{self, ContextLanguage};
use crate::zcode_worker::{Config, ProviderSignal, Services, ZcodeWorker};
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsString,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
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
    ObservedAuthBlocked,
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
            Self::ObservedAuthBlocked => "provider_unavailable",
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
struct Source {
    key: SessionKey,
    nonce: Arc<()>,
    attempt: OnceLock<Attempt>,
}
struct Entry {
    attempt: Option<Attempt>,
    source: Option<Arc<Source>>,
    nonce: Arc<()>,
    cancel: watch::Sender<bool>,
    ticket: Option<Ticket>,
    route: Option<(Check, Environment)>,
    quarantined: bool,
    progress: Option<watch::Receiver<Progress>>,
}
struct Shared {
    state: Mutex<HashMap<SessionKey, Entry>>,
    closed: watch::Sender<bool>,
    changed: Notify,
    guard: Arc<NetworkGuard>,
    parent: Environment,
    extra: Environment,
    blocked: AtomicBool,
    driver: Arc<Driver>,
}
impl Shared {
    fn route(&self, ticket: &Ticket, snapshot: &TurnSnapshot) -> bool {
        if *self.closed.borrow()
            || self.blocked.load(Ordering::Acquire)
            || self.driver.snapshot_for_dispatch(ticket).as_ref() != Some(snapshot)
        {
            return false;
        }
        let route = {
            let mut entries = self.state.lock().expect("ZCode runtime");
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
                .worker_environment(&check, &self.parent, &self.extra)
                .is_ok_and(|fresh| fresh == environment)
            && !*self.closed.borrow()
            && self.driver.snapshot_for_dispatch(ticket).as_ref() == Some(snapshot)
            && self
                .state
                .lock()
                .expect("ZCode runtime")
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
    limits: Limits,
    shared: Arc<Shared>,
    owner: OnceCell<Arc<ZcodeOwner>>,
    runtime: tokio::runtime::Handle,
}
pub struct ZcodeRuntime {
    inner: Arc<Inner>,
}
impl ZcodeRuntime {
    /// Pure shape validation. Filesystem identity/settings work belongs to the
    /// owned preparation, not a caller or Tokio worker blocked on Registry IO.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        deps: Dependencies,
        command: TrustedCommand,
        config: RuntimeConfig,
        parent: Environment,
        extra: Environment,
        guard: Arc<NetworkGuard>,
        limits: Limits,
    ) -> Result<Self, RuntimeError> {
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| RuntimeError::Invalid)?;
        if !deps.home.is_absolute()
            || limits.turns == 0
            || limits.turns > 256
            || limits.start_timeout.is_zero()
            || limits.start_timeout > Duration::from_secs(120)
            || !command.prefix_args.is_empty()
            || !parent
                .get(std::ffi::OsStr::new("HOME"))
                .is_some_and(|home| std::path::Path::new(home).is_absolute())
            || parent.contains_key(std::ffi::OsStr::new("PULT_MEMORY_KEY"))
        {
            return Err(RuntimeError::Invalid);
        }
        let filtered_extra = zcode_launch::extra_env(&extra).map_err(|_| RuntimeError::Invalid)?;
        if filtered_extra != extra {
            return Err(RuntimeError::Invalid);
        }
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
            extra,
            blocked: AtomicBool::new(false),
            driver: deps.driver.clone(),
        });
        Ok(Self {
            inner: Arc::new(Inner {
                deps,
                command,
                config,
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
        let mut entries = self.inner.shared.state.lock().expect("ZCode runtime");
        if reap_finished(&mut entries) {
            self.inner.shared.changed.notify_waiters();
        }
        entries.contains_key(key)
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
        let mut entries = self.inner.shared.state.lock().expect("ZCode runtime");
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
            .expect("ZCode runtime")
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
    /// Observed native authentication failure; never proof of account logout.
    pub fn blocked(&self) -> bool {
        self.inner.shared.blocked.load(Ordering::Acquire)
    }
    /// Trusted owner command only. Never logs in, changes credentials, or clears
    /// native-session uncertainty. All own work must have confirmed cleanup.
    pub fn reset_auth(&self) -> Result<bool, RuntimeError> {
        let mut entries = self.inner.shared.state.lock().expect("ZCode runtime");
        if *self.inner.shared.closed.borrow() {
            return Err(RuntimeError::Closed);
        }
        if self.inner.deps.driver.storage_failed() {
            return Err(RuntimeError::Storage);
        }
        if reap_finished(&mut entries) {
            self.inner.shared.changed.notify_waiters();
        }
        if !entries.is_empty() {
            return Err(RuntimeError::Busy);
        }
        Ok(self.inner.shared.blocked.swap(false, Ordering::AcqRel))
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
                let (reaped, decision) = {
                    let mut entries = shared.state.lock().expect("ZCode runtime");
                    let reaped = reap_finished(&mut entries);
                    let decision = if entries.is_empty() {
                        Some(Ok(()))
                    } else if entries.values().any(|entry| entry.quarantined) {
                        Some(Err(RuntimeError::CleanupUnconfirmed))
                    } else {
                        None
                    };
                    (reaped, decision)
                };
                if reaped {
                    shared.changed.notify_waiters();
                }
                if let Some(result) = decision {
                    return result;
                }
                changed.await;
            }
        })
    }
}
impl Drop for ZcodeRuntime {
    fn drop(&mut self) {
        close(&self.inner.shared);
    }
}
fn close(shared: &Shared) {
    shared.closed.send_replace(true);
    let tickets: Vec<_> = {
        let entries = shared.state.lock().expect("ZCode runtime");
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
            let mut entries = self.shared.state.lock().expect("ZCode runtime");
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
    let mut entries = shared.state.lock().expect("ZCode runtime");
    if entries
        .get(key)
        .is_some_and(|entry| Arc::ptr_eq(&entry.nonce, nonce))
    {
        entries.remove(key);
    }
    drop(entries);
    shared.changed.notify_waiters();
}
// The progress owner can be runnable but not yet scheduled. A Driver Finished
// value is cleanup proof; Quarantined or an absent active-ticket lookup is not.
fn reap_finished(entries: &mut HashMap<SessionKey, Entry>) -> bool {
    let before = entries.len();
    entries.retain(|_, entry| {
        !entry
            .progress
            .as_ref()
            .is_some_and(|progress| matches!(*progress.borrow(), Progress::Finished(_)))
    });
    before != entries.len()
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
    if input.metadata.queue_item_id.is_some() != input.metadata.queue_item_at.is_some()
        || input
            .metadata
            .queue_item_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 1024)
        || input
            .metadata
            .queue_item_at
            .as_ref()
            .is_some_and(|at| at.len() > 1024)
    {
        return Err(RuntimeError::Invalid);
    }
    if inner.deps.driver.storage_failed() {
        return Err(RuntimeError::Storage);
    }
    let mut entries = inner.shared.state.lock().expect("ZCode runtime");
    if *inner.shared.closed.borrow() {
        return Err(RuntimeError::Closed);
    }
    if reap_finished(&mut entries) {
        inner.shared.changed.notify_waiters();
    }
    if inner.shared.blocked.load(Ordering::Acquire) {
        return Err(RuntimeError::ObservedAuthBlocked);
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
            progress: None,
            source: None,
            attempt: None,
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
    } else if inner.shared.blocked.load(Ordering::Acquire) {
        Err(RuntimeError::ObservedAuthBlocked)
    } else if *reservation.cancel.borrow() {
        Err(RuntimeError::Cancelled)
    } else {
        Ok(())
    }
}
async fn owner(inner: &Arc<Inner>) -> Result<Arc<ZcodeOwner>, RuntimeError> {
    let owner = inner
        .owner
        .get_or_try_init(|| async {
            let creating = inner.clone();
            tokio::task::spawn_blocking(move || {
                let weak = Arc::downgrade(&creating.shared);
                let driver = Arc::downgrade(&creating.deps.driver);
                let fatal = driver.clone();
                ZcodeOwner::new(
                    creating.deps.home.clone(),
                    creating.deps.registry.clone(),
                    driver,
                    creating.deps.consent.clone(),
                    Arc::new(move |ticket, snapshot| {
                        weak.upgrade()
                            .is_some_and(|shared| shared.route(ticket, snapshot))
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
    alive(&inner, reservation)?;
    let reading = inner.clone();
    let checking = key.clone();
    let authority = owner.clone();
    let metadata = input.metadata.attachments.clone();
    let input_text = input.text.clone();
    let (snapshot, attachments) = tokio::task::spawn_blocking(move || {
        let before = reading
            .deps
            .registry
            .lock()
            .map_err(|_| RuntimeError::Storage)?
            .find(&checking.name)
            .cloned()
            .ok_or(RuntimeError::Owner(OwnerError::Invalid))?;
        let snapshot = authority.snapshot(&checking).map_err(RuntimeError::Owner)?;
        if snapshot.provider != Provider::Zcode
            || snapshot.settings.browser.is_some()
            || before
                .get("forkOnResume")
                .is_some_and(|raw| !matches!(raw.get().trim(), "false" | "null"))
            || before.get("settingSources").is_some()
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
            .ok_or(RuntimeError::Owner(OwnerError::Invalid))?;
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
            "zcodePendingInput",
            "mode",
        ] {
            if before.get(field).map(|v| v.get()) != after.get(field).map(|v| v.get()) {
                return Err(RuntimeError::Owner(OwnerError::Invalid));
            }
        }
        if after.get("providerSessionId").is_some() && after.scalar("providerSessionId").is_none() {
            return Err(RuntimeError::Invalid);
        }
        let values = Value::Array(metadata.iter().map(|a| a.value()).collect());
        let attachments = crate::prompt_attachments::validate_owned_prompt_attachments(
            &reading.deps.home,
            &checking.name,
            Some(&values),
        )
        .map_err(|_| RuntimeError::Invalid)?;
        let native = after.scalar("providerSessionId");
        if native.as_deref().is_some_and(|s| {
            s.is_empty() || s.len() > 512 || s.starts_with('-') || s.chars().any(char::is_control)
        }) {
            return Err(RuntimeError::Invalid);
        }
        let text =
            crate::prompt_attachments::prompt_attachment_context(&input_text, &attachments, true);
        let prompt = format!(
            "{text}\n\n{}",
            zcode_launch::approval_context_language(
                snapshot.settings.approval,
                true,
                match reading.config.language {
                    crate::runtime_config::Language::En => ContextLanguage::En,
                    _ => ContextLanguage::Ru,
                }
            )
        );
        zcode_launch::argv(&zcode_launch::Options {
            prompt: &prompt,
            cwd: snapshot.cwd.to_str().ok_or(RuntimeError::Invalid)?,
            resume_session_id: native.as_deref(),
            approval: snapshot.settings.approval,
            model: snapshot.settings.model.as_deref(),
            effort: snapshot.settings.effort.as_deref(),
        })
        .map_err(|_| RuntimeError::Invalid)?;
        Ok((snapshot, attachments))
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    input.metadata.attachments = attachments;
    alive(&inner, reservation)?;
    let mut closed = inner.shared.closed.subscribe();
    let mut cancelled = reservation.cancel.clone();
    let rule = inner.config.guard.as_network_rule();
    let check = tokio::select! {
        result=inner.shared.guard.check(Provider::Zcode,&inner.config.network.zcode,&rule,false)=>result.map_err(|_|RuntimeError::NetworkDenied)?,
        _=closed.changed()=>return Err(RuntimeError::Closed),
        _=cancelled.changed()=>return Err(RuntimeError::Cancelled),
        _=inner.deps.driver.wait_for_storage_failure()=>return Err(RuntimeError::Storage),
    };
    let env = inner
        .shared
        .guard
        .worker_environment(&check, &inner.shared.parent, &inner.shared.extra)
        .map_err(|_| RuntimeError::NetworkDenied)?;
    alive(&inner, reservation)?;
    {
        let mut entries = inner.shared.state.lock().expect("ZCode runtime");
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
    let reservation_nonce = reservation.nonce.clone();
    let handle = tokio::task::spawn_blocking(move || {
        let _runtime = building.runtime.enter();
        if *cancellation.borrow() || *building.shared.closed.borrow() {
            return Err(RuntimeError::Cancelled);
        }
        let source = Arc::new(Source {
            key: key_for_build.clone(),
            nonce: reservation_nonce.clone(),
            attempt: OnceLock::new(),
        });
        {
            let mut entries = building.shared.state.lock().expect("ZCode runtime");
            let entry = entries
                .get_mut(&key_for_build)
                .filter(|e| Arc::ptr_eq(&e.nonce, &reservation_nonce) && !*e.cancel.borrow())
                .ok_or(RuntimeError::Cancelled)?;
            entry.source = Some(source.clone());
        }
        let weak = Arc::downgrade(&building.shared);
        let route = owner.clone();
        let gate: Arc<dyn DispatchGate> =
            Arc::new(move |ticket: &Ticket, snapshot: &TurnSnapshot| route.gate(ticket, snapshot));
        let for_spawn = source.clone();
        let spawn_owner = owner.clone();
        let signal_source = source.clone();
        let signal_shared = weak.clone();
        let driver = Arc::downgrade(&building.deps.driver);
        let worker = ZcodeWorker::new(
            Config {
                session: key_for_build,
                home: building.deps.home.clone(),
                launch: Launch {
                    holder: building.command.holder.clone(),
                    program: building.command.program.clone(),
                    args: vec![],
                    cwd: snapshot_for_build.cwd.clone(),
                    env,
                },
                attachments: input.metadata.attachments.clone(),
                broker_context: true,
                language: match building.config.language {
                    crate::runtime_config::Language::En => ContextLanguage::En,
                    _ => ContextLanguage::Ru,
                },
                start_timeout: building.limits.start_timeout,
                terminal_grace: Duration::from_secs(1),
            },
            Services {
                driver: driver.clone(),
                sink: building.deps.sink.clone(),
                gate: gate.clone(),
                store: owner.store(),
                spawn_gate: Arc::new(move |attempt, initial, _approval| {
                    let shared = weak.upgrade().ok_or_else(|| WorkerError {
                        code: "closed".into(),
                        message: "ZCode controller closed".into(),
                    })?;
                    bind_source(&shared, &for_spawn, &attempt).map_err(|_| WorkerError {
                        code: "cancelled".into(),
                        message: "ZCode source revoked".into(),
                    })?;
                    Ok(Arc::new(RuntimeSpawn {
                        shared,
                        owner: spawn_owner.clone(),
                        source: for_spawn.clone(),
                        initial,
                    }))
                }),
                redactors: Arc::new(|| Box::new(crate::zcode_events::LogRedactor)),
                fatal_storage: Arc::new(move || {
                    if let Some(driver) = driver.upgrade() {
                        driver.report_storage_failure();
                    }
                }),
                provider_signal: Arc::new(move |signal| {
                    if let Some(shared) = signal_shared.upgrade() {
                        observe_signal(&shared, &signal_source, signal);
                    }
                }),
            },
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
                crate::turn_driver::DriverError::Invalid => RuntimeError::Invalid,
                _ => RuntimeError::Closed,
            })
    })
    .await
    .map_err(|_| RuntimeError::Storage)??;
    let ticket = handle.ticket().clone();
    let cancel_now = {
        let mut entries = inner.shared.state.lock().expect("ZCode runtime");
        let entry = entries.get_mut(&key).expect("owned preparation");
        let conflict = entry.ticket.as_ref().is_some_and(|bound| bound != &ticket);
        entry.ticket = Some(ticket.clone());
        entry.progress = Some(handle.subscribe_progress());
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
            if let Some(entry) = shared
                .state
                .lock()
                .expect("ZCode runtime")
                .get_mut(&key)
                .filter(|entry| Arc::ptr_eq(&entry.nonce, &nonce))
            {
                entry.quarantined = matches!(current, Progress::Quarantined(_));
            }
            shared.changed.notify_waiters();
            if progress.changed().await.is_err() {
                if let Some(entry) = shared
                    .state
                    .lock()
                    .expect("ZCode runtime")
                    .get_mut(&key)
                    .filter(|entry| Arc::ptr_eq(&entry.nonce, &nonce))
                {
                    entry.quarantined = true;
                }
                shared.changed.notify_waiters();
                return; // Keep uncertain entry; never claim cleanup.
            }
        }
    });
    Ok(handle)
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn finished_receiver_releases_capacity_without_waiting_for_watcher_poll() {
        let key = SessionKey {
            name: "private-fixture".into(),
            created_at: "2026-11-12T00:00:00Z".into(),
        };
        let (sender, progress) = watch::channel(Progress::Starting);
        let mut entries = HashMap::from([(
            key.clone(),
            Entry {
                source: None,
                attempt: None,
                nonce: Arc::new(()),
                cancel: watch::channel(false).0,
                ticket: None,
                route: None,
                quarantined: false,
                progress: Some(progress),
            },
        )]);
        assert!(!reap_finished(&mut entries));
        sender.send_replace(Progress::Quarantined(
            crate::turn_coordinator::Outcome::Interrupted,
        ));
        assert!(!reap_finished(&mut entries));
        assert!(entries.contains_key(&key));
        // No await or watcher poll can happen between terminal publication and
        // this synchronous admission cleanup; this is the original handoff gap.
        sender.send_replace(Progress::Finished(Err(
            crate::turn_driver::DriverError::Cancelled,
        )));
        assert!(reap_finished(&mut entries));
        assert!(!entries.contains_key(&key));
    }
}

fn source_entry(entry: &Entry, source: &Arc<Source>, attempt: &Attempt) -> bool {
    Arc::ptr_eq(&entry.nonce, &source.nonce)
        && entry
            .source
            .as_ref()
            .is_some_and(|bound| Arc::ptr_eq(bound, source))
        && entry.ticket.as_ref() == Some(attempt.ticket())
        && attempt.ticket().session() == &source.key
        && !*entry.cancel.borrow()
        && !entry
            .progress
            .as_ref()
            .is_some_and(|p| matches!(*p.borrow(), Progress::Finished(_)))
}
fn bind_source(
    shared: &Arc<Shared>,
    source: &Arc<Source>,
    attempt: &Attempt,
) -> Result<(), RuntimeError> {
    if shared
        .driver
        .snapshot_for_dispatch(attempt.ticket())
        .is_none()
    {
        return Err(RuntimeError::Cancelled);
    }
    let mut entries = shared.state.lock().expect("ZCode runtime");
    let entry = entries
        .get_mut(&source.key)
        .ok_or(RuntimeError::Cancelled)?;
    if *shared.closed.borrow()
        || shared.blocked.load(Ordering::Acquire)
        || !source_entry(entry, source, attempt)
    {
        return Err(RuntimeError::Cancelled);
    }
    if entry.attempt.is_some() {
        return Err(RuntimeError::Cancelled);
    }
    source
        .attempt
        .set(attempt.clone())
        .map_err(|_| RuntimeError::Cancelled)?;
    entry.attempt = Some(attempt.clone());
    Ok(())
}
fn bound_attempt(entry: &Entry, attempt: &Attempt) -> bool {
    entry.attempt.as_ref().is_some_and(|bound| {
        bound.ticket() == attempt.ticket()
            && bound.generation() == attempt.generation()
            && Arc::ptr_eq(bound.spawn_action(), attempt.spawn_action())
    })
}
struct RuntimeSpawn {
    shared: Arc<Shared>,
    owner: Arc<ZcodeOwner>,
    source: Arc<Source>,
    initial: TurnSnapshot,
}
struct RuntimePermit<'a> {
    _admission: std::sync::MutexGuard<'a, HashMap<SessionKey, Entry>>,
}
impl SpawnPermit for RuntimePermit<'_> {}
impl SpawnGate for RuntimeSpawn {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        let attempt = self.source.attempt.get().ok_or(SpawnDenied)?;
        let entries = self.shared.state.lock().map_err(|_| SpawnDenied)?;
        let entry = entries.get(&self.source.key).ok_or(SpawnDenied)?;
        let stamp = entry.route.as_ref().ok_or(SpawnDenied)?;
        if *self.shared.closed.borrow()
            || self.shared.blocked.load(Ordering::Acquire)
            || !source_entry(entry, &self.source, attempt)
            || !bound_attempt(entry, attempt)
            || !self.shared.guard.is_current(&stamp.0)
            || self
                .shared
                .driver
                .snapshot_for_dispatch(attempt.ticket())
                .as_ref()
                != Some(&self.initial)
            || !self.owner.seal_spawn(attempt)
        {
            return Err(SpawnDenied);
        }
        Ok(Box::new(RuntimePermit {
            _admission: entries,
        }))
    }
}
fn observe_signal(shared: &Arc<Shared>, source: &Arc<Source>, signal: ProviderSignal) {
    if signal != ProviderSignal::Authentication {
        return;
    }
    let Some(attempt) = source.attempt.get() else {
        return;
    };
    let tickets = {
        let entries = shared.state.lock().expect("ZCode runtime");
        let Some(entry) = entries.get(&source.key) else {
            return;
        };
        if *shared.closed.borrow()
            || !source_entry(entry, source, attempt)
            || !bound_attempt(entry, attempt)
            || !attempt.spawn_action().sealed()
            || shared
                .driver
                .snapshot_for_dispatch(attempt.ticket())
                .is_none()
        {
            return;
        }
        shared.blocked.store(true, Ordering::Release);
        entries
            .values()
            .filter_map(|entry| {
                if entry.ticket.as_ref() == Some(attempt.ticket()) {
                    return None;
                }
                entry.cancel.send_replace(true);
                entry.ticket.clone()
            })
            .collect::<Vec<_>>()
    };
    for ticket in tickets {
        shared.driver.cancel(&ticket);
    }
    shared.changed.notify_waiters();
}

#[cfg(test)]
#[path = "../tests/support/zcode_runtime_unit.rs"]
mod tests;
