#![forbid(unsafe_code)]
pub mod ask_mcp;
pub mod claude_ask;
pub mod claude_events;
pub mod claude_host_services;
pub mod claude_launch;
pub mod claude_mcp;
pub mod claude_runtime;
pub mod claude_settings;
pub mod claude_worker;
pub mod codex_events;
pub mod codex_host_services;
pub mod codex_permissions;
pub mod codex_process;
pub mod codex_rpc;
pub mod codex_runtime;
pub mod codex_worker;
pub mod consent_store;
mod history;
mod host_jobs;
pub mod host_paths;
pub mod host_policy;
pub mod journal;
mod locale;
pub mod mcp_stdio;
mod memory;
mod memory_api;
mod memory_catalog;
pub mod memory_client;
pub mod memory_mcp;
pub mod memory_policy;
mod memory_project;
pub(crate) mod memory_turn;
pub mod network_guard;
mod owner_trust;
pub mod panic_guard;
pub mod permission_broker;
mod permission_state;
pub mod prompt_attachments;
mod provider_runtime;
mod read_api;
pub mod redaction;
pub mod registry;
pub mod runtime_bootstrap;
pub mod runtime_config;
mod runtime_journal;
mod runtime_state;
mod session_api;
pub mod session_create;
pub mod session_live;
mod session_memory;
mod session_memory_api;
mod session_model;
mod session_queue;
mod session_read;
mod session_runtime_api;
mod session_tree;
mod snapshot;
mod stream;
mod subscriptions;
pub mod turn_coordinator;
pub mod turn_driver;
pub mod turn_journal;
pub mod turn_snapshot;
pub mod worker_env;
pub mod worker_process;
pub mod zcode_events;
pub mod zcode_host_services;
pub mod zcode_launch;
pub mod zcode_worker;

use anyhow::{Context, Result, bail, ensure};
use chrono::Utc;
use fs2::FileExt;
use nix::sys::signal::kill;
use nix::unistd::Pid;
use serde::Serialize;
use serde_json::value::{RawValue, to_raw_value};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL: u64 = 1;
pub const MAX_LINE: usize = 1024 * 1024;
// Catalog inventory spans roles. Owner transport rejects ask-only methods
// before ordinary session dispatch; scoped hello advertises its own methods.
pub const PARTIAL: [&str; 11] = [
    "agent.start",
    "agent.list",
    "agent.prompt",
    "agent.stop",
    "agent.queue.send",
    "agent.queue.resume",
    "agent.queue.remove",
    "agent.queue.move",
    "perm.list",
    "perm.request",
    "perm.resolve",
];
pub const SUPPORTED: [&str; 28] = [
    "agent.archive",
    "agent.read",
    "agent.rename",
    "agent.seen",
    "agent.tree",
    "daemon.status",
    "daemon.stop",
    "events.emit",
    "events.get",
    "events.history",
    "events.snapshot",
    "events.subscribe",
    "events.tail",
    "events.unsubscribe",
    "memory.add",
    "memory.catalog",
    "memory.configure",
    "memory.context.bind",
    "memory.context.issue",
    "memory.context.revoke",
    "memory.context.status",
    "memory.forget",
    "memory.get",
    "memory.history",
    "memory.list",
    "memory.search",
    "memory.update",
    "protocol.catalog",
];
const SCRATCH_MARKER: &str = "pult-rust-scratch-v1\n";

fn marked_scratch(home: &Path) -> Result<bool> {
    let path = home.join(".rust-core-scratch");
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).context("cannot read scratch marker"),
    };
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.permissions().mode() & 0o077 == 0,
        "scratch marker must be a private regular file"
    );
    ensure!(
        metadata.len() == SCRATCH_MARKER.len() as u64,
        "invalid scratch marker"
    );
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    ensure!(contents == SCRATCH_MARKER, "invalid scratch marker");
    Ok(true)
}

fn initialize_scratch(home: &Path) -> Result<()> {
    if !marked_scratch(home)? {
        let mut random = [0; 8];
        getrandom::fill(&mut random)
            .map_err(|error| anyhow::anyhow!("marker randomness: {error}"))?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let temporary = home.join(format!(".rust-core-scratch.{suffix}.tmp"));
        let mut marker = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        let result = (|| -> Result<()> {
            marker.write_all(SCRATCH_MARKER.as_bytes())?;
            marker.sync_all()?;
            fs::hard_link(&temporary, home.join(".rust-core-scratch"))?;
            fs::File::open(home)?.sync_all()?;
            Ok(())
        })();
        let _ = fs::remove_file(temporary);
        result?;
    }
    Ok(())
}

pub fn catalog() -> Value {
    serde_json::from_str(include_str!("../../protocol/methods.json"))
        .expect("checked protocol catalog")
}

fn canonical_candidate(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let parent = path.parent().context("path has no existing ancestor")?;
    Ok(canonical_candidate(parent)?.join(path.file_name().context("missing path name")?))
}

pub fn checked_home(home: &Path) -> Result<PathBuf> {
    ensure!(home.is_absolute(), "--home must be absolute");
    ensure!(
        !fs::symlink_metadata(home).is_ok_and(|m| m.file_type().is_symlink()),
        "home may not be a symlink"
    );
    let canonical = canonical_candidate(home)?;
    let mut protected = Vec::new();
    if let Some(user) = std::env::var_os("HOME") {
        protected.push(PathBuf::from(user).join(".pult"));
    }
    if let Some(configured) = std::env::var_os("PULT_HOME") {
        protected.push(PathBuf::from(configured));
    }
    for path in protected {
        let path = canonical_candidate(&path)?;
        ensure!(
            !canonical.starts_with(&path) && !path.starts_with(&canonical),
            "choose a scratch home separate from production Pult"
        );
    }
    for name in ["config.json", "sessions.json"] {
        if fs::symlink_metadata(canonical.join(name)).is_ok() {
            ensure!(
                marked_scratch(&canonical)?,
                "existing Pult state requires a Rust scratch home"
            );
        }
    }
    if fs::symlink_metadata(canonical.join("events")).is_ok() {
        ensure!(
            marked_scratch(&canonical)?,
            "existing events require a Rust scratch home"
        );
    }
    if canonical.exists() {
        private_directory(&canonical)?;
    }
    ensure!(
        canonical.join("run/pultd.sock").as_os_str().len() < 104,
        "socket path is too long"
    );
    Ok(canonical)
}

