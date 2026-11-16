//! Owner-only Route B contracts. No native process/transport is implemented here.
use super::*;
use crate::host_policy::{self, AccessFacts, SessionGrant};
use crate::turn_driver::Task;
use crate::turn_snapshot::Approval;
use std::marker::PhantomData;
use std::sync::MutexGuard;

/// Host-issued tracing values, not native IDs or dispatch authority.
pub struct HostInputIds {
    pub(super) input_id: String,
    pub(super) query_id: String,
}
fn host_id(value: &str) -> bool {
    let js_space = |c| {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}'
        | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}'
        | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    };
    id(value) && value.len() <= 256 && value.trim_matches(js_space) == value
}
impl HostInputIds {
    pub fn new(input_id: String, query_id: String) -> Result<Self, Error> {
        if !host_id(&input_id) || !host_id(&query_id) {
            return Err(Error::Invalid);
        }
        Ok(Self { input_id, query_id })
    }
}

/// The exact shared Attempt, with a checked Route B discriminant.
#[derive(Clone)]
pub struct AppServerAttempt(Attempt);
impl AppServerAttempt {
    pub fn attempt(&self) -> &Attempt {
        &self.0
    }
    fn input(&self) -> &InputAction {
        match &self.0.0.route {
            AttemptRoute::AppServer { input, .. } => input,
            AttemptRoute::Argv => unreachable!("checked app-server wrapper"),
        }
    }
    fn ids(&self) -> &HostInputIds {
        match &self.0.0.route {
            AttemptRoute::AppServer { ids, .. } => ids,
            AttemptRoute::Argv => unreachable!("checked app-server wrapper"),
        }
    }
    pub fn host_input_id(&self) -> &str {
        &self.ids().input_id
    }
    pub fn host_query_id(&self) -> &str {
        &self.ids().query_id
    }
    pub fn cancel_before_input(&self) -> bool {
        self.input().cancel() || self.input().never_enqueued()
    }
    pub fn input_sealed(&self) -> bool {
        self.input().sealed()
    }
    pub fn never_enqueued(&self) -> bool {
        self.input().never_enqueued()
    }
}

/// Durable native identity only, bound to an issuing Owner and exact Attempt.
pub struct NativeSessionReceipt {
    attempt: AppServerAttempt,
    sid: String,
}
impl NativeSessionReceipt {
    pub fn native_session_id(&self) -> &str {
        &self.sid
    }
    fn matches(&self, attempt: &AppServerAttempt) -> bool {
        Arc::ptr_eq(&self.attempt.0.0, &attempt.0.0)
    }
}

/// Acquire and consume on the same owned blocking thread, before entering the
/// Runtime State admission gate. No await/FS/store lock acquisition after that
/// gate. Consent and Registry serialization remain held through first handoff.
/// ```compile_fail
/// use pult_core::zcode_host_services::AppServerInputFrontier;
/// fn require_send<T: Send>() {}
/// require_send::<AppServerInputFrontier<'static>>();
/// ```
#[must_use]
pub struct AppServerInputFrontier<'owner> {
    owner: &'owner ZcodeOwner,
    attempt: AppServerAttempt,
    sid: String,
    registry: MutexGuard<'owner, Registry>,
    _consent: MutexGuard<'owner, ConsentStore>,
}
/// Borrowed, !Send, non-cloneable handoff token. It cannot outlive the Registry
/// frontier. Its existence is not native acceptance or cleanup proof.
/// ```compile_fail
/// use pult_core::zcode_host_services::{AppServerInputFrontier, AppServerInputSeal};
/// fn detach<'a>(frontier: AppServerInputFrontier<'a>) -> AppServerInputSeal<'a> {
///     frontier.seal().unwrap()
/// }
/// ```
#[must_use]
pub struct AppServerInputSeal<'frontier> {
    attempt: AppServerAttempt,
    sid: String,
    _frontier: PhantomData<MutexGuard<'frontier, ()>>,
}
impl AppServerInputFrontier<'_> {
    /// Current metadata under this frontier's held Registry serialization.
    pub fn current_record(&self) -> &crate::registry::Record {
        self.registry
            .find(&self.attempt.0.ticket().session().name)
            .expect("frontier retains the exact checked Registry record")
    }
    /// Caller holds fresh Runtime/route admission through the first synchronous
    /// enqueue/poll. This method does bounded memory work and the Driver CAS.
    pub fn seal(&self) -> Option<AppServerInputSeal<'_>> {
        if self.owner.failed.load(Ordering::Acquire) {
            return None;
        }
        let record = self
            .registry
            .find(&self.attempt.0.ticket().session().name)?;
        if record.get(MARKER).map(|v| v.get()) != Some(self.attempt.0.0.marker.as_str())
            || record.scalar("providerSessionId").as_deref() != Some(&self.sid)
        {
            return None;
        }
        let attempts = self.owner.attempts.lock().ok()?;
        if !attempts
            .get(self.attempt.0.ticket().session())
            .is_some_and(|a| Arc::ptr_eq(&a.0, &self.attempt.0.0))
            || !Arc::ptr_eq(&self.owner.brand, &self.attempt.0.0.owner_brand)
        {
            return None;
        }
        let driver = self.owner.trust.driver.upgrade()?;
        if !driver.seal_input(
            self.attempt.0.ticket(),
            &self.attempt.0.0.initial,
            self.attempt.input(),
        ) {
            return None;
        }
        Some(AppServerInputSeal {
            attempt: self.attempt.clone(),
            sid: self.sid.clone(),
            _frontier: PhantomData,
        })
    }
}
impl AppServerInputSeal<'_> {
    pub fn native_session_id(&self) -> &str {
        &self.sid
    }
}

