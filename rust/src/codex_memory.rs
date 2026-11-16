//! Persistent transport registration; only a trusted native call ledger selects
//! an exact Ticket handle. Model supplied metadata is never authority.
use crate::{
    memory::MemoryError,
    memory_turn::{Backend, Lease, TurnMemory},
    turn_coordinator::Ticket,
    turn_snapshot::{SessionKey, TurnSnapshot},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::sync::{Notify, Semaphore};
const METHODS: [&str; 1] = ["codex.memory.call"];
const LEDGER_CALLS: usize = 256;
const LEDGER_BYTES: usize = 256 * 1024;
pub(crate) const ENVELOPE_BYTES: usize = 64 * 1024;
fn denied() -> MemoryError {
    MemoryError {
        code: "forbidden",
        message: "Codex memory call is unavailable".into(),
    }
}
fn capacity() -> MemoryError {
    MemoryError {
        code: "capacity",
        message: "Codex memory capacity reached".into(),
    }
}
fn identity(s: &str) -> bool {
    !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control)
}
pub(crate) fn nonce() -> Result<String, MemoryError> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|_| denied())?;
    Ok(bytes.iter().map(|v| format!("{v:02x}")).collect())
}
pub(crate) struct Registry {
    backend: Weak<Backend>,
    entries: Mutex<Vec<Weak<Registration>>>,
    waiters: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    active_memory: Arc<Semaphore>,
    identity_bytes: Arc<Semaphore>,
    identities: Arc<Semaphore>,
}
pub(crate) struct Registration {
    registry: Weak<Registry>,
    pub(crate) session: SessionKey,
    epoch: String,
    key: String,
    state: Mutex<Binding>,
    changed: Notify,
}
struct Binding {
    closed: bool,
    thread: Option<String>,
    active: Weak<Turn>,
    native_ids: HashMap<String, NativeOwner>,
}
struct NativeOwner {
    ticket: Ticket,
    turn: Weak<Turn>,
    _bytes: tokio::sync::OwnedSemaphorePermit,
    _entry: tokio::sync::OwnedSemaphorePermit,
}
pub(crate) struct Turn {
    registration: Weak<Registration>,
    backend: Weak<Backend>,
    ticket: Ticket,
    lease: Option<Handle>,
    state: Mutex<TurnState>,
    changed: Notify,
    closed: AtomicBool,
}
pub(crate) struct Handle {
    lease: Lease,
    backend: Arc<Backend>,
    ticket: Ticket,
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
    runtime: tokio::runtime::Handle,
}
impl Drop for Handle {
    fn drop(&mut self) {
        if let Some(slot) = self.slot.take() {
            let backend = self.backend.clone();
            let ticket = self.ticket.clone();
            backend.revoke(&ticket);
            self.runtime.spawn(async move {
                let _slot = slot;
                let _ = backend.drain(ticket).await;
            });
        }
    }
}
#[cfg(test)]
impl Handle {
    pub(crate) fn test(backend: Arc<Backend>, ticket: Ticket, lease: Lease) -> Self {
        Self {
            lease,
            backend,
            ticket,
            slot: None,
            runtime: tokio::runtime::Handle::current(),
        }
    }
}
struct TurnState {
    native: Option<String>,
    ack: bool,
    started: bool,
    ledger: HashMap<String, Call>,
    bytes: usize,
}
struct Call {
    tool: String,
    consumed: bool,
    arguments: Value,
}
impl Registry {
    pub(crate) fn new(backend: Weak<Backend>) -> Arc<Self> {
        Arc::new(Self {
            backend,
            entries: Mutex::new(Vec::new()),
            waiters: Arc::new(Semaphore::new(16)),
            bytes: Arc::new(Semaphore::new(512 * 1024)),
            active_memory: Arc::new(Semaphore::new(2)),
            identity_bytes: Arc::new(Semaphore::new(8 * 1024 * 1024)),
            identities: Arc::new(Semaphore::new(8192)),
        })
    }
    pub(crate) fn register(
        self: &Arc<Self>,
        session: SessionKey,
        epoch: &str,
    ) -> Result<Arc<Registration>, MemoryError> {
        if !identity(epoch) {
            return Err(denied());
        }
        let mut entries = self.entries.lock().map_err(|_| denied())?;
        entries.retain(|e| e.strong_count() > 0);
        if entries.len() >= 256
            || entries
                .iter()
                .filter_map(Weak::upgrade)
                .filter(|r| r.epoch == epoch)
                .count()
                >= 32
        {
            return Err(capacity());
        }
        let reg = Arc::new(Registration {
            registry: Arc::downgrade(self),
            session,
            epoch: epoch.into(),
            key: format!("cm_{}", nonce()?),
            state: Mutex::new(Binding {
                closed: false,
                thread: None,
                active: Weak::new(),
                native_ids: HashMap::new(),
            }),
            changed: Notify::new(),
        });
        entries.push(Arc::downgrade(&reg));
        Ok(reg)
    }
    pub(crate) fn lookup(&self, key: &str) -> Option<Arc<Registration>> {
        if key.len() != 67 || !key.starts_with("cm_") {
            return None;
        }
        self.entries
            .lock()
            .ok()?
            .iter()
            .filter_map(Weak::upgrade)
            .find(|r| {
                bool::from(r.key.as_bytes().ct_eq(key.as_bytes()))
                    && !r.state.lock().map(|s| s.closed).unwrap_or(true)
            })
    }
    pub(crate) async fn prepare(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        public_turn: String,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> Result<Option<Handle>, crate::turn_driver::WorkerError> {
        let backend = self
            .backend
            .upgrade()
            .ok_or_else(|| crate::turn_driver::WorkerError {
                code: "memory_unavailable".into(),
                message: "memory backend unavailable".into(),
            })?;
        if backend.enabled(snapshot.key.clone()).await? {
            let cancelled_error = || crate::turn_driver::WorkerError {
                code: "interrupted".into(),
                message: "Codex memory preparation cancelled".into(),
            };
            if *cancelled.borrow() {
                return Err(cancelled_error());
            }
            let slot = tokio::select! {
                slot=self.active_memory.clone().acquire_owned()=>slot.map_err(|_|cancelled_error())?,
                _=cancelled.changed()=>return Err(cancelled_error()),
            };
            if *cancelled.borrow() {
                return Err(cancelled_error());
            }
            if !backend.enabled(snapshot.key.clone()).await? {
                return Ok(None);
            }
            let lease = backend
                .prepare_handle(ticket.clone(), snapshot, public_turn)
                .await?;
            Ok(Some(Handle {
                lease,
                backend,
                ticket,
                slot: Some(slot),
                runtime: tokio::runtime::Handle::current(),
            }))
        } else {
            Ok(None)
        }
    }
    pub(crate) fn methods() -> &'static [&'static str] {
        &METHODS
    }
}
impl Registration {
    pub(crate) fn server(&self) -> Result<Value, MemoryError> {
        self.registry
            .upgrade()
            .and_then(|r| r.backend.upgrade())
            .ok_or_else(denied)?
            .bridge_server(&self.key)
    }
    pub(crate) fn bind(&self, thread: &str) -> Result<(), MemoryError> {
        let mut state = self.state.lock().map_err(|_| denied())?;
        if state.closed || !identity(thread) || state.thread.as_deref().is_some_and(|s| s != thread)
        {
            return Err(denied());
        }
        state.thread = Some(thread.into());
        self.changed.notify_waiters();
        Ok(())
    }
    pub(crate) fn turn(
        self: &Arc<Self>,
        ticket: Ticket,
        lease: Option<Handle>,
    ) -> Result<Arc<Turn>, MemoryError> {
        let mut state = self.state.lock().map_err(|_| denied())?;
        if state.closed
            || ticket.session() != &self.session
            || state
                .active
                .upgrade()
                .is_some_and(|t| !t.closed.load(Ordering::Acquire))
        {
            return Err(denied());
        }
        let registry = self.registry.upgrade().ok_or_else(denied)?;
        let turn = Arc::new(Turn {
            registration: Arc::downgrade(self),
            backend: registry.backend.clone(),
            ticket,
            lease,
            state: Mutex::new(TurnState {
                native: None,
                ack: false,
                started: false,
                ledger: HashMap::new(),
                bytes: 0,
            }),
            changed: Notify::new(),
            closed: AtomicBool::new(false),
        });
        state.active = Arc::downgrade(&turn);
        self.changed.notify_waiters();
        Ok(turn)
    }
    fn claim_native(&self, turn: &Turn, native: &str) -> Result<(), MemoryError> {
        let result = (|| {
            let mut state = self.state.lock().map_err(|_| denied())?;
            if state.closed {
                return Err(denied());
            }
            if let Some(owner) = state.native_ids.get(native) {
                return if owner.ticket == turn.ticket && std::ptr::eq(owner.turn.as_ptr(), turn) {
                    Ok(())
                } else {
                    Err(denied())
                };
            }
            if state.native_ids.len() >= 1024 {
                return Err(capacity());
            }
            let registry = self.registry.upgrade().ok_or_else(denied)?;
            let bytes = registry
                .identity_bytes
                .clone()
                .try_acquire_many_owned(native.len() as u32)
                .map_err(|_| capacity())?;
            let entry = registry
                .identities
                .clone()
                .try_acquire_owned()
                .map_err(|_| capacity())?;
            let active = state.active.clone();
            if !std::ptr::eq(active.as_ptr(), turn) {
                return Err(denied());
            }
            state.native_ids.insert(
                native.into(),
                NativeOwner {
                    ticket: turn.ticket.clone(),
                    turn: active,
                    _bytes: bytes,
                    _entry: entry,
                },
            );
            Ok(())
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    pub(crate) fn available(&self) -> bool {
        self.state.lock().is_ok_and(|s| !s.closed)
    }
    pub(crate) fn close(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.closed = true;
            if let Some(t) = s.active.upgrade() {
                t.close()
            }
        }
        self.changed.notify_waiters();
    }
    pub(crate) async fn closed(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().map(|s| s.closed).unwrap_or(true) {
                return;
            }
            changed.await;
        }
    }
    pub(crate) fn call(
        self: Arc<Self>,
        envelope: Value,
    ) -> crate::turn_driver::Task<Result<Value, MemoryError>> {
        // Charge before the daemon can queue this task, including unpolled tasks.
        let admission = (|| {
            struct Count(usize);
            impl std::io::Write for Count {
                fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                    self.0 = self
                        .0
                        .checked_add(bytes.len())
                        .filter(|n| *n <= ENVELOPE_BYTES)
                        .ok_or_else(|| std::io::Error::other("bridge envelope budget"))?;
                    Ok(bytes.len())
                }
                fn flush(&mut self) -> std::io::Result<()> {
                    Ok(())
                }
            }
            let mut count = Count(0);
            serde_json::to_writer(&mut count, &envelope).map_err(|_| capacity())?;
            let name = envelope["name"]
                .as_str()
                .filter(|v| identity(v) && v.len() <= 128)
                .ok_or_else(denied)?;
            let arguments = envelope["arguments"].as_object().ok_or_else(denied)?;
            if !matches!(
                name,
                "memory_catalog"
                    | "memory_list"
                    | "memory_search"
                    | "memory_get"
                    | "memory_propose"
            ) || (name == "memory_propose"
                && !matches!(
                    arguments.get("operation").and_then(Value::as_str),
                    Some("add" | "update" | "forget")
                ))
            {
                return Err(denied());
            }
            let meta = &envelope["meta"];
            let blob = &meta["x-codex-turn-metadata"];
            let thread = meta["threadId"]
                .as_str()
                .filter(|v| identity(v))
                .ok_or_else(denied)?;
            if blob["thread_id"].as_str() != Some(thread)
                || !meta["callId"].as_str().is_some_and(identity)
                || !blob["turn_id"].as_str().is_some_and(identity)
            {
                return Err(denied());
            }
            let registry = self.registry.upgrade().ok_or_else(denied)?;
            let slot = registry
                .waiters
                .clone()
                .try_acquire_owned()
                .map_err(|_| capacity())?;
            let bytes = registry
                .bytes
                .clone()
                .try_acquire_many_owned(count.0 as u32)
                .map_err(|_| capacity())?;
            Ok((slot, bytes))
        })();
        match admission {
            Ok((slot, bytes)) => Box::pin(async move {
                let _slot = slot;
                let _bytes = bytes;
                self.call_admitted(envelope).await
            }),
            Err(error) => Box::pin(async move { Err(error) }),
        }
    }
    async fn call_admitted(self: Arc<Self>, envelope: Value) -> Result<Value, MemoryError> {
        let meta = &envelope["meta"];
        let thread = meta["threadId"]
            .as_str()
            .filter(|v| identity(v))
            .ok_or_else(denied)?;
        let call = meta["callId"]
            .as_str()
            .filter(|v| identity(v))
            .ok_or_else(denied)?;
        let blob = &meta["x-codex-turn-metadata"];
        if blob["thread_id"].as_str() != Some(thread) {
            return Err(denied());
        }
        let native = blob["turn_id"]
            .as_str()
            .filter(|v| identity(v))
            .ok_or_else(denied)?;
        let tool = envelope["name"]
            .as_str()
            .filter(|v| identity(v) && v.len() <= 128)
            .ok_or_else(denied)?;
        let original_args = &envelope["arguments"];
        let mut args = original_args.clone();
        if !args.is_object() {
            return Err(denied());
        }
        let method = crate::memory_mcp::method(tool, &mut args, true).map_err(|_| denied())?;
        let turn = {
            let s = self.state.lock().map_err(|_| denied())?;
            if s.closed {
                return Err(denied());
            }
            s.active.upgrade().ok_or_else(denied)?
        };
        let lease = turn
            .lease
            .as_ref()
            .map(|h| h.lease.clone())
            .ok_or_else(denied)?;
        if matches!(method, "memory.add" | "memory.update" | "memory.forget") && !lease.writable() {
            return Err(denied());
        }
        let backend = turn.backend.upgrade().ok_or_else(denied)?;
        let admitted = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let changed = turn.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                let registered = self.changed.notified();
                tokio::pin!(registered);
                registered.as_mut().enable();
                if turn.closed.load(Ordering::Acquire) || !backend.check_handle(&lease) {
                    return Err(denied());
                }
                let ready = {
                    let binding = self.state.lock().map_err(|_| denied())?;
                    if binding.closed
                        || binding
                            .thread
                            .as_deref()
                            .is_some_and(|value| value != thread)
                        || !binding
                            .active
                            .upgrade()
                            .is_some_and(|active| Arc::ptr_eq(&active, &turn))
                    {
                        return Err(denied());
                    }
                    let state = turn.state.lock().map_err(|_| denied())?;
                    if state.native.as_deref().is_some_and(|value| value != native) {
                        return Err(denied());
                    }
                    if let Some(entry) = state.ledger.get(call)
                        && (entry.tool != tool
                            || entry.consumed
                            || &entry.arguments != original_args)
                    {
                        return Err(denied());
                    }
                    binding.thread.as_deref() == Some(thread)
                        && state.native.as_deref() == Some(native)
                        && state.ack
                        && state.started
                        && state.ledger.contains_key(call)
                };
                if ready {
                    break;
                }
                tokio::select! {
                    _ = changed => {},
                    _ = registered => {},
                    _ = backend.revoked_handle(&lease) => return Err(denied()),
                }
            }
            backend.accepted_handle(&lease).await?;
            // No await between consuming the native ledger and Backend admission.
            let future = {
                let binding = self.state.lock().map_err(|_| denied())?;
                let mut state = turn.state.lock().map_err(|_| denied())?;
                if binding.closed
                    || turn.closed.load(Ordering::Acquire)
                    || !backend.check_handle(&lease)
                {
                    return Err(denied());
                }
                let entry = state.ledger.get_mut(call).ok_or_else(denied)?;
                if entry.consumed || entry.tool != tool || &entry.arguments != original_args {
                    return Err(denied());
                }
                entry.consumed = true;
                backend.call(lease.clone(), method.into(), args)
            };
            Ok(future)
        })
        .await
        .map_err(|_| denied())??;
        admitted.await
    }
}
impl Turn {
    pub(crate) fn enabled(&self) -> bool {
        self.lease.is_some()
    }
    pub(crate) fn native(&self, native: &str, ack: bool, started: bool) -> Result<(), MemoryError> {
        if !identity(native) {
            return Err(denied());
        }
        self.registration
            .upgrade()
            .ok_or_else(denied)?
            .claim_native(self, native)?;
        let mut state = self.state.lock().map_err(|_| denied())?;
        if self.closed.load(Ordering::Acquire)
            || !identity(native)
            || state.native.as_deref().is_some_and(|v| v != native)
        {
            return Err(denied());
        }
        state.native = Some(native.into());
        state.ack |= ack;
        state.started |= started;
        self.changed.notify_waiters();
        Ok(())
    }
    pub(crate) fn ledger(&self, native: &str, item: &Value) -> Result<(), MemoryError> {
        if item["server"] != "pult_memory" {
            return Ok(());
        }
        let result = (|| {
            let id = item["id"]
                .as_str()
                .filter(|v| identity(v))
                .ok_or_else(denied)?;
            let tool = item["tool"]
                .as_str()
                .filter(|v| identity(v) && v.len() <= 128)
                .ok_or_else(denied)?;
            let mut state = self.state.lock().map_err(|_| denied())?;
            if self.closed.load(Ordering::Acquire)
                || state.native.as_deref() != Some(native)
                || state.ledger.contains_key(id)
            {
                return Err(denied());
            }
            let arguments = item
                .get("arguments")
                .filter(|v| v.is_object())
                .ok_or_else(denied)?;
            let argument_bytes = serde_json::to_vec(arguments).map_err(|_| denied())?.len();
            if argument_bytes > ENVELOPE_BYTES {
                return Err(capacity());
            }
            let bytes = id.len() + tool.len() + argument_bytes;
            if state.ledger.len() >= LEDGER_CALLS
                || state.bytes.saturating_add(bytes) > LEDGER_BYTES
            {
                return Err(capacity());
            }
            state.bytes += bytes;
            state.ledger.insert(
                id.into(),
                Call {
                    tool: tool.into(),
                    consumed: false,
                    arguments: arguments.clone(),
                },
            );
            self.changed.notify_waiters();
            Ok(())
        })();
        if result.is_err() {
            self.close();
        }
        result
    }
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(backend) = self.backend.upgrade() {
            backend.revoke(&self.ticket)
        }
        self.changed.notify_waiters();
    }
}
impl Drop for Turn {
    fn drop(&mut self) {
        self.close();
    }
}