fn private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "directory must be regular"
    );
    ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "directory must be private (0700)"
    );
    Ok(())
}

fn make_private(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(path)?;
    }
    private_directory(path)
}

fn ps_field(pid: u32, field: &str) -> Option<String> {
    let mut child = Command::new("/bin/ps")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .args(["-p", &pid.to_string(), "-o", field])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut text = String::new();
                child.stdout.take()?.read_to_string(&mut text).ok()?;
                return (!text.trim().is_empty()).then(|| text.trim().to_string());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn ps_start(pid: u32) -> Option<String> {
    ps_field(pid, "lstart=")
}

fn holder_live(bytes: &[u8]) -> bool {
    let Ok(record) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let Some(pid) = record
        .get("pid")
        .or_else(|| record.is_number().then_some(&record))
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0 && *n <= i32::MAX as u32)
    else {
        return false;
    };
    if kill(Pid::from_raw(pid as i32), None).is_err_and(|e| e == nix::errno::Errno::ESRCH) {
        return false;
    }
    match record
        .get("started")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(recorded) => ps_start(pid).is_none_or(|current| current == recorded),
        None => ps_field(pid, "command=").is_none_or(|command| {
            command.contains("pultd")
                || command.contains("pult/dist")
                || command.contains("daemon/main.js")
        }),
    }
}

// Release the open-file-description lock explicitly after owner cleanup. An
// unrelated child between fork and exec may still hold a duplicate descriptor;
// waiting for its last close would extend daemon ownership beyond this owner.
struct OwnershipGuard(std::fs::File);
impl Drop for OwnershipGuard {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

struct Ownership {
    run: PathBuf,
    record: Vec<u8>,
    token: String,
    socket: Option<(u64, u64)>,
    _guard: OwnershipGuard,
    token_published: bool,
}

impl Ownership {
    fn acquire(home: &Path, started_at: &str) -> Result<Self> {
        make_private(home)?;
        let run = home.join("run");
        make_private(&run)?;
        for name in ["pultd.lock", "token", "rust-owner.guard"] {
            if let Ok(metadata) = fs::symlink_metadata(run.join(name)) {
                ensure!(
                    metadata.is_file() && !metadata.file_type().is_symlink(),
                    "runtime files must be regular files"
                );
            }
        }
        for name in ["pultd.lock", "token", "pultd.sock"] {
            ensure!(
                !fs::symlink_metadata(run.join(name)).is_ok_and(|m| m.file_type().is_symlink()),
                "runtime files may not be symlinks"
            );
        }
        let guard_path = run.join("rust-owner.guard");
        ensure!(
            !fs::symlink_metadata(&guard_path).is_ok_and(|m| m.file_type().is_symlink()),
            "guard may not be a symlink"
        );
        let guard = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(guard_path)?;
        guard
            .try_lock_exclusive()
            .context("another Rust daemon owns this home")?;
        let guard = OwnershipGuard(guard);
        let pid = std::process::id();
        let record = serde_json::to_vec(
            &json!({"pid":pid,"startedAt":started_at,"started":ps_start(pid).context("cannot identify this process")?,"cmd":"pultd-rust"}),
        )?;
        let path = run.join("pultd.lock");
        for _ in 0..4 {
            let temporary = run.join(format!("pultd.lock.{pid}.tmp"));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&record)?;
            file.sync_all()?;
            let published = fs::hard_link(&temporary, &path);
            fs::remove_file(&temporary)?;
            match published {
                Ok(()) => {
                    ensure!(
                        fs::read(&path)? == record,
                        "daemon lock ownership changed after publication"
                    );
                    let mut random = [0; 32];
                    getrandom::fill(&mut random)
                        .map_err(|e| anyhow::anyhow!("token generation: {e}"))?;
                    let token = random
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>();
                    let owner = Self {
                        run,
                        record,
                        token,
                        socket: None,
                        _guard: guard,
                        token_published: false,
                    };
                    ensure!(
                        fs::read(&path)? == owner.record,
                        "daemon lock ownership changed during startup"
                    );
                    return Ok(owner);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let raw = fs::read(&path)?;
                    ensure!(!holder_live(&raw), "another daemon owns this home");
                    ensure!(
                        fs::read(&path)? == raw,
                        "lock changed while probing its owner"
                    );
                    fs::remove_file(&path)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        bail!("cannot acquire daemon lock after concurrent changes")
    }

    fn write_token(&mut self) -> Result<()> {
        let temporary = self.run.join(format!("token.{}.tmp", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(self.token.as_bytes())?;
        file.sync_all()?;
        fs::rename(temporary, self.run.join("token"))?;
        self.token_published = true;
        Ok(())
    }
}

impl Drop for Ownership {
    fn drop(&mut self) {
        use std::os::unix::fs::MetadataExt;
        if fs::read(self.run.join("pultd.lock")).ok().as_deref() != Some(&self.record) {
            return;
        }
        let socket = self.run.join("pultd.sock");
        if fs::symlink_metadata(&socket).is_ok_and(|m| self.socket == Some((m.dev(), m.ino()))) {
            let _ = fs::remove_file(socket);
        }
        if self.token_published
            && fs::read_to_string(self.run.join("token")).ok().as_deref() == Some(&self.token)
        {
            let _ = fs::remove_file(self.run.join("token"));
        }
        let _ = fs::remove_file(self.run.join("pultd.lock"));
    }
}

pub async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Ok(None);
        }
        let count = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |i| i + 1);
        let newline = buffer.get(count.saturating_sub(1)) == Some(&b'\n');
        ensure!(
            line.len() + count - usize::from(newline) <= MAX_LINE,
            "line_too_long"
        );
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if newline {
            if line.iter().all(u8::is_ascii_whitespace) {
                line.clear();
                continue;
            }
            return Ok(Some(line));
        }
    }
}

async fn write_value<W: tokio::io::AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    ensure!(bytes.len() <= MAX_LINE, "response exceeds frame budget");
    tokio::time::timeout(Duration::from_secs(1), writer.write_all(&bytes))
        .await
        .context("slow client write deadline")??;
    Ok(())
}

