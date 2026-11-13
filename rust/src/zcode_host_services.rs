//! Trusted ZCode Route A native identity and durable input uncertainty.
//! No process, JSON dispatch, credentials, inherited settings or MCP integration.
use crate::consent_store::ConsentStore;
use crate::owner_trust::{OwnerError, OwnerTrust, RouteValidity, yes};
use crate::registry::{Record, Registry};
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{DispatchDecision, Driver, InputAction, Receipt, SpawnAction, Terminal};
use crate::turn_snapshot::{Provider, SessionKey, TurnSnapshot};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicU8, Ordering},
};

mod app_server;
pub use app_server::{
    AcceptedNativeSource, AppServerAttempt, AppServerInputFrontier, AppServerInputSeal,
    AppServerNativeObserver, AppServerReplyFrontier, AppServerReplySeal, AppServerSessionStore,
    AppServerStartedEvidence, HostInputIds, NativeSessionReceipt,
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
    owner_brand: Arc<()>,
    ticket: Ticket,
    initial: TurnSnapshot,
    generation: u64,
    public_turn: String,
    expected_resume: Option<String>,
    marker: String,
    spawn: Arc<SpawnAction>,
    route: AttemptRoute,
    native: Mutex<Option<String>>,
    retired: AtomicBool,
}
enum AttemptRoute {
    Argv,
    AppServer {
        input: Arc<InputAction>,
        ids: HostInputIds,
    },
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
    fn argv(&self) -> bool {
        matches!(self.0.route, AttemptRoute::Argv)
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
        if !attempt.argv() || !id(&session_id) || !id(&turn_id) {
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
/// Observed missing-session diagnostic plus exact owned cleanup, NOT proof
/// that the previous argv input did not execute. No cold/JSON constructor.
pub struct MissingAfterJoin {
    attempt: Attempt,
    expected_resume: String,
}
impl MissingAfterJoin {
    /// Trusted Worker only, after natural stdout EOF, confirmed process/stderr
    /// reader joins, and all Store/Sink IO known. `saw_matching_native_turn_started`
    /// is actual protocol observation, never merely Published Started state.
    #[allow(dead_code)] // Worker consumer is added separately.
    pub(crate) fn from_owned_missing_after_join(
        attempt: &Attempt,
        joined: JoinedCleanup,
        saw_matching_native_turn_started: bool,
    ) -> Result<Self, Error> {
        if !attempt.argv()
            || !Arc::ptr_eq(&attempt.0, &joined.0.0)
            || saw_matching_native_turn_started
            || !attempt.sealed()
            || !attempt.0.retired.load(Ordering::Acquire)
        {
            return Err(Error::Invalid);
        }
        let expected_resume = attempt
            .resume_session_id()
            .filter(|v| id(v))
            .ok_or(Error::Invalid)?
            .to_owned();
        Ok(Self {
            attempt: attempt.clone(),
            expected_resume,
        })
    }
    pub fn session(&self) -> &SessionKey {
        self.attempt.ticket().session()
    }
    pub fn expected_resume_session_id(&self) -> &str {
        &self.expected_resume
    }
    pub fn previous_public_turn(&self) -> &str {
        self.attempt.public_turn()
    }
}
/// Host's same-name idle reservation, retained until all metadata IO is known.
/// Constructor is internal and does not itself reserve a Runtime slot. Caller
/// must exclude every own active/preparing/quarantined/new same-name execution.
/// No external callbacks, FS operations, or arbitrary JSON authority live here.
pub struct IdleRecoveryPermit {
    proof: Arc<MissingAfterJoin>,
    terminal_event_id: u64,
    deadline: std::time::Instant,
    // Ready(0) -> sealed metadata commit(1) or revoked(2).
    state: AtomicU8,
}
impl IdleRecoveryPermit {
    #[allow(dead_code)] // Runtime consumer is added separately.
    pub(crate) fn from_finished_idle(
        proof: Arc<MissingAfterJoin>,
        finished: &Terminal,
        deadline: std::time::Instant,
    ) -> Result<Arc<Self>, Error> {
        let terminal_event_id = finished
            .terminal_event_id
            .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
            .ok_or(Error::Invalid)?;
        if finished.turn.ticket != *proof.attempt.ticket()
            || finished.turn.provider_turn_id.is_some()
            || !proof.attempt.0.retired.load(Ordering::Acquire)
            || std::time::Instant::now() >= deadline
        {
            return Err(Error::Invalid);
        }
        Ok(Arc::new(Self {
            proof,
            terminal_event_id,
            deadline,
            state: AtomicU8::new(0),
        }))
    }
    /// Cancellation before seal wins. After seal the owned metadata commit may
    /// finish; it never dispatches input and does not promise rollback.
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }
    pub fn sealed(&self) -> bool {
        self.state.load(Ordering::Acquire) == 1
    }
    fn ready(&self) -> bool {
        self.state.load(Ordering::Acquire) == 0 && std::time::Instant::now() < self.deadline
    }
    fn seal(&self) -> bool {
        self.ready()
            && self
                .state
                .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }
}
/// Explicit authenticated owner acknowledgement of possible prior execution.
/// This is host authorization, not a universal proof that a human clicked.
/// Scoped MCP/model JSON, filesystem Full and tool rules cannot construct it.
pub struct OwnerConfirmedRecovery(Arc<IdleRecoveryPermit>);
impl OwnerConfirmedRecovery {
    #[allow(dead_code)] // Authenticated owner RPC/UI consumer is added separately.
    pub(crate) fn from_owner_confirmation(permit: &Arc<IdleRecoveryPermit>) -> Self {
        Self(permit.clone())
    }
}
/// Durable REQUESTED warning, never an assertion that reset already committed.
pub struct RecoveryWarningReceipt {
    permit: Arc<IdleRecoveryPermit>,
    receipt: Receipt,
}
impl RecoveryWarningReceipt {
    #[allow(dead_code)] // Runtime calls only after actual owned requested-warning append.
    pub(crate) fn from_owned_requested_append(
        permit: &Arc<IdleRecoveryPermit>,
        receipt: Receipt,
    ) -> Result<Self, Error> {
        if receipt.id <= permit.terminal_event_id
            || receipt.id > 9_007_199_254_740_991
            || receipt.ts.is_empty()
            || receipt.ts.len() > 128
            || receipt.ts.chars().any(char::is_control)
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            permit: permit.clone(),
            receipt,
        })
    }
}
/// Metadata-only success receipt. Never grants a dispatch or resumes the queue.
pub struct RecoveryReceipt {
    permit: Arc<IdleRecoveryPermit>,
    warning_event_id: u64,
}
impl RecoveryReceipt {
    pub fn session(&self) -> &SessionKey {
        self.permit.proof.session()
    }
    pub fn warning_event_id(&self) -> u64 {
        self.warning_event_id
    }
    #[allow(dead_code)]
    pub(crate) fn matches(&self, permit: &Arc<IdleRecoveryPermit>) -> bool {
        Arc::ptr_eq(&self.permit, permit)
    }
}

