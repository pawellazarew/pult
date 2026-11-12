//! Owned ZCode Route A: one fresh process per input, argv prompt, no MCP.
//! Only typed native turn.started accepts input; session identity alone does not.
use crate::{
    prompt_attachments::{self, PromptAttachment},
    turn_coordinator::{Outcome, Ticket},
    turn_driver::{
        DispatchDecision, DispatchGate, Driver, EventSink, Progress, Started, Task, Worker,
        WorkerError,
    },
    turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot},
    worker_process::{
        Framing, Launch, Process, SpawnDenied, SpawnGate, SpawnPermit, StartingProcess,
        StderrPolicy, StopSignal,
    },
    zcode_events::{self, HostBinding, Normalizer, Signal, TrustedCallback},
    zcode_host_services::{
        Attempt, Error as StoreError, JoinedCleanup, ReserveRequest, SessionStore,
        TurnStartedEvidence,
    },
    zcode_launch::{self, ContextLanguage},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, oneshot, watch};

fn error(code: &str, message: &str) -> WorkerError {
    WorkerError {
        code: code.into(),
        message: message.into(),
    }
}
fn interrupted() -> WorkerError {
    error("interrupted", "ZCode turn was cancelled")
}
fn unavailable() -> WorkerError {
    error("provider_unavailable", "ZCode worker is unavailable")
}
fn failure(code: &str, message: &str) -> Outcome {
    Outcome::Failure {
        code: code.into(),
        message: message.into(),
    }
}
fn native_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && !s.starts_with('-') && !s.chars().any(char::is_control)
}
fn rank(a: Approval) -> u8 {
    match a {
        Approval::ReadOnly => 0,
        Approval::Ask => 1,
        Approval::Workspace => 2,
        Approval::Full | Approval::Inherit => 3,
    }
}
/// A fresh host permit must serialize host admission/route mutation across the
/// actual OS spawn and seal this exact Attempt through Driver::seal_spawn.
/// Construction runs outside all Worker locks. It must not spawn a process.
pub type SpawnGateFactory = Arc<
    dyn Fn(Attempt, TurnSnapshot, Approval) -> Result<Arc<dyn SpawnGate>, WorkerError>
        + Send
        + Sync,
