//! Owner-only, explicitly partial session execution API. Existing metadata uses
//! RawValue replies; receipts and native IO stay owned when an RPC disappears.
use crate::turn_snapshot::SessionKey;
use crate::{State, host_policy::ClientKind, permission_broker, runtime_state, session_model};
use serde_json::{
    Value, json,
    value::{RawValue, to_raw_value},
};
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) const METHODS: [&str; 6] = [
    "agent.start",
    "agent.list",
    "agent.prompt",
    "agent.stop",
    "perm.list",
    "perm.resolve",
];
// Root preflight covers lookup/bootstrap before Runtime's owned reservation.
// Stop replaces the slot and seals an earlier prompt before any async work.
pub(crate) struct Gate {
    entries: Mutex<HashMap<String, Arc<Token>>>,
    slots: Arc<Semaphore>,
}
const MAX_COMMANDS: usize = 128;
impl Default for Gate {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAX_COMMANDS)),
        }
    }
}
struct Admission {
    _slot: OwnedSemaphorePermit,
    command: Option<CommandGuard>,
}
struct Token {
    cancelled: AtomicBool,
    stopping: bool,
}
struct CommandGuard {
    name: String,
    token: Arc<Token>,
    gate: Weak<Gate>,
}
impl Gate {
    fn admit(self: &Arc<Self>, method: &str, params: &Value) -> Result<Admission> {
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("capacity", "session command capacity reached"))?;
        let command = match method {
            "agent.prompt" => {
                fields(
                    params,
                    &["name", "text", "attachments", "queue", "interrupt", "steer"],
                )?;
                for flag in ["queue", "interrupt", "steer"] {
                    if params.get(flag).is_some_and(|value| value != false) {
                        return Err(error(
                            "unsupported",
                            "queue, interrupt-and-send and steering are not ported yet",
                        ));
                    }
                }
                params["text"].as_str().ok_or_else(invalid)?;
                Some(self.reserve(&name(params)?, false)?)
            }
            "agent.stop" => {
                fields(params, &["name", "turnId"])?;
                let name = name(params)?;
                match params.get("turnId") {
                    Some(turn_id) => {
                        turn_id.as_str().ok_or_else(invalid)?;
                        None
                    }
                    None => Some(self.reserve(&name, true)?),
                }
            }
            _ => None,
        };
        Ok(Admission {
            _slot: slot,
            command,
        })
    }
    fn reserve(self: &Arc<Self>, name: &str, stopping: bool) -> Result<CommandGuard> {
        let mut entries = self.entries.lock().map_err(|_| storage())?;
        if let Some(previous) = entries.get(name) {
            if !stopping || previous.stopping {
                return Err(error("busy", "a session command is already pending"));
            }
            previous.cancelled.store(true, Ordering::Release);
        } else if entries.len() >= 128 {
            return Err(error("capacity", "session command capacity reached"));
        }
        let token = Arc::new(Token {
            cancelled: AtomicBool::new(false),
            stopping,
        });
        entries.insert(name.into(), token.clone());
        Ok(CommandGuard {
            name: name.into(),
            token,
            gate: Arc::downgrade(self),
        })
    }
}
impl CommandGuard {
    fn check(&self) -> Result<()> {
        if self.token.cancelled.load(Ordering::Acquire) {
            Err(error("cancelled", "session command was stopped"))
        } else {
            Ok(())
        }
    }
    fn submit(
        &self,
        runtime: &crate::codex_runtime::CodexRuntime,
        key: SessionKey,
        input: crate::turn_driver::Input,
    ) -> Result<
        crate::turn_driver::Task<
            std::result::Result<crate::turn_driver::Handle, crate::codex_runtime::RuntimeError>,
        >,
    > {
        let gate = self.gate.upgrade().ok_or_else(storage)?;
        let entries = gate.entries.lock().map_err(|_| storage())?;
        if !entries
            .get(&self.name)
            .is_some_and(|token| Arc::ptr_eq(token, &self.token))
        {
            return Err(error("cancelled", "session command was stopped"));
        }
        self.check()?;
        // execute reserves synchronously; stop cannot miss the handoff.
        Ok(runtime.execute(key, input))
    }
}
impl Drop for CommandGuard {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.upgrade()
            && let Ok(mut entries) = gate.entries.lock()
            && entries
                .get(&self.name)
                .is_some_and(|token| Arc::ptr_eq(token, &self.token))
        {
            entries.remove(&self.name);
        }
    }
}