pub struct ZcodeOwner {
    brand: Arc<()>,
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
            brand: Arc::new(()),
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
    /// Metadata recovery only, executed in owned blocking work. Runtime must
    /// retain this exact same-name idle reservation until the outcome is known.
    /// Direct uncoordinated trusted Driver starts are outside that controller
    /// boundary; next input still requires fresh Driver/policy authorization.
    pub fn confirm_missing_for_next_turn(
        &self,
        permit: Arc<IdleRecoveryPermit>,
        confirmed: OwnerConfirmedRecovery,
        warning: RecoveryWarningReceipt,
    ) -> Result<RecoveryReceipt, Error> {
        // Proof is local to the issuing Owner lifetime, even if another home
        // copies all visible metadata or a fresh Owner reopens the same stores.
        // Reject before any policy/FS read, callback or recovery side effect.
        if !Arc::ptr_eq(&self.brand, &permit.proof.attempt.0.owner_brand) {
            return Err(Error::Invalid);
        }
        self.operation(|| {
            if !Arc::ptr_eq(&permit, &confirmed.0) || !Arc::ptr_eq(&permit, &warning.permit) {
                return Err(Error::Invalid);
            }
            if !permit.ready() {
                return Err(Error::Unavailable);
            }
            let proof = &permit.proof;
            let policy = self.trust.snapshot_policy(proof.session())?;
            if policy.snapshot.cwd != proof.attempt.0.initial.cwd {
                return Err(Error::Invalid);
            }
            #[cfg(test)]
            tests::before_recovery_transaction();
            let mut consent = self.trust.consent.lock().map_err(|_| Error::Storage)?;
            let mut registry = self.trust.registry()?;
            if registry.write_poisoned() {
                return Err(Error::Storage);
            }
            let record = registry.find(&proof.session().name).ok_or(Error::Invalid)?;
            self.trust.transaction_scope(record, &policy.snapshot)?;
            if !crate::owner_trust::same_authority(&policy.record, record) {
                return Err(Error::Unavailable);
            }
            // Refresh consent after both mutex waits; no user callback is run
            // under these guards. Metadata recovery never grants effective Full.
            consent.read().map_err(|_| Error::Storage)?;
            if record.scalar("providerSessionId").as_deref() != Some(proof.expected_resume.as_str())
                || record.get(MARKER).map(|v| v.get()) != Some(proof.attempt.0.marker.as_str())
            {
                return Err(Error::Uncertain);
            }
            if !proof.attempt.0.retired.load(Ordering::Acquire) {
                return Err(Error::Unavailable);
            }
            let driver = self.trust.driver.upgrade().ok_or(Error::Unavailable)?;
            if driver.storage_failed()
                || driver
                    .active_ticket_for_name(&proof.session().name)
                    .is_some()
            {
                return Err(Error::Unavailable);
            }
            // Bounded local CAS only. No callbacks, FS or OS spawn under a
            // Driver/Runtime mutex; Runtime's reservation excludes new starts.
            if !permit.seal() {
                return Err(Error::Unavailable);
            }
            registry
                .update_checked(proof.session(), |record| {
                    record.remove("providerSessionId");
                    record.remove(MARKER);
                    record.set_bool("queuePaused", true);
                    Ok(())
                })
                .map_err(|_| Error::Storage)?;
            Ok(RecoveryReceipt {
                permit: permit.clone(),
                warning_event_id: warning.receipt.id,
            })
        })
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
        self.reserve_route(
            ReserveRequest::new(ticket, initial, generation, public_turn, deadline),
            None,
        )
    }
    fn reserve_route(
        &self,
        request: ReserveRequest,
        app_server: Option<HostInputIds>,
    ) -> Result<Attempt, Error> {
        self.operation(|| {
            let ReserveRequest {
                ticket,
                initial,
                generation,
                public_turn,
                deadline,
            } = request;
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
            let mut marker = json!({
                "version": 1,
                "nonce": nonce,
                "generation": generation,
                "publicTurn": public_turn,
                "resumeSessionId": resume,
            });
            if let Some(ids) = &app_server {
                marker["version"] = json!(2);
                marker["route"] = json!("app-server");
                marker["inputId"] = json!(ids.input_id);
                marker["queryId"] = json!(ids.query_id);
            }
            let marker = marker.to_string();
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
            let route = match app_server {
                None => AttemptRoute::Argv,
                Some(ids) => AttemptRoute::AppServer {
                    input: Arc::new(InputAction::new(spawn.clone())),
                    ids,
                },
            };
            let attempt = Attempt(Arc::new(Entry {
                owner_brand: self.brand.clone(),
                ticket,
                initial,
                generation,
                public_turn,
                expected_resume: resume,
                marker,
                spawn,
                route,
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
        if !attempt.argv() {
            return Err(Error::Invalid);
        }
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
            if !attempt.argv() || !Arc::ptr_eq(&attempt.0, &evidence.attempt.0) {
                return Err(Error::Invalid);
            }
            self.identity(attempt, &evidence.session_id, Some(&evidence.turn_id))
        })
    }
    pub fn clear_never_sent(&self, attempt: &Attempt, proof: JoinedCleanup) -> Result<(), Error> {
        if !attempt.argv() {
            return Err(Error::Invalid);
        }
        self.clear_never_sent_inner(attempt, proof)
    }
    fn clear_never_sent_inner(&self, attempt: &Attempt, proof: JoinedCleanup) -> Result<(), Error> {
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