>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderSignal {
    Authentication,
    Quota,
    MissingSession,
}
pub struct Services {
    pub driver: Weak<Driver>,
    pub sink: Arc<dyn EventSink>,
    pub gate: Arc<dyn DispatchGate>,
    pub store: Arc<dyn SessionStore>,
    pub spawn_gate: SpawnGateFactory,
    pub redactors: Arc<dyn Fn() -> Box<dyn zcode_events::Redactor> + Send + Sync>,
    pub fatal_storage: Arc<dyn Fn() + Send + Sync>,
    /// Evidence only; the provider controller decides its own auth latch. Never
    /// close the global Driver/Broker for a provider authentication failure.
    pub provider_signal: Arc<dyn Fn(ProviderSignal) + Send + Sync>,
}
pub struct Config {
    pub session: SessionKey,
    pub home: std::path::PathBuf,
    pub launch: Launch,
    pub attachments: Vec<PromptAttachment>,
    pub broker_context: bool,
    pub language: ContextLanguage,
    pub start_timeout: Duration,
    pub terminal_grace: Duration,
}
#[derive(Clone, Copy)]
enum Closed {
    Pending,
    Confirmed,
    Unconfirmed,
}
struct State {
    active: Option<Arc<Job>>,
    used: bool,
}
struct Inner {
    config: Config,
    services: Services,
    state: Mutex<State>,
}
struct Vault {
    starting: Option<StartingProcess>,
    process: Option<Process>,
    spawn_inflight: bool,
}
struct Job {
    deadline: Instant,
    // Ready(0) -> publication accepted(1) or locally revoked(2).
    publication: AtomicU8,
    ticket: Ticket,
    generation: u64,
    public_turn: String,
    cancel: watch::Sender<bool>,
    closed: watch::Sender<Closed>,
    retry: Notify,
    attempt: Mutex<Option<Attempt>>,
    signal: Mutex<Option<StopSignal>>,
    vault: tokio::sync::Mutex<Vault>,
    unknown_io: AtomicBool,
    // Sticky: a failed task cannot prove completion of IO it may have started.
    uncertain_io: AtomicBool,
}
impl Job {
    fn cancel(&self) {
        let _ = self
            .publication
            .compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire);
        self.cancel.send_replace(true);
        if let Some(a) = self.attempt.lock().expect("ZCode attempt").as_ref() {
            a.cancel_before_spawn();
        }
        self.stop();
        self.retry.notify_one();
    }
    fn stop(&self) {
        if let Some(s) = self.signal.lock().expect("ZCode signal").as_ref() {
            s.request_stop();
        }
    }
    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }
}
pub struct ZcodeWorker(Arc<Inner>);
impl ZcodeWorker {
    pub fn new(config: Config, services: Services) -> Result<Arc<Self>, WorkerError> {
        if config.session.validate().is_err()
            || !config.home.is_absolute()
            || config.launch.validate_shape().is_err()
            || config
                .launch
                .env
                .contains_key(std::ffi::OsStr::new("PULT_MEMORY_KEY"))
            || config.attachments.len() > prompt_attachments::MAX_PROMPT_ATTACHMENTS
            || config.start_timeout.is_zero()
            || config.start_timeout > Duration::from_secs(120)
            || config.terminal_grace.is_zero()
            || config.terminal_grace > Duration::from_secs(30)
        {
            return Err(error(
                "invalid_params",
                "invalid ZCode worker configuration",
            ));
        }
        Ok(Arc::new(Self(Arc::new(Inner {
            config,
            services,
            state: Mutex::new(State {
                active: None,
                used: false,
            }),
        }))))
    }
    /// A facade freezes one input's metadata; recreate from the owner for the next
    /// explicit input. This is neither native identity nor process cleanup proof.
    pub fn is_retired(&self) -> bool {
        self.0.state.lock().expect("ZCode state").used
    }
    pub fn begin_shutdown(&self) {
        let active = {
            let mut state = self.0.state.lock().expect("ZCode state");
            state.used = true;
            state.active.clone()
        };
        if let Some(job) = active {
            job.cancel();
        }
    }
}
impl Drop for ZcodeWorker {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}
impl Worker for ZcodeWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        text: String,
    ) -> Task<Result<Started, WorkerError>> {
        let runtime = match tokio::runtime::Handle::try_current() {
            Ok(v) => v,
            Err(_) => return Box::pin(async { Err(unavailable()) }),
        };
        if ticket.session() != &self.0.config.session
            || snapshot.key != self.0.config.session
            || snapshot.provider != Provider::Zcode
            || snapshot.cwd != self.0.config.launch.cwd
            || snapshot.settings.approval == Approval::Inherit
            || snapshot.settings.browser.is_some()
            || snapshot.validate().is_err()
        {
            return Box::pin(async { Err(error("invalid_params", "invalid ZCode turn scope")) });
        }
        let progress = match self
            .0
            .services
            .driver
            .upgrade()
            .and_then(|d| d.progress_for_ticket(&ticket))
        {
            Some(v) => v,
            None => return Box::pin(async { Err(unavailable()) }),
        };
        // Host opaque identity only: never passed as a native --session-id/--resume.
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let generation =
            match NEXT.try_update(Ordering::AcqRel, Ordering::Acquire, |v| v.checked_add(1)) {
                Ok(v) => v,
                Err(_) => return Box::pin(async { Err(unavailable()) }),
            };
        let mut random = [0u8; 8];
        if getrandom::fill(&mut random).is_err() {
            return Box::pin(async { Err(unavailable()) });
        }
        let nonce = random
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        let job = Arc::new(Job {
            deadline: Instant::now() + self.0.config.start_timeout,
            publication: AtomicU8::new(0),
            ticket,
            generation,
            public_turn: format!("zcode-turn-{nonce}-{generation}"),
            cancel: watch::channel(false).0,
            closed: watch::channel(Closed::Pending).0,
            retry: Notify::new(),
            attempt: Mutex::new(None),
            signal: Mutex::new(None),
            vault: tokio::sync::Mutex::new(Vault {
                starting: None,
                process: None,
                spawn_inflight: false,
            }),
            unknown_io: AtomicBool::new(false),
            uncertain_io: AtomicBool::new(false),
        });
        {
            let mut state = self.0.state.lock().expect("ZCode state");
            if state.used {
                return Box::pin(async {
                    Err(error(
                        "worker_retired",
                        "recreate ZCode worker from checked owner state",
                    ))
                });
            }
            state.used = true;
            state.active = Some(job.clone());
        }
        let (send, receive) = oneshot::channel();
        runtime.spawn(run(self.0.clone(), job, snapshot, text, progress, send));
        Box::pin(async move { receive.await.unwrap_or_else(|_| Err(unavailable())) })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        let job = self
            .0
            .state
            .lock()
            .expect("ZCode state")
            .active
            .clone()
            .filter(|j| j.ticket == ticket);
        Box::pin(async move {
            let Some(job) = job else {
                return Ok(());
            };
            job.cancel();
            let mut closed = job.closed.subscribe();
            loop {
                let state = *closed.borrow_and_update();
                match state {
                    Closed::Confirmed => return Ok(()),
                    Closed::Unconfirmed => {
                        return Err(error("cleanup_unconfirmed", "ZCode cleanup is unconfirmed"));
                    }
                    Closed::Pending => {}
                }
                if closed.changed().await.is_err() {
                    return Err(unavailable());
                }
            }
        })
    }
}
fn start_live(inner: &Inner, job: &Job) -> Result<(), WorkerError> {
    if job.cancelled() {
        return Err(interrupted());
    }
    if Instant::now() >= job.deadline {
        Err(error(
            "start_unknown",
            "ZCode input acceptance deadline expired",
        ))
    } else if inner
        .services
        .driver
        .upgrade()
        .and_then(|d| d.snapshot_for_dispatch(&job.ticket))
        .is_none()
    {
        Err(interrupted())
    } else {
        Ok(())
    }
}
fn fatal(inner: &Inner) {
    if let Some(d) = inner.services.driver.upgrade() {
        d.report_storage_failure();
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (inner.services.fatal_storage)()
    }));
}
async fn store<T: Send + 'static>(
    inner: &Inner,
    job: &Job,
    work: impl FnOnce(Arc<dyn SessionStore>) -> Task<Result<T, StoreError>> + Send + 'static,
) -> Result<T, WorkerError> {
    job.unknown_io.store(true, Ordering::Release);
    let service = inner.services.store.clone();
    let joined = tokio::spawn(async move { work(service).await }).await;
    match joined {
        Ok(result) => {
            job.unknown_io.store(false, Ordering::Release);
            result.map_err(|e| {
                if e == StoreError::Storage {
                    fatal(inner);
                }
                error(e.code(), "ZCode session persistence failed")
            })
        }
        Err(_) => {
            job.uncertain_io.store(true, Ordering::Release);
            fatal(inner);
            Err(error(
                "storage_unavailable",
                "ZCode session IO completion is unknown",
            ))
        }
    }
}
async fn append(inner: &Inner, job: &Job, draft: Value) -> Result<(), WorkerError> {
    job.unknown_io.store(true, Ordering::Release);
    let sink = inner.services.sink.clone();
    let joined = tokio::spawn(async move { sink.append(draft).await }).await;
    match joined {
        Ok(result) => {
            job.unknown_io.store(false, Ordering::Release);
            match result {
                Ok(r) if r.id > 0 && r.id <= 9_007_199_254_740_991 && !r.ts.is_empty() => Ok(()),
                _ => {
                    fatal(inner);
                    Err(error(
                        "storage_unavailable",
                        "ZCode journal outcome is unknown",
                    ))
                }
            }
        }
        Err(_) => {
            job.uncertain_io.store(true, Ordering::Release);
            fatal(inner);
            Err(error(
                "storage_unavailable",
                "ZCode journal IO completion is unknown",
            ))
        }
    }
}
fn policy(
    gate: &dyn DispatchGate,
    ticket: &Ticket,
    snapshot: &TurnSnapshot,
) -> Result<Approval, WorkerError> {
    let decision = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        gate.check(ticket, snapshot)
    }))
    .unwrap_or(DispatchDecision::Deny);
    match decision {
        DispatchDecision::Allow => Ok(snapshot.settings.approval),
        DispatchDecision::Restrict(a)
            if a != Approval::Inherit && rank(a) <= rank(snapshot.settings.approval) =>
        {
            Ok(a)
        }
        _ => Err(error("access_changed", "ZCode dispatch authority changed")),
    }
}
struct CheckedSpawn {
    host: Arc<dyn SpawnGate>,
    gate: Arc<dyn DispatchGate>,
    job: Arc<Job>,
    attempt: Attempt,
    snapshot: TurnSnapshot,
    approval: Approval,
}
impl SpawnGate for CheckedSpawn {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        if self.job.cancelled()
            || policy(&*self.gate, &self.job.ticket, &self.snapshot).ok() != Some(self.approval)
        {
            return Err(SpawnDenied);
        }
        let permit = self.host.enter()?;
        if self.job.cancelled() || !self.attempt.spawn_action().sealed() {
            return Err(SpawnDenied);
        }
        Ok(permit)
    }
}
async fn receipt_ready(progress: &mut watch::Receiver<Progress>, job: &Job) -> bool {
    let mut cancel = job.cancel.subscribe();
    loop {
        if job.cancelled() {
            return false;
        }
        let state = progress.borrow_and_update().clone();
        match state {
            Progress::Starting => {}
            Progress::Running(r) => return r.turn_id == job.public_turn && r.user_event_id > 0,
            _ => return false,
        }
        tokio::select! {
            _=cancel.changed()=>return false,
            changed=progress.changed()=>if changed.is_err(){return false;},
        }
    }
}
async fn run(
    inner: Arc<Inner>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    progress: watch::Receiver<Progress>,
    started: oneshot::Sender<Result<Started, WorkerError>>,
) {
    let (done, receive) = oneshot::channel();
    let starter = Arc::new(Mutex::new(Some(started)));
    let running_inner = inner.clone();
    let running_job = job.clone();
    let running_starter = starter.clone();
    let joined = tokio::spawn(async move {
        turn(
            running_inner,
            running_job,
            snapshot,
            text,
            progress,
            running_starter,
            receive,
        )
        .await
    })
    .await;
    let result = match joined {
        Ok(result) => result,
        Err(_) => Err(error("worker_panic", "ZCode worker failed")),
    };
    cleanup(&inner, &job).await;
    let attempt = job.attempt.lock().expect("ZCode attempt").clone();
    if let Some(attempt) = attempt {
        let proof = JoinedCleanup::from_owned_join(&attempt);
        let cleared = if attempt.spawn_action().never_sent() {
            let a = attempt.clone();
            store(&inner, &job, move |s| s.clear_never_sent(a, proof)).await
        } else {
            let a = attempt.clone();
            store(&inner, &job, move |s| s.retire(a, proof)).await
        };
        if cleared.is_err() && !job.uncertain_io.load(Ordering::Acquire) {
            let proof = JoinedCleanup::from_owned_join(&attempt);
            let _ = store(&inner, &job, move |s| s.retire(attempt, proof)).await;
        }
    }
    // Unknown external Store/Sink IO is not a cleanup receipt, even on panic.
    while job.unknown_io.load(Ordering::Acquire) || job.uncertain_io.load(Ordering::Acquire) {
        job.closed.send_replace(Closed::Unconfirmed);
        job.retry.notified().await;
    }
    inner.state.lock().expect("ZCode state").active = None;
    job.closed.send_replace(Closed::Confirmed);
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(e) => {
            if let Some(sender) = starter.lock().expect("ZCode start").take() {
                let _ = sender.send(Err(e));
                return;
            }
            failure(&e.code, &e.message)
        }
    };
    let _ = done.send(if job.cancelled() {
        Outcome::Interrupted
    } else {
        outcome
    });
}
async fn cleanup(inner: &Inner, job: &Job) {
    if let Some(attempt) = job.attempt.lock().expect("ZCode attempt").as_ref() {
        attempt.cancel_before_spawn();
    }
    job.stop();
    loop {
        let result = {
            let mut vault = job.vault.lock().await;
            if let Some(starting) = vault.starting.take() {
                vault.process = Some(starting.into_process());
            }
            if vault.spawn_inflight {
                false
            } else if let Some(process) = vault.process.as_mut() {
                process.stop().await.is_ok()
            } else {
                true
            }
        };
        if result
            && !job.unknown_io.load(Ordering::Acquire)
            && !job.uncertain_io.load(Ordering::Acquire)
        {
            break;
        }
        job.closed.send_replace(Closed::Unconfirmed);
        job.retry.notified().await;
        job.closed.send_replace(Closed::Pending);
    }
    job.signal.lock().expect("ZCode signal").take();
    let _ = inner;
}
type StartReply = Arc<Mutex<Option<oneshot::Sender<Result<Started, WorkerError>>>>>;
#[allow(clippy::too_many_arguments)]
async fn turn(
    inner: Arc<Inner>,
    job: Arc<Job>,
    snapshot: TurnSnapshot,
    text: String,
    mut progress: watch::Receiver<Progress>,
    started: StartReply,
    done: oneshot::Receiver<Outcome>,
) -> Result<Outcome, WorkerError> {
    if job.cancelled() {
        return Err(interrupted());
    }
    let checking = inner.clone();
    let scope = job.ticket.clone();
    let initial = snapshot.clone();
    let approval =
        tokio::task::spawn_blocking(move || policy(&*checking.services.gate, &scope, &initial))
            .await
            .map_err(|_| unavailable())??;
    start_live(&inner, &job)?;
    let request = ReserveRequest::new(
        job.ticket.clone(),
        snapshot.clone(),
        job.generation,
        job.public_turn.clone(),
        job.deadline,
    );
    let attempt = store(&inner, &job, move |s| s.reserve(request)).await?;
    if attempt.ticket() != &job.ticket
        || attempt.generation() != job.generation
        || attempt.public_turn() != job.public_turn
    {
        fatal(&inner);
        return Err(error(
            "storage_unavailable",
            "ZCode store returned a foreign attempt",
        ));
    }
    *job.attempt.lock().expect("ZCode attempt") = Some(attempt.clone());
    start_live(&inner, &job)?;
    if job.cancelled() {
        attempt.cancel_before_spawn();
        return Err(interrupted());
    }
    let preparing = inner.clone();
    let a = attempt.clone();
    let initial = snapshot.clone();
    let (prepared, host) = tokio::task::spawn_blocking(move || {
        let attachments = Value::Array(
            preparing
                .config
                .attachments
                .iter()
                .map(|a| a.value())
                .collect(),
        );
        let attachments = prompt_attachments::validate_owned_prompt_attachments(
            &preparing.config.home,
            &preparing.config.session.name,
            Some(&attachments),
        )
        .map_err(|_| error("invalid_params", "invalid ZCode attachments"))?;
        let text = prompt_attachments::prompt_attachment_context(&text, &attachments, true);
        let prompt = format!(
            "{text}\n\n{}",
            zcode_launch::approval_context_language(
                approval,
                preparing.config.broker_context,
                preparing.config.language
            )
        );
        let args = zcode_launch::argv(&zcode_launch::Options {
            prompt: &prompt,
            cwd: initial.cwd.to_str().ok_or_else(unavailable)?,
            resume_session_id: a.resume_session_id(),
            approval,
            model: initial.settings.model.as_deref(),
            effort: initial.settings.effort.as_deref(),
        })
        .map_err(|_| error("invalid_params", "ZCode Route A argv budget exceeded"))?;
        let mut launch = preparing.config.launch.clone();
        launch.args.extend(args.into_iter().map(Into::into));
        let host = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (preparing.services.spawn_gate)(a, initial, approval)
        }))
        .unwrap_or_else(|_| {
            Err(error(
                "access_changed",
                "ZCode spawn gate construction failed",
            ))
        })?;
        Ok::<_, WorkerError>((launch, host))
    })
    .await
    .map_err(|_| unavailable())??;
    start_live(&inner, &job)?;
    let prepared = Process::prepare_launch(
        prepared,
        Framing::codex(),
        StderrPolicy::PrivateTail {
            max_bytes: 64 * 1024,
        },
    )
    .await
    .map_err(|_| unavailable())?;
    start_live(&inner, &job)?;
    if job.cancelled() {
        attempt.cancel_before_spawn();
        return Err(interrupted());
    }
    append(&inner,&job,json!({"sessionId":inner.config.session.name,"provider":"zcode","kind":"status.changed","data":{"status":"working","turnId":job.public_turn}})).await?;
    start_live(&inner, &job)?;
    let gate = CheckedSpawn {
        host,
        gate: inner.services.gate.clone(),
        job: job.clone(),
        attempt: attempt.clone(),
        snapshot,
        approval,
    };
    let spawning = job.clone();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let _runtime = runtime.enter();
        let mut vault = spawning.vault.try_lock().map_err(|_| unavailable())?;
        vault.spawn_inflight = true;
        match Process::begin_spawn(prepared, &gate) {
            Ok(starting) => {
                *spawning.signal.lock().expect("ZCode signal") = Some(starting.stop_signal());
                vault.starting = Some(starting);
                vault.spawn_inflight = false;
                Ok(())
            }
            Err(failure) => {
                vault.process = failure.process.map(|v| *v);
                vault.spawn_inflight = false;
                Err(error("access_changed", "ZCode process could not start"))
            }
        }
    })
    .await
    .map_err(|_| unavailable())??;
    start_live(&inner, &job)?;
    {
        let mut vault = job.vault.lock().await;
        let acknowledged = vault
            .starting
            .as_mut()
            .ok_or_else(unavailable)?
            .acknowledge()
            .await;
        let starting = vault.starting.take().ok_or_else(unavailable)?;
        vault.process = Some(starting.into_process());
        acknowledged.map_err(|_| unavailable())?;
    }
    start_live(&inner, &job)?;
    let mut output = {
        let mut vault = job.vault.lock().await;
        vault
            .process
            .as_mut()
            .ok_or_else(unavailable)?
            .take_output()
            .map_err(|_| unavailable())?
    };
    let redactor = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        (inner.services.redactors)()
    }))
    .map_err(|_| error("redaction_failed", "ZCode redactor unavailable"))?;
    let mut mapper = Normalizer::new(
        HostBinding::new(
            inner.config.session.clone(),
            job.ticket.clone(),
            job.generation,
            job.public_turn.clone(),
        )
        .map_err(|_| unavailable())?,
        Default::default(),
        redactor,
    )
    .map_err(|_| unavailable())?;
    let callback = TrustedCallback {
        ticket: job.ticket.clone(),
        generation: job.generation,
    };
    let mut sid: Option<String> = None;
    let mut tid: Option<String> = None;
    let mut accepted = false;
    let mut done = Some(done);
    let mut early = VecDeque::new();
    let mut early_bytes = 0usize;
    let mut result: Option<bool> = None;
    let mut ended: Option<(bool, bool, bool)> = None;
    let mut cancel = job.cancel.subscribe();
    let deadline = tokio::time::sleep_until(tokio::time::Instant::from_std(job.deadline));
    tokio::pin!(deadline);
    let mut terminal_deadline: Option<tokio::time::Instant> = None;
    let mut natural_eof = false;
    loop {
        let grace = terminal_deadline
            .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(86_400));
        let frame = tokio::select! {_=cancel.changed()=>return Err(interrupted()),_=deadline.as_mut(),if !accepted=>return Err(error("start_unknown","ZCode input acceptance was not confirmed")),_=tokio::time::sleep_until(grace),if terminal_deadline.is_some()=>break,frame=output.recv()=>match frame{None=>{natural_eof=true;break},Some(Err(_))=>return Err(error("protocol_error","ZCode output stream failed")),Some(Ok(v))=>v}};
        if job.cancelled() {
            return Err(interrupted());
        }
        if !accepted {
            start_live(&inner, &job)?;
        }
        for (field, known) in [("sessionId", &mut sid), ("turnId", &mut tid)] {
            if let Some(value) = frame.get(field) {
                let id = value
                    .as_str()
                    .filter(|s| native_id(s))
                    .ok_or_else(|| error("protocol_error", "invalid ZCode native identity"))?;
                if known.as_deref().is_some_and(|old| old != id) {
                    return Err(error("protocol_error", "conflicting ZCode native identity"));
                }
                if known.is_none() {
                    *known = Some(id.into());
                    if field == "sessionId" {
                        let a = attempt.clone();
                        let id = id.to_owned();
                        store(&inner, &job, move |s| s.record_native_session(a, id)).await?;
                        if !accepted {
                            start_live(&inner, &job)?;
                        }
                    }
                }
            }
        }
        mapper
            .pin_native(&callback, sid.as_deref(), tid.as_deref())
            .map_err(|_| error("protocol_error", "ZCode native binding changed"))?;
        if frame["type"] == "turn.started" && !accepted {
            let native_sid = frame["sessionId"]
                .as_str()
                .filter(|s| native_id(s))
                .ok_or_else(|| error("protocol_error", "turn.started has no ZCode session"))?
                .to_owned();
            let native_tid = frame["turnId"]
                .as_str()
                .filter(|s| native_id(s))
                .ok_or_else(|| error("protocol_error", "turn.started has no ZCode turn"))?
                .to_owned();
            let evidence = TurnStartedEvidence::from_owned_turn_started(
                &attempt,
                native_sid.clone(),
                native_tid.clone(),
            )
            .map_err(|_| unavailable())?;
            let a = attempt.clone();
            let receipt = store(&inner, &job, move |s| s.accept_turn_started(a, evidence)).await?;
            if !receipt.matches(&attempt)
                || receipt.native_session_id() != native_sid
                || receipt.native_turn_id() != native_tid
            {
                fatal(&inner);
                return Err(error(
                    "storage_unavailable",
                    "ZCode acceptance receipt mismatched",
                ));
            }
            start_live(&inner, &job)?;
            {
                // Atomic decision with local revocation, without a guard across
                // channel send (which can invoke the waiting future's Waker).
                if job
                    .publication
                    .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Err(interrupted());
                }
                let sender = started
                    .lock()
                    .expect("ZCode start")
                    .take()
                    .ok_or_else(unavailable)?;
                let completion = done.take().ok_or_else(unavailable)?;
                let _ = sender.send(Ok(Started {
                    turn_id: job.public_turn.clone(),
                    done: Box::pin(async move {
                        completion.await.unwrap_or_else(|_| {
                            failure("worker_failed", "ZCode completion was lost")
                        })
                    }),
                }));
            }
            accepted = true;
            if !receipt_ready(&mut progress, &job).await {
                return Err(interrupted());
            }
        }
        if !accepted {
            early_bytes = early_bytes
                .saturating_add(serde_json::to_vec(&frame).map_err(|_| unavailable())?.len());
            if early.len() >= 128 || early_bytes > 2 * 1024 * 1024 {
                return Err(error("capacity", "ZCode early event budget exceeded"));
            }
            early.push_back(frame);
            continue;
        }
        early.push_back(frame);
        while let Some(frame) = early.pop_front() {
            let batch = mapper.push(&callback, &frame);
            if batch.fault.is_some() {
                return Err(error(
                    "normalization_failed",
                    "ZCode output normalization failed",
                ));
            }
            for draft in batch.drafts {
                append(
                    &inner,
                    &job,
                    serde_json::to_value(draft).map_err(|_| unavailable())?,
                )
                .await?;
            }
            for signal in batch.signals {
                match signal {
                    Signal::Result { ok, .. } => {
                        result = Some(ok);
                        terminal_deadline.get_or_insert_with(|| {
                            tokio::time::Instant::now() + inner.config.terminal_grace
                        });
                    }
                    Signal::TurnEnded {
                        ok,
                        text,
                        result_type,
                    } => {
                        ended = Some((
                            ok,
                            text.is_some_and(|v| !v.is_empty()),
                            result_type.as_deref() == Some("cancelled"),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }
    // stdout EOF (or bounded terminal retirement) precedes private stderr access.
    drop(output);
    let tail = {
        let mut vault = job.vault.lock().await;
        let process = vault.process.as_mut().ok_or_else(unavailable)?;
        process.stop().await.map_err(|_| {
            error(
                "cleanup_unconfirmed",
                "ZCode process cleanup is unconfirmed",
            )
        })?;
        process
            .take_private_stderr()
            .map_err(|_| error("worker_io_failed", "ZCode stderr completion is unavailable"))?
    };
    if job.cancelled() {
        return Err(interrupted());
    }
    if !accepted {
        return classify(&inner, &job, tail.as_bytes())
            .await
            .and_then(|_| Err(error("start_unknown", "ZCode input was not accepted")));
    }
    if result == Some(true) || result.is_none() && ended.is_some_and(|(ok, text, _)| ok && text) {
        return Ok(Outcome::Success);
    }
    if result.is_none() && ended.is_some_and(|(_, _, cancelled)| cancelled) {
        return Ok(Outcome::Interrupted);
    }
    if !natural_eof {
        return Err(error("worker_io_failed", "ZCode output did not reach EOF"));
    }
    classify(&inner, &job, tail.as_bytes()).await?;
    Ok(failure(
        "provider_failed",
        "ZCode returned no successful result",
    ))
}
async fn classify(inner: &Inner, job: &Job, bytes: &[u8]) -> Result<(), WorkerError> {
    let text = String::from_utf8_lossy(bytes);
    let lines = text
        .trim_matches(crate::claude_launch::js_whitespace)
        .split('\n')
        .rev()
        .take(3)
        .collect::<Vec<_>>();
    let tail = lines.into_iter().rev().collect::<Vec<_>>().join("\n");
    let units: Vec<u16> = tail.encode_utf16().take(500).collect();
    let tail = String::from_utf16_lossy(&units).to_lowercase();
    let signal = if [
        "not_authenticated",
        "official_auth_unavailable",
        "authentication_required",
        "zcode-jwt-invalid",
        "zcode_credential_decrypt_failed",
        "unable to read shared zcode credentials",
    ]
    .iter()
    .any(|v| tail.contains(v))
    {
        Some(ProviderSignal::Authentication)
    } else if [
        "quota_exceeded",
        "coding_plan_required",
        "rate_limited",
        "limit_exceeded",
    ]
    .iter()
    .any(|v| tail.contains(v))
    {
        Some(ProviderSignal::Quota)
    } else {
        let missing = tail.contains("invalid session id")
            || tail
                .split(['\n', '\r', '\u{2028}', '\u{2029}'])
                .any(|line| {
                    line.match_indices("session").any(|(at, _)| {
                        let rest = &line[at + "session".len()..];
                        ["not found", "не найден", "не существует"]
                            .iter()
                            .any(|needle| {
                                rest.match_indices(needle)
                                    .any(|(gap, _)| rest[..gap].encode_utf16().count() <= 40)
                            })
                    })
                });
        missing.then_some(ProviderSignal::MissingSession)
    };
    if let Some(signal) = signal {
        let (kind, data) = match signal {
            ProviderSignal::Authentication => (
                "provider.blocked",
                json!({"provider":"zcode","text":"ZCode reported unavailable authentication","hint":"Check the provider account outside this restricted process"}),
            ),
            ProviderSignal::Quota => (
                "limit.hit",
                json!({"source":"stderr","detail":"ZCode quota or rate limit"}),
            ),
            ProviderSignal::MissingSession => (
                "session.configured",
                json!({"changes":{},"notice":"ZCode could not find the native conversation; automatic retry is disabled"}),
            ),
        };
        append(inner,job,json!({"sessionId":inner.config.session.name,"provider":"zcode","kind":kind,"data":data})).await?;
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (inner.services.provider_signal)(signal)
        }));
        return Err(error(
            if signal == ProviderSignal::MissingSession {
                "native_session_missing"
            } else {
                "provider_unavailable"
            },
            "ZCode provider reported an execution failure",
        ));
    }
    Ok(())
}