pub(crate) struct Error {
    pub code: &'static str,
    pub message: &'static str,
}
type Result<T> = std::result::Result<T, Error>;
fn error(code: &'static str, message: &'static str) -> Error {
    Error { code, message }
}
fn invalid() -> Error {
    error("invalid_params", "invalid session command parameters")
}
fn storage() -> Error {
    error("storage_unavailable", "session storage is unavailable")
}
fn raw(value: Value) -> Result<Box<RawValue>> {
    to_raw_value(&value).map_err(|_| storage())
}
fn fields(params: &Value, allowed: &[&str]) -> Result<()> {
    let object = params.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(error(
            "unsupported",
            "this session command form is not ported yet",
        ));
    }
    Ok(())
}
fn name(params: &Value) -> Result<String> {
    let name = params["name"]
        .as_str()
        .filter(|name| session_model::is_name(name))
        .ok_or_else(invalid)?;
    Ok(name.into())
}
fn key(record: &crate::registry::Record) -> Result<SessionKey> {
    let key = SessionKey {
        name: record.name().into(),
        created_at: record.scalar("createdAt").ok_or_else(storage)?,
    };
    key.validate().map_err(|_| storage())?;
    Ok(key)
}
async fn lookup(state: Arc<State>, name: String) -> Result<(SessionKey, String)> {
    let job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _job = job;
        let registry = state.registry.lock().map_err(|_| storage())?;
        let record = registry
            .find(&name)
            .ok_or_else(|| error("not_found", "session does not exist"))?;
        Ok((key(record)?, record.scalar("provider").ok_or_else(storage)?))
    })
    .await
    .map_err(|_| storage())?
}
fn available(state: &State) -> Result<()> {
    if *state.stop.borrow() {
        return Err(error("closed", "daemon is stopping"));
    }
    if runtime_state::unavailable(state) {
        return Err(storage());
    }
    Ok(())
}

async fn create(state: Arc<State>, params: Value, client: ClientKind) -> Result<Box<RawValue>> {
    let failed = state.clone();
    let job = state.host_jobs.track();
    let result = tokio::task::spawn_blocking(move || {
        let _job = job;
        available(&state)?;
        let consent = runtime_state::consent(&state).map_err(|_| storage())?;
        // Serialize registration with all event projections. No native dispatch
        // is performed by metadata creation, including after a lost response.
        let store = state.store.lock().map_err(|_| storage())?;
        if !state
            .live_sessions
            .lock()
            .map_err(|_| storage())?
            .can_register()
        {
            return Err(error("capacity", "session status cache is full"));
        }
        let record = crate::session_create::create(
            &state.home,
            &state.registry,
            &consent,
            &params,
            client,
            store.last_id(),
        );
        let mut record = match record {
            Ok(record) => record,
            Err(e) => {
                drop(store);
                if e == crate::session_create::CreateError::Storage {
                    state.execution_storage_failed();
                }
                return Err(error(e.code(), "session could not be created"));
            }
        };
        let registered = state.live_sessions.lock().map_err(|_| storage())?.seed(
            key(&record)?,
            crate::session_live::Status::Cold,
            0,
        );
        if registered.is_err() {
            drop(store);
            state.execution_storage_failed();
            return Err(storage());
        }
        record.set_string("status", "cold");
        record.set_number("pendingPermissions", 0.0);
        record.set_raw(
            "liveApproval",
            to_raw_value(&Value::Null).map_err(|_| storage())?,
        );
        session_model::public_record(&record).map_err(|_| storage())
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            failed.execution_storage_failed();
            Err(storage())
        }
    }
}

