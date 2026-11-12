//! In-memory JSON-RPC multiplexing for one Codex app-server generation.
//!
//! This layer neither starts processes nor grants thread ownership. The transport
//! bridge must observe `shutdown_signal`, terminate its process and bound framing
//! to 16 MiB. Handshake (`initialize`, then `initialized`) belongs to the caller.
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::time::Instant;

pub const MAX_PENDING: usize = 256;
/// Protocol method names are short; bound peer-controlled names independently.
pub const MAX_METHOD_BYTES: usize = 256;
pub const MAX_PAYLOAD: usize = 16 * 1024 * 1024;
const MAX_ID: u64 = 9_007_199_254_740_991;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, PartialEq, Eq)]
pub enum RpcError {
    Closed,
    Shutdown,
    Timeout,
    Capacity,
    Backpressure,
    PayloadTooLarge,
    InvalidFrame,
    InvalidPermit,
    IdExhausted,
    Wire(WireError),
    Remote(ResponseError),
}
impl fmt::Debug for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Closed => "Codex RPC closed",
            Self::Shutdown => "Codex RPC shutdown",
            Self::Timeout => "Codex RPC request timed out",
            Self::Capacity => "Codex RPC capacity exhausted",
            Self::Backpressure => "Codex RPC backpressure",
            Self::PayloadTooLarge => "Codex RPC payload too large",
            Self::InvalidFrame => "invalid Codex RPC frame",
            Self::InvalidPermit => "invalid Codex RPC response permit",
            Self::IdExhausted => "Codex RPC ID space exhausted",
            Self::Wire(_) => "Codex RPC transport failed",
            Self::Remote(_) => "Codex RPC remote error",
        })
    }
}
impl std::error::Error for RpcError {}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    Eof,
    Failed,
    InvalidFrame,
    PayloadTooLarge,
}
/// Deliberately has no Debug implementation: messages/data can contain secrets.
#[derive(Clone, PartialEq, Eq)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}
impl ResponseError {
    pub fn denied() -> Self {
        Self {
            code: -32000,
            message: "request denied".into(),
            data: None,
        }
    }
}
/// Transport-owned queues must have bounded capacities; spawn checks their worst
/// case serialized payload footprint against Limits::queued_bytes.
pub struct Wire {
    pub outbound: mpsc::Sender<Value>,
    pub inbound: mpsc::Receiver<Result<Value, WireError>>,
}
pub struct MemoryPeer {
    pub inbound: mpsc::Receiver<Value>,
    pub outbound: mpsc::Sender<Result<Value, WireError>>,
}
pub fn memory_wire(capacity: usize) -> (Wire, MemoryPeer) {
    let (send, inbound) = mpsc::channel(capacity);
    let (outbound, recv) = mpsc::channel(capacity);
    (
        Wire { outbound, inbound },
        MemoryPeer {
            inbound: recv,
            outbound: send,
        },
    )
}
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Nonzero and at most MAX_PENDING (also prevents Tokio channel panics).
    pub command_slots: usize,
    /// Nonzero and at most MAX_PENDING.
    pub event_slots: usize,
    pub max_payload: usize,
    /// Aggregate serialized JSON bytes for queued commands, pending writes, events and retained
    /// response capabilities; each wire
    /// direction is additionally restricted to at most this worst-case budget.
    pub queued_bytes: usize,
    /// Maximum simultaneous server requests, hard capped at MAX_PENDING.
    pub server_ids: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            command_slots: 64,
            event_slots: 64,
            max_payload: MAX_PAYLOAD,
            queued_bytes: 32 * 1024 * 1024,
            server_ids: MAX_PENDING,
        }
    }
}
#[derive(Clone)]
pub struct Client {
    inner: Arc<Shared>,
}
struct Shared {
    commands: mpsc::Sender<Envelope>,
    stop: watch::Sender<Option<RpcError>>,
    bytes: Arc<Semaphore>,
    pending: Arc<Semaphore>,
    prune: Notify,
    max_payload: usize,
}
pub struct Events {
    receiver: mpsc::Receiver<EventEnvelope>,
}
pub enum Event {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        method: String,
        params: Value,
        permit: ResponsePermit,
    },
}
struct EventEnvelope {
    event: Event,
    _bytes: OwnedSemaphorePermit,
}
impl Events {
    pub async fn recv(&mut self) -> Option<Event> {
        self.receiver.recv().await.map(|v| v.event)
    }
}
/// A capability for exactly one server request, not an authorization decision.
/// Dropping it produces a generic error; queue failure closes the generation.
pub struct ResponsePermit {
    client: Client,
    id: Option<Value>,
    method: String,
    nonce: u64,
}
impl ResponsePermit {
    pub fn id(&self) -> &Value {
        self.id.as_ref().expect("live permit")
    }
    pub fn method(&self) -> &str {
        &self.method
    }
}
impl Drop for ResponsePermit {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let answer = Err(ResponseError::denied());
            match payload_size(
                &response_frame(id.clone(), &answer),
                self.client.inner.max_payload,
            ) {
                Ok(size) => {
                    let _ = self.client.enqueue(
                        Command::Respond {
                            id,
                            nonce: self.nonce,
                            answer,
                            reply: None,
                        },
                        size,
                    );
                }
                Err(error) => self.client.close(error),
            }
        }
    }
}
struct Envelope {
    command: Command,
    _bytes: OwnedSemaphorePermit,
}
type Reply = oneshot::Sender<Result<Value, RpcError>>;
enum Command {
    Request {
        method: String,
        params: Value,
        deadline: Instant,
        reply: Reply,
        _slot: OwnedSemaphorePermit,
    },
    Notify {
        method: String,
        params: Value,
        reply: Reply,
    },
    Respond {
        id: Value,
        nonce: u64,
        answer: Result<Value, ResponseError>,
        reply: Option<Reply>,
    },
}
struct Pending {
    sent: bool,
    deadline: Instant,
    reply: Reply,
    _slot: OwnedSemaphorePermit,
}
struct Write {
    frame: Value,
    action: WriteAction,
    _bytes: OwnedSemaphorePermit,
}
enum WriteAction {
    Request(u64),
    Notify(Reply),
    Respond {
        key: String,
        nonce: u64,
        reply: Option<Reply>,
    },
}
fn reject_write(write: Write, error: RpcError) {
    let reply = match write.action {
        WriteAction::Request(_) => None,
        WriteAction::Notify(reply) => Some(reply),
        WriteAction::Respond { reply, .. } => reply,
    };
    if let Some(reply) = reply {
        let _ = reply.send(Err(error));
    }
}
struct Cancellation {
    receiver: oneshot::Receiver<Result<Value, RpcError>>,
    shared: Arc<Shared>,
}
impl Drop for Cancellation {
    fn drop(&mut self) {
        self.receiver.close();
        self.shared.prune.notify_one();
    }
}