/// Exact accepted process/input identity; it is not native tool approval.
/// No public constructor, Debug, Clone or serde. Arc clones retain the same binding.
///
/// ```compile_fail
/// fn inspect(value: &pult_core::zcode_host_services::AcceptedNativeSource) {
///     let _ = format!("{value:?}");
/// }
/// ```
/// ```compile_fail
/// fn duplicate(value: pult_core::zcode_host_services::AcceptedNativeSource) {
///     let _ = value.clone();
/// }
/// ```
/// ```compile_fail
/// fn serialize(value: &pult_core::zcode_host_services::AcceptedNativeSource) {
///     let _ = serde_json::to_string(value);
/// }
/// ```
pub struct AcceptedNativeSource {
    attempt: AppServerAttempt,
    observed: crate::zcode_appserver_worker::ObservedRunning,
    native_session: String,
    native_turn: String,
    runtime: crate::zcode_runtime::RuntimeSourceBinding,
}

impl AcceptedNativeSource {
    pub(crate) fn attempt(&self) -> &AppServerAttempt {
        &self.attempt
    }
    pub(crate) fn ticket(&self) -> &Ticket {
        self.attempt.0.ticket()
    }
    pub(crate) fn generation(&self) -> u64 {
        self.attempt.0.generation()
    }
    pub(crate) fn accepted(&self) -> &crate::turn_driver::Accepted {
        self.observed.accepted()
    }
    pub(crate) fn initial(&self) -> &TurnSnapshot {
        &self.attempt.0.0.initial
    }
    pub(crate) fn native_session_id(&self) -> &str {
        &self.native_session
    }
    pub(crate) fn native_turn_id(&self) -> &str {
        &self.native_turn
    }
    pub(crate) fn deadline(
        &self,
        admitted: std::time::Instant,
        timeout: std::time::Duration,
    ) -> std::time::Instant {
        self.observed.deadline(admitted, timeout)
    }
    pub(crate) fn runtime(&self) -> &crate::zcode_runtime::RuntimeSourceBinding {
        &self.runtime
    }
}
/// Construct/use on one owned blocking thread before Runtime admission. No revived
/// initial-input marker, attempt-map membership or inherited start-deadline check.
pub struct AppServerReplyFrontier<'o> {
    owner: &'o ZcodeOwner,
    source: Arc<AcceptedNativeSource>,
    registry: MutexGuard<'o, Registry>,
    _consent: MutexGuard<'o, ConsentStore>,
}

pub struct AppServerReplySeal<'f> {
    _frontier: PhantomData<MutexGuard<'f, ()>>,
}