struct State {
    home: PathBuf,
    started_at: String,
    started: Instant,
    token: String,
    clients: AtomicUsize,
    connection_id: AtomicU64,
    host_jobs: Arc<host_jobs::Tracker>,
    session_commands: Arc<session_runtime_api::Gate>,
    stop: watch::Sender<bool>,
    store: Mutex<journal::EventStore>,
    history: Mutex<history::HistoryCache>,
    registry: Arc<Mutex<registry::Registry>>,
    memory: Mutex<std::result::Result<memory::MemoryStore, String>>,
    session_memory: Mutex<session_memory::SessionMemory>,
    last_event_id: AtomicU64,
    test_mode: bool,
    projection_degraded: AtomicBool,
    subscriptions: AtomicUsize,
    committed: watch::Sender<u64>,
    live_id: AtomicU64,
    driver: OnceLock<Arc<turn_driver::Driver>>,
    execution_storage_failed: AtomicBool,
    execution_admission: Mutex<()>,
    native_runtime: OnceLock<Arc<codex_runtime::CodexRuntime>>,
    memory_turns: OnceLock<Arc<memory_turn::Backend>>,
    claude_asks: OnceLock<Arc<claude_ask::Backend>>,
    permissions: OnceLock<permission_broker::Broker>,
    claude_runtime: OnceLock<Arc<runtime_state::Claude>>,
    zcode_runtime: OnceLock<Arc<runtime_state::Zcode>>,
    runtime_init: Mutex<()>,
    consent: Mutex<Option<runtime_state::Consent>>,
    live_sessions: Mutex<session_live::Cache>,
}

fn memory_status(state: &State) -> Value {
    match state.memory.try_lock() {
        Ok(memory) => match &*memory {
            Ok(_) => json!({"available":true}),
            Err(error) => json!({"available":false,"error":error}),
        },
        Err(std::sync::TryLockError::WouldBlock) => json!({"busy":true}),
        Err(_) => json!({"available":false,"error":"memory lock poisoned"}),
    }
}

#[derive(Serialize)]
struct TailResult {
    events: Vec<Box<RawValue>>,
    cursor: u64,
}

#[derive(Serialize)]
struct RpcResult<'a> {
    id: &'a Value,
    result: Box<RawValue>,
}

async fn journal_request(
    state: Arc<State>,
    method: String,
    params: Value,
) -> Result<Box<RawValue>> {
    let host_job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _host_job = host_job;
        if method == "events.tail" {
            let mut store = state
                .store
                .lock()
                .map_err(|_| anyhow::anyhow!("journal lock poisoned"))?;
            let since = params["since"].as_f64().unwrap_or(0.0).floor().max(0.0) as u64;
            let limit = params["limit"]
                .as_f64()
                .map_or(usize::MAX, |n| n.ceil().max(0.0) as usize);
            let session = params["sessionId"].as_str();
            let events = store.read_from(since, session, limit, MAX_LINE)?;
            let last = events.last().map(|event| event.id);
            if let Some(last) = last {
                ensure!(
                    events.len() >= limit
                        || store.read_from(last, session, 1, MAX_LINE)?.is_empty(),
                    "events.tail exceeds frame budget; reduce limit or advance since"
                );
            }
            let result = to_raw_value(&TailResult {
                events: events.into_iter().map(|event| event.json).collect(),
                cursor: store.last_id(),
            })?;
            ensure!(
                result.get().len() < MAX_LINE - 256,
                "events.tail exceeds frame budget; reduce limit or advance since"
            );
            return Ok(result);
        }
        let count = params["count"]
            .as_f64()
            .unwrap_or(1.0)
            .clamp(1.0, 1000.0)
            .ceil() as usize;
        let session = params["sessionId"].as_str().unwrap_or("daemon");
        let provider = match params["provider"].as_str() {
            Some("claude") => "claude",
            Some("codex") => "codex",
            _ => "pult",
        };
        let mut ids = Vec::with_capacity(count);
        for n in 0..count {
            let mut data = params["data"].as_object().cloned().unwrap_or_default();
            data.insert("n".into(), json!(n));
            let mut draft =
                json!({"sessionId":session,"provider":provider,"kind":params["kind"],"data":data});
            if let Some(parent) = params["parentId"].as_str() {
                draft["parentId"] = json!(parent);
            }
            let mut store = match state.store.lock() {
                Ok(store) => store,
                Err(_) => {
                    state.execution_storage_failed();
                    bail!("journal lock poisoned");
                }
            };
            let result = store.append(draft);
            let projected = result
                .as_ref()
                .map_or(Ok(()), |event| runtime_state::project(&state, event));
            let last = store.last_id();
            let degraded = store.projection_error().is_some();
            drop(store);
            state.publish_commit(last, degraded);
            if projected.is_err() {
                state.execution_storage_failed();
                bail!("live projection persistence unconfirmed");
            }
            let event = match result {
                Ok(event) => event,
                Err(error) => {
                    state.execution_storage_failed();
                    return Err(error);
                }
            };
            ids.push(event["id"].clone());
        }
        Ok(to_raw_value(
            &json!({"ids":ids,"lastEventId":state.last_event_id.load(Ordering::Acquire)}),
        )?)
    })
    .await
    .context("journal task failed")?
}