impl Client {
    pub fn shutdown_signal(&self) -> watch::Receiver<Option<RpcError>> {
        self.inner.stop.subscribe()
    }
    pub fn shutdown(&self) {
        self.close(RpcError::Shutdown);
    }
    fn close(&self, error: RpcError) {
        self.inner.stop.send_if_modified(|s| {
            if s.is_none() {
                *s = Some(error);
                true
            } else {
                false
            }
        });
    }
    fn enqueue(&self, command: Command, bytes: usize) -> Result<(), RpcError> {
        if let Some(error) = self.inner.stop.borrow().clone() {
            return Err(error);
        }
        if bytes > self.inner.max_payload {
            return Err(RpcError::PayloadTooLarge);
        }
        let budget = self
            .inner
            .bytes
            .clone()
            .try_acquire_many_owned(bytes as u32)
            .map_err(|_| {
                self.close(RpcError::Backpressure);
                RpcError::Backpressure
            })?;
        self.inner
            .commands
            .try_send(Envelope {
                command,
                _bytes: budget,
            })
            .map_err(|_| {
                self.close(RpcError::Backpressure);
                RpcError::Backpressure
            })
    }
    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        let method = method.into();
        let size = payload_size(
            &json!({"id":MAX_ID,"method":method,"params":params}),
            self.inner.max_payload,
        )?;
        let slot = self
            .inner
            .pending
            .clone()
            .try_acquire_owned()
            .map_err(|_| RpcError::Capacity)?;
        let (reply, recv) = oneshot::channel();
        let mut cancellation = Cancellation {
            receiver: recv,
            shared: self.inner.clone(),
        };
        self.enqueue(
            Command::Request {
                method,
                params,
                deadline: Instant::now()
                    .checked_add(timeout)
                    .ok_or(RpcError::Timeout)?,
                reply,
                _slot: slot,
            },
            size,
        )?;
        (&mut cancellation.receiver)
            .await
            .unwrap_or(Err(RpcError::Closed))
    }
    pub async fn notify(&self, method: impl Into<String>, params: Value) -> Result<(), RpcError> {
        let method = method.into();
        let size = payload_size(
            &json!({"method":method,"params":params}),
            self.inner.max_payload,
        )?;
        let (reply, recv) = oneshot::channel();
        self.enqueue(
            Command::Notify {
                method,
                params,
                reply,
            },
            size,
        )?;
        recv.await.unwrap_or(Err(RpcError::Closed)).map(|_| ())
    }
    pub async fn respond(
        &self,
        mut permit: ResponsePermit,
        answer: Result<Value, ResponseError>,
    ) -> Result<(), RpcError> {
        if !Arc::ptr_eq(&self.inner, &permit.client.inner) {
            return Err(RpcError::InvalidPermit);
        }
        let id = permit.id.as_ref().ok_or(RpcError::InvalidPermit)?.clone();
        let size = payload_size(&response_frame(id.clone(), &answer), self.inner.max_payload)?;
        let (reply, recv) = oneshot::channel();
        self.enqueue(
            Command::Respond {
                id,
                nonce: permit.nonce,
                answer,
                reply: Some(reply),
            },
            size,
        )?;
        permit.id.take();
        recv.await.unwrap_or(Err(RpcError::Closed)).map(|_| ())
    }
}
fn payload_size(value: &Value, limit: usize) -> Result<usize, RpcError> {
    let size = serde_json::to_vec(value)
        .map_err(|_| RpcError::InvalidFrame)?
        .len();
    if size > limit {
        Err(RpcError::PayloadTooLarge)
    } else {
        Ok(size)
    }
}
fn response_frame(id: Value, answer: &Result<Value, ResponseError>) -> Value {
    match answer {
        Ok(result) => json!({"id":id,"result":result}),
        Err(error) => {
            let mut frame = json!({"id":id,"error":{"code":error.code,"message":error.message}});
            if let Some(data) = &error.data {
                frame["error"]["data"] = data.clone();
            }
            frame
        }
    }
}
fn id_key(value: &Value) -> Option<String> {
    if let Some(id) = value.as_str() {
        Some(format!("s:{id}"))
    } else {
        value.as_i64().map(|id| format!("n:{id}"))
    }
}
pub fn spawn(wire: Wire, limits: Limits) -> Result<(Client, Events), RpcError> {
    if limits.command_slots == 0
        || limits.command_slots > MAX_PENDING
        || limits.event_slots == 0
        || limits.event_slots > MAX_PENDING
        || limits.server_ids == 0
        || limits.server_ids > MAX_PENDING
        || limits.max_payload == 0
        || limits.max_payload > MAX_PAYLOAD
        || limits.queued_bytes > Semaphore::MAX_PERMITS
        || limits.queued_bytes > u32::MAX as usize
        || limits.queued_bytes < limits.max_payload
        || wire
            .outbound
            .max_capacity()
            .checked_mul(limits.max_payload)
            .is_none_or(|n| n > limits.queued_bytes)
        || wire
            .inbound
            .max_capacity()
            .checked_mul(limits.max_payload)
            .is_none_or(|n| n > limits.queued_bytes)
    {
        return Err(RpcError::Capacity);
    }
    let (commands, receiver) = mpsc::channel(limits.command_slots);
    let (events, event_receiver) = mpsc::channel(limits.event_slots);
    let (stop, _) = watch::channel(None);
    let client = Client {
        inner: Arc::new(Shared {
            commands,
            stop,
            bytes: Arc::new(Semaphore::new(limits.queued_bytes)),
            pending: Arc::new(Semaphore::new(MAX_PENDING)),
            prune: Notify::new(),
            max_payload: limits.max_payload,
        }),
    };
    tokio::spawn(run(client.clone(), wire, receiver, events, limits));
    Ok((
        client,
        Events {
            receiver: event_receiver,
        },
    ))
}
async fn run(
    client: Client,
    mut wire: Wire,
    mut commands: mpsc::Receiver<Envelope>,
    events: mpsc::Sender<EventEnvelope>,
    limits: Limits,
) {
    let mut stopped = client.shutdown_signal();
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    let mut permits = HashMap::new();
    let mut next_nonce = 1u64;
    let mut writes: VecDeque<Write> = VecDeque::new();
    let outcome: Result<(), RpcError> = async {
        loop {
            pending.retain(|_, p| !p.reply.is_closed());
            let now = Instant::now();
            let expired: Vec<_> = pending.iter().filter(|(_, p)| p.deadline <= now).map(|(id, _)| *id).collect();
            for id in expired { if let Some(p) = pending.remove(&id) { let _ = p.reply.send(Err(RpcError::Timeout)); } }
            writes.retain(|write| match write.action { WriteAction::Request(id) => pending.contains_key(&id), _ => true });
            let deadline = pending.values().map(|p| p.deadline).min().unwrap_or(now + Duration::from_secs(86400));
            if let Some(error) = stopped.borrow().clone() { return Err(error); }
            tokio::select! {
                _ = stopped.changed() => return Err(stopped.borrow().clone().unwrap_or(RpcError::Closed)),
                _ = client.inner.prune.notified() => {},
                _ = tokio::time::sleep_until(deadline) => {},
                _ = events.closed() => return Err(RpcError::Closed),
                reserved = wire.outbound.reserve(), if !writes.is_empty() => {
                    let slot = reserved.map_err(|_| RpcError::Wire(WireError::Failed))?;
                    // Publication and actual wire enqueue are serialized. This
                    // guard never crosses an await (reservation happened above).
                    let dispatch = client.inner.stop.borrow();
                    if let Some(error) = dispatch.as_ref() { return Err(error.clone()); }
                    let write = writes.pop_front().expect("nonempty writes");
                    match write.action {
                        WriteAction::Request(id) => {
                            let Some(p) = pending.get_mut(&id) else { continue; };
                            if p.reply.is_closed() { pending.remove(&id); continue; }
                            if p.deadline <= Instant::now() {
                                if let Some(p) = pending.remove(&id) { let _ = p.reply.send(Err(RpcError::Timeout)); }
                                continue;
                            }
                            p.sent = true;
                            slot.send(write.frame);
                        }
                        WriteAction::Notify(reply) => { slot.send(write.frame); let _ = reply.send(Ok(Value::Null)); }
                        WriteAction::Respond { key, nonce, reply } => {
                            if permits.get(&key).map(|(n, _)| n) != Some(&nonce) {
                                if let Some(reply) = reply { let _ = reply.send(Err(RpcError::InvalidPermit)); }
                                continue;
                            }
                            slot.send(write.frame);
                            permits.remove(&key);
                            if let Some(reply) = reply { let _ = reply.send(Ok(Value::Null)); }
                        }
                    }
                }
                command = commands.recv() => {
                    let Some(Envelope { command, _bytes }) = command else { return Err(RpcError::Closed); };
                    if let Some(error) = stopped.borrow().clone() { reject(command, error.clone()); return Err(error); }
                    if writes.len() >= limits.command_slots {
                        reject(command, RpcError::Backpressure);
                        return Err(RpcError::Backpressure);
                    }
                    let (frame, action) = match command {
                        Command::Request { method, params, deadline, reply, _slot } => {
                            if reply.is_closed() { continue; }
                            if deadline <= Instant::now() { let _ = reply.send(Err(RpcError::Timeout)); continue; }
                            let id = NEXT_ID.try_update(Ordering::Relaxed, Ordering::Relaxed, |n| (n <= MAX_ID).then_some(n + 1)).map_err(|_| RpcError::IdExhausted)?;
                            pending.insert(id, Pending { sent: false, deadline, reply, _slot });
                            (json!({"id":id,"method":method,"params":params}), WriteAction::Request(id))
                        }
                        Command::Notify { method, params, reply } => {
                            (json!({"method":method,"params":params}), WriteAction::Notify(reply))
                        }
                        Command::Respond { id, nonce, answer, reply } => {
                            let key = id_key(&id).ok_or(RpcError::InvalidPermit)?;
                            if permits.get(&key).map(|(n, _)| n) != Some(&nonce) { if let Some(reply) = reply { let _ = reply.send(Err(RpcError::InvalidPermit)); } continue; }
                            (response_frame(id, &answer), WriteAction::Respond { key, nonce, reply })
                        }
                    };
                    writes.push_back(Write { frame, action, _bytes });
                }
                frame = wire.inbound.recv() => {
                    let frame = frame.ok_or(RpcError::Wire(WireError::Eof))?.map_err(RpcError::Wire)?;
                    let size = payload_size(&frame, limits.max_payload)?;
                    if !frame.is_object() || frame.get("jsonrpc").is_some_and(|v| v != "2.0") { return Err(RpcError::InvalidFrame); }
                    let id = frame.get("id");
                    let method = frame.get("method");
                    if let Some(method) = method {
                        let method = method.as_str().filter(|m| !m.is_empty() && m.len() <= MAX_METHOD_BYTES).ok_or(RpcError::InvalidFrame)?.to_owned();
                        if frame.get("result").is_some() || frame.get("error").is_some() { return Err(RpcError::InvalidFrame); }
                        let params = frame.get("params").cloned().unwrap_or(Value::Null);
                        let event = if let Some(id) = id {
                            let key = id_key(id).ok_or(RpcError::InvalidFrame)?;
                            if permits.len() >= limits.server_ids || permits.contains_key(&key) { return Err(RpcError::InvalidPermit); }
                            let nonce = next_nonce;
                            next_nonce = next_nonce.checked_add(1).ok_or(RpcError::IdExhausted)?;
                            // Retained IDs are peer-controlled and can be large.
                            let retained = key.len().checked_mul(2).and_then(|n| n.checked_add(method.len())).ok_or(RpcError::Backpressure)?;
                            let retained = u32::try_from(retained).map_err(|_| RpcError::Backpressure)?;
                            let budget = client.inner.bytes.clone().try_acquire_many_owned(retained).map_err(|_| RpcError::Backpressure)?;
                            permits.insert(key, (nonce, budget));
                            Event::ServerRequest { method: method.clone(), params, permit: ResponsePermit { client: client.clone(), id: Some(id.clone()), method, nonce } }
                        } else { Event::Notification { method, params } };
                        let budget = client.inner.bytes.clone().try_acquire_many_owned(size as u32).map_err(|_| RpcError::Backpressure)?;
                        events.try_send(EventEnvelope { event, _bytes: budget }).map_err(|_| RpcError::Backpressure)?;
                    } else {
                        let id = id.ok_or(RpcError::InvalidFrame)?;
                        id_key(id).ok_or(RpcError::InvalidFrame)?;
                        if frame.get("result").is_some() == frame.get("error").is_some() { return Err(RpcError::InvalidFrame); }
                        let answer = if let Some(error) = frame.get("error") {
                            Err(RpcError::Remote(ResponseError { code: error.get("code").and_then(Value::as_i64).ok_or(RpcError::InvalidFrame)?, message: error.get("message").and_then(Value::as_str).ok_or(RpcError::InvalidFrame)?.into(), data: error.get("data").cloned() }))
                        } else { Ok(frame["result"].clone()) };
                        // Late, unknown and duplicate response IDs never acquire a permit.
                        if let Some(id) = id.as_u64()
                            && pending.get(&id).is_some_and(|p| p.sent)
                            && let Some(p) = pending.remove(&id) { let _ = p.reply.send(answer); }
                    }
                }
            }
        }
    }.await;
    let error = outcome.err().unwrap_or(RpcError::Closed);
    client.close(error.clone());
    commands.close();
    for (_, p) in pending {
        let _ = p.reply.send(Err(error.clone()));
    }
    for write in writes {
        reject_write(write, error.clone());
    }
    while let Ok(envelope) = commands.try_recv() {
        reject(envelope.command, error.clone());
    }
}

