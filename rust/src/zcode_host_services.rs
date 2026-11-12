//! Trusted ZCode Route A native identity and durable input uncertainty.
//! No process, JSON dispatch, credentials, inherited settings or MCP integration.
use crate::consent_store::ConsentStore;
use crate::owner_trust::{OwnerError, OwnerTrust, RouteValidity, yes};
use crate::registry::{Record, Registry};
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{DispatchDecision, Driver, SpawnAction};
use crate::turn_snapshot::{Provider, SessionKey, TurnSnapshot};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};

const MARKER: &str = "zcodePendingInput";
const MAX_ATTEMPTS: usize = 256;
pub const UNCERTAIN_MESSAGE: &str = "Предыдущая реплика ZCode могла выполниться, но подтверждение потеряно. Автоматический повтор запрещён. Проверь историю ZCode перед ручным восстановлением; повторная отправка может выполнить задачу дважды.";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Uncertain,
    Unavailable,
    Storage,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid_session",
            Self::Uncertain => "start_unknown",
            Self::Unavailable => "provider_unavailable",
            Self::Storage => "storage_unavailable",
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if *self == Self::Uncertain {
            UNCERTAIN_MESSAGE
        } else {
            self.code()
        })
    }
}
impl std::error::Error for Error {}
impl From<OwnerError> for Error {
    fn from(e: OwnerError) -> Self {
        match e {
            OwnerError::Storage => Self::Storage,
            OwnerError::Uncertain => Self::Uncertain,
            OwnerError::Unavailable => Self::Unavailable,
            _ => Self::Invalid,
        }
    }
}
fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}
struct Entry {
    ticket: Ticket,
    initial: TurnSnapshot,
    generation: u64,
    public_turn: String,
    expected_resume: Option<String>,
    marker: String,
    spawn: Arc<SpawnAction>,
    native: Mutex<Option<String>>,
    retired: AtomicBool,
}
/// Opaque fresh owned-process binding. It is not deserializable authority.
#[derive(Clone)]
pub struct Attempt(Arc<Entry>);
impl Attempt {
    pub fn ticket(&self) -> &Ticket {
        &self.0.ticket
    }
    pub fn generation(&self) -> u64 {
        self.0.generation
    }
    pub fn public_turn(&self) -> &str {
        &self.0.public_turn
    }
    pub fn resume_session_id(&self) -> Option<&str> {
        self.0.expected_resume.as_deref()
    }
    /// Same exact action must be passed to Driver::seal_spawn at actual spawn.
    pub fn spawn_action(&self) -> &Arc<SpawnAction> {
        &self.0.spawn
    }
    pub fn cancel_before_spawn(&self) -> bool {
        self.0.spawn.cancel() || self.0.spawn.never_sent()
    }
    fn sealed(&self) -> bool {
        self.0.spawn.sealed()
    }
}
impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZcodeAttempt").finish_non_exhaustive()
    }
}
/// Constructed only by a trusted fresh Worker after typed native turn.started;
/// session.created/SessionId alone is never input acceptance. Future Worker must
/// verify its HostBinding, generation, native SID/TID and exact owned process.
pub struct TurnStartedEvidence {
    attempt: Attempt,
    session_id: String,
    turn_id: String,
}
impl TurnStartedEvidence {
    #[allow(dead_code)] // Internal seam for the subsequent Worker, no public JSON constructor.
    pub(crate) fn from_owned_turn_started(
        attempt: &Attempt,
        session_id: String,
        turn_id: String,
    ) -> Result<Self, Error> {
        if !id(&session_id) || !id(&turn_id) {
            return Err(Error::Invalid);
        }
        Ok(Self {
            attempt: attempt.clone(),
            session_id,
            turn_id,
        })
    }
}
/// Only after the exact Worker has joined process/readers and all owned IO.
/// No absent-PID lookup, dropped future, timeout or error is cleanup evidence.
pub struct JoinedCleanup(Attempt);
impl JoinedCleanup {
    #[allow(dead_code)] // Future Worker calls this after its actual owned joins.
    pub(crate) fn from_owned_join(attempt: &Attempt) -> Self {
        Self(attempt.clone())
    }
}
/// Acceptance metadata, not dispatch authority. Native IDs remain private.
pub struct Acceptance {
    attempt: Attempt,
    native_session: String,
    native_turn: String,
}
impl Acceptance {
    #[allow(dead_code)] // The subsequent Worker checks the exact store receipt.
    pub(crate) fn matches(&self, attempt: &Attempt) -> bool {
        Arc::ptr_eq(&self.attempt.0, &attempt.0)
    }
    pub fn native_session_id(&self) -> &str {
        &self.native_session
    }
    pub fn native_turn_id(&self) -> &str {
        &self.native_turn
    }
}
pub struct ZcodeOwner {
    trust: OwnerTrust,
    attempts: Mutex<HashMap<SessionKey, Attempt>>,
    failed: AtomicBool,
    fatal: Arc<dyn Fn() + Send + Sync>,
}
impl ZcodeOwner {
    /// Same-home sole-writer stores and a host captured network/environment route
    /// are preconditions. Call filesystem methods in owned blocking work.
    pub fn new(
        home: PathBuf,
        registry: Arc<Mutex<Registry>>,
        driver: Weak<Driver>,
        consent: Arc<Mutex<ConsentStore>>,
        route: RouteValidity,
        fatal: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Arc<Self>, Error> {
        Ok(Arc::new(Self {
            trust: OwnerTrust::new(
                home,
                registry,
                driver,
                consent,
                route,
                Provider::Zcode,
                None,
            )?,
            attempts: Mutex::new(HashMap::new()),
            failed: AtomicBool::new(false),
            fatal,
        }))
    }
    pub fn store(self: &Arc<Self>) -> Arc<dyn SessionStore> {
        Arc::new(OwnerStore(self.clone()))
    }
    fn operation<T>(&self, run: impl FnOnce() -> Result<T, Error>) -> Result<T, Error> {
        if self.failed.load(Ordering::Acquire) {
            return Err(Error::Storage);
        }
        let result = run();
        // RAII store guards in run are gone before injected fault publication.
        if matches!(result, Err(Error::Storage)) && !self.failed.swap(true, Ordering::AcqRel) {
            self.trust.storage_fault();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.fatal)()));
        }
        result
    }
    pub fn snapshot(&self, key: &SessionKey) -> Result<TurnSnapshot, Error> {
        self.operation(|| {
            if self.trust.record(key)?.get(MARKER).is_some() {
                return Err(Error::Uncertain);
            }
            let snapshot = self.trust.snapshot(key)?;
            if self.trust.record(key)?.get(MARKER).is_some() {
                return Err(Error::Uncertain);
            }
            Ok(snapshot)
        })
    }
    /// Policy preflight only. This is NOT a SpawnGate; actual spawn additionally
    /// requires Driver's atomic action seal and the host cancellation protocol.
    pub fn gate(&self, ticket: &Ticket, initial: &TurnSnapshot) -> DispatchDecision {
        self.operation(|| {
            let owned_marker = || -> Result<bool, Error> {
                let record = self.trust.record(ticket.session())?;
                let Some(marker) = record.get(MARKER) else {
                    return Ok(true);
                };
                Ok(self
                    .attempts
                    .lock()
                    .map_err(|_| Error::Storage)?
                    .get(ticket.session())
                    .is_some_and(|v| {
                        v.ticket() == ticket
                            && v.0.initial == *initial
                            && v.0.marker == marker.get()
                    }))
            };
            if !owned_marker()? {
                return Ok(DispatchDecision::Deny);
            }
            let result = self.trust.gate(ticket, initial);
            Ok(if owned_marker()? {
                result
            } else {
                DispatchDecision::Deny
            })
        })
        .unwrap_or(DispatchDecision::Deny)
    }
    /// In-memory atomic Driver seal only. The host first performs fresh policy
    /// and route preflight, then holds its SpawnPermit across actual OS spawn.
    /// No callbacks, filesystem work or OS spawn execute under Driver's mutex.
    pub fn seal_spawn(&self, attempt: &Attempt) -> bool {
        if self.failed.load(Ordering::Acquire) {
            return false;
        }
        let Ok(attempts) = self.attempts.lock() else {
            return false;
        };
        if !attempts
            .get(attempt.ticket().session())
            .is_some_and(|v| Arc::ptr_eq(&v.0, &attempt.0))
        {
            return false;
        }
        self.trust.driver.upgrade().is_some_and(|driver| {
            driver.seal_spawn(attempt.ticket(), &attempt.0.initial, &attempt.0.spawn)
        })
    }
    fn owned(&self, attempt: &Attempt) -> Result<(), Error> {
        if !self
            .attempts
            .lock()
            .map_err(|_| Error::Storage)?
            .get(attempt.ticket().session())
            .is_some_and(|old| Arc::ptr_eq(&old.0, &attempt.0))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn checked(&self, attempt: &Attempt) -> Result<(), Error> {
        self.owned(attempt)?;
        if self.trust.live(attempt.ticket()).as_ref() != Ok(&attempt.0.initial) {
            return Err(Error::Unavailable);
        }
        let driver = self.trust.driver.upgrade().ok_or(Error::Unavailable)?;
        if driver
            .public_turn_id(attempt.ticket())
            .as_deref()
            .is_some_and(|v| v != attempt.public_turn())
        {
            return Err(Error::Invalid);
        }
        if !matches!(
            self.trust.gate(attempt.ticket(), &attempt.0.initial),
            DispatchDecision::Allow
        ) {
            return Err(Error::Unavailable);
        }
        Ok(())
    }
    /// Durable before actual spawn. Does not change healthy queue pause/status.
    /// Driver may still be Starting: public_turn is host captured, not invented
    /// from a native ID or required to have been published by Driver already.
    pub fn reserve(
        &self,
        ticket: Ticket,
        initial: TurnSnapshot,
        generation: u64,
        public_turn: String,
        deadline: std::time::Instant,
    ) -> Result<Attempt, Error> {
        self.operation(|| {
            if generation == 0
                || !id(&public_turn)
                || ticket.session() != &initial.key
                || initial.provider != Provider::Zcode
            {
                return Err(Error::Invalid);
            }
            if self.trust.live(&ticket).as_ref() != Ok(&initial)
                || !matches!(self.trust.gate(&ticket, &initial), DispatchDecision::Allow)
            {
                return Err(Error::Unavailable);
            }
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|_| Error::Unavailable)?;
            let nonce: String = nonce.iter().map(|v| format!("{v:02x}")).collect();
            let mut registry = self.trust.registry()?;
            if registry.write_poisoned() {
                return Err(Error::Storage);
            }
            let record = registry.find(&initial.key.name).ok_or(Error::Invalid)?;
            self.trust.transaction_scope(record, &initial)?;
            if record.get(MARKER).is_some() {
                return Err(Error::Uncertain);
            }
            if yes(record, "forkOnResume") {
                return Err(Error::Invalid);
            }
            let resume = record.scalar("providerSessionId");
            if record.get("providerSessionId").is_some() && resume.is_none() {
                return Err(Error::Invalid);
            }
            if resume.as_deref().is_some_and(|v| !id(v)) {
                return Err(Error::Invalid);
            }
            let mut attempts = self.attempts.lock().map_err(|_| Error::Storage)?;
            if attempts.contains_key(&initial.key) || attempts.len() >= MAX_ATTEMPTS {
                return Err(Error::Unavailable);
            }
            if self.trust.live(&ticket).as_ref() != Ok(&initial) {
                return Err(Error::Unavailable);
            }
            let marker = json!({
                "version": 1,
                "nonce": nonce,
                "generation": generation,
                "publicTurn": public_turn,
                "resumeSessionId": resume,
            })
            .to_string();
            registry
                .update_checked(&initial.key, |record| {
                    record.set_raw(
                        MARKER,
                        serde_json::value::RawValue::from_string(marker.clone())?,
                    );
                    Ok(())
                })
                .map_err(|_| Error::Storage)?;
            let spawn = Arc::new(SpawnAction::new(ticket.clone(), deadline));
            let attempt = Attempt(Arc::new(Entry {
                ticket,
                initial,
                generation,
                public_turn,
                expected_resume: resume,
                marker,
                spawn,
                native: Mutex::new(None),
                retired: AtomicBool::new(false),
            }));
            attempts.insert(attempt.ticket().session().clone(), attempt.clone());
            Ok(attempt)
        })
    }
    fn marker(&self, record: &Record, attempt: &Attempt) -> Result<(), Error> {
        self.trust.transaction_scope(record, &attempt.0.initial)?;
        if record.get(MARKER).map(|v| v.get()) != Some(attempt.0.marker.as_str()) {
            return Err(Error::Uncertain);
        }
        let native = attempt.0.native.lock().map_err(|_| Error::Storage)?;
        if record.get("providerSessionId").is_some() && record.scalar("providerSessionId").is_none()
        {
            return Err(Error::Uncertain);
        }
        if record.scalar("providerSessionId")
            != native.clone().or_else(|| attempt.0.expected_resume.clone())
        {
            return Err(Error::Uncertain);
        }
        Ok(())
    }
    /// Native identity only. The unknown-input marker is deliberately retained.
    pub fn record_native_session(&self, attempt: &Attempt, sid: &str) -> Result<(), Error> {
        self.operation(|| self.identity(attempt, sid, None).map(|_| ()))
    }
    fn identity(
        &self,
        attempt: &Attempt,
        sid: &str,
        tid: Option<&str>,
    ) -> Result<Acceptance, Error> {
        if !attempt.sealed() || !id(sid) || tid.is_some_and(|v| !id(v)) {
            return Err(Error::Invalid);
        }
        if attempt.resume_session_id().is_some_and(|old| old != sid) {
            return Err(Error::Uncertain);
        }
        self.checked(attempt)?;
        let mut registry = self.trust.registry()?;
        if registry.write_poisoned() {
            return Err(Error::Storage);
        }
        let record = registry
            .find(&attempt.ticket().session().name)
            .ok_or(Error::Invalid)?;
        self.marker(record, attempt)?;
        if self.trust.live(attempt.ticket()).as_ref() != Ok(&attempt.0.initial) {
            return Err(Error::Unavailable);
        }
        let mut attempts = self.attempts.lock().map_err(|_| Error::Storage)?;
        if !attempts
            .get(attempt.ticket().session())
            .is_some_and(|v| Arc::ptr_eq(&v.0, &attempt.0))
        {
            return Err(Error::Invalid);
        }
        let mut native = attempt.0.native.lock().map_err(|_| Error::Storage)?;
        if native.as_deref().is_some_and(|old| old != sid) {
            return Err(Error::Uncertain);
        }
        if tid.is_none() && native.as_deref() == Some(sid) {
            return Ok(Acceptance {
                attempt: attempt.clone(),
                native_session: sid.into(),
                native_turn: String::new(),
            });
        }
        registry
            .update_checked(attempt.ticket().session(), |record| {
                record.set_string("providerSessionId", sid);
                if tid.is_some() {
                    record.remove(MARKER);
                }
                Ok(())
            })
            .map_err(|_| Error::Storage)?;
        *native = Some(sid.into());
        if tid.is_some() {
            attempt.0.retired.store(true, Ordering::Release);
            attempts.remove(attempt.ticket().session());
        }
        Ok(Acceptance {
            attempt: attempt.clone(),
            native_session: sid.into(),
            native_turn: tid.unwrap_or_default().into(),
        })
    }
    pub fn accept_turn_started(
        &self,
        attempt: &Attempt,
        evidence: TurnStartedEvidence,
    ) -> Result<Acceptance, Error> {
        self.operation(|| {
            if !Arc::ptr_eq(&attempt.0, &evidence.attempt.0) {
                return Err(Error::Invalid);
            }
            self.identity(attempt, &evidence.session_id, Some(&evidence.turn_id))
        })
    }
    pub fn clear_never_sent(&self, attempt: &Attempt, proof: JoinedCleanup) -> Result<(), Error> {
        self.operation(|| {
            if !Arc::ptr_eq(&attempt.0, &proof.0.0) || !attempt.0.spawn.never_sent() {
                return Err(Error::Invalid);
            }
            self.owned(attempt)?;
            let mut registry = self.trust.registry()?;
            if registry.write_poisoned() {
                return Err(Error::Storage);
            }
            let record = registry
                .find(&attempt.ticket().session().name)
                .ok_or(Error::Invalid)?;
            self.marker(record, attempt)?;
            registry
                .update_checked(attempt.ticket().session(), |record| {
                    record.remove(MARKER);
                    Ok(())
                })
                .map_err(|_| Error::Storage)?;
            self.attempts
                .lock()
                .map_err(|_| Error::Storage)?
                .remove(attempt.ticket().session());
            attempt.0.retired.store(true, Ordering::Release);
            Ok(())
        })
    }
    /// Exact joined cleanup releases bounded bookkeeping; sealed unknown marker
    /// survives. No Drop auto-clear and no newest-session lookup.
    pub fn retire(&self, attempt: &Attempt, proof: JoinedCleanup) -> Result<(), Error> {
        // Cleanup bookkeeping grants no authority and must remain possible after
        // a global storage fault. It performs no FS IO and never clears marker.
        if !Arc::ptr_eq(&attempt.0, &proof.0.0) {
            return Err(Error::Invalid);
        }
        if attempt.0.retired.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut attempts = self.attempts.lock().map_err(|_| Error::Storage)?;
        if !attempts
            .get(attempt.ticket().session())
            .is_some_and(|v| Arc::ptr_eq(&v.0, &attempt.0))
        {
            return Err(Error::Invalid);
        }
        attempts.remove(attempt.ticket().session());
        attempt.0.retired.store(true, Ordering::Release);
        Ok(())
    }
}