impl AppServerReplyFrontier<'_> {
    pub fn current_record(&self) -> &crate::registry::Record {
        self.registry
            .find(&self.source.ticket().session().name)
            .expect("reply frontier retains the checked record")
    }
    /// Caller holds exact Runtime, memory-resource and pending-call gates through
    /// the immediate bounded enqueue. There is no callback/IO under Driver CAS.
    pub(crate) fn seal(
        &self,
        action: &crate::turn_driver::NativeReplyAction,
    ) -> Option<AppServerReplySeal<'_>> {
        let record = self.current_record();
        if self.owner.failed.load(Ordering::Acquire)
            || record.get(MARKER).is_some()
            || record.scalar("providerSessionId").as_deref() != Some(&self.source.native_session)
            || !Arc::ptr_eq(&self.owner.brand, &self.source.attempt.0.0.owner_brand)
        {
            return None;
        }
        self.owner
            .trust
            .driver
            .upgrade()?
            .seal_native_reply(
                self.source.ticket(),
                self.source.initial(),
                self.source.accepted(),
                action,
            )
            .then_some(AppServerReplySeal {
                _frontier: PhantomData,
            })
    }
}

fn rank(approval: Approval) -> u8 {
    match approval {
        Approval::ReadOnly => 0,
        Approval::Ask => 1,
        Approval::Workspace => 2,
        Approval::Full => 3,
        Approval::Inherit => 4,
    }
}
impl ZcodeOwner {
    fn app_server_owned(&self, attempt: &AppServerAttempt) -> Result<(), Error> {
        if !Arc::ptr_eq(&self.brand, &attempt.0.0.owner_brand)
            || !matches!(attempt.0.0.route, AttemptRoute::AppServer { .. })
        {
            return Err(Error::Invalid);
        }
        self.operation(|| self.owned(&attempt.0))
    }
    /// Only the actual Runtime reply binder supplies its opaque Source witness.
    /// A publicly constructible Accepted value alone cannot mint this identity.
    pub(crate) fn bind_app_server_accepted(
        &self,
        attempt: &AppServerAttempt,
        native: Acceptance,
        observed: crate::zcode_appserver_worker::ObservedRunning,
        runtime: crate::zcode_runtime::RuntimeSourceBinding,
    ) -> Result<Arc<AcceptedNativeSource>, Error> {
        let accepted = observed.accepted();
        if self.failed.load(Ordering::Acquire)
            || !Arc::ptr_eq(&self.brand, &attempt.0.0.owner_brand)
            || !native.matches(attempt.attempt())
            || !attempt.input_sealed()
            || !attempt.0.0.retired.load(Ordering::Acquire)
            || !matches!(attempt.0.0.route, AttemptRoute::AppServer { .. })
            || !id(&native.native_session)
            || !id(&native.native_turn)
            || !runtime.matches_current(attempt.attempt())
            || accepted.turn_id != attempt.0.public_turn()
        {
            return Err(Error::Invalid);
        }
        if attempt
            .0
            .0
            .native
            .lock()
            .map_err(|_| Error::Storage)?
            .as_deref()
            != Some(native.native_session.as_str())
        {
            return Err(Error::Invalid);
        }
        let progress = self
            .trust
            .driver
            .upgrade()
            .and_then(|d| d.progress_for_ticket(attempt.0.ticket()))
            .ok_or(Error::Unavailable)?;
        if !matches!(&*progress.borrow(), crate::turn_driver::Progress::Running(a)
            if a == accepted && a.user_event_id > 0 && a.user_event_id <= 9_007_199_254_740_991)
        {
            return Err(Error::Unavailable);
        }
        Ok(Arc::new(AcceptedNativeSource {
            attempt: attempt.clone(),
            observed,
            native_session: native.native_session,
            native_turn: native.native_turn,
            runtime,
        }))
    }

