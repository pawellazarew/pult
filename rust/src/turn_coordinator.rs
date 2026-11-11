//! Internal execution state. The driver owns IO, durable receipts and workers.
//! Cancellation is a request, never proof that a worker stopped.
use crate::turn_snapshot::{Approval, TurnSnapshot};
use std::collections::{HashMap, VecDeque};
use std::fmt;

const MAX_ATTEMPT: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Ticket {
    generation: [u8; 32],
    session: crate::turn_snapshot::SessionKey,
    attempt: u64,
}
impl Ticket {
    pub fn session(&self) -> &crate::turn_snapshot::SessionKey {
        &self.session
    }
    pub fn attempt(&self) -> u64 {
        self.attempt
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ErrorCode {
    Invalid,
    Busy,
    Capacity,
    Exhausted,
    Transition,
    Unavailable,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnError {
    pub code: ErrorCode,
    pub message: &'static str,
}
impl fmt::Display for TurnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for TurnError {}
fn error(code: ErrorCode, message: &'static str) -> TurnError {
    TurnError { code, message }
}
pub type Result<T> = std::result::Result<T, TurnError>;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub active: usize,
    pub finished: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            active: 64,
            finished: 128,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Outcome {
    Success,
    Failure { code: String, message: String },
    Interrupted,
}
impl Outcome {
    fn validate(&self) -> Result<()> {
        let Self::Failure { code, message } = self else {
            return Ok(());
        };
        if code.is_empty()
            || code.len() > 128
            || !code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
            || message.chars().count() > 4096
            || message.len() > 16384
        {
            return Err(error(
                ErrorCode::Invalid,
                "invalid or oversized turn failure",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Starting,
    Dispatching,
    Running,
    Cancelling,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DispatchAction {
    /// Snapshot sealed immediately before external start IO.
    Proceed(TurnSnapshot),
    Cancelled,
    Stale,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StartAction {
    /// The adapter acknowledged the start. The driver must still obey its
    /// durable receipt policy before acknowledging the caller.
    Proceed,
    /// A cancel crossed the start reply. Abort this exact worker; do not
    /// publish this as a newly accepted user/queue message.
    CancelProvider,
    Stale,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Change {
    Applied,
    Unchanged,
    Stale,
}

#[derive(Clone, Debug)]
pub struct ActiveTurn {
    ticket: Ticket,
    snapshot: TurnSnapshot,
    provider_turn_id: Option<String>,
    cancel_requested: bool,
    dispatched: bool,
}
impl ActiveTurn {
    pub fn ticket(&self) -> &Ticket {
        &self.ticket
    }
    pub fn snapshot(&self) -> &TurnSnapshot {
        &self.snapshot
    }
    pub fn provider_turn_id(&self) -> Option<&str> {
        self.provider_turn_id.as_deref()
    }
    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested
    }
    pub fn phase(&self) -> Phase {
        if self.cancel_requested {
            Phase::Cancelling
        } else if self.provider_turn_id.is_some() {
            Phase::Running
        } else if self.dispatched {
            Phase::Dispatching
        } else {
            Phase::Starting
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinishedTurn {
    pub ticket: Ticket,
    pub provider_turn_id: Option<String>,
    pub outcome: Outcome,
    pub cancel_requested: bool,
}

/// Single-owner synchronous state machine. A driver serializes transitions;
/// no mutex is held here over adapter, registry or journal IO. It never evicts
/// active/cancelling slots, and never frees a slot merely because a timer fired.
pub struct Coordinator {
    limits: Limits,
    generation: [u8; 32],
    next_attempt: u64,
    active: HashMap<String, ActiveTurn>,
    finished: VecDeque<FinishedTurn>,
}
impl Coordinator {
    pub fn new(limits: Limits) -> Result<Self> {
        if limits.active == 0 || limits.active > 4096 || limits.finished > 4096 {
            return Err(error(ErrorCode::Invalid, "invalid turn coordinator limits"));
        }
        let mut generation = [0; 32];
        getrandom::fill(&mut generation)
            .map_err(|_| error(ErrorCode::Unavailable, "turn identity entropy unavailable"))?;
        Ok(Self {
            limits,
            generation,
            next_attempt: 1,
            active: HashMap::new(),
            finished: VecDeque::new(),
        })
    }
    /// Reserve synchronously before the first asynchronous step. Busy is keyed
    /// by name, even if a caller presents a newer registry incarnation.
    pub fn reserve(&mut self, snapshot: TurnSnapshot) -> Result<Ticket> {
        snapshot
            .validate()
            .map_err(|_| error(ErrorCode::Invalid, "invalid turn snapshot"))?;
        if self.active.contains_key(&snapshot.key.name) {
            return Err(error(
                ErrorCode::Busy,
                "a turn already owns this session name",
            ));
        }
        if self.active.len() >= self.limits.active {
            return Err(error(ErrorCode::Capacity, "active turn capacity reached"));
        }
        if self.next_attempt > MAX_ATTEMPT {
            return Err(error(
                ErrorCode::Exhausted,
                "turn attempt counter exhausted",
            ));
        }
        let ticket = Ticket {
            generation: self.generation,
            session: snapshot.key.clone(),
            attempt: self.next_attempt,
        };
        self.next_attempt += 1;
        self.active.insert(
            ticket.session.name.clone(),
            ActiveTurn {
                ticket: ticket.clone(),
                snapshot,
                provider_turn_id: None,
                cancel_requested: false,
                dispatched: false,
            },
        );
        Ok(ticket)
    }
    pub fn active(&self, ticket: &Ticket) -> Option<&ActiveTurn> {
        self.active
            .get(&ticket.session.name)
            .filter(|entry| entry.ticket == *ticket)
    }
    pub fn by_name(&self, name: &str) -> Option<&ActiveTurn> {
        self.active.get(name)
    }
    pub fn active_count(&self) -> usize {
        self.active.len()
    }
    pub fn finished_count(&self) -> usize {
        self.finished.len()
    }
    pub fn result(&self, ticket: &Ticket) -> Option<&FinishedTurn> {
        self.finished.iter().find(|entry| entry.ticket == *ticket)
    }
    fn current_mut(&mut self, ticket: &Ticket) -> Option<&mut ActiveTurn> {
        self.active
            .get_mut(&ticket.session.name)
            .filter(|entry| entry.ticket == *ticket)
    }
    /// Only an explicit narrowing is allowed after reservation. Model/effort/
    /// browser remain frozen. Inherit has unknown privileges and is never a
    /// target of a narrowing from another mode.
    pub fn restrict_before_start(&mut self, ticket: &Ticket, approval: Approval) -> Result<Change> {
        let Some(entry) = self.current_mut(ticket) else {
            return Ok(Change::Stale);
        };
        if entry.dispatched || entry.cancel_requested {
            return Err(error(
                ErrorCode::Transition,
                "turn settings are already applied or cancelling",
            ));
        }
        let old = entry.snapshot.settings.approval;
        let allowed = old == approval
            || match old {
                Approval::Full => matches!(
                    approval,
                    Approval::Workspace | Approval::Ask | Approval::ReadOnly
                ),
                Approval::Workspace => matches!(approval, Approval::Ask | Approval::ReadOnly),
                Approval::Ask => approval == Approval::ReadOnly,
                Approval::Inherit => false,
                Approval::ReadOnly => false,
            };
        if !allowed {
            return Err(error(
                ErrorCode::Invalid,
                "turn approval cannot be expanded",
            ));
        }
        if old == approval {
            return Ok(Change::Unchanged);
        }
        entry.snapshot.settings.approval = approval;
        Ok(Change::Applied)
    }
    /// Seal the exact settings sent to the adapter. The driver must use this
    /// returned copy for start IO, rather than an earlier diagnostic snapshot.
    pub fn dispatch_start(&mut self, ticket: &Ticket) -> Result<DispatchAction> {
        let Some(entry) = self.current_mut(ticket) else {
            return Ok(DispatchAction::Stale);
        };
        if entry.cancel_requested {
            return Ok(DispatchAction::Cancelled);
        }
        if entry.dispatched {
            return Err(error(
                ErrorCode::Transition,
                "turn start was already dispatched",
            ));
        }
        entry.dispatched = true;
        Ok(DispatchAction::Proceed(entry.snapshot.clone()))
    }
    /// Call only after a successful adapter start reply and after checking an
    /// already-failed outcome. This is not a durable queue/question receipt.
    pub fn provider_started(
        &mut self,
        ticket: &Ticket,
        provider_turn_id: &str,
    ) -> Result<StartAction> {
        let Some(entry) = self.current_mut(ticket) else {
            return Ok(StartAction::Stale);
        };
        if provider_turn_id.is_empty()
            || provider_turn_id.len() > 256
            || provider_turn_id.chars().any(char::is_control)
        {
            return Err(error(ErrorCode::Invalid, "invalid provider turn id"));
        }
        if !entry.dispatched {
            return Err(error(
                ErrorCode::Transition,
                "turn start has not been dispatched",
            ));
        }
        if entry.provider_turn_id.is_some() {
            return Err(error(
                ErrorCode::Transition,
                "turn already has a provider start reply",
            ));
        }
        entry.provider_turn_id = Some(provider_turn_id.to_owned());
        Ok(if entry.cancel_requested {
            StartAction::CancelProvider
        } else {
            StartAction::Proceed
        })
    }
    pub fn request_cancel(&mut self, ticket: &Ticket) -> Change {
        let Some(entry) = self.current_mut(ticket) else {
            return Change::Stale;
        };
        if entry.cancel_requested {
            return Change::Unchanged;
        }
        entry.cancel_requested = true;
        Change::Applied
    }
    /// Adapter resume/start failed before acknowledgement. The driver must have
    /// closed any partially-created worker before releasing this reservation.
    pub fn start_failed(&mut self, ticket: &Ticket, outcome: Outcome) -> Result<Change> {
        let Some(entry) = self.active(ticket) else {
            return Ok(Change::Stale);
        };
        if entry.provider_turn_id.is_some() || !matches!(outcome, Outcome::Failure { .. }) {
            return Err(error(
                ErrorCode::Transition,
                "start failure requires an unacknowledged failed turn",
            ));
        }
        outcome.validate()?;
        self.retire(ticket, outcome);
        Ok(Change::Applied)
    }
    /// A final adapter outcome is authoritative even if a cancellation raced
    /// with natural completion. It must also mean this turn is no longer live;
    /// background worker ownership is a separate adapter responsibility.
    pub fn complete(&mut self, ticket: &Ticket, outcome: Outcome) -> Result<Change> {
        let Some(entry) = self.active(ticket) else {
            return Ok(Change::Stale);
        };
        if entry.provider_turn_id.is_none() {
            return Err(error(
                ErrorCode::Transition,
                "cannot complete before a provider start reply",
            ));
        }
        outcome.validate()?;
        self.retire(ticket, outcome);
        Ok(Change::Applied)
    }
    /// Explicit driver proof of shutdown, including an interrupted start. A
    /// timeout or client disconnection is NOT such proof. Until this is called
    /// (or a terminal outcome arrives), replacement/removal must stay blocked.
    pub fn stopped(&mut self, ticket: &Ticket) -> Result<Change> {
        let Some(entry) = self.active(ticket) else {
            return Ok(Change::Stale);
        };
        if !entry.cancel_requested {
            return Err(error(
                ErrorCode::Transition,
                "worker stop was not requested",
            ));
        }
        self.retire(ticket, Outcome::Interrupted);
        Ok(Change::Applied)
    }
    fn retire(&mut self, ticket: &Ticket, outcome: Outcome) {
        let entry = self
            .active
            .remove(&ticket.session.name)
            .expect("current ticket checked");
        if self.limits.finished > 0 {
            if self.finished.len() == self.limits.finished {
                self.finished.pop_front();
            }
            self.finished.push_back(FinishedTurn {
                ticket: entry.ticket,
                provider_turn_id: entry.provider_turn_id,
                outcome,
                cancel_requested: entry.cancel_requested,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_snapshot::{Provider, SessionKey, TurnSettings};
    fn snapshot(name: &str) -> TurnSnapshot {
        TurnSnapshot {
            key: SessionKey {
                name: name.into(),
                created_at: "2026-11-11T00:00:00Z".into(),
            },
            provider: Provider::Codex,
            cwd: "/tmp/project".into(),
            settings: TurnSettings {
                model: None,
                effort: None,
                service_tier: None,
                approval: Approval::Ask,
                browser: None,
            },
        }
    }
    fn failure() -> Outcome {
        Outcome::Failure {
            code: "provider_unavailable".into(),
            message: "fixture failure".into(),
        }
    }
    #[test]
    fn attempt_counter_never_wraps_or_reuses_a_ticket() {
        let mut core = Coordinator::new(Limits::default()).unwrap();
        core.next_attempt = MAX_ATTEMPT;
        let final_ticket = core.reserve(snapshot("last")).unwrap();
        assert_eq!(final_ticket.attempt(), MAX_ATTEMPT);
        core.start_failed(&final_ticket, failure()).unwrap();
        assert_eq!(
            core.reserve(snapshot("next")).unwrap_err().code,
            ErrorCode::Exhausted
        );
        assert_eq!(core.active_count(), 0);
        assert_eq!(core.result(&final_ticket).unwrap().outcome, failure());
    }
    #[test]
    fn invalid_inputs_and_invalid_transitions_never_release_the_slot() {
        let mut core = Coordinator::new(Limits::default()).unwrap();
        let ticket = core.reserve(snapshot("one")).unwrap();
        for id in ["", "\n", "x\rnext"] {
            assert_eq!(
                core.provider_started(&ticket, id).unwrap_err().code,
                ErrorCode::Invalid
            );
        }
        assert_eq!(
            core.provider_started(&ticket, "valid-but-not-dispatched")
                .unwrap_err()
                .code,
            ErrorCode::Transition
        );
        assert_eq!(
            core.complete(&ticket, Outcome::Success).unwrap_err().code,
            ErrorCode::Transition
        );
        assert_eq!(
            core.stopped(&ticket).unwrap_err().code,
            ErrorCode::Transition
        );
        assert_eq!(
            core.start_failed(&ticket, Outcome::Success)
                .unwrap_err()
                .code,
            ErrorCode::Transition
        );
        assert_eq!(core.active(&ticket).unwrap().phase(), Phase::Starting);
        let huge = Outcome::Failure {
            code: "invalid space".into(),
            message: "x".repeat(16385),
        };
        assert_eq!(
            core.start_failed(&ticket, huge).unwrap_err().code,
            ErrorCode::Invalid
        );
        core.dispatch_start(&ticket).unwrap();
        assert_eq!(
            core.dispatch_start(&ticket).unwrap_err().code,
            ErrorCode::Transition
        );
        assert_eq!(core.active(&ticket).unwrap().phase(), Phase::Dispatching);
        core.provider_started(&ticket, "turn").unwrap();
        assert_eq!(
            core.start_failed(&ticket, failure()).unwrap_err().code,
            ErrorCode::Transition
        );
        assert_eq!(
            core.provider_started(&ticket, "turn").unwrap_err().code,
            ErrorCode::Transition
        );
        let huge = Outcome::Failure {
            code: "error".into(),
            message: "🌊".repeat(4097),
        };
        assert_eq!(
            core.complete(&ticket, huge).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert_eq!(core.active(&ticket).unwrap().phase(), Phase::Running);
    }
    #[test]
    fn limits_are_validated_and_zero_retention_still_prevents_replay() {
        for limits in [
            Limits {
                active: 0,
                finished: 1,
            },
            Limits {
                active: 4097,
                finished: 1,
            },
            Limits {
                active: 1,
                finished: 4097,
            },
        ] {
            assert!(Coordinator::new(limits).is_err());
        }
        let mut core = Coordinator::new(Limits {
            active: 1,
            finished: 0,
        })
        .unwrap();
        let old = core.reserve(snapshot("one")).unwrap();
        core.start_failed(&old, failure()).unwrap();
        assert!(core.result(&old).is_none());
        let new = core.reserve(snapshot("one")).unwrap();
        assert_ne!(old, new);
        assert_eq!(core.start_failed(&old, failure()).unwrap(), Change::Stale);
        assert!(core.active(&new).is_some());
    }
}
