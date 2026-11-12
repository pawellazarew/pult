//! Checked Claude host authority and sealed durable native-session evidence.
//! The inherited-mode resolver is mandatory host input; no ambient allow mode.
use crate::claude_worker::{
    ScopedMcp, Services, SessionReceipt, SessionStage, SessionStore, SessionWrite, StoreError,
};
use crate::consent_store::ConsentStore;
use crate::host_policy::{self, AccessFacts, SessionGrant};
pub use crate::owner_trust::{
    InheritContext, InheritMode, OwnerError, RouteValidity, UNCERTAIN_MESSAGE,
};
use crate::owner_trust::{OwnerTrust, yes};
use crate::registry::Registry;
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{DispatchDecision, Driver, EventSink, Task};
use crate::turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};

const RESERVED: &str = "claudeReservedSessionId";
fn native_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}
#[derive(Clone)]
struct Reservation {
    ticket: Ticket,
    parent: Option<String>,
    native: String,
    fork: bool,
    inherit: bool,
    approval: Approval,
    initialized: Option<String>,
}
pub struct ClaudeOwner {
    trust: OwnerTrust,
    reservations: Mutex<HashMap<SessionKey, Reservation>>,
    failed: AtomicBool,
    fatal_storage: Arc<dyn Fn() + Send + Sync>,
}
impl ClaudeOwner {
    /// Stores must be the same home's shared sole-writer Registry/ConsentStore.
    /// Call from owned blocking work. `inherit` reads explicitly selected native
    /// settings; `route` validates the host's captured environment/network stamp.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        home: PathBuf,
        registry: Arc<Mutex<Registry>>,
        driver: Weak<Driver>,
        consent: Arc<Mutex<ConsentStore>>,
        route: RouteValidity,
        inherit: InheritMode,
        fatal_storage: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, OwnerError> {
        Ok(Arc::new(Self {
            trust: OwnerTrust::new(
                home,
                registry,
                driver,
                consent,
                route,
                Provider::Claude,
                Some(inherit),
            )?,
            reservations: Mutex::new(HashMap::new()),
            failed: AtomicBool::new(false),
            fatal_storage,
        }))
    }
    fn fault(&self) {
        if !self.failed.swap(true, Ordering::AcqRel) {
            self.trust.storage_fault();
            let _ =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.fatal_storage)()));
        }
    }
    pub fn snapshot(&self, key: &SessionKey) -> Result<TurnSnapshot, OwnerError> {
        if self.failed.load(Ordering::Acquire) {
            return Err(OwnerError::Storage);
        }
        let result = (|| {
            if self.trust.record(key)?.get(RESERVED).is_some() {
                return Err(OwnerError::Uncertain);
            }
            let snapshot = self.trust.snapshot(key)?;
            // A resolver/store wait must not hide a newly committed reservation.
            if self.trust.record(key)?.get(RESERVED).is_some() {
                return Err(OwnerError::Uncertain);
            }
            Ok(snapshot)
        })();
        if result == Err(OwnerError::Storage) {
            self.fault();
        }
        result
    }
    fn owned_reservation(&self, ticket: &Ticket) -> bool {
        let record = match self.trust.record(ticket.session()) {
            Ok(v) => v,
            Err(_) => return false,
        };
        if record.get(RESERVED).is_none() {
            return true;
        }
        let Ok(reservations) = self.reservations.lock() else {
            return false;
        };
        reservations
            .get(ticket.session())
            .is_some_and(|reservation| {
                reservation.ticket == *ticket
                    && reservation.initialized.is_none()
                    && record.scalar(RESERVED).as_deref() == Some(reservation.native.as_str())
            })
    }
    fn gate(&self, ticket: &Ticket, initial: &TurnSnapshot) -> DispatchDecision {
        if self.failed.load(Ordering::Acquire) || !self.owned_reservation(ticket) {
            return DispatchDecision::Deny;
        }
        let decision = self.trust.gate(ticket, initial);
        if self
            .trust
            .driver
            .upgrade()
            .is_some_and(|driver| driver.storage_failed())
        {
            self.fault();
            return DispatchDecision::Deny;
        }
        if !self.owned_reservation(ticket) || self.trust.live(ticket).as_ref() != Ok(initial) {
            return DispatchDecision::Deny;
        }
        decision
    }
    pub fn services(
        self: &Arc<Self>,
        sink: Arc<dyn EventSink>,
        mcp: Option<Arc<dyn ScopedMcp>>,
    ) -> Services {
        let owner = self.clone();
        let fatal = self.clone();
        Services {
            driver: self.trust.driver.clone(),
            sink,
            gate: Arc::new(move |ticket: &Ticket, initial: &TurnSnapshot| {
                owner.gate(ticket, initial)
            }),
            store: Arc::new(OwnerStore(self.clone())),
            redactors: Arc::new(|| Box::new(crate::claude_events::LogRedactor)),
            fatal_storage: Arc::new(move || fatal.fault()),
            mcp,
        }
    }
    fn persist(&self, request: SessionWrite) -> Result<SessionReceipt, StoreError> {
        if self.failed.load(Ordering::Acquire)
            || !native_id(request.native_id())
            || !native_id(request.previous_id())
        {
            return Err(StoreError::Rejected);
        }
        match request.stage() {
            SessionStage::Reserved => self.reserve(request),
            SessionStage::Initialized => self.initialize(request),
            SessionStage::AbortedBeforeInput => self.abort_before_input(request),
        }
    }
    fn reserve(&self, request: SessionWrite) -> Result<SessionReceipt, StoreError> {
        let initial = self
            .trust
            .live(request.ticket())
            .map_err(|_| StoreError::Rejected)?;
        if initial.key != *request.session()
            || initial.provider != Provider::Claude
            || request.native_id() != request.previous_id()
            || !self.trust.route_ok(request.ticket(), &initial)
        {
            return Err(StoreError::Rejected);
        }
        let current = self
            .trust
            .snapshot(request.session())
            .map_err(store_error)?;
        if current.cwd != initial.cwd || !self.trust.route_ok(request.ticket(), &initial) {
            return Err(StoreError::Rejected);
        }
        // All callbacks precede final store/liveness checks. Never invoke host
        // code during a Registry transaction or while holding the private seal.
        let mut registry = self.trust.registry().map_err(store_error)?;
        let record = registry
            .find(&initial.key.name)
            .ok_or(StoreError::Rejected)?;
        self.trust
            .transaction_scope(record, &initial)
            .map_err(store_error)?;
        if self.trust.live(request.ticket()).as_ref() != Ok(&initial) {
            return Err(StoreError::Rejected);
        }
        let parent = record.scalar("providerSessionId");
        let fork = yes(record, "forkOnResume");
        if parent
            .as_deref()
            .is_some_and(|parent| parent != request.previous_id())
            || (fork && parent.is_none())
        {
            return Err(StoreError::Rejected);
        }
        let mut reservations = self.reservations.lock().map_err(|_| StoreError::Unknown)?;
        if record.get(RESERVED).is_some() {
            let owned = reservations.get(&initial.key).is_some_and(|old| {
                old.ticket == *request.ticket()
                    && old.native == request.native_id()
                    && old.parent == parent
                    && old.fork == fork
                    && old.initialized.is_none()
            });
            if !owned || record.scalar(RESERVED).as_deref() != Some(request.native_id()) {
                return Err(StoreError::Rejected);
            }
            return Ok(request.acknowledge());
        }
        // A new incarnation can replace old diagnostic seals, never another
        // active ticket. The map is bounded even across removed sessions.
        reservations.retain(|key, _| key.name != initial.key.name || key == &initial.key);
        if !reservations.contains_key(&initial.key) && reservations.len() >= 4096 {
            return Err(StoreError::Rejected);
        }
        let reservation = Reservation {
            ticket: request.ticket().clone(),
            parent,
            native: request.native_id().into(),
            fork,
            inherit: initial.settings.approval == Approval::Inherit
                && current.settings.approval == Approval::Inherit,
            approval: if approval_rank(current.settings.approval)
                < approval_rank(initial.settings.approval)
            {
                current.settings.approval
            } else {
                initial.settings.approval
            },
            initialized: None,
        };
        registry
            .update_checked(request.session(), |record| {
                record.set_string(RESERVED, request.native_id());
                Ok(())
            })
            .map_err(|_| StoreError::Unknown)?;
        reservations.insert(initial.key, reservation);
        Ok(request.acknowledge())
    }
    fn abort_before_input(&self, request: SessionWrite) -> Result<SessionReceipt, StoreError> {
        let initial = self
            .trust
            .diagnostic(request.ticket())
            .map_err(|_| StoreError::Rejected)?;
        if initial.key != *request.session() || initial.provider != Provider::Claude {
            return Err(StoreError::Rejected);
        }
        let mut registry = self.trust.registry().map_err(store_error)?;
        let record = registry
            .find(&initial.key.name)
            .ok_or(StoreError::Rejected)?;
        self.trust
            .transaction_scope(record, &initial)
            .map_err(store_error)?;
        if self.trust.diagnostic(request.ticket()).as_ref() != Ok(&initial) {
            return Err(StoreError::Rejected);
        }
        let mut reservations = self.reservations.lock().map_err(|_| StoreError::Unknown)?;
        let Some(reservation) = reservations.get(&initial.key) else {
            return if record.get(RESERVED).is_none() {
                Ok(request.acknowledge())
            } else {
                Err(StoreError::Rejected)
            };
        };
        if reservation.ticket != *request.ticket()
            || reservation.initialized.is_some()
            || reservation.native != request.native_id()
            || reservation.native != request.previous_id()
            || record.scalar(RESERVED).as_deref() != Some(reservation.native.as_str())
            || record.scalar("providerSessionId") != reservation.parent
            || yes(record, "forkOnResume") != reservation.fork
        {
            return Err(StoreError::Rejected);
        }
        registry
            .update_checked(request.session(), |record| {
                record.remove(RESERVED);
                Ok(())
            })
            .map_err(|_| StoreError::Unknown)?;
        reservations.remove(&initial.key);
        Ok(request.acknowledge())
    }
    fn initialize(&self, request: SessionWrite) -> Result<SessionReceipt, StoreError> {
        let initial = self
            .trust
            .diagnostic(request.ticket())
            .map_err(|_| StoreError::Rejected)?;
        if initial.key != *request.session() || initial.provider != Provider::Claude {
            return Err(StoreError::Rejected);
        }
        let mode = request.permission_mode();
        if mode.is_some_and(|mode| {
            mode.is_empty() || mode.len() > 128 || mode.chars().any(char::is_control)
        }) {
            return Err(StoreError::Rejected);
        }
        // Resolver callbacks run before locks. Preserve their source facts so a
        // settings-source mutation during a mutex wait cannot authorize init.
        let policy = self
            .trust
            .snapshot_policy(request.session())
            .map_err(store_error)?;
        let mut consent = self.trust.consent.lock().map_err(|_| StoreError::Unknown)?;
        let mut registry = self.trust.registry().map_err(store_error)?;
        let record = registry
            .find(&initial.key.name)
            .ok_or(StoreError::Rejected)?;
        self.trust
            .transaction_scope(record, &initial)
            .map_err(store_error)?;
        let mut reservations = self.reservations.lock().map_err(|_| StoreError::Unknown)?;
        let reservation = reservations
            .get_mut(&initial.key)
            .filter(|reservation| reservation.ticket == *request.ticket())
            .ok_or(StoreError::Rejected)?;
        if self.trust.diagnostic(request.ticket()).as_ref() != Ok(&initial) {
            return Err(StoreError::Rejected);
        }
        let duplicate = if let Some(initialized) = &reservation.initialized {
            if initialized != request.native_id()
                || (request.previous_id() != reservation.native
                    && request.previous_id() != initialized)
                || record.scalar("providerSessionId").as_deref() != Some(initialized)
                || record.get(RESERVED).is_some()
                || yes(record, "forkOnResume")
            {
                return Err(StoreError::Rejected);
            }
            true
        } else {
            if reservation.native != request.previous_id()
                || record.scalar("providerSessionId") != reservation.parent
                || yes(record, "forkOnResume") != reservation.fork
                || record.scalar(RESERVED).as_deref() != Some(reservation.native.as_str())
                || (reservation.fork && request.native_id() == reservation.native)
                || (!reservation.fork && request.native_id() != reservation.native)
            {
                return Err(StoreError::Rejected);
            }
            false
        };
        let facts = consent.read().map_err(|_| StoreError::Unknown)?.facts();
        let desired = TurnSnapshot::try_from(record)
            .map_err(|_| StoreError::Rejected)?
            .settings
            .approval;
        let remember_inherit = reservation.inherit && desired == Approval::Inherit;
        let inherit_seen = if remember_inherit {
            mode.map(str::to_owned)
                .or_else(|| record.scalar("inheritSeen"))
        } else {
            record.scalar("inheritSeen")
        };
        let access = AccessFacts {
            provider: Provider::Claude,
            desired,
            effective_inherit_mode: policy.inherit_mode,
            inherit_seen,
            session_grant: (record.scalar("grant").as_deref() == Some("cli-once"))
                .then_some(SessionGrant::CliOnce),
            consent: facts,
        };
        let current = host_policy::effective_access(&access).effective;
        let sources_unchanged = policy.record.get("settingSources").map(|v| v.get())
            == record.get("settingSources").map(|v| v.get());
        let allowed = sources_unchanged
            && evidence_allowed(current, reservation.approval, mode, access.full_allowed())
            && evidence_allowed(
                reservation.approval,
                reservation.approval,
                mode,
                access.full_allowed(),
            );
        // Known native identity survives denial/cancellation, but is not a new
        // grant. Repeat init must recheck mode/consent rather than early-ack.
        let update_seen = remember_inherit
            && mode.is_some_and(|mode| record.scalar("inheritSeen").as_deref() != Some(mode));
        if !duplicate || update_seen {
            registry
                .update_checked(request.session(), |record| {
                    record.set_string("providerSessionId", request.native_id());
                    record.remove(RESERVED);
                    record.remove("forkOnResume");
                    if remember_inherit && let Some(mode) = mode {
                        record.set_string("inheritSeen", mode);
                    }
                    Ok(())
                })
                .map_err(|_| StoreError::Unknown)?;
        }
        reservation.initialized = Some(request.native_id().into());
        if !allowed {
            return Err(StoreError::Rejected);
        }
        Ok(request.acknowledge())
    }
}
fn approval_rank(mode: Approval) -> u8 {
    match mode {
        Approval::ReadOnly => 0,
        Approval::Ask => 1,
        Approval::Workspace => 2,
        Approval::Full => 3,
        Approval::Inherit => 4,
    }
}
fn evidence_allowed(
    current: Approval,
    launched: Approval,
    mode: Option<&str>,
    full_allowed: bool,
) -> bool {
    match mode {
        None => current == launched || (current == Approval::Full && full_allowed),
        Some("manual" | "default" | "plan") => {
            current != Approval::ReadOnly || launched == Approval::ReadOnly
        }
        Some("acceptEdits") => matches!(
            current,
            Approval::Workspace | Approval::Full | Approval::Inherit
        ),
        Some("bypassPermissions") => {
            matches!(current, Approval::Full | Approval::Inherit) && full_allowed
        }
        Some("auto" | "dontAsk") => matches!(current, Approval::Full | Approval::Inherit),
        Some(_) => false,
    }
}
fn store_error(error: OwnerError) -> StoreError {
    if error == OwnerError::Storage {
        StoreError::Unknown
    } else {
        StoreError::Rejected
    }
}
struct OwnerStore(Arc<ClaudeOwner>);
impl SessionStore for OwnerStore {
    fn persist(&self, request: SessionWrite) -> Task<Result<SessionReceipt, StoreError>> {
        let owner = self.0.clone();
        Box::pin(async move {
            let fault = owner.clone();
            let result = tokio::task::spawn_blocking(move || {
                let result = owner.persist(request);
                if matches!(result, Err(StoreError::Unknown)) {
                    owner.fault();
                }
                result
            })
            .await
            .unwrap_or(Err(StoreError::Unknown));
            if matches!(result, Err(StoreError::Unknown)) {
                fault.fault();
            }
            result
        })
    }
}