    pub(crate) fn prepare_app_server_reply<'o>(
        &'o self,
        source: &Arc<AcceptedNativeSource>,
    ) -> Result<AppServerReplyFrontier<'o>, Error> {
        if self.failed.load(Ordering::Acquire)
            || !Arc::ptr_eq(&self.brand, &source.attempt.0.0.owner_brand)
        {
            return Err(Error::Invalid);
        }
        self.operation(|| {
            // All injected/FS work precedes the caller's Runtime lock.
            let policy = self.trust.snapshot_policy(source.ticket().session())?;
            if !matches!(
                self.trust.gate(source.ticket(), source.initial()),
                DispatchDecision::Allow
            ) {
                return Err(Error::Unavailable);
            }
            let mut consent = self.trust.consent.lock().map_err(|_| Error::Storage)?;
            let registry = self.trust.registry()?;
            if registry.write_poisoned() {
                return Err(Error::Storage);
            }
            let record = registry
                .find(&source.ticket().session().name)
                .ok_or(Error::Invalid)?;
            self.trust.transaction_scope(record, source.initial())?;
            if record.get(MARKER).is_some()
                || record.scalar("providerSessionId").as_deref() != Some(source.native_session_id())
                || !crate::owner_trust::same_authority(&policy.record, record)
            {
                return Err(Error::Uncertain);
            }
            let current = TurnSnapshot::try_from(record).map_err(|_| Error::Invalid)?;
            let effective = host_policy::effective_access(&AccessFacts {
                provider: current.provider,
                desired: current.settings.approval,
                effective_inherit_mode: policy.inherit_mode,
                inherit_seen: record.scalar("inheritSeen"),
                session_grant: (record.scalar("grant").as_deref() == Some("cli-once"))
                    .then_some(SessionGrant::CliOnce),
                consent: consent.read().map_err(|_| Error::Storage)?.facts(),
            })
            .effective;
            if rank(effective) < rank(source.initial().settings.approval)
                || self.trust.live(source.ticket()).as_ref() != Ok(source.initial())
            {
                return Err(Error::Unavailable);
            }
            Ok(AppServerReplyFrontier {
                owner: self,
                source: source.clone(),
                registry,
                _consent: consent,
            })
        })
    }
    pub fn reserve_app_server(
        &self,
        request: ReserveRequest,
        ids: HostInputIds,
    ) -> Result<AppServerAttempt, Error> {
        self.reserve_route(request, Some(ids)).map(AppServerAttempt)
    }
    pub fn record_app_server_session(
        &self,
        attempt: &AppServerAttempt,
        sid: &str,
    ) -> Result<NativeSessionReceipt, Error> {
        self.app_server_owned(attempt)?;
        self.operation(|| {
            self.identity(&attempt.0, sid, None)?;
            Ok(NativeSessionReceipt {
                attempt: attempt.clone(),
                sid: sid.into(),
            })
        })
    }
    pub fn prepare_app_server_input<'owner>(
        &'owner self,
        attempt: &AppServerAttempt,
        identity: &NativeSessionReceipt,
    ) -> Result<AppServerInputFrontier<'owner>, Error> {
        // Reject foreign capability before FS or injected policy callbacks.
        self.app_server_owned(attempt)?;
        if !identity.matches(attempt) {
            return Err(Error::Invalid);
        }
        self.operation(|| {
            self.checked(&attempt.0)?; // callbacks/FS finish before store guards
            let policy = self.trust.snapshot_policy(attempt.0.ticket().session())?;
            #[cfg(test)]
            tests::before_frontier_locks();
            // Shared sole-writer order. Keep both guards through actual handoff.
            let mut consent = self.trust.consent.lock().map_err(|_| Error::Storage)?;
            let registry = self.trust.registry()?;
            if registry.write_poisoned() {
                return Err(Error::Storage);
            }
            let record = registry
                .find(&attempt.0.ticket().session().name)
                .ok_or(Error::Invalid)?;
            self.trust.transaction_scope(record, &attempt.0.0.initial)?;
            self.marker(record, &attempt.0)?;
            if !crate::owner_trust::same_authority(&policy.record, record)
                || record.scalar("providerSessionId").as_deref() != Some(identity.sid.as_str())
            {
                return Err(Error::Uncertain);
            }
            let current = TurnSnapshot::try_from(record).map_err(|_| Error::Invalid)?;
            let facts = consent.read().map_err(|_| Error::Storage)?.facts();
            let effective = host_policy::effective_access(&AccessFacts {
                provider: current.provider,
                desired: current.settings.approval,
                effective_inherit_mode: policy.inherit_mode,
                inherit_seen: record.scalar("inheritSeen"),
                session_grant: (record.scalar("grant").as_deref() == Some("cli-once"))
                    .then_some(SessionGrant::CliOnce),
                consent: facts,
            })
            .effective;
            if rank(effective) < rank(attempt.0.0.initial.settings.approval)
                || self.trust.live(attempt.0.ticket()).as_ref() != Ok(&attempt.0.0.initial)
            {
                return Err(Error::Unavailable);
            }
            Ok(AppServerInputFrontier {
                owner: self,
                attempt: attempt.clone(),
                sid: identity.sid.clone(),
                registry,
                _consent: consent,
            })
        })
    }
    pub fn accept_app_server_started(
        &self,
        attempt: &AppServerAttempt,
        evidence: AppServerStartedEvidence,
    ) -> Result<Acceptance, Error> {
        self.app_server_owned(attempt)?;
        self.operation(|| {
            if !Arc::ptr_eq(&attempt.0.0, &evidence.attempt.0.0)
                || !attempt.input_sealed()
                || evidence.input_id != attempt.host_input_id()
                || evidence.query_id != attempt.host_query_id()
            {
                return Err(Error::Invalid);
            }
            self.identity(&attempt.0, &evidence.sid, Some(&evidence.tid))
        })
    }
    pub fn clear_app_server_before_bootstrap(
        &self,
        attempt: &AppServerAttempt,
        joined: JoinedCleanup,
    ) -> Result<(), Error> {
        self.app_server_owned(attempt)?;
        if !attempt.never_enqueued() {
            return Err(Error::Invalid);
        }
        self.clear_never_sent_inner(&attempt.0, joined)
    }
    pub fn app_server_store(self: &Arc<Self>) -> Arc<dyn AppServerSessionStore> {
        Arc::new(AppServerStore(self.clone()))
    }
}