struct ConnectionCount(Arc<State>);
impl Drop for ConnectionCount {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn connection(
    socket: UnixStream,
    state: Arc<State>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    state.clients.fetch_add(1, Ordering::Relaxed);
    let _count = ConnectionCount(state.clone());
    let (input, mut output) = socket.into_split();
    let mut reader = BufReader::new(input);
    let first = tokio::time::timeout(Duration::from_secs(2), read_line(&mut reader)).await;
    let hello = match first {
        Err(_) => {
            write_value(
                &mut output,
                &json!({"type":"error","code":"handshake_timeout"}),
            )
            .await?;
            return Ok(());
        }
        Ok(Err(_)) => {
            write_value(&mut output, &json!({"type":"error","code":"line_too_long"})).await?;
            return Ok(());
        }
        Ok(Ok(None)) => return Ok(()),
        Ok(Ok(Some(bytes))) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(value) => value,
            Err(_) => {
                write_value(&mut output, &json!({"type":"error","code":"bad_json"})).await?;
                return Ok(());
            }
        },
    };
    if !hello.is_object() {
        write_value(&mut output, &json!({"type":"error","code":"bad_json"})).await?;
        return Ok(());
    }
    let ask_given = hello.get("ask");
    let ask_lease = if ask_given.is_some()
        && hello.get("memory").is_none()
        && hello.get("memoryTurn").is_none()
        && hello.get("token").is_none()
        && hello.get("runtime").is_none()
    {
        ask_given
            .and_then(Value::as_str)
            .and_then(|key| state.claude_asks.get()?.lookup(key))
    } else {
        None
    };
    let memory_given = hello.get("memory");
    let memory_turn_given = hello.get("memoryTurn");
    let memory_turn_lease = if memory_turn_given.is_some()
        && memory_given.is_none()
        && hello.get("token").is_none()
        && hello.get("ask").is_none()
        && hello.get("runtime").is_none()
    {
        memory_turn_given
            .and_then(Value::as_str)
            .and_then(|key| state.memory_turns.get()?.lookup(key))
    } else {
        None
    };
    let memory_lease = if memory_given.is_some()
        && memory_turn_given.is_none()
        && hello.get("token").is_none()
        && hello.get("ask").is_none()
        && hello.get("runtime").is_none()
    {
        memory_given
            .and_then(Value::as_str)
            .and_then(|key| state.session_memory.lock().ok()?.lookup(key))
    } else {
        None
    };
    let error = if hello["type"] != "hello" {
        Some("handshake_required")
    } else {
        let given = hello["token"].as_str().unwrap_or("");
        let owner_valid = memory_given.is_none()
            && memory_turn_given.is_none()
            && hello.get("ask").is_none()
            && hello.get("runtime").is_none()
            && given.len() == state.token.len()
            && bool::from(given.as_bytes().ct_eq(state.token.as_bytes()));
        if !owner_valid
            && memory_lease.is_none()
            && memory_turn_lease.is_none()
            && ask_lease.is_none()
        {
            Some("bad_token")
        } else if hello
            .get("protocol")
            .is_some_and(|p| p.as_f64() != Some(PROTOCOL as f64))
        {
            Some("bad_protocol")
        } else {
            None
        }
    };
    if let Some(code) = error {
        write_value(&mut output, &json!({"type":"error","code":code})).await?;
        return Ok(());
    }
    let supported: &[&str] = if ask_lease.is_some() {
        &claude_ask::METHODS
    } else if memory_turn_lease.is_some() {
        &memory_turn::METHODS
    } else if memory_lease.is_some() {
        &session_memory_api::READ_METHODS
    } else {
        &SUPPORTED
    };
    let partial: &[&str] =
        if memory_lease.is_some() || memory_turn_lease.is_some() || ask_lease.is_some() {
            &[]
        } else {
            &PARTIAL
        };
    let client_kind = if hello["client"].as_str() == Some("shell") {
        host_policy::ClientKind::Shell
    } else {
        host_policy::ClientKind::Other
    };
    // Only a bounded client label becomes durable permission provenance; an
    // arbitrary hello string must not become a journal payload or an identity.
    let client_label = match hello["client"].as_str() {
        Some("shell") => "shell",
        Some("cli") => "cli",
        Some("sdk") => "sdk",
        _ => "other",
    };
    let by = format!(
        "{}#{}",
        client_label,
        state.connection_id.fetch_add(1, Ordering::Relaxed)
    );
    let _queue_connection = session_queue::ConnectionLease(state.clone(), by.clone());
    let mut welcome = json!({"type":"hello_ok","protocol":PROTOCOL,"daemon":{"version":VERSION,"pid":std::process::id(),"startedAt":state.started_at},"capabilities":{"experimental":true,"supportedMethods":supported,"partialMethods":partial}});
    if let Some(lease) = &memory_turn_lease {
        welcome["capabilities"]["memoryWrite"] = json!(lease.writable());
    }
    write_value(&mut output, &welcome).await?;
    let (writer, _writer_task) = stream::Writer::start(output);
    let mut writer_closed = writer.closed();
    let mut subscriptions = subscriptions::Subscriptions::new();
    let mut daemon_stopping = false;
    let mut responses = JoinSet::new();
    loop {
        let line = tokio::select! {
            _ = shutdown.changed() => { daemon_stopping = true; break; },
            _ = writer_closed.changed() => break,
            line = read_line(&mut reader) => line,
        };
        let bytes = match line {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(_) => {
                writer
                    .response(&json!({"type":"error","code":"line_too_long"}))
                    .await?;
                break;
            }
        };
        if let Some(lease) = &ask_lease {
            // Purpose-specific role: no owner fallback, resolve or subscriptions.
            let request: Value = match serde_json::from_slice(&bytes) {
                Ok(request) => request,
                Err(_) => {
                    writer
                        .response(&json!({"type":"error","code":"bad_json"}))
                        .await?;
                    break;
                }
            };
            let id = request
                .get("id")
                .cloned()
                .filter(|id| id.is_string() || id.is_number())
                .unwrap_or(Value::Null);
            if request["method"] != "perm.request" {
                writer.response(&json!({"id":id,"error":{"code":"forbidden","message":"permission credential only permits perm.request"}})).await?;
                continue;
            }
            while responses.try_join_next().is_some() {}
            if id.is_null() || !request["params"].is_object() {
                writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":"request needs id and object params"}})).await?;
                continue;
            }
            if responses.len() >= 16 {
                writer.response(&json!({"id":id,"error":{"code":"capacity","message":"too many permission requests"}})).await?;
                continue;
            }
            let Some(backend) = state.claude_asks.get() else {
                break;
            };
            let reply = backend.call(lease.clone(), request["params"].clone());
            let writer = writer.clone();
            responses.spawn(async move {
                let response = match reply.await {
                    Ok(result) => json!({"id":id,"result":result}),
                    Err(_) => json!({"id":id,"error":{"code":"forbidden","message":"permission turn is unavailable"}}),
                };
                let _ = writer.response(&response).await;
            });
            continue;
        }
        if let Some(lease) = &memory_turn_lease {
            // This purpose-specific role never falls through to owner/core RPC.
            let response = if let Some((id, command)) = memory_api::parse(&bytes) {
                match command {
                    Ok((method, params)) if memory_turn::METHODS.contains(&method.as_str()) => {
                        let result = match state.memory_turns.get() {
                            Some(memory) => memory.call(lease.clone(), method, params).await,
                            None => Err(memory::MemoryError {
                                code: "forbidden",
                                message: "memory turn is unavailable".into(),
                            }),
                        };
                        match result {
                            Ok(result) => json!({"id":id,"result":result}),
                            Err(error) => {
                                json!({"id":id,"error":{"code":error.code,"message":error.message}})
                            }
                        }
                    }
                    Err(error) => {
                        json!({"id":id,"error":{"code":error.code,"message":"invalid memory request"}})
                    }
                    _ => {
                        json!({"id":id,"error":{"code":"forbidden","message":"memory turn credential cannot call this method"}})
                    }
                }
            } else {
                let id = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .and_then(|request| request.get("id").cloned())
                    .filter(|id| id.is_string() || id.is_number())
                    .unwrap_or(Value::Null);
                json!({"id":id,"error":{"code":"forbidden","message":"memory turn credential cannot call this method"}})
            };
            if serde_json::to_vec(&response)?.len() >= MAX_LINE {
                break;
            }
            writer.response(&response).await?;
            continue;
        }
        if let Some(lease) = &memory_lease {
            // This role never reaches the owner dispatcher, including on malformed
            // or unknown methods. Re-authorize the lease for every permitted read.
            let header = (|| -> Result<(Value, String)> {
                let raw: Box<RawValue> = serde_json::from_slice(&bytes)?;
                let fields = history::Fields::parse(&raw)?;
                let id = fields
                    .get("id")
                    .and_then(|v| serde_json::from_str::<Value>(v.get()).ok())
                    .unwrap_or(Value::Null);
                let method = fields
                    .get("method")
                    .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                    .unwrap_or_default();
                Ok((id, method))
            })();
            let (id, method) = match header {
                Ok(value) => value,
                Err(_) => {
                    writer
                        .response(&json!({"type":"error","code":"bad_json"}))
                        .await?;
                    break;
                }
            };
            let response = if !session_memory_api::READ_METHODS.contains(&method.as_str()) {
                json!({"id":id,"error":{"code":"forbidden","message":"memory credential only permits scoped memory reads"}})
            } else if let Some((_, command)) = memory_api::parse(&bytes) {
                match command {
                    Ok((method, params)) => match session_memory_api::read(
                        state.clone(),
                        method,
                        params,
                        Some(lease.clone()),
                    )
                    .await
                    {
                        Ok(result) => json!({"id":id,"result":result}),
                        Err(error) => {
                            json!({"id":id,"error":{"code":error.code,"message":error.message}})
                        }
                    },
                    Err(error) => {
                        json!({"id":id,"error":{"code":error.code,"message":error.message}})
                    }
                }
            } else {
                json!({"id":id,"error":{"code":"invalid_params","message":"invalid scoped memory request"}})
            };
            if serde_json::to_vec(&response)?.len() < MAX_LINE {
                writer.response(&response).await?;
            } else {
                writer.response(&json!({"id":id,"error":{"code":"internal","message":"response exceeds frame budget; reduce limit or advance offset"}})).await?;
            }
            continue;
        }
        if let Some((id, command)) = session_api::parse(&bytes) {
            match command {
                Err(error) => writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":error.to_string()}})).await?,
                Ok(command) => {
                    let overflow = if command.is_mutation() { "operation committed but response exceeds frame budget" } else { "response exceeds frame budget" };
                    match session_api::execute(state.clone(), command).await {
                    Ok(result) => {
                        let response = RpcResult { id: &id, result };
                        if serde_json::to_vec(&response)?.len() < MAX_LINE {
                            writer.response(&response).await?;
                        } else {
                            writer.response(&json!({"id":id,"error":{"code":"internal","message":overflow}})).await?;
                        }
                    },
                    Err(error) => writer.response(&json!({"id":id,"error":{"code":error.code,"message":error.message}})).await?,
                    }
                }
            }
            continue;
        }
        if let Some((id, query)) = read_api::parse(&bytes) {
            match query {
                Err(error) => writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":error.to_string()}})).await?,
                Ok(query) => {
                    let result = read_api::execute(state.clone(), query).await;
                    match result {
                        Ok(result) if result.get().len() < MAX_LINE - 256 => writer.response(&RpcResult { id: &id, result }).await?,
                        result => {
                            let message = result.err().map_or_else(|| "response exceeds frame budget".to_owned(), |error| error.to_string());
                            writer.response(&json!({"id":id,"error":{"code":"internal","message":message}})).await?;
                        }
                    }
                }
            }
            continue;
        }
        if let Some((id, command)) = memory_api::parse(&bytes) {
            let mut mutation = false;
            let response = match command {
                Ok((method, params)) => {
                    let is_mutation = matches!(
                        method.as_str(),
                        "memory.add" | "memory.update" | "memory.forget"
                    );
                    match memory_api::execute(state.clone(), method, params).await {
                        Ok(result) => {
                            mutation = is_mutation;
                            json!({"id":id,"result":result})
                        }
                        Err(error) => {
                            json!({"id":id,"error":{"code":error.code,"message":error.message}})
                        }
                    }
                }
                Err(error) => json!({"id":id,"error":{"code":error.code,"message":error.message}}),
            };
            if serde_json::to_vec(&response)?.len() < MAX_LINE {
                writer.response(&response).await?;
            } else {
                let message = if mutation {
                    "operation committed but response exceeds frame budget; retry the same commandId"
                } else {
                    "response exceeds frame budget; reduce limit or advance offset"
                };
                writer
                    .response(&json!({"id":id,"error":{"code":"internal","message":message}}))
                    .await?;
            }
            continue;
        }
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(request) => request,
            Err(_) => {
                writer
                    .response(&json!({"type":"error","code":"bad_json"}))
                    .await?;
                break;
            }
        };
        if !request.is_object() {
            writer
                .response(&json!({"type":"error","code":"bad_json"}))
                .await?;
            break;
        }
        let id = &request["id"];
        if !(id.is_string() || id.is_number())
            || !request["method"].is_string()
            || request.get("params").is_some_and(|v| !v.is_object())
        {
            writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":"request needs id, method and object params"}})).await?;
            continue;
        }
        let method = request["method"].as_str().unwrap();
        if method == "perm.request" {
            writer.response(&json!({"id":id,"error":{"code":"forbidden","message":"permission questions require a scoped ask credential"}})).await?;
            continue;
        }
        if session_runtime_api::METHODS.contains(&method) {
            while responses.try_join_next().is_some() {}
            if responses.len() >= 16 {
                writer.response(&json!({"id":id,"error":{"code":"capacity","message":"too many concurrent session commands"}})).await?;
                continue;
            }
            let reply = session_runtime_api::execute(
                state.clone(),
                method,
                request.get("params").cloned().unwrap_or_else(|| json!({})),
                client_kind,
                &by,
            );
            let writer = writer.clone();
            let id = id.clone();
            // Read further frames while preparation runs so stop/resolve on
            // this same socket cannot be queued behind a pending prompt.
            responses.spawn(async move {
                match reply.await {
                    Ok(result) => {
                        let response = RpcResult { id:&id, result };
                        if serde_json::to_vec(&response).is_ok_and(|bytes|bytes.len()<MAX_LINE) {
                            let _ = writer.response(&response).await;
                        } else {
                            let _ = writer.response(&json!({"id":id,"error":{"code":"capacity","message":"response exceeds frame budget; query current session state"}})).await;
                        }
                    },
                    Err(error) => { let _ = writer.response(&json!({"id":id,"error":{"code":error.code,"message":error.message}})).await; },
                }
            });
            continue;
        }
        let result = match method {
            "daemon.status" => {
                if let Some(initialize) = request["params"].get("initializeRuntime") {
                    let Some(initialize) = initialize.as_bool() else {
                        writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":"initializeRuntime must be a boolean"}})).await?;
                        continue;
                    };
                    if initialize && runtime_state::instance(&state).await.is_err() {
                        writer.response(&json!({"id":id,"error":{"code":"runtime_unavailable","message":"native runtime initialization failed"}})).await?;
                        continue;
                    }
                }
                json!({"version":VERSION,"protocol":PROTOCOL,"pid":std::process::id(),"startedAt":state.started_at,"uptimeMs":state.started.elapsed().as_millis(),"home":state.home,"sock":state.home.join("run/pultd.sock"),"clients":state.clients.load(Ordering::Relaxed),"subscriptions":state.subscriptions.load(Ordering::Relaxed),"lastEventId":state.last_event_id.load(Ordering::Acquire),"mode":"on-demand","journal":{"projectionDegraded":state.projection_degraded.load(Ordering::Relaxed),"executionUnavailable":runtime_state::unavailable(&state)},"registry":state.registry.try_lock().ok().map(|r|r.status()),"memory":memory_status(&state),"nativeRuntime":{"initialized":state.native_runtime.get().is_some()||state.claude_runtime.get().is_some()||state.zcode_runtime.get().is_some(),"hosts":state.native_runtime.get().map_or(0, |runtime|runtime.host_count()),"activeTurns":state.driver.get().map_or(0, |driver|driver.active_count()),"providers":{"codex":{"initialized":state.native_runtime.get().is_some()},"claude":{"initialized":state.claude_runtime.get().is_some()},"zcode":{"initialized":state.zcode_runtime.get().is_some(),"blocked":state.zcode_runtime.get().is_some_and(|slot|slot.runtime.blocked())}}},"capabilities":{"experimental":true,"supportedMethods":SUPPORTED,"partialMethods":PARTIAL}})
            }
            "daemon.stop" => {
                runtime_state::begin_shutdown(&state);
                json!({"stopping":true})
            }
            "protocol.catalog" => catalog(),
            "events.subscribe" => {
                match subscriptions.prepare(&state, &request["params"]) {
                    Ok(pending) => {
                        writer.response(&json!({"id":id,"result":{"sub":pending.id,"cursor":pending.cursor}})).await?;
                        subscriptions.start(pending, state.clone(), writer.clone());
                    }
                    Err(error) => {
                        writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":error.to_string()}})).await?;
                    }
                }
                continue;
            }
            "events.unsubscribe" => {
                let sub = &request["params"]["sub"];
                if !sub.is_number() {
                    writer.response(&json!({"id":id,"error":{"code":"invalid_params","message":"sub must be a number"}})).await?;
                    continue;
                }
                let removed = if let Some(number) = sub
                    .as_f64()
                    .filter(|n| *n >= 0.0 && n.fract() == 0.0 && *n <= journal::MAX_EVENT_ID as f64)
                {
                    subscriptions.unsubscribe(number as u64).await
                } else {
                    false
                };
                json!({"removed":removed})
            }
            "events.tail" | "events.emit" => {
                let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
                if method == "events.emit" {
                    let valid_kind = catalog()["methods"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|method| method["name"] == "events.emit")
                        .unwrap()["paramsSchema"]["properties"]["kind"]["enum"]
                        .as_array()
                        .unwrap()
                        .contains(&params["kind"]);
                    let error = if !state.test_mode {
                        Some(("not_found", "events.emit requires PULT_TEST=1"))
                    } else if !valid_kind {
                        Some(("invalid_params", "kind is not a known event kind"))
                    } else if params
                        .get("data")
                        .is_some_and(|data| !data.is_null() && !data.is_object())
                    {
                        Some(("invalid_params", "data must be an object"))
                    } else {
                        None
                    };
                    if let Some((code, message)) = error {
                        writer
                            .response(&json!({"id":id,"error":{"code":code,"message":message}}))
                            .await?;
                        continue;
                    }
                }
                match journal_request(state.clone(), method.to_owned(), params).await {
                    Ok(result) => {
                        writer.response(&RpcResult { id, result }).await?;
                        continue;
                    }
                    Err(error) => {
                        let code = if method == "events.emit" {
                            "journal_write_failed"
                        } else {
                            "internal"
                        };
                        writer
                            .response(
                                &json!({"id":id,"error":{"code":code,"message":error.to_string()}}),
                            )
                            .await?;
                        continue;
                    }
                }
            }
            _ => {
                let known = catalog()["methods"]
                    .as_array()
                    .is_some_and(|methods| methods.iter().any(|m| m["name"] == method));
                writer.response(&json!({"id":id,"error":{"code":if known {"not_implemented"} else {"not_found"},"message":"method is unavailable in Rust core foundation"}})).await?;
                continue;
            }
        };
        writer.response(&json!({"id":id,"result":result})).await?;
        if method == "daemon.stop" {
            daemon_stopping = true;
            if let Ok(mut contexts) = state.session_memory.lock() {
                contexts.revoke_all();
            }
            break;
        }
    }

    if daemon_stopping {
        subscriptions.shutdown(&writer).await;
    }
    Ok(())
}