async fn list(state: Arc<State>, params: Value) -> Result<Box<RawValue>> {
    fields(&params, &[])?;
    let job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _job = job;
        // Use the same store -> registry order as metadata mutations. Release
        // cache guards before any Registry IO; this path only reads the cache.
        let _store = state.store.lock().map_err(|_| storage())?;
        let registry = state.registry.lock().map_err(|_| storage())?;
        let driver = state.driver.get().ok_or_else(storage)?;
        let mut response = String::from("{\"sessions\":[");
        for (index, record) in registry.records().iter().enumerate() {
            let key = key(record)?;
            let status = state
                .live_sessions
                .lock()
                .map_err(|_| storage())?
                .view(&key)
                .map(|view| view.status.as_str())
                .unwrap_or("cold");
            let snapshot = driver
                .active_ticket(&key)
                .and_then(|ticket| driver.execution_snapshot(&ticket));
            let mut public = record.clone();
            public.set_string("status", status);
            let pending = state.native_runtime.get().map_or(0, |runtime| {
                runtime.list_permissions(Some(record.name())).len()
            });
            public.set_number("pendingPermissions", pending as f64);
            public.set_raw(
                "liveApproval",
                to_raw_value(&snapshot.map(|s| s.settings.approval.as_str()))
                    .map_err(|_| storage())?,
            );
            let public = session_model::public_record(&public).map_err(|_| storage())?;
            if response.len().saturating_add(public.get().len()) > crate::MAX_LINE - 512 {
                return Err(error("capacity", "session list exceeds response budget"));
            }
            if index > 0 {
                response.push(',');
            }
            response.push_str(public.get());
        }
        response.push_str("]}");
        RawValue::from_string(response).map_err(|_| storage())
    })
    .await
    .map_err(|_| storage())?
}

async fn prompt(state: Arc<State>, params: Value, command: CommandGuard) -> Result<Box<RawValue>> {
    fields(
        &params,
        &["name", "text", "attachments", "queue", "interrupt", "steer"],
    )?;
    // Advanced forms must not leave a user receipt or start a provider.
    for flag in ["queue", "interrupt", "steer"] {
        if params.get(flag).is_some_and(|value| value != false) {
            return Err(error(
                "unsupported",
                "queue, interrupt-and-send and steering are not ported yet",
            ));
        }
    }
    let name = name(&params)?;
    let text = params["text"].as_str().ok_or_else(invalid)?.to_owned();
    let (session, provider) = lookup(state.clone(), name.clone()).await?;
    if provider != "codex" {
        return Err(error(
            "unsupported",
            "native execution currently supports Codex ordinary turns only",
        ));
    }
    let checking = state.clone();
    let job = state.host_jobs.track();
    let attachments = tokio::task::spawn_blocking(move || {
        let _job = job;
        crate::prompt_attachments::validate_owned_prompt_attachments(
            &checking.home,
            &name,
            params.get("attachments"),
        )
    })
    .await
    .map_err(|_| storage())?
    .map_err(|_| invalid())?;
    available(&state)?;
    command.check()?;
    let runtime = runtime_state::instance(&state)
        .await
        .map_err(|_| error("runtime_unavailable", "native runtime is unavailable"))?;
    let input = crate::turn_driver::Input {
        text,
        metadata: crate::turn_driver::InputMetadata {
            attachments,
            ..Default::default()
        },
    };
    let mut handle = command
        .submit(&runtime, session, input)?
        .await
        .map_err(|e| error(e.code(), "turn was not accepted"))?;
    let accepted = handle.accepted().await.map_err(|e| {
        use crate::turn_driver::DriverError;
        let code = match e {
            DriverError::Invalid => "invalid_params",
            DriverError::Busy => "busy",
            DriverError::Cancelled => "cancelled",
            DriverError::Closed => "closed",
            DriverError::StorageUnavailable => "storage_unavailable",
            DriverError::AccessDenied => "forbidden",
            _ => "internal",
        };
        error(code, "turn was not accepted")
    })?;
    raw(json!({"turnId":accepted.turn_id}))
}

async fn stop(
    state: Arc<State>,
    params: Value,
    command: Option<CommandGuard>,
) -> Result<Box<RawValue>> {
    fields(&params, &["name", "turnId"])?;
    let name = name(&params)?;
    let turn_id = params
        .get("turnId")
        .map(|value| value.as_str().ok_or_else(invalid))
        .transpose()?;
    // Cancel a submitted/preparing turn before any Registry IO can block.
    let mut stopped = if command.is_some() {
        state
            .native_runtime
            .get()
            .map(|runtime| runtime.stop_name(&name))
            .transpose()
            .map_err(|e| error(e.code(), "stop request failed"))?
            .unwrap_or(false)
    } else {
        false
    };
    let (key, provider) = lookup(state.clone(), name).await?;
    if let Some(runtime) = state.native_runtime.get() {
        stopped |= if turn_id.is_none() {
            runtime.stop_name(&key.name)
        } else {
            runtime.stop(&key, turn_id)
        }
        .map_err(|e| error(e.code(), "stop request failed"))?;
    }
    if turn_id.is_none() || stopped {
        // Interrupted describes the user's stop intent. Native close proof and
        // its Full diagnostic snapshot remain owned until actual cleanup.
        let sink = state.execution_sink();
        sink.append(json!({"sessionId":key.name,"provider":provider,"kind":"status.changed","data":{"status":"interrupted"}})).await.map_err(|_|storage())?;
        return raw(json!({"stopped":true}));
    }
    raw(json!({"stopped":stopped}))
}