/// Native observations belong only to the trusted Worker owning the exact fresh
/// process. This module has no OS observer and makes no real-native proof claim.
pub struct AppServerNativeObserver {
    attempt: AppServerAttempt,
    pending: Option<(String, String)>, // exact send RPC ID and native SID
    ack: bool,
    started: Option<String>,
    saw_native_started: bool,
    failed: bool,
    taken: bool,
}
/// Joint ACK + actual native start evidence; no public JSON/field constructor.
pub struct AppServerStartedEvidence {
    attempt: AppServerAttempt,
    sid: String,
    tid: String,
    input_id: String,
    query_id: String,
}
impl AppServerNativeObserver {
    /// Trusted future Worker only, after binding its exact owned process and
    /// fresh generation. Caller must never route another process's frames here.
    #[allow(dead_code)] // Only constructor seam for the subsequent real Worker.
    pub(crate) fn from_owned_process(
        attempt: &AppServerAttempt,
        generation: u64,
    ) -> Result<Self, Error> {
        if attempt.0.generation() != generation || !attempt.0.sealed() {
            return Err(Error::Invalid);
        }
        Ok(Self {
            attempt: attempt.clone(),
            pending: None,
            ack: false,
            started: None,
            saw_native_started: false,
            failed: false,
            taken: false,
        })
    }
    /// Register only the first session/send, under the borrowed Registry seal
    /// and before its first handoff. Native bootstrap RPCs are not send ACKs.
    pub fn bind_first_send(
        &mut self,
        seal: &AppServerInputSeal<'_>,
        request_id: &str,
    ) -> Result<(), Error> {
        if self.failed
            || self.pending.is_some()
            || !host_id(request_id)
            || !Arc::ptr_eq(&self.attempt.0.0, &seal.attempt.0.0)
            || !self.attempt.input_sealed()
        {
            self.failed = true;
            return Err(Error::Invalid);
        }
        self.pending = Some((request_id.into(), seal.sid.clone()));
        Ok(())
    }
    pub fn observe_send_ack(
        &mut self,
        request_id: &str,
        sid: &str,
        accepted: bool,
        state_revision: u64,
    ) -> Result<(), Error> {
        let expected = self.pending.as_ref();
        if self.failed
            || self.ack
            || !accepted
            || state_revision > 9_007_199_254_740_991
            || expected.is_none_or(|(rpc, native)| rpc != request_id || native != sid)
        {
            self.failed = true;
            return Err(Error::Invalid);
        }
        self.ack = true;
        Ok(())
    }
    /// Called only for an actual typed session/event turn.started observation.
    /// Sticky observation precedes validation and every possible Store/Sink IO.
    pub fn observe_turn_started(
        &mut self,
        sid: &str,
        tid: Option<&str>,
        input_id: Option<&str>,
        query_id: Option<&str>,
    ) -> Result<(), Error> {
        self.saw_native_started = true;
        if self.failed {
            return Err(Error::Invalid);
        }
        let Some((_, native)) = &self.pending else {
            return Ok(());
        };
        if native != sid {
            self.failed = true;
            return Err(Error::Uncertain);
        }
        let Some(tid) = tid.filter(|v| id(v)) else {
            return Ok(());
        };
        if input_id != Some(self.attempt.host_input_id())
            || query_id != Some(self.attempt.host_query_id())
        {
            return Ok(());
        }
        if self.started.as_deref().is_some_and(|old| old != tid) {
            self.failed = true;
            return Err(Error::Uncertain);
        }
        self.started = Some(tid.into());
        Ok(())
    }
    pub(crate) fn matching_started_turn(&self) -> Option<&str> {
        if self.failed || self.pending.is_none() {
            None
        } else {
            self.started.as_deref()
        }
    }
    pub fn saw_native_started(&self) -> bool {
        self.saw_native_started
    }
    pub fn take_started_evidence(&mut self) -> Option<AppServerStartedEvidence> {
        if self.failed || self.taken || !self.ack {
            return None;
        }
        let tid = self.started.as_ref()?;
        let (_, sid) = self.pending.as_ref()?;
        self.taken = true;
        Some(AppServerStartedEvidence {
            attempt: self.attempt.clone(),
            sid: sid.clone(),
            tid: tid.clone(),
            input_id: self.attempt.host_input_id().into(),
            query_id: self.attempt.host_query_id().into(),
        })
    }
}