struct ServeCancellation(watch::Sender<bool>);
impl Drop for ServeCancellation {
    fn drop(&mut self) {
        let _ = self.0.send(true);
    }
}

/// Cancelling the caller requests shutdown; the owned supervisor retains the
/// daemon lease until execution cleanup finishes. It is not aborted with RPC.
pub async fn serve(home: PathBuf) -> Result<()> {
    let (cancel, cancellation) = watch::channel(false);
    let _cancel_on_drop = ServeCancellation(cancel);
    let supervisor = tokio::spawn(serve_owned(home, cancellation));
    supervisor
        .await
        .map_err(|_| anyhow::anyhow!("daemon supervisor failed"))?
}

async fn serve_owned(home: PathBuf, mut cancellation: watch::Receiver<bool>) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    if *cancellation.borrow() {
        return Ok(());
    }
    let home = checked_home(&home)?;
    let started_at = Utc::now().to_rfc3339();
    let mut owner = Ownership::acquire(&home, &started_at)?;
    let socket = owner.run.join("pultd.sock");
    if let Ok(metadata) = fs::symlink_metadata(&socket) {
        ensure!(
            metadata.file_type().is_socket(),
            "existing socket path is not a socket"
        );
        match tokio::time::timeout(Duration::from_secs(1), UnixStream::connect(&socket))
            .await
            .context("existing socket probe deadline exceeded")?
        {
            Ok(_) => bail!("existing socket still accepts connections"),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                ) => {}
            Err(error) => {
                return Err(error).context("cannot establish that existing socket is stale");
            }
        }
        fs::remove_file(&socket)?;
    }
    initialize_scratch(&home)?;
    let events = home.join("events");
    let registry_home = home.clone();
    let (store, registry, memory) = tokio::task::spawn_blocking(move || -> Result<_> {
        let mut store = journal::EventStore::open(&events)?;
        let registry = registry::Registry::open(&registry_home, &mut store)?;
        let memory = memory::MemoryStore::open(&registry_home).map_err(|error| error.to_string());
        Ok((store, registry, memory))
    })
    .await??;
    let last_event_id = AtomicU64::new(store.last_id());
    let (committed, _) = watch::channel(store.last_id());
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let metadata = fs::symlink_metadata(&socket)?;
    owner.socket = Some((metadata.dev(), metadata.ino()));
    ensure!(
        fs::read(owner.run.join("pultd.lock"))? == owner.record,
        "daemon lock ownership changed before listen"
    );
    owner.write_token()?;
    let (stop, mut shutdown) = watch::channel(false);
    let live_sessions = runtime_state::seed_live(&registry)?;
    let state = Arc::new(State {
        home,
        token: owner.token.clone(),
        started_at,
        started: Instant::now(),
        clients: AtomicUsize::new(0),
        connection_id: AtomicU64::new(1),
        host_jobs: Arc::default(),
        session_commands: Arc::default(),
        stop,
        store: Mutex::new(store),
        history: Mutex::new(history::HistoryCache::default()),
        registry: Arc::new(Mutex::new(registry)),
        memory: Mutex::new(memory),
        session_memory: Mutex::new(session_memory::SessionMemory::default()),
        last_event_id,
        test_mode: std::env::var("PULT_TEST").as_deref() == Ok("1"),
        projection_degraded: AtomicBool::new(false),
        subscriptions: AtomicUsize::new(0),
        committed,
        live_id: AtomicU64::new(subscriptions::LIVE_BASE),
        driver: OnceLock::new(),
        execution_storage_failed: AtomicBool::new(false),
        execution_admission: Mutex::new(()),
        native_runtime: OnceLock::new(),
        memory_turns: OnceLock::new(),
        claude_asks: OnceLock::new(),
        permissions: OnceLock::new(),
        claude_runtime: OnceLock::new(),
        zcode_runtime: OnceLock::new(),
        runtime_init: Mutex::new(()),
        consent: Mutex::new(None),
        live_sessions: Mutex::new(live_sessions),
    });
    runtime_journal::initialize(&state)?;
    let permits = Arc::new(Semaphore::new(64));
    let mut tasks = JoinSet::new();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut accept_error = None;
    let execution_driver = state.driver.get().expect("driver initialized").clone();
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = terminate.recv() => break,
            _ = shutdown.changed() => break,
            _ = cancellation.changed() => break,
            _ = execution_driver.wait_for_storage_failure() => {
                state.execution_storage_failed();
                break;
            },
            connection_result = listener.accept() => {
                let (socket, _) = match connection_result {
                    Ok(connection) => connection,
                    Err(error) => {
                        accept_error = Some(error);
                        break;
                    }
                };
                if let Ok(permit) = permits.clone().try_acquire_owned() {
                    let state = state.clone();
                    let shutdown = shutdown.clone();
                    tasks.spawn(async move { let _permit = permit; let _ = connection(socket, state, shutdown).await; });
                }
            }
            _ = tasks.join_next(), if !tasks.is_empty() => (),
        }
    }
    runtime_state::begin_shutdown(&state);
    if tokio::time::timeout(Duration::from_secs(2), async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
    drop(listener);
    runtime_journal::shutdown(&state, owner).await;
    match accept_error {
        Some(error) => Err(error).context("daemon accept failed"),
        None if runtime_state::unavailable(&state) => {
            bail!("execution storage failed; daemon stopped after cleanup")
        }
        None => Ok(()),
    }
}

