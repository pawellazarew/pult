//! Owned shared-Inbox native permission bridge. No native/JSON consent constructor.
use crate::{
    permission_broker::{Decision, Offers, PermissionRequest, Scope},
    turn_coordinator::Ticket,
    turn_driver::{Progress, Task, WorkerError},
    turn_snapshot::SessionKey,
    zcode_appserver_protocol::{NativePermissionPayload, ReverseRequest},
    zcode_appserver_worker::{
        BoundReverseReply, NativeInteractions, NativePending, ReverseContext,
    },
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex, Weak},
    time::Instant,
};
use tokio::{
    sync::{Semaphore, oneshot, watch},
    task::JoinHandle,
};
fn unavailable() -> WorkerError {
    WorkerError {
        code: "access_changed".into(),
        message: "Native permission unavailable".into(),
    }
}
fn unknown() -> WorkerError {
    WorkerError {
        code: "cleanup_unconfirmed".into(),
        message: "Native permission cleanup is unconfirmed".into(),
    }
}

/// One daemon service; only weak State, never a second Broker or Runtime owner.
pub(crate) struct Service {
    state: Weak<crate::State>,
    slots: Arc<Semaphore>,
    #[cfg(test)]
    hooks: tests::Hooks,
}
impl Service {
    pub(crate) fn new(state: Weak<crate::State>) -> Arc<Self> {
        Arc::new(Self {
            state,
            slots: Arc::new(Semaphore::new(32)),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        })
    }
    pub(crate) fn slots(&self) -> Arc<Semaphore> {
        self.slots.clone()
    }
    #[cfg(test)]
    pub(crate) fn before_native_binder(&self) {
        self.hooks.before_binder();
    }
    pub(crate) fn scoped(self: &Arc<Self>, key: SessionKey) -> Arc<dyn NativeInteractions> {
        let adapter = Arc::new_cyclic(|myself| Adapter {
            myself: myself.clone(),
            service: self.clone(),
            key,
            state: Mutex::new(AdapterState {
                bound: None,
                closed: false,
                preclosed: false,
                tombstones: Vec::new(),
                jobs: Vec::new(),
                drain: None,
            }),
        });
        #[cfg(test)]
        self.hooks.bind_adapter(&adapter);
        adapter
    }
}
struct Adapter {
    myself: Weak<Adapter>,
    service: Arc<Service>,
    key: SessionKey,
    state: Mutex<AdapterState>,
}
struct AdapterState {
    bound: Option<(Ticket, u64)>,
    closed: bool,
    preclosed: bool,
    tombstones: Vec<(Ticket, u64)>,
    jobs: Vec<Arc<QuestionJob>>,
    drain: Option<watch::Sender<DrainState>>,
}
#[derive(Clone, Copy)]
enum DrainState {
    Pending,
    Known,
    Unknown,
}
struct QuestionJob {
    ticket: Ticket,
    generation: u64,
    pending: Mutex<Option<Arc<NativePending>>>,
    cancel: watch::Sender<bool>,
    closed: watch::Sender<DrainState>,
    handle: Mutex<Option<JoinHandle<()>>>,
}
impl QuestionJob {
    fn cancel(&self) {
        self.cancel.send_replace(true);
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(pending) = pending {
            pending.revoke();
        }
    }
}
struct Waiter {
    job: Arc<QuestionJob>,
    armed: bool,
}
impl Waiter {
    fn disarm(&mut self) {
        self.armed = false;
    }
}
impl Drop for Waiter {
    fn drop(&mut self) {
        if self.armed {
            self.job.cancel();
        }
    }
}
/// Can only be minted below after the actual Broker handle delivered and drained.
/// No Debug/Clone/serde/Value/Decision constructor or public grant API.
pub(crate) struct NativeApprovalReceipt {
    pending: Arc<NativePending>,
    _question_id: String,
}
impl NativeApprovalReceipt {
    pub(crate) fn pending(&self) -> &Arc<NativePending> {
        &self.pending
    }
}