/// Trusted host input captured before native spawn. JSON is not a constructor.
pub struct ReserveRequest {
    ticket: Ticket,
    initial: TurnSnapshot,
    generation: u64,
    public_turn: String,
    deadline: std::time::Instant,
}
impl ReserveRequest {
    #[allow(dead_code)]
    pub(crate) fn new(
        ticket: Ticket,
        initial: TurnSnapshot,
        generation: u64,
        public_turn: String,
        deadline: std::time::Instant,
    ) -> Self {
        Self {
            ticket,
            initial,
            generation,
            public_turn,
            deadline,
        }
    }
    pub fn ticket(&self) -> &Ticket {
        &self.ticket
    }
    pub fn initial(&self) -> &TurnSnapshot {
        &self.initial
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn public_turn(&self) -> &str {
        &self.public_turn
    }
    pub fn deadline(&self) -> std::time::Instant {
        self.deadline
    }
}
/// All returned Tasks stay in an owned Worker job through cancellation and
/// cleanup. Dropping their waiter is never a blocking-IO completion receipt.
pub trait SessionStore: Send + Sync {
    fn reserve(&self, request: ReserveRequest) -> crate::turn_driver::Task<Result<Attempt, Error>>;
    fn record_native_session(
        &self,
        attempt: Attempt,
        sid: String,
    ) -> crate::turn_driver::Task<Result<(), Error>>;
    fn accept_turn_started(
        &self,
        attempt: Attempt,
        evidence: TurnStartedEvidence,
    ) -> crate::turn_driver::Task<Result<Acceptance, Error>>;
    fn clear_never_sent(
        &self,
        attempt: Attempt,
        proof: JoinedCleanup,
    ) -> crate::turn_driver::Task<Result<(), Error>>;
    fn retire(
        &self,
        attempt: Attempt,
        proof: JoinedCleanup,
    ) -> crate::turn_driver::Task<Result<(), Error>>;
}
struct OwnerStore(Arc<ZcodeOwner>);
impl OwnerStore {
    fn io<T: Send + 'static>(
        &self,
        work: impl FnOnce(Arc<ZcodeOwner>) -> Result<T, Error> + Send + 'static,
    ) -> crate::turn_driver::Task<Result<T, Error>> {
        let owner = self.0.clone();
        Box::pin(async move {
            let fault = owner.clone();
            match tokio::task::spawn_blocking(move || work(owner)).await {
                Ok(result) => result,
                Err(_) => fault.operation(|| Err(Error::Storage)),
            }
        })
    }
}
impl SessionStore for OwnerStore {
    fn reserve(&self, request: ReserveRequest) -> crate::turn_driver::Task<Result<Attempt, Error>> {
        self.io(move |owner| {
            owner.reserve(
                request.ticket,
                request.initial,
                request.generation,
                request.public_turn,
                request.deadline,
            )
        })
    }
    fn record_native_session(
        &self,
        attempt: Attempt,
        sid: String,
    ) -> crate::turn_driver::Task<Result<(), Error>> {
        self.io(move |owner| owner.record_native_session(&attempt, &sid))
    }
    fn accept_turn_started(
        &self,
        attempt: Attempt,
        evidence: TurnStartedEvidence,
    ) -> crate::turn_driver::Task<Result<Acceptance, Error>> {
        self.io(move |owner| owner.accept_turn_started(&attempt, evidence))
    }
    fn clear_never_sent(
        &self,
        attempt: Attempt,
        proof: JoinedCleanup,
    ) -> crate::turn_driver::Task<Result<(), Error>> {
        self.io(move |owner| owner.clear_never_sent(&attempt, proof))
    }
    fn retire(
        &self,
        attempt: Attempt,
        proof: JoinedCleanup,
    ) -> crate::turn_driver::Task<Result<(), Error>> {
        self.io(move |owner| owner.retire(&attempt, proof))
    }
}
#[cfg(test)]
#[path = "../tests/support/zcode_owner_unit.rs"]
mod tests;