fn reject(command: Command, error: RpcError) {
    let reply = match command {
        Command::Request { reply, .. } | Command::Notify { reply, .. } => Some(reply),
        Command::Respond { reply, .. } => reply,
    };
    if let Some(reply) = reply {
        let _ = reply.send(Err(error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_nonce_drop_cannot_deny_reused_server_id() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (wire, mut peer) = memory_wire(1);
            let (client, mut events) = spawn(wire, Limits::default()).unwrap();
            peer.outbound
                .send(Ok(json!({"id":"reused","method":"permission"})))
                .await
                .unwrap();
            let Some(Event::ServerRequest { permit, .. }) = events.recv().await else {
                panic!("request");
            };
            // Deliberately forge a stale internal capability to exercise nonce
            // validation. Public callers cannot clone or construct permits.
            let stale = ResponsePermit {
                client: client.clone(),
                id: Some(permit.id().clone()),
                method: permit.method().into(),
                nonce: permit.nonce,
            };
            client
                .respond(permit, Err(ResponseError::denied()))
                .await
                .unwrap();
            peer.inbound.recv().await.unwrap();
            peer.outbound
                .send(Ok(json!({"id":"reused","method":"permission"})))
                .await
                .unwrap();
            let Some(Event::ServerRequest { permit, .. }) = events.recv().await else {
                panic!("request");
            };
            drop(stale);
            // Queued after stale abandonment: receipt is an actor barrier.
            client.notify("barrier", Value::Null).await.unwrap();
            assert_eq!(peer.inbound.recv().await.unwrap()["method"], "barrier");
            client
                .respond(permit, Ok(json!({"decision":"decline"})))
                .await
                .unwrap();
            assert_eq!(
                peer.inbound.recv().await.unwrap()["result"]["decision"],
                "decline"
            );
            client.shutdown();
        })
        .await
        .expect("10 second watchdog");
    }
}