fn live(state: &crate::State, pending: &NativePending) -> bool {
    if *state.stop.borrow()
        || crate::runtime_state::unavailable(state)
        || !pending.valid()
        || pending
            .expires
            .get()
            .is_none_or(|expiry| Instant::now() >= *expiry)
    {
        return false;
    }
    let Some(source) = pending.source.get() else {
        return false;
    };
    state.driver.get().is_some_and(|driver| {
        driver.snapshot_for_dispatch(&pending.ticket).as_ref()==Some(source.initial())
            && driver.progress_for_ticket(&pending.ticket).is_some_and(|progress|
                matches!(&*progress.borrow(),Progress::Running(a) if a==source.accepted()))
    })
}
fn display(request: &ReverseRequest) -> Result<Value, WorkerError> {
    let ReverseRequest::Permission {
        payload: NativePermissionPayload::Retained(data),
        ..
    } = request
    else {
        return Err(unavailable());
    };
    if data.untrusted_turn_id().is_none() || data.untrusted_origin().is_some() {
        return Err(unavailable());
    }
    let options: Value =
        serde_json::from_str(data.untrusted_options().get()).map_err(|_| unavailable())?;
    let once = options.as_array().is_some_and(|options| {
        options.iter().any(|option| {
            matches!(option["kind"].as_str(), Some("allow_once" | "allow"))
                && option["response"].as_object().is_some_and(|response| {
                    response.get("decision").and_then(Value::as_str) == Some("allow")
                        && response
                            .keys()
                            .all(|k| matches!(k.as_str(), "decision" | "reason"))
                })
        })
    });
    if !once {
        return Err(unavailable());
    }
    let input: Value =
        serde_json::from_str(data.untrusted_input().get()).map_err(|_| unavailable())?;
    let value = json!({"nativeToolName":data.untrusted_tool_name(),"toolCallId":data.untrusted_tool_call_id(),
        "reason":data.untrusted_reason(),"riskLevel":data.untrusted_risk_level(),"input":input});
    let mut nodes = 0usize;
    let mut stack = vec![&value];
    while let Some(v) = stack.pop() {
        nodes += 1;
        if nodes > 4096 {
            return Err(unavailable());
        }
        match v {
            Value::Array(a) => stack.extend(a),
            Value::Object(o) => stack.extend(o.values()),
            _ => {}
        }
    }
    // Checked BEFORE Broker retains/redacts/clones the display input. Original
    // request remains one bounded immutable raw backing; no partial input.
    if serde_json::to_vec(&value).map_err(|_| unavailable())?.len()
        > crate::permission_broker::MAX_INPUT_BYTES
        || crate::redaction::contains_memory_capability(&value)
    {
        return Err(unavailable());
    }
    Ok(value)
}
async fn question(
    state: Arc<crate::State>,
    pending: Arc<NativePending>,
    job: Arc<QuestionJob>,
    service: Arc<Service>,
) -> Result<BoundReverseReply, WorkerError> {
    #[cfg(not(test))]
    let _ = service;
    let deny = || BoundReverseReply::default_deny(&pending.request);
    if !live(&state, &pending) {
        return deny();
    }
    let input = match display(&pending.request) {
        Ok(input) => input,
        Err(_) => return deny(),
    };
    if !live(&state, &pending) {
        return deny();
    }
    let ReverseRequest::Permission {
        payload: NativePermissionPayload::Retained(data),
        ..
    } = &*pending.request
    else {
        return deny();
    };
    let mut progress = state
        .driver
        .get()
        .and_then(|d| d.progress_for_ticket(&pending.ticket))
        .ok_or_else(unavailable)?;
    let expires = *pending.expires.get().ok_or_else(unavailable)?;
    #[cfg(test)]
    service.hooks.before_request(&pending).await;
    let mut handle = crate::permission_state::request(
        &state,
        PermissionRequest {
            session_id: pending.ticket.session().name.clone(),
            tool_name: "ZCodePermission".into(),
            tool_use_id: Some(data.untrusted_tool_call_id()),
            input,
            offers: Offers::default(),
            concealed: false,
        },
    )
    .map_err(|_| unavailable())?;
    let question_id = handle.id().to_owned();
    #[cfg(test)]
    {
        service.hooks.after_request().await;
        service.hooks.after_issuance();
    }
    let mut cancel = job.cancel.subscribe();
    let mut stop = state.stop.subscribe();
    let decision = {
        let decision = handle.decision();
        tokio::pin!(decision);
        loop {
            let changed = pending.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if *cancel.borrow() || !live(&state, &pending) {
                break None;
            }
            tokio::select! {
                result=&mut decision=>break Some(result),
                _=changed=>{},_=cancel.changed()=>{},_=stop.changed()=>{},
                r=progress.changed()=>if r.is_err(){break None;},
                _=tokio::time::sleep_until(expires.into())=>break None,
            }
        }
    };
    // Regular Broker approvals normalize absent edits to Some(original input).
    // Compare the deterministic immutable display value, then drop BOTH decision
    // and comparison value before any further await. Equal normalization cannot
    // change the native request; any semantic edit remains unsupported.
    let once = match decision {
        Some(Decision::Allow {
            scope: Scope::Once,
            updated_input,
            answers: None,
        }) => updated_input.is_none_or(|updated| {
            display(&pending.request).is_ok_and(|original| updated == original)
        }),
        _ => false,
    };
    // These actual requested/resolved writes remain owned even after timeout or
    // waiter Drop. Decision alone is not known cleanup or native permission.
    handle.cancel();
    handle.drained().await;
    if !live(&state, &pending) || *cancel.borrow() || !once {
        return deny();
    }
    Ok(BoundReverseReply::approved_once(NativeApprovalReceipt {
        pending,
        _question_id: question_id,
    }))
}
impl NativeInteractions for Adapter {
    fn handle(
        &self,
        context: ReverseContext,
        request: Arc<ReverseRequest>,
    ) -> Task<Result<BoundReverseReply, WorkerError>> {
        let Some(pending) = context.pending else {
            return Box::pin(async move { BoundReverseReply::default_deny(&request) });
        };
        if !Arc::ptr_eq(&request, &pending.request)
            || pending.ticket != context.ticket
            || pending.generation != context.generation
            || pending.ticket.session() != &self.key
        {
            return Box::pin(async { Err(unavailable()) });
        }
        let setup = (|| {
            let state = self.service.state.upgrade().ok_or_else(unavailable)?;
            if !live(&state, &pending) {
                return Err(unavailable());
            }
            let mut scope = self.state.lock().map_err(|_| unknown())?;
            let key = (context.ticket.clone(), context.generation);
            if scope.preclosed
                || scope.closed
                || scope.tombstones.contains(&key)
                || scope.bound.as_ref().is_some_and(|bound| bound != &key)
            {
                return Err(unavailable());
            }
            scope.bound = Some(key);
            // Only completed jobs with a consumed actual JoinHandle can be
            // discarded. Unknown remains sticky; no arbitrary retry cleanup.
            if scope.jobs.len() >= 128 {
                return Err(unavailable());
            }
            let job = Arc::new(QuestionJob {
                ticket: context.ticket,
                generation: context.generation,
                pending: Mutex::new(Some(pending.clone())),
                cancel: watch::channel(false).0,
                closed: watch::channel(DrainState::Pending).0,
                handle: Mutex::new(None),
            });
            let (start, begin) = oneshot::channel();
            let (send, receive) = oneshot::channel();
            let running = job.clone();
            let service = self.service.clone();
            let tracked = state.host_jobs.track();
            let monitor = tokio::spawn(async move {
                if begin.await.is_err() {
                    running.closed.send_replace(DrainState::Unknown);
                    return;
                }
                let owned = running.clone();
                let result = tokio::spawn(async move {
                    let _tracked = tracked;
                    question(state, pending, owned, service).await
                })
                .await;
                match result {
                    Ok(result) => {
                        // Actual question cancel+drained completed. An approved
                        // receipt or its Worker still pins this same call until
                        // handoff; on Unknown below we retain the strong pin.
                        running
                            .pending
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .take();
                        running.closed.send_replace(DrainState::Known);
                        let _ = send.send(result);
                    }
                    Err(_) => {
                        running.closed.send_replace(DrainState::Unknown);
                        let _ = send.send(Err(unknown()));
                    }
                }
            });
            *job.handle.lock().map_err(|_| unknown())? = Some(monitor);
            scope.jobs.push(job.clone()); // registered BEFORE the owned body starts
            Ok((job, start, receive))
        })();
        match setup {
            Err(e) => Box::pin(async move { Err(e) }),
            Ok((job, start, receive)) => {
                let _ = start.send(());
                let waiter = Waiter { job, armed: true };
                Box::pin(async move {
                    let mut waiter = waiter;
                    let result = receive.await.unwrap_or(Err(unknown()));
                    waiter.disarm();
                    result
                })
            }
        }
    }
    fn revoke(&self, ticket: &Ticket, generation: u64) {
        let controls = {
            let mut scope = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let key = (ticket.clone(), generation);
            if scope.bound.as_ref().is_some_and(|bound| bound != &key) {
                return;
            }
            if scope.bound.is_none() {
                if ticket.session() == &self.key
                    && generation > 0
                    && !scope.tombstones.contains(&key)
                {
                    if scope.tombstones.len() < 8 {
                        scope.tombstones.push(key);
                    } else {
                        scope.preclosed = true;
                    }
                }
            } else {
                scope.closed = true;
            }
            scope
                .jobs
                .iter()
                .filter(|j| &j.ticket == ticket && j.generation == generation)
                .cloned()
                .collect::<Vec<_>>()
        };
        for job in controls {
            job.cancel();
        }
    }
    fn drain(&self, ticket: Ticket, generation: u64) -> Task<Result<(), WorkerError>> {
        self.revoke(&ticket, generation);
        let setup = (|| {
            let adapter = self.myself.upgrade().ok_or_else(unknown)?;
            let mut scope = self.state.lock().map_err(|_| unknown())?;
            let key = (ticket.clone(), generation);
            if scope.bound.as_ref().is_none_or(|bound| bound != &key) {
                return Ok(None);
            }
            if let Some(done) = &scope.drain {
                return Ok(Some(done.subscribe()));
            }
            let (done, watching) = watch::channel(DrainState::Pending);
            scope.drain = Some(done.clone());
            let jobs = scope.jobs.clone();
            let (start, begin) = oneshot::channel();
            // Retained by the runtime task itself; all waiters can be dropped.
            tokio::spawn(async move {
                let _ = begin.await;
                let mut known = true;
                for job in jobs {
                    let handle = job
                        .handle
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .take();
                    if let Some(handle) = handle
                        && handle.await.is_err()
                    {
                        known = false;
                    }
                    if !matches!(*job.closed.borrow(), DrainState::Known) {
                        known = false;
                    }
                }
                adapter.revoke(&ticket, generation);
                done.send_replace(if known {
                    DrainState::Known
                } else {
                    DrainState::Unknown
                });
            });
            let _ = start.send(());
            Ok(Some(watching))
        })();
        Box::pin(async move {
            let Some(mut watching) = setup? else {
                return Ok(());
            };
            loop {
                let status = *watching.borrow_and_update();
                match status {
                    DrainState::Known => return Ok(()),
                    DrainState::Unknown => return Err(unknown()),
                    DrainState::Pending => {}
                }
                if watching.changed().await.is_err() {
                    return Err(unknown());
                }
            }
        })
    }
}

#[cfg(test)]
#[path = "zcode_native_permissions_tests.rs"]
pub(crate) mod tests;