/// All Tasks are owned through their actual completion, including cancellation.
/// The !Send frontier is deliberately absent: consume it on one blocking thread.
pub trait AppServerSessionStore: Send + Sync {
    fn reserve(
        &self,
        request: ReserveRequest,
        ids: HostInputIds,
    ) -> Task<Result<AppServerAttempt, Error>>;
    fn record_session(
        &self,
        attempt: AppServerAttempt,
        sid: String,
    ) -> Task<Result<NativeSessionReceipt, Error>>;
    fn accept_started(
        &self,
        attempt: AppServerAttempt,
        evidence: AppServerStartedEvidence,
    ) -> Task<Result<Acceptance, Error>>;
    fn clear_before_bootstrap(
        &self,
        attempt: AppServerAttempt,
        joined: JoinedCleanup,
    ) -> Task<Result<(), Error>>;
    fn retire(&self, attempt: AppServerAttempt, joined: JoinedCleanup) -> Task<Result<(), Error>>;
}
struct AppServerStore(Arc<ZcodeOwner>);
impl AppServerSessionStore for AppServerStore {
    fn reserve(
        &self,
        request: ReserveRequest,
        ids: HostInputIds,
    ) -> Task<Result<AppServerAttempt, Error>> {
        OwnerStore(self.0.clone()).io(move |o| o.reserve_app_server(request, ids))
    }
    fn record_session(
        &self,
        attempt: AppServerAttempt,
        sid: String,
    ) -> Task<Result<NativeSessionReceipt, Error>> {
        OwnerStore(self.0.clone()).io(move |o| o.record_app_server_session(&attempt, &sid))
    }
    fn accept_started(
        &self,
        attempt: AppServerAttempt,
        evidence: AppServerStartedEvidence,
    ) -> Task<Result<Acceptance, Error>> {
        OwnerStore(self.0.clone()).io(move |o| o.accept_app_server_started(&attempt, evidence))
    }
    fn clear_before_bootstrap(
        &self,
        attempt: AppServerAttempt,
        joined: JoinedCleanup,
    ) -> Task<Result<(), Error>> {
        OwnerStore(self.0.clone())
            .io(move |o| o.clear_app_server_before_bootstrap(&attempt, joined))
    }
    fn retire(&self, attempt: AppServerAttempt, joined: JoinedCleanup) -> Task<Result<(), Error>> {
        OwnerStore(self.0.clone()).io(move |o| o.retire(&attempt.0, joined))
    }
}

#[cfg(test)]
#[path = "../../tests/support/zcode_app_server_owner_unit.rs"]
mod tests;