pub async fn request(home: &Path, method: &str) -> Result<Box<RawValue>> {
    request_with_params(home, method, json!({})).await
}

pub async fn request_with_params(
    home: &Path,
    method: &str,
    params: Value,
) -> Result<Box<RawValue>> {
    request_with_locale(home, method, params, None).await
}

pub fn display_string(raw: &RawValue) -> Result<String> {
    Ok(String::from_utf16_lossy(&journal::decode_js_string(raw)?))
}

pub fn cli_locale(home: &Path) -> Result<&'static str> {
    let configured = registry::Registry::configured_language(home).unwrap_or(locale::Setting::Auto);
    let setting = std::env::var("PULT_LANG")
        .ok()
        .and_then(|s| locale::cli_setting(&s))
        .unwrap_or(configured);
    Ok(if locale::english(setting, None) {
        "en"
    } else {
        "ru"
    })
}

pub async fn request_with_locale(
    home: &Path,
    method: &str,
    params: Value,
    locale: Option<&str>,
) -> Result<Box<RawValue>> {
    let home = checked_home(home)?;
    let token = fs::read_to_string(home.join("run/token"))?;
    let socket = tokio::time::timeout(
        Duration::from_secs(3),
        UnixStream::connect(home.join("run/pultd.sock")),
    )
    .await
    .context("daemon connection deadline exceeded")??;
    let (input, mut output) = socket.into_split();
    let mut input = BufReader::new(input);
    write_value(
        &mut output,
        &json!({"type":"hello","protocol":PROTOCOL,"token":token,"client":"cli"}),
    )
    .await?;
    let hello = tokio::time::timeout(Duration::from_secs(3), read_line(&mut input))
        .await??
        .context("daemon closed before hello")?;
    let hello: Value = serde_json::from_slice(&hello)?;
    ensure!(
        hello["type"] == "hello_ok" && hello["protocol"].as_u64() == Some(PROTOCOL),
        "handshake failed: {hello}"
    );
    write_value(
        &mut output,
        &json!({"id":1,"method":method,"params":params,"locale":locale}),
    )
    .await?;
    let response = tokio::time::timeout(Duration::from_secs(3), read_line(&mut input))
        .await??
        .context("daemon closed before response")?;
    let mut response: HashMap<String, Box<RawValue>> = serde_json::from_slice(&response)?;
    let id: Value =
        serde_json::from_str(response.get("id").context("response is missing id")?.get())?;
    ensure!(
        id.as_u64() == Some(1),
        "response does not match pending request"
    );
    ensure!(
        !response.contains_key("error"),
        "request failed: {}",
        response.get("error").map_or("", |error| error.get())
    );
    response
        .remove("result")
        .context("response is missing result")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_cleanup_releases_guard_even_when_a_duplicate_descriptor_survives() {
        let home = tempfile::tempdir().unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let owner = Ownership::acquire(home.path(), "fixture").unwrap();
        // Model the same open-file description retained by an unrelated child
        // between fork and exec. No sleeps or replacement-acquire retries.
        let inherited = owner._guard.0.try_clone().unwrap();
        let run = owner.run.clone();
        drop(owner);
        assert!(
            !run.join("pultd.lock").exists(),
            "owner cleanup must finish before release"
        );
        let replacement = Ownership::acquire(home.path(), "replacement")
            .unwrap_or_else(|error| panic!("replacement with inherited guard: {error:#}"));
        drop(replacement);
        drop(inherited);
    }

    #[test]
    fn owner_guard_releases_after_foreign_record_skips_owner_cleanup() {
        let home = tempfile::tempdir().unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let owner = Ownership::acquire(home.path(), "fixture").unwrap();
        let inherited = owner._guard.0.try_clone().unwrap();
        let run = owner.run.clone();
        fs::write(run.join("pultd.lock"), b"foreign record").unwrap();
        drop(owner);
        assert_eq!(fs::read(run.join("pultd.lock")).unwrap(), b"foreign record");
        let replacement = OpenOptions::new()
            .read(true)
            .write(true)
            .open(run.join("rust-owner.guard"))
            .unwrap();
        replacement
            .try_lock_exclusive()
            .expect("guard release also covers early owner cleanup return");
        drop(inherited);
        // Closing the old description must not unlock a new owner's guard.
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(run.join("rust-owner.guard"))
            .unwrap();
        assert!(contender.try_lock_exclusive().is_err());
        FileExt::unlock(&replacement).unwrap();
    }

    #[test]
    fn protocol_and_version_match_shared_contract() {
        let package: Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(VERSION, package["version"].as_str().unwrap());
        let catalog = catalog();
        assert_eq!(PROTOCOL, catalog["protocolVersion"].as_u64().unwrap());
        let mut implemented: Vec<_> = catalog["methods"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|method| method["rust"] == "implemented")
            .map(|method| method["name"].as_str().unwrap())
            .collect();
        implemented.sort_unstable();
        let mut supported = SUPPORTED.to_vec();
        supported.sort_unstable();
        assert_eq!(implemented, supported);
        let mut partial: Vec<_> = catalog["methods"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|method| method["rust"] == "partial")
            .map(|method| method["name"].as_str().unwrap())
            .collect();
        partial.sort_unstable();
        let mut advertised = PARTIAL.to_vec();
        advertised.sort_unstable();
        assert_eq!(partial, advertised);
        assert!(PARTIAL.iter().all(|method| !SUPPORTED.contains(method)));
    }
}
