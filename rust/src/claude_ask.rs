//! Exact-ticket permission credentials for a retired-after-turn Claude process.
//! Host code issues credentials; RPC can only use one to ask, never to resolve.
//! This does not authorize warm reuse of a credential for another native input.
use crate::{
    State,
    claude_worker::McpContext,
    permission_broker::{Decision, Offers, PermissionRequest, Scope},
    turn_coordinator::Ticket,
    turn_driver::{Accepted, DispatchDecision, DispatchGate, Progress, Task, WorkerError},
    turn_snapshot::{Provider, TurnSnapshot},
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, oneshot, watch};

const MAX_TURNS: usize = 64;
const MAX_CALLS: usize = 16;
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(600);
pub(crate) const METHODS: [&str; 1] = ["perm.request"];
fn denied() -> WorkerError {
    WorkerError {
        code: "forbidden".into(),
        message: "permission turn authority is unavailable".into(),
    }
}
fn deny() -> Value {
    json!({"behavior":"deny","message":"pult: permission turn is unavailable"})
}
pub(crate) fn valid_key(key: &str) -> bool {
    key.strip_prefix("pa_")
        .is_some_and(|raw| raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn secret() -> Result<String, WorkerError> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| denied())?;
    Ok(format!(
        "pa_{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}
struct Control {
    context: McpContext,
    snapshot: TurnSnapshot,
    key: String,
    gate: Arc<dyn DispatchGate>,
    progress: watch::Receiver<Progress>,
    active: Mutex<bool>,
    jobs: AtomicUsize,
    calls: Arc<Semaphore>,
    changed: Notify,
    issued: AtomicBool,
}
impl Control {
    fn valid(&self) -> bool {
        self.active.lock().is_ok_and(|active| *active)
    }
    fn revoke(&self) {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = false;
        self.changed.notify_waiters();
    }
    fn admit(self: &Arc<Self>) -> Result<Job, WorkerError> {
        let active = self.active.lock().map_err(|_| denied())?;
        if !*active {
            return Err(denied());
        }
        let permit = self
            .calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| denied())?;
        self.jobs.fetch_add(1, Ordering::AcqRel);
        Ok(Job {
            control: self.clone(),
            _permit: permit,
        })
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
struct Cancel(watch::Sender<bool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}
struct PreparationWait(Option<Arc<Control>>);
impl Drop for PreparationWait {
    fn drop(&mut self) {
        if let Some(control) = &self.0 {
            control.revoke();
        }
    }
}
#[derive(Clone)]
pub(crate) struct Lease(Arc<Control>);
/// A secret-bearing host result; deliberately has no Debug/Serialize impl.
pub struct Prepared {
    key: String,
}
impl Prepared {
    pub fn key(&self) -> &str {
        &self.key
    }
}
pub struct Backend {
    state: Weak<State>,
    controls: Mutex<Vec<Arc<Control>>>,
}
impl Backend {
    pub(crate) fn new(state: Weak<State>) -> Arc<Self> {
        Arc::new(Self {
            state,
            controls: Mutex::new(Vec::new()),
        })
    }
    pub(crate) fn host_resources(
        &self,
    ) -> Option<(std::path::PathBuf, Arc<crate::host_jobs::Tracker>)> {
        let state = self.state.upgrade()?;
        Some((state.home.clone(), state.host_jobs.clone()))
    }
    /// Host-only issuance. Caller must retain the exact ticket until drain.
    /// A caller disappearing cannot abandon the owned authorization work.
    pub fn prepare(
        self: &Arc<Self>,
        context: McpContext,
        gate: Arc<dyn DispatchGate>,
    ) -> Task<Result<Prepared, WorkerError>> {
        let Some(state) = self.state.upgrade() else {
            return Box::pin(async { Err(denied()) });
        };
        // Reserve synchronously before the first offloaded callback. A concurrent
        // revoke/drain must see pending issuance and retain its owned job too.
        let reserved = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let driver = state.driver.get().ok_or_else(denied)?;
            let snapshot = driver
                .snapshot_for_dispatch(&context.ticket)
                .ok_or_else(denied)?;
            let progress = driver
                .progress_for_ticket(&context.ticket)
                .ok_or_else(denied)?;
            if context.session != *context.ticket.session()
                || context.session != snapshot.key
                || snapshot.provider != Provider::Claude
                || context.generation == 0
                || context.public_turn.is_empty()
                || context.public_turn.len() > 512
                || context.public_turn.chars().any(char::is_control)
                || driver
                    .public_turn_id(&context.ticket)
                    .is_some_and(|id| id != context.public_turn)
            {
                return Err(denied());
            }
            let control = Arc::new(Control {
                context,
                snapshot,
                key: secret()?,
                gate,
                progress,
                active: Mutex::new(true),
                jobs: AtomicUsize::new(0),
                calls: Arc::new(Semaphore::new(MAX_CALLS)),
                changed: Notify::new(),
                issued: AtomicBool::new(false),
            });
            let mut controls = self.controls.lock().map_err(|_| denied())?;
            if controls.len() >= MAX_TURNS
                || controls
                    .iter()
                    .any(|other| other.context.ticket == control.context.ticket)
            {
                return Err(denied());
            }
            let _admission = state.execution_admission.lock().map_err(|_| denied())?;
            Self::live(&state, &control)?;
            let job = control.admit()?;
            controls.push(control.clone());
            Ok((control, job))
        }))
        .unwrap_or_else(|_| Err(denied()));
        let (control, job) = match reserved {
            Ok(reserved) => reserved,
            Err(error) => return Box::pin(async { Err(error) }),
        };
        let waiting = PreparationWait(Some(control.clone()));
        let tracked = state.host_jobs.track();
        let (send, receive) = oneshot::channel();
        tokio::task::spawn_blocking(move || {
            let _tracked = tracked;
            let _job = job;
            let result = (|| {
                Self::verify(&state, &control)?;
                let _admission = state.execution_admission.lock().map_err(|_| denied())?;
                Self::live(&state, &control)?;
                let active = control.active.lock().map_err(|_| denied())?;
                if !*active {
                    return Err(denied());
                }
                control.issued.store(true, Ordering::Release);
                Ok(Prepared {
                    key: control.key.clone(),
                })
            })();
            if result.is_err() {
                control.revoke();
            }
            if send.send(result).is_err() {
                control.revoke();
            }
        });
        Box::pin(async move {
            let mut waiting = waiting;
            let result = receive.await.unwrap_or_else(|_| Err(denied()));
            if result.is_ok() {
                waiting.0 = None;
            }
            result
        })
    }
    pub(crate) fn lookup(&self, key: &str) -> Option<Lease> {
        if !valid_key(key) {
            return None;
        }
        let controls = self.controls.lock().ok()?;
        let mut found = None;
        for control in controls.iter() {
            if bool::from(control.key.as_bytes().ct_eq(key.as_bytes()))
                && control.valid()
                && control.issued.load(Ordering::Acquire)
            {
                found = Some(Lease(control.clone()));
            }
        }
        found
    }
    pub fn revoke(&self, ticket: &Ticket, generation: u64) {
        if let Some(control) = self.control(ticket, generation) {
            control.revoke();
        }
    }
    fn control(&self, ticket: &Ticket, generation: u64) -> Option<Arc<Control>> {
        self.controls
            .lock()
            .ok()?
            .iter()
            .find(|control| {
                control.context.ticket == *ticket && control.context.generation == generation
            })
            .cloned()
    }
    pub fn drain(
        self: &Arc<Self>,
        ticket: Ticket,
        generation: u64,
    ) -> Task<Result<(), WorkerError>> {
        let backend = self.clone();
        Box::pin(async move {
            let Some(control) = backend.control(&ticket, generation) else {
                return Ok(());
            };
            control.revoke();
            loop {
                let changed = control.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if control.jobs.load(Ordering::Acquire) == 0 {
                    break;
                }
                changed.await;
            }
            let mut controls = backend.controls.lock().map_err(|_| denied())?;
            controls.retain(|current| !Arc::ptr_eq(current, &control));

            control.changed.notify_waiters();
            Ok(())
        })
    }
    fn live(state: &State, control: &Control) -> Result<(), WorkerError> {
        // A poisoned Driver query must deny inside the owned scope, not unwind
        // past the RequestHandle and abandon its pending journal cleanup.
        let live = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            !*state.stop.borrow()
                && !crate::runtime_state::unavailable(state)
                && control.valid()
                && state
                    .driver
                    .get()
                    .and_then(|driver| driver.snapshot_for_dispatch(&control.context.ticket))
                    .as_ref()
                    == Some(&control.snapshot)
        }))
        .unwrap_or(false);
        if !live {
            return Err(denied());
        }
        Ok(())
    }
    fn verify(state: &State, control: &Control) -> Result<(), WorkerError> {
        Self::live(state, control)?;
        let allowed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match control
                .gate
                .check(&control.context.ticket, &control.snapshot)
            {
                DispatchDecision::Allow => true,
                DispatchDecision::Restrict(approval) => approval == control.context.approval,
                DispatchDecision::Deny => false,
            }
        }))
        .unwrap_or(false);
        if !allowed {
            return Err(denied());
        }
        Self::live(state, control)
    }
    async fn checked(state: Arc<State>, control: Arc<Control>) -> Result<(), WorkerError> {
        let tracked = state.host_jobs.track();
        tokio::task::spawn_blocking(move || {
            let _tracked = tracked;
            Self::verify(&state, &control)
        })
        .await
        .unwrap_or_else(|_| Err(denied()))
    }
    /// Starts an owned question immediately; dropping the returned future revokes
    /// just this call. Exact broker IO is still drained before the job releases.
    pub(crate) fn call(
        self: &Arc<Self>,
        lease: Lease,
        params: Value,
    ) -> Task<Result<Value, WorkerError>> {
        let control = lease.0;
        let job = match control.admit() {
            Ok(job) => job,
            Err(error) => return Box::pin(async { Err(error) }),
        };
        let Some(state) = self.state.upgrade() else {
            return Box::pin(async { Err(denied()) });
        };
        let tracked = state.host_jobs.track();
        let (cancel, cancelled) = watch::channel(false);
        let cancel = Cancel(cancel);
        let (send, receive) = oneshot::channel();
        tokio::spawn(async move {
            let _job = job;
            let _tracked = tracked;
            let result = Self::question(
                state,
                control,
                params,
                cancelled,
                tokio::time::Instant::now() + DEADLINE,
            )
            .await;
            let _ = send.send(result);
        });
        Box::pin(async move {
            let _cancel = cancel;
            receive.await.unwrap_or_else(|_| Err(denied()))
        })
    }
    async fn question(
        state: Arc<State>,
        control: Arc<Control>,
        params: Value,
        mut cancelled: watch::Receiver<bool>,
        expires: tokio::time::Instant,
    ) -> Result<Value, WorkerError> {
        if !params.is_object()
            || crate::redaction::contains_memory_capability(&params)
            || params
                .get("sessionId")
                .is_some_and(|id| id.as_str() != Some(&control.context.session.name))
        {
            return Err(denied());
        }
        let tool = params["toolName"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
            .ok_or_else(denied)?
            .to_owned();
        let input = params
            .get("input")
            .filter(|value| value.is_object())
            .ok_or_else(denied)?
            .clone();
        let tool_use_id = match params.get("toolUseId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id))
                if !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control) =>
            {
                Some(id.clone())
            }
            _ => return Err(denied()),
        };
        let deadline = tokio::time::sleep_until(expires);
        tokio::pin!(deadline);
        let mut progress = control.progress.clone();
        // No synthetic source receipt: a pre-ack callback waits for this exact
        // input's real Driver acceptance or cancellation/start timeout.
        let accepted = loop {
            let changed = control.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if *cancelled.borrow() {
                return Ok(deny());
            }
            Self::live(&state, &control)?;
            match progress.borrow_and_update().clone() {
                Progress::Running(accepted)
                    if accepted.user_event_id > 0
                        && accepted.turn_id == control.context.public_turn =>
                {
                    break accepted;
                }
                Progress::Starting => {}
                _ => return Ok(deny()),
            }
            tokio::select! { _ = changed => {}, _ = cancelled.changed() => {}, _ = &mut deadline => return Ok(deny()), result = progress.changed() => { if result.is_err() { return Ok(deny()); } } }
        };
        Self::checked(state.clone(), control.clone()).await?;
        if *cancelled.borrow() || tokio::time::Instant::now() >= expires {
            return Ok(deny());
        }
        let mut question = crate::permission_state::request(
            &state,
            PermissionRequest {
                session_id: control.context.session.name.clone(),
                tool_name: tool,
                tool_use_id,
                input,
                offers: Offers::default(),
                concealed: false,
            },
        )
        .map_err(|_| denied())?;
        let decision = {
            let decision = question.decision();
            tokio::pin!(decision);
            loop {
                let changed = control.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if *cancelled.borrow()
                    || Self::live(&state, &control).is_err()
                    || !same_receipt(&progress, &accepted)
                {
                    break None;
                }
                tokio::select! { result = &mut decision => break Some(result), _ = changed => {}, _ = cancelled.changed() => {}, _ = &mut deadline => break None, result = progress.changed() => { if result.is_err() { break None; } } }
            }
        };
        // Deliberately outside the decision deadline/cancellation scope. The
        // exact question's late journal write must not outlive its Ticket.
        question.cancel();
        question.drained().await;
        if *cancelled.borrow()
            || !same_receipt(&progress, &accepted)
            || tokio::time::Instant::now() >= expires
        {
            return Ok(deny());
        }
        Self::checked(state, control).await?;
        if tokio::time::Instant::now() >= expires {
            return Ok(deny());
        }
        Ok(match decision {
            Some(Decision::Allow {
                scope: Scope::Once,
                updated_input,
                answers: None,
            }) => {
                let mut result = json!({"behavior":"allow"});
                if let Some(input) = updated_input {
                    result["updatedInput"] = input;
                }
                result
            }
            Some(Decision::Deny { message }) => json!({"behavior":"deny","message":message}),
            _ => deny(),
        })
    }
}
fn same_receipt(progress: &watch::Receiver<Progress>, expected: &Accepted) -> bool {
    matches!(&*progress.borrow(), Progress::Running(accepted) if accepted == expected)
}

#[cfg(test)]
#[path = "claude_ask_tests.rs"]
mod tests;