async fn resolve(state: Arc<State>, params: Value, by: &str) -> Result<Box<RawValue>> {
    if params.get("updatedInput").is_some() {
        return Err(invalid());
    }
    fields(&params, &["id", "decision", "scope", "answers", "message"])?;
    let id = params["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512)
        .ok_or_else(invalid)?;
    let scope = match params.get("scope").and_then(Value::as_str) {
        None if !params.as_object().unwrap().contains_key("scope") => {
            permission_broker::Scope::Once
        }
        Some("once") => permission_broker::Scope::Once,
        Some("session") => permission_broker::Scope::Session,
        Some("rule") => permission_broker::Scope::Rule,
        _ => return Err(invalid()),
    };
    let decision_name = params["decision"].as_str().ok_or_else(invalid)?;
    let decision = match decision_name {
        "allow" => permission_broker::Decision::Allow {
            scope,
            updated_input: None,
            answers: params.get("answers").cloned(),
        },
        "deny" if scope == permission_broker::Scope::Once => permission_broker::Decision::Deny {
            message: params
                .get("message")
                .map(|v| v.as_str().ok_or_else(invalid))
                .transpose()?
                .unwrap_or("pult: отказано")
                .into(),
        },
        _ => return Err(invalid()),
    };
    let runtime = state
        .native_runtime
        .get()
        .ok_or_else(|| error("not_found", "permission is not pending"))?;
    let resolution = runtime
        .resolve_permission(id, decision, by)
        .map_err(broker_error)?;
    if !resolution.wait().await.map_err(broker_error)? {
        return Err(error("not_found", "permission is not pending"));
    }
    let mut result = json!({"resolved":true,"id":id,"decision":decision_name});
    if decision_name == "allow" {
        result["scope"] = json!(match scope {
            permission_broker::Scope::Once => "once",
            permission_broker::Scope::Session => "session",
            permission_broker::Scope::Rule => "rule",
        });
    }
    raw(result)
}
fn broker_error(error_value: permission_broker::BrokerError) -> Error {
    use permission_broker::BrokerError;
    match error_value {
        BrokerError::Invalid | BrokerError::InvalidScope | BrokerError::InvalidAnswers => invalid(),
        BrokerError::StorageUnavailable => storage(),
        BrokerError::Capacity => error("capacity", "permission capacity reached"),
        BrokerError::Closed => error("closed", "permission broker is closed"),
    }
}

async fn execute_owned(
    state: Arc<State>,
    method: &str,
    params: Value,
    client: ClientKind,
    by: &str,
    command: Option<CommandGuard>,
) -> Result<Box<RawValue>> {
    available(&state)?;
    match method {
        "agent.start" => create(state, params, client).await,
        "agent.list" => list(state, params).await,
        "agent.prompt" => prompt(state, params, command.ok_or_else(storage)?).await,
        "agent.stop" => stop(state, params, command).await,
        "perm.list" => {
            fields(&params, &["name"])?;
            let name = params
                .get("name")
                .map(|v| v.as_str().ok_or_else(invalid))
                .transpose()?;
            let pending = state
                .native_runtime
                .get()
                .map_or_else(Vec::new, |runtime| runtime.list_permissions(name));
            raw(json!({"pending":pending}))
        }
        "perm.resolve" => resolve(state, params, by).await,
        _ => Err(error("not_found", "unknown session command")),
    }
}

/// Receipt/stop ownership survives the socket's response future being dropped.
pub(crate) fn execute(
    state: Arc<State>,
    method: &str,
    params: Value,
    client: ClientKind,
    by: &str,
) -> crate::turn_driver::Task<Result<Box<RawValue>>> {
    // Reserve before spawning so frame admission order, not task scheduling,
    // determines which earlier prompt an unconditional stop revokes.
    let admission =
        match available(&state).and_then(|_| state.session_commands.admit(method, &params)) {
            Ok(admission) => admission,
            Err(error) => return Box::pin(async move { Err(error) }),
        };
    let job = state.host_jobs.track();
    let method = method.to_owned();
    let by = by.to_owned();
    let (send, receive) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _job = job;
        let Admission { _slot, command } = admission;
        let result = execute_owned(state, &method, params, client, &by, command).await;
        let _ = send.send(result);
    });
    Box::pin(async move { receive.await.unwrap_or_else(|_| Err(storage())) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        OnceLock,
        atomic::{AtomicU64, AtomicUsize},
    };
    use std::task::{Context, Poll, Waker};
    use std::time::{Duration, Instant};
    use tokio::sync::watch;

    fn fixture() -> (tempfile::TempDir, Arc<State>) {
        let home = tempfile::tempdir().unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut store = crate::journal::EventStore::open(&home.path().join("events")).unwrap();
        let registry = crate::registry::Registry::open(home.path(), &mut store).unwrap();
        let (stop, _) = watch::channel(false);
        let (committed, _) = watch::channel(store.last_id());
        let state = Arc::new(State {
            home: home.path().into(),
            started_at: "fixture".into(),
            started: Instant::now(),
            token: "fixture".into(),
            clients: AtomicUsize::new(0),
            stop,
            store: Mutex::new(store),
            history: Mutex::new(Default::default()),
            registry: Arc::new(Mutex::new(registry)),
            memory: Mutex::new(Err("fixture disabled".into())),
            session_memory: Mutex::new(Default::default()),
            last_event_id: AtomicU64::new(0),
            test_mode: true,
            projection_degraded: AtomicBool::new(false),
            subscriptions: AtomicUsize::new(0),
            committed,
            live_id: AtomicU64::new(1),
            connection_id: AtomicU64::new(1),
            driver: OnceLock::new(),
            execution_storage_failed: AtomicBool::new(false),
            execution_admission: Mutex::new(()),
            host_jobs: Arc::default(),
            session_commands: Arc::default(),
            native_runtime: OnceLock::new(),
            memory_turns: OnceLock::new(),
            runtime_init: Mutex::new(()),
            consent: Mutex::new(None),
            live_sessions: Mutex::new(crate::session_live::Cache::new(65536).unwrap()),
        });
        crate::runtime_journal::initialize(&state).unwrap();
        (home, state)
    }

    #[tokio::test]
    async fn stop_revokes_earlier_prompt_before_either_owned_task_is_polled() {
        let (_home, state) = fixture();
        let prompt = execute(
            state.clone(),
            "agent.prompt",
            json!({"name":"chat","text":"hello"}),
            ClientKind::Other,
            "fixture",
        );
        let token = state
            .session_commands
            .entries
            .lock()
            .unwrap()
            .get("chat")
            .cloned();
        let stop = execute(
            state.clone(),
            "agent.stop",
            json!({"name":"chat"}),
            ClientKind::Other,
            "fixture",
        );
        let revoked = token
            .as_ref()
            .is_some_and(|token| token.cancelled.load(Ordering::Acquire));
        drop(prompt);
        drop(stop);
        tokio::time::timeout(Duration::from_secs(5), state.host_jobs.wait())
            .await
            .unwrap();
        assert!(
            revoked,
            "earlier admitted prompt was invisible to stop before task polling"
        );
        assert!(state.native_runtime.get().is_none());
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn dropped_response_waiters_do_not_release_owned_controller_capacity() {
        let (_home, state) = fixture();
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let blocked = state.clone();
        let holder = std::thread::spawn(move || {
            let _store = blocked.store.lock().unwrap();
            entered.send(()).unwrap();
            let _ = release_rx.recv();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        for _ in 0..MAX_COMMANDS {
            drop(execute(
                state.clone(),
                "agent.list",
                json!({}),
                ClientKind::Other,
                "fixture",
            ));
        }
        let mut overflow = execute(
            state.clone(),
            "agent.list",
            json!({}),
            ClientKind::Other,
            "fixture",
        );
        let mut context = Context::from_waker(Waker::noop());
        let capacity = matches!(
            overflow.as_mut().poll(&mut context),
            Poll::Ready(Err(Error {
                code: "capacity",
                ..
            }))
        );
        let reserved = state.host_jobs.active();
        release.send(()).unwrap();
        holder.join().unwrap();
        drop(overflow);
        tokio::time::timeout(Duration::from_secs(10), state.host_jobs.wait())
            .await
            .unwrap();
        assert!(
            capacity,
            "dropped waiters allowed unbounded detached controllers"
        );
        assert_eq!(reserved, MAX_COMMANDS);
        assert_eq!(
            state.session_commands.slots.available_permits(),
            MAX_COMMANDS
        );
    }
}
