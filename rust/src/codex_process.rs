//! Owned Codex app-server connection. This trusted host API is not a public
//! spawn endpoint and does not authorize threads, tools, or model turns.
use crate::codex_rpc::{self, Client, Events, RpcError, WireError};
use crate::worker_process::{Framing, Launch, Process};
use serde_json::{Value, json};
use std::fmt;
use std::future::{Future, poll_fn};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::task::Poll;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidOptions,
    RuntimeUnavailable,
    Launch,
    NotReady,
    Closed,
    Handshake,
    HandshakeTimeout,
    Io,
    SendTimeout,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidOptions => "invalid Codex connection options",
            Self::RuntimeUnavailable => "Codex connection requires an active Tokio runtime",
            Self::Launch => "Codex process startup failed",
            Self::NotReady => "Codex connection is not initialized",
            Self::Closed => "Codex connection closed",
            Self::Handshake => "Codex initialization failed",
            Self::HandshakeTimeout => "Codex initialization timed out",
            Self::Io => "Codex process transport failed",
            Self::SendTimeout => "Codex process write timed out",
        })
    }
}
impl std::error::Error for Error {}
#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub handshake: Duration,
    pub send: Duration,
}
impl Default for Timeouts {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(30),
            send: Duration::from_secs(5),
        }
    }
}
impl Timeouts {
    fn validate(self) -> Result<(), Error> {
        if [self.handshake, self.send]
            .into_iter()
            .any(|d| d.is_zero() || d > Duration::from_secs(120))
        {
            Err(Error::InvalidOptions)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Unconfirmed,
}
#[derive(Clone)]
pub struct Cleanup {
    status: watch::Receiver<CleanupStatus>,
    retry: mpsc::Sender<()>,
    retrying: Arc<AtomicBool>,
}
impl Cleanup {
    pub fn status(&self) -> CleanupStatus {
        *self.status.borrow()
    }
    pub fn subscribe(&self) -> watch::Receiver<CleanupStatus> {
        self.status.clone()
    }
    /// Queue at most one retry. Never blocks and never claims successful cleanup.
    pub fn retry(&self) -> bool {
        if self.status() != CleanupStatus::Unconfirmed
            || self
                .retrying
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return false;
        }
        if self.retry.try_send(()).is_err() {
            self.retrying.store(false, Ordering::Release);
            return false;
        }
        true
    }
    pub async fn finished(&mut self) -> CleanupStatus {
        loop {
            let value = self.status();
            if matches!(value, CleanupStatus::Stopped | CleanupStatus::Unconfirmed) {
                return value;
            }
            if self.status.changed().await.is_err() {
                return self.status();
            }
        }
    }
}
#[derive(Clone, Copy)]
enum Phase {
    Initializing,
    Ready,
    Failed(Error),
}
pub struct Connection {
    client: Client,
    pub events: Events,
    phase: watch::Receiver<Phase>,
    cleanup: Cleanup,
}
impl Connection {
    /// Available only after the owned initialize/initialized handshake succeeds.
    pub fn client(&self) -> Result<Client, Error> {
        if self.client.shutdown_signal().borrow().is_some() {
            return Err(Error::Closed);
        }
        match *self.phase.borrow() {
            Phase::Ready => Ok(self.client.clone()),
            Phase::Initializing => Err(Error::NotReady),
            Phase::Failed(error) => Err(error),
        }
    }
    pub async fn ready(&mut self) -> Result<Client, Error> {
        loop {
            match *self.phase.borrow() {
                Phase::Ready => return self.client(),
                Phase::Failed(error) => return Err(error),
                Phase::Initializing => {}
            }
            if self.phase.changed().await.is_err() {
                return Err(Error::Closed);
            }
        }
    }
    pub fn cleanup(&self) -> Cleanup {
        self.cleanup.clone()
    }
    pub fn shutdown(&self) {
        self.client.shutdown();
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.client.shutdown();
    }
}

/// Starts an owned task synchronously, before the caller can await/cancel ready.
/// A trusted host Launch is required; no command RPC is exposed. Pure shape
/// checks are synchronous; filesystem validation is owned by the startup task.
pub fn start(launch: Launch, timeouts: Timeouts) -> Result<Connection, Error> {
    let runtime = tokio::runtime::Handle::try_current().map_err(|_| Error::RuntimeUnavailable)?;
    timeouts.validate()?;
    launch.validate_shape().map_err(|_| Error::Launch)?;
    let (wire, peer) = codex_rpc::memory_wire(2);
    let (client, events) =
        codex_rpc::spawn(wire, codex_rpc::Limits::default()).map_err(|_| Error::InvalidOptions)?;
    let (phase, phase_rx) = watch::channel(Phase::Initializing);
    let (status, status_rx) = watch::channel(CleanupStatus::Starting);
    let (retry, retries) = mpsc::channel(1);
    let retrying = Arc::new(AtomicBool::new(false));
    let cleanup = Cleanup {
        status: status_rx,
        retry,
        retrying: retrying.clone(),
    };
    runtime.spawn(own(
        launch,
        timeouts,
        client.clone(),
        peer,
        phase,
        status,
        retries,
        retrying,
    ));
    Ok(Connection {
        client,
        events,
        phase: phase_rx,
        cleanup,
    })
}
fn fail_phase(phase: &watch::Sender<Phase>, error: Error) {
    phase.send_if_modified(|value| {
        if matches!(value, Phase::Failed(_)) {
            false
        } else {
            *value = Phase::Failed(error);
            true
        }
    });
}
async fn initialize(
    client: Client,
    phase: watch::Sender<Phase>,
    timeout: Duration,
    written: oneshot::Receiver<()>,
) {
    let result = tokio::time::timeout(timeout, async {
        let value = client
            .request(
                "initialize",
                json!({
                    "clientInfo":{"name":"pult","version":env!("CARGO_PKG_VERSION")},
                    "capabilities":{"experimentalApi":true}
                }),
                timeout,
            )
            .await
            .map_err(|error| {
                if error == RpcError::Timeout {
                    Error::HandshakeTimeout
                } else {
                    Error::Handshake
                }
            })?;
        if !value.is_object() {
            return Err(Error::Handshake);
        }
        client
            .notify("initialized", json!({}))
            .await
            .map_err(|_| Error::Handshake)?;
        written.await.map_err(|_| Error::Handshake)?;
        Ok(())
    })
    .await
    .unwrap_or(Err(Error::HandshakeTimeout));
    match result {
        Ok(()) => {
            phase.send_if_modified(|value| {
                if matches!(value, Phase::Initializing) {
                    *value = Phase::Ready;
                    true
                } else {
                    false
                }
            });
        }
        Err(error) => {
            fail_phase(&phase, error);
            client.shutdown();
        }
    }
}

// A write is polled only under the actor's shutdown read guard, so publication
// cannot race a new poll/send. The guard is dropped before every actual await.
// Cancelling this inline future drops Process::send's WriteGuard before the
// owner can enter stop; there is no detached write task to outlive cleanup.
async fn send(
    process: &mut Process,
    frame: &Value,
    client: &Client,
    timeout: Duration,
) -> Result<(), Error> {
    let shutdown = client.shutdown_signal();
    let mut write = std::pin::pin!(process.send(frame));
    let guarded = poll_fn(|cx| {
        let state = shutdown.borrow();
        if state.is_some() {
            return Poll::Ready(Err(Error::Closed));
        }
        match write.as_mut().poll(cx) {
            Poll::Ready(result) => Poll::Ready(result.map_err(|_| Error::Io)),
            Poll::Pending => Poll::Pending,
        }
    });
    tokio::pin!(guarded);
    // Separate receiver avoids mutably borrowing the receiver used by the guard.
    let mut stop = client.shutdown_signal();
    tokio::select! {
        _ = stop.changed() => Err(Error::Closed),
        result = tokio::time::timeout(timeout, &mut guarded) => result.unwrap_or(Err(Error::SendTimeout)),
    }
}
async fn read(
    mut output: mpsc::Receiver<anyhow::Result<Value>>,
    inbound: mpsc::Sender<Result<Value, WireError>>,
    client: Client,
) {
    let mut stop = client.shutdown_signal();
    loop {
        if stop.borrow().is_some() {
            return;
        }
        let frame = tokio::select! { _ = stop.changed() => return, frame = output.recv() => frame };
        // EOF closes the only inbound sender after all preceding frames. The
        // actor drains its queue before publishing shutdown; do not overtake
        // tail replies/notifications by shutting it down from this reader.
        let (frame, failed) = match frame {
            Some(Ok(frame)) => (Ok(frame), false),
            Some(Err(_)) => (Err(WireError::Failed), true),
            None => return,
        };
        tokio::select! {
            _ = stop.changed() => return,
            sent = inbound.send(frame) => if sent.is_err() { client.shutdown(); return; },
        }
        if failed {
            return;
        }
    }
}
#[allow(clippy::too_many_arguments)]
async fn own(
    launch: Launch,
    timeouts: Timeouts,
    client: Client,
    mut peer: codex_rpc::MemoryPeer,
    phase: watch::Sender<Phase>,
    status: watch::Sender<CleanupStatus>,
    mut retries: mpsc::Receiver<()>,
    retrying: Arc<AtomicBool>,
) {
    let mut process = match Process::spawn_owned(launch, Framing::codex()).await {
        Ok(process) => process,
        Err(failure) => {
            fail_phase(&phase, Error::Launch);
            client.shutdown();
            if let Some(mut process) = failure.process {
                cleanup_process(&mut process, &status, &mut retries, &retrying).await;
            } else {
                status.send_replace(CleanupStatus::Stopped);
            }
            return;
        }
    };
    status.send_replace(CleanupStatus::Running);
    let mut shutdown = client.shutdown_signal();
    let output = match process.take_output() {
        Ok(output) => output,
        Err(_) => {
            fail_phase(&phase, Error::Io);
            client.shutdown();
            cleanup_process(&mut process, &status, &mut retries, &retrying).await;
            return;
        }
    };
    let reader = tokio::spawn(read(output, peer.outbound, client.clone()));
    let (written, initialized) = oneshot::channel();
    let mut written = Some(written);
    let handshake = if shutdown.borrow().is_none() {
        Some(tokio::spawn(initialize(
            client.clone(),
            phase.clone(),
            timeouts.handshake,
            initialized,
        )))
    } else {
        None
    };
    let failure = loop {
        if shutdown.borrow().is_some() {
            break Error::Closed;
        }
        let frame = tokio::select! { _ = shutdown.changed() => break Error::Closed, frame = peer.inbound.recv() => frame };
        let Some(frame) = frame else {
            break Error::Closed;
        };
        if let Err(error) = send(&mut process, &frame, &client, timeouts.send).await {
            break error;
        }
        if frame.get("method").and_then(Value::as_str) == Some("initialized")
            && let Some(written) = written.take()
        {
            let _ = written.send(());
        }
    };
    client.shutdown();
    fail_phase(&phase, failure);
    if let Some(handshake) = handshake {
        handshake.abort();
        let _ = handshake.await;
    }
    reader.abort();
    let _ = reader.await;
    cleanup_process(&mut process, &status, &mut retries, &retrying).await;
}
async fn cleanup_process(
    process: &mut Process,
    status: &watch::Sender<CleanupStatus>,
    retries: &mut mpsc::Receiver<()>,
    retrying: &AtomicBool,
) {
    loop {
        status.send_replace(CleanupStatus::Stopping);
        let stopped = process.stop().await.is_ok();
        status.send_replace(if stopped {
            CleanupStatus::Stopped
        } else {
            CleanupStatus::Unconfirmed
        });
        retrying.store(false, Ordering::Release);
        if stopped {
            return;
        }
        // Process remains in the owned task on every error, including when all
        // external handles disappear. A missing retry handle is not exit proof.
        if retries.recv().await.is_none() {
            std::future::pending::<()>().await;
        }
    }
}
