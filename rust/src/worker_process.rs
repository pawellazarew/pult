//! Bounded JSON transport for an explicitly selected, supervised subprocess.
//! This is a trusted host API, not permission to execute a client command.
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const MAX_FRAME: usize = 1024 * 1024;
const QUEUE: usize = 16;
const CODEX_FRAME: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy, Debug)]
pub struct Framing {
    max_wire_bytes: usize,
    max_input_bytes: usize,
    recover: bool,
}
impl Framing {
    pub fn strict() -> Self {
        Self {
            max_wire_bytes: MAX_FRAME,
            max_input_bytes: MAX_FRAME,
            recover: false,
        }
    }
    pub fn codex() -> Self {
        Self {
            max_wire_bytes: CODEX_FRAME + 1,
            max_input_bytes: CODEX_FRAME + 1,
            recover: true,
        }
    }
    pub fn claude() -> Self {
        Self {
            max_wire_bytes: CODEX_FRAME + 1,
            max_input_bytes: crate::claude_launch::MAX_INPUT_BYTES + 1,
            recover: true,
        }
    }
    /// Prepare outside event-loop/admission locks when input can be large.
    pub fn encode(self, value: &Value) -> Result<PreparedInput> {
        let mut bytes = serde_json::to_vec(value).context("worker request serialization failed")?;
        ensure!(
            bytes.len() < self.max_input_bytes,
            "worker request exceeds framing limit"
        );
        bytes.push(b'\n');
        Ok(PreparedInput(bytes))
    }
}

/// A single encoded NDJSON frame; no public constructor or raw diagnostic data.
pub struct PreparedInput(Vec<u8>);
impl std::fmt::Debug for PreparedInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedInput")
            .field("bytes", &self.0.len())
            .finish()
    }
}

/// Stderr remains count-only unless a trusted host explicitly requests a tail.
#[derive(Clone, Copy, Debug, Default)]
pub enum StderrPolicy {
    #[default]
    CountOnly,
    PrivateTail {
        max_bytes: usize,
    },
}
const MAX_PRIVATE_STDERR: usize = 64 * 1024;

/// Validated launch with no spawned process. Arguments/environment are private.
/// Keep preparation in an owned job: dropping its waiter does not abort the
/// underlying blocking validation, and does not constitute IO cleanup proof.
pub struct PreparedLaunch {
    command: Command,
    framing: Framing,
    stderr: StderrPolicy,
}
impl std::fmt::Debug for PreparedLaunch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedLaunch").finish_non_exhaustive()
    }
}

/// Static denial; never contains host callback errors or panic payloads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SpawnDenied;
impl std::fmt::Display for SpawnDenied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("worker spawn denied")
    }
}
impl std::error::Error for SpawnDenied {}

/// Trusted-host seal held across the actual OS spawn. No IO/callbacks in Drop.
pub trait SpawnPermit {}
/// A fresh synchronous authorization seal, not an ordinary check callback.
/// The host must check the exact Driver Ticket/fault state and serialize
/// cancellation/fault publication with this seal (e.g. a shared short mutex).
/// Before-seal cancellation denies; after-seal cancellation may observe a new
/// process, which the owned supervisor must stop and join. A Driver stop which
/// does not share this protocol cannot promise that no PID will be created.
/// Embedders install `crate::panic_guard::install()` before callbacks: catching
/// unwinding does not suppress the process-wide default panic hook.
pub trait SpawnGate: Send + Sync {
    fn enter(&self) -> std::result::Result<Box<dyn SpawnPermit + '_>, SpawnDenied>;
}
struct TrustedSpawn;
impl SpawnPermit for TrustedSpawn {}
impl SpawnGate for TrustedSpawn {
    fn enter(&self) -> std::result::Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        Ok(Box::new(TrustedSpawn))
    }
}

struct StderrTail {
    bytes: VecDeque<u8>,
    limit: usize,
    eof: bool,
}
impl StderrTail {
    fn append(&mut self, bytes: &[u8]) {
        let suffix = &bytes[bytes.len().saturating_sub(self.limit)..];
        let remove = (self.bytes.len() + suffix.len()).saturating_sub(self.limit);
        self.bytes.drain(..remove);
        self.bytes.extend(suffix);
    }
}
/// Private trusted-host evidence. Never serialize into public errors/events.
/// Available only after confirmed EOF and the stderr reader's successful join.
pub struct PrivateStderr(Vec<u8>);
impl PrivateStderr {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}
impl std::fmt::Debug for PrivateStderr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrivateStderr")
            .field("bytes", &self.0.len())
            .finish()
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StderrUnavailable {
    Disabled,
    Incomplete,
    Taken,
}
impl std::fmt::Display for StderrUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Disabled => "private stderr is disabled",
            Self::Incomplete => "private stderr is incomplete",
            Self::Taken => "private stderr was already taken",
        })
    }
}
impl std::error::Error for StderrUnavailable {}

/// Best-effort control, never cleanup proof. The owner invalidates it before
/// reaping/dropping Child, so a retained handle cannot signal a reused PID.
#[derive(Clone)]
pub struct StopSignal(Arc<Mutex<Option<u32>>>);
impl StopSignal {
    pub fn request_stop(&self) -> bool {
        let Ok(pid) = self.0.lock() else {
            return false;
        };
        pid.is_some_and(|pid| {
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            )
            .is_ok()
        })
    }
    fn invalidate(&self) {
        self.0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
    }
}
impl std::fmt::Debug for StopSignal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StopSignal").finish_non_exhaustive()
    }
}

const START_TIMEOUT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct Launch {
    pub holder: PathBuf,
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    pub env: BTreeMap<OsString, OsString>,
}
impl std::fmt::Debug for Launch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Launch")
            .field("argument_count", &self.args.len())
            .field("environment_count", &self.env.len())
            .finish_non_exhaustive()
    }
}

impl Launch {
    /// Pure structural checks; safe inside the host pool's short admission lock.
    pub(crate) fn validate_shape(&self) -> Result<()> {
        ensure!(
            self.holder.is_absolute() && self.program.is_absolute() && self.cwd.is_absolute(),
            "worker paths must be absolute"
        );
        crate::worker_env::validate(&self.env)?;
        let mut size = 0usize;
        for item in std::iter::once(self.holder.as_os_str())
            .chain(std::iter::once(self.program.as_os_str()))
            .chain(std::iter::once(self.cwd.as_os_str()))
            .chain(self.args.iter().map(OsString::as_os_str))
            .chain(
                self.env
                    .iter()
                    .flat_map(|(key, value)| [key.as_os_str(), value.as_os_str()]),
            )
        {
            let bytes = item.as_bytes();
            ensure!(!bytes.contains(&0), "worker launch contains NUL");
            size = size
                .checked_add(bytes.len() + 1)
                .context("worker launch exceeds budget")?;
            ensure!(size <= MAX_FRAME, "worker launch exceeds 1 MiB budget");
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_shape()?;
        ensure!(
            std::fs::metadata(&self.holder)
                .context("worker holder unavailable")?
                .is_file(),
            "worker holder must be a regular file"
        );
        ensure!(
            std::fs::metadata(&self.program)
                .context("worker program unavailable")?
                .is_file(),
            "worker program must be a regular file"
        );
        ensure!(
            std::fs::metadata(&self.cwd)
                .context("worker directory unavailable")?
                .is_dir(),
            "worker directory must be a directory"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Exit {
    pub code: Option<i32>,
    pub stderr_bytes: u64,
}

/// Parser EOF and task completion are separate facts: a reader can panic or
/// be aborted after EOF was observed. Neither receiver closure nor one flag is
/// enough to certify the stdout reader's outcome.
#[derive(Default)]
struct OutputCompletion {
    eof: AtomicBool,
    joined: AtomicBool,
}
impl OutputCompletion {
    fn finished_cleanly(&self) -> bool {
        self.eof.load(Ordering::Acquire) && self.joined.load(Ordering::Acquire)
    }
}

pub struct Process {
    child: Child,
    stop_signal: StopSignal,
    stdin: Option<ChildStdin>,
    output: mpsc::Receiver<Result<Value>>,
    output_taken: bool,
    output_completion: Arc<OutputCompletion>,
    stdout_reader_index: Option<usize>,
    readers: Vec<Option<JoinHandle<()>>>,
    stderr_bytes: Arc<AtomicU64>,
    private_stderr: Option<Arc<Mutex<StderrTail>>>,
    stderr_joined: bool,
    stderr_taken: bool,
    write_failed: bool,
    startup_reader: Option<BufReader<ChildStdout>>,
    startup_sender: Option<mpsc::Sender<Result<Value>>>,
    startup_attempted: bool,
    ready: bool,
    exit: Option<Exit>,
    framing: Framing,
    discarded: Arc<AtomicU64>,
}

/// A spawned PID owner available before the first asynchronous holder ACK poll.
/// Keep this value in the supervisor's vault while borrowing acknowledge().
/// A panic/drop of that borrowed future cannot drop its Process or stdout FD.
/// Holder readiness is not native input acceptance or cleanup proof.
pub struct StartingProcess {
    process: Process,
}
impl std::fmt::Debug for StartingProcess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartingProcess")
            .field("ready", &self.process.ready)
            .finish_non_exhaustive()
    }
}
impl StartingProcess {
    pub fn pid(&self) -> Option<u32> {
        self.process.pid()
    }
    /// Best effort only; copy before borrowing acknowledge() so cancellation
    /// need not acquire the vault mutex held by an in-flight startup future.
    pub fn stop_signal(&self) -> StopSignal {
        self.process.stop_signal()
    }
    pub async fn acknowledge(&mut self) -> Result<()> {
        self.process.acknowledge().await
    }
    /// Also usable after a failed/panicking ACK waiter for owned stop/join.
    /// An unacknowledged Process rejects stdin; this is not acceptance proof.
    pub fn into_process(self) -> Process {
        self.process
    }
}

/// Startup failed. A retained process still requires confirmed cleanup, even
/// when the holder did not acknowledge launch. No process means spawn never
/// succeeded. Diagnostics deliberately omit launch arguments and IO details.
pub struct SpawnFailure {
    pub process: Option<Box<Process>>,
    error: anyhow::Error,
}

// The supervisor awaits this owned check through cancellation. A panic has not
// spawned a child, so its result is a before-spawn failure, never cleanup proof
// for an existing process. There is no production callback or fault hook.
async fn validated_launch<F>(
    launch: Launch,
    validate: F,
) -> std::result::Result<Launch, SpawnFailure>
where
    F: FnOnce(&Launch) -> Result<()> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        validate(&launch).map_err(SpawnFailure::before_spawn)?;
        Ok(launch)
    })
    .await
    .map_err(|_| SpawnFailure::before_spawn(anyhow::anyhow!("worker launch validation failed")))?
}
impl std::fmt::Debug for SpawnFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SpawnFailure")
            .field("retained_process", &self.process.is_some())
            .finish_non_exhaustive()
    }
}
impl SpawnFailure {
    fn before_spawn(error: anyhow::Error) -> Self {
        Self {
            process: None,
            error,
        }
    }
    fn after_spawn(process: Process, error: anyhow::Error) -> Self {
        Self {
            process: Some(Box::new(process)),
            error,
        }
    }
}

impl Process {
    pub async fn spawn(launch: Launch) -> Result<Self> {
        Self::spawn_with_framing(launch, Framing::strict()).await
    }
    pub async fn spawn_with_framing(launch: Launch, framing: Framing) -> Result<Self> {
        match Self::spawn_owned(launch, framing).await {
            Ok(process) => Ok(process),
            Err(mut failure) => {
                if let Some(process) = &mut failure.process
                    && process.stop().await.is_err()
                {
                    return Err(failure
                        .error
                        .context("worker startup failed; cleanup unconfirmed"));
                }
                Err(failure.error.context("worker startup failed"))
            }
        }
    }

    /// Owned supervisors use this entry point: errors after OS spawn return the
    /// process for stop/retry/quarantine instead of reducing it to an error.
    /// Keep this future inside an owned task; dropping it only sends TERM via
    /// Process::drop and cannot serve as proof that cleanup completed.
    pub async fn spawn_owned(
        launch: Launch,
        framing: Framing,
    ) -> std::result::Result<Self, SpawnFailure> {
        let prepared = Self::prepare_launch(launch, framing, StderrPolicy::CountOnly).await?;
        Self::spawn_prepared_owned(prepared, &TrustedSpawn).await
    }

    /// Owned validation must be awaited through cancellation by the supervisor.
    /// This performs no spawn; dropping PreparedLaunch creates no process.
    pub async fn prepare_launch(
        launch: Launch,
        framing: Framing,
        stderr: StderrPolicy,
    ) -> std::result::Result<PreparedLaunch, SpawnFailure> {
        if matches!(stderr, StderrPolicy::PrivateTail { max_bytes } if max_bytes == 0 || max_bytes > MAX_PRIVATE_STDERR)
        {
            return Err(SpawnFailure::before_spawn(anyhow::anyhow!(
                "invalid private stderr budget"
            )));
        }
        let launch = validated_launch(launch, Launch::validate).await?;
        let mut command = Command::new(&launch.holder);
        command
            .arg(std::process::id().to_string())
            .arg(&launch.program)
            .args(&launch.args)
            .current_dir(&launch.cwd)
            .env_clear()
            .envs(&launch.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(false)
            .process_group(0);
        Ok(PreparedLaunch {
            command,
            framing,
            stderr,
        })
    }

    /// The compatibility wrapper owns startup until ACK. Supervisors needing
    /// recovery after an unexpected task panic use begin_spawn + a borrowed ACK.
    pub async fn spawn_prepared_owned(
        prepared: PreparedLaunch,
        gate: &dyn SpawnGate,
    ) -> std::result::Result<Self, SpawnFailure> {
        let mut starting = Self::begin_spawn(prepared, gate)?;
        if let Err(error) = starting.acknowledge().await {
            return Err(SpawnFailure::after_spawn(starting.into_process(), error));
        }
        Ok(starting.into_process())
    }

    /// Synchronous actual spawn frontier, returning a PID owner before any ACK
    /// await. Requires the trusted host's Tokio runtime with IO enabled. No
    /// authorization callback/FS operation belongs inside the Driver seal.
    pub fn begin_spawn(
        prepared: PreparedLaunch,
        gate: &dyn SpawnGate,
    ) -> std::result::Result<StartingProcess, SpawnFailure> {
        if tokio::runtime::Handle::try_current().is_err() {
            return Err(SpawnFailure::before_spawn(anyhow::anyhow!(
                "worker startup requires a runtime"
            )));
        }
        let (mut process, sender) = Self::spawn_frontier(prepared, gate)?;
        let stderr_bytes = process.stderr_bytes.clone();
        let private_stderr = process.private_stderr.clone();
        process.stdin = process.child.stdin.take();
        let Some(stdout) = process.child.stdout.take() else {
            return Err(SpawnFailure::after_spawn(
                process,
                anyhow::anyhow!("worker stdout unavailable"),
            ));
        };
        let Some(stderr) = process.child.stderr.take() else {
            return Err(SpawnFailure::after_spawn(
                process,
                anyhow::anyhow!("worker stderr unavailable"),
            ));
        };
        process.startup_reader = Some(BufReader::new(stdout));
        process.startup_sender = Some(sender);
        process.readers.push(Some(tokio::spawn(collect_stderr(
            stderr,
            stderr_bytes,
            private_stderr,
        ))));
        Ok(StartingProcess { process })
    }

    async fn acknowledge(&mut self) -> Result<()> {
        ensure!(
            !self.startup_attempted && !self.ready && self.exit.is_none(),
            "worker acknowledgement is unavailable"
        );
        self.startup_attempted = true;
        // Borrow, never move, the reader across await: unwinding/cancellation
        // must keep the stdout FD with the PID owner for subsequent stop/join.
        let reader = self
            .startup_reader
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("worker acknowledgement is unavailable"))?;
        let line = tokio::time::timeout(START_TIMEOUT, bounded_line(reader))
            .await
            .context("worker holder startup timeout")??
            .context("worker holder exited before ready")?;
        let value: Value = serde_json::from_slice(&line)
            .map_err(|_| anyhow::anyhow!("invalid worker holder acknowledgement"))?;
        ensure!(
            value.get("holder_ready") == Some(&Value::Bool(true))
                && value
                    .get("providerPid")
                    .and_then(Value::as_u64)
                    .is_some_and(|pid| pid > 0 && pid <= i32::MAX as u64),
            "invalid worker holder acknowledgement"
        );
        let reader = self
            .startup_reader
            .take()
            .ok_or_else(|| anyhow::anyhow!("worker acknowledgement is unavailable"))?;
        let sender = self
            .startup_sender
            .take()
            .ok_or_else(|| anyhow::anyhow!("worker acknowledgement is unavailable"))?;
        let framing = self.framing;
        let discarded = self.discarded.clone();
        let completion = self.output_completion.clone();
        self.stdout_reader_index = Some(self.readers.len());
        self.readers.push(Some(tokio::spawn(collect_output(
            reader,
            sender,
            framing,
            discarded,
            completion,
            #[cfg(test)]
            None,
        ))));
        self.ready = true;
        Ok(())
    }

    fn spawn_frontier(
        prepared: PreparedLaunch,
        gate: &dyn SpawnGate,
    ) -> std::result::Result<(Self, mpsc::Sender<Result<Value>>), SpawnFailure> {
        let PreparedLaunch {
            mut command,
            framing,
            stderr,
        } = prepared;
        let permit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| gate.enter()))
            .ok()
            .and_then(std::result::Result::ok)
            .ok_or_else(|| SpawnFailure::before_spawn(anyhow::anyhow!("worker spawn denied")))?;
        let child = command.spawn();
        let child = match child {
            Ok(child) => child,
            Err(_) => {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(permit)));
                return Err(SpawnFailure::before_spawn(anyhow::anyhow!(
                    "worker holder spawn failed"
                )));
            }
        };
        let (sender, output) = mpsc::channel(if framing.recover { 1 } else { QUEUE });
        let discarded = Arc::new(AtomicU64::new(0));
        let stderr_bytes = Arc::new(AtomicU64::new(0));
        // The guard exists before any await: cancelling the startup handshake
        // sends TERM to the holder, whose handler precedes provider launch.
        let stop_signal = StopSignal(Arc::new(Mutex::new(
            child.id().filter(|pid| *pid > 1 && *pid <= i32::MAX as u32),
        )));
        let process = Self {
            child,
            stop_signal,
            stdin: None,
            output,
            output_taken: false,
            output_completion: Arc::default(),
            stdout_reader_index: None,
            readers: Vec::new(),
            stderr_bytes: stderr_bytes.clone(),
            private_stderr: match stderr {
                StderrPolicy::CountOnly => None,
                StderrPolicy::PrivateTail { max_bytes } => Some(Arc::new(Mutex::new(StderrTail {
                    bytes: VecDeque::with_capacity(max_bytes),
                    limit: max_bytes,
                    eof: false,
                }))),
            },
            stderr_joined: false,
            stderr_taken: false,
            write_failed: false,
            startup_reader: None,
            startup_sender: None,
            startup_attempted: false,
            ready: false,
            exit: None,
            framing,
            discarded: discarded.clone(),
        };
        // Install the PID owner before releasing any host-supplied guard.
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(permit))).is_err() {
            return Err(SpawnFailure::after_spawn(
                process,
                anyhow::anyhow!("worker spawn seal release failed"),
            ));
        }
        Ok((process, sender))
    }

    pub fn take_private_stderr(&mut self) -> std::result::Result<PrivateStderr, StderrUnavailable> {
        let tail = self
            .private_stderr
            .as_ref()
            .ok_or(StderrUnavailable::Disabled)?;
        if self.exit.is_none() || !self.stderr_joined {
            return Err(StderrUnavailable::Incomplete);
        }
        let mut tail = tail.lock().map_err(|_| StderrUnavailable::Incomplete)?;
        if !tail.eof {
            return Err(StderrUnavailable::Incomplete);
        }
        if self.stderr_taken {
            return Err(StderrUnavailable::Taken);
        }
        self.stderr_taken = true;
        Ok(PrivateStderr(tail.bytes.drain(..).collect()))
    }

    /// True only after the acknowledged stdout reader observed its normal EOF
    /// path with a live receiver and stop() successfully joined that reader.
    /// Recovering profiles may have discarded invalid frames before EOF. This
    /// proves neither output consumption/delivery nor native acceptance or PID
    /// cleanup: callers must retain those independent observations/proofs.
    pub fn output_finished_cleanly(&self) -> bool {
        self.ready && self.exit.is_some() && self.output_completion.finished_cleanly()
    }

    pub fn discarded_frames(&self) -> u64 {
        self.discarded.load(Ordering::Relaxed)
    }
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn stop_signal(&self) -> StopSignal {
        self.stop_signal.clone()
    }

    pub async fn send(&mut self, value: &Value) -> Result<()> {
        ensure!(
            self.ready && !self.write_failed && self.exit.is_none(),
            "worker input is unavailable"
        );
        let frame = self.framing.encode(value)?;
        self.send_prepared(frame).await
    }

    pub async fn send_prepared(&mut self, frame: PreparedInput) -> Result<()> {
        ensure!(
            self.ready && !self.write_failed && self.exit.is_none(),
            "worker input is unavailable"
        );
        ensure!(
            frame.0.len() <= self.framing.max_input_bytes,
            "worker request exceeds framing limit"
        );
        let mut write = WriteGuard {
            stdin: &mut self.stdin,
            failed: &mut self.write_failed,
            armed: true,
        };
        let input = write.stdin.as_mut().context("worker input is closed")?;
        let result = tokio::time::timeout(WRITE_TIMEOUT, async {
            input.write_all(&frame.0).await?;
            input.flush().await
        })
        .await;
        match result {
            Ok(Ok(())) => {
                write.armed = false;
                Ok(())
            }
            _ => bail!("worker request delivery is unknown; input closed"),
        }
    }

    /// Transfer the single receiver to a reader task. A second transfer fails.
    pub fn take_output(&mut self) -> Result<mpsc::Receiver<Result<Value>>> {
        ensure!(!self.output_taken, "worker output already transferred");
        self.output_taken = true;
        let (_sender, empty) = mpsc::channel(1);
        Ok(std::mem::replace(&mut self.output, empty))
    }
    pub async fn recv(&mut self) -> Result<Option<Value>> {
        ensure!(
            !self.output_taken,
            "worker output belongs to another reader"
        );
        self.output.recv().await.transpose()
    }

    pub async fn stop(&mut self) -> Result<Exit> {
        self.stop_signal.invalidate();
        if let Some(exit) = &self.exit {
            return Ok(exit.clone());
        }
        self.stdin.take();
        self.term_holder();
        let status = tokio::time::timeout(STOP_TIMEOUT, self.child.wait())
            .await
            .context("worker cleanup timeout")?
            .context("worker holder wait failed")?;
        // A holder killed by TERM before registering its handler has not yet
        // spawned a provider. Other fatal signals do not prove cleanup.
        ensure!(
            status.code() != Some(125),
            "worker holder could not confirm cleanup"
        );
        ensure!(
            status.signal().is_none() || status.signal() == Some(15),
            "worker holder cleanup interrupted"
        );
        // Keep an unacknowledged stdout FD open until the holder exit proves
        // cleanup; dropping it earlier can turn a valid ACK into a broken pipe.
        self.startup_reader.take();
        self.startup_sender.take();
        self.output.close();
        for (index, reader) in self.readers.iter_mut().enumerate() {
            if let Some(task) = reader.as_mut() {
                let joined = join_reader(task).await;
                if index == 0 {
                    self.stderr_joined = joined;
                }
                if self.stdout_reader_index == Some(index) {
                    self.output_completion
                        .joined
                        .store(joined, Ordering::Release);
                }
                *reader = None;
            }
        }
        self.readers.clear();
        let exit = Exit {
            code: status.code(),
            stderr_bytes: self.stderr_bytes.load(Ordering::Relaxed),
        };
        self.exit = Some(exit.clone());
        Ok(exit)
    }

    fn term_holder(&self) {
        if let Some(pid) = self.child.id() {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.stop_signal.invalidate();
        self.stdin.take();
        self.term_holder();
        for task in self.readers.iter().flatten() {
            task.abort();
        }
    }
}

async fn join_reader(task: &mut JoinHandle<()>) -> bool {
    match tokio::time::timeout(Duration::from_secs(1), &mut *task).await {
        Ok(result) => result.is_ok(),
        Err(_) => {
            task.abort();
            let _ = task.await;
            false
        }
    }
}

#[cfg(test)]
enum OutputEofHook {
    Panic,
    Pause(Arc<tokio::sync::Notify>),
}
async fn collect_output<R: AsyncBufRead + Unpin>(
    mut reader: R,
    sender: mpsc::Sender<Result<Value>>,
    framing: Framing,
    discarded: Arc<AtomicU64>,
    completion: Arc<OutputCompletion>,
    #[cfg(test)] hook: Option<OutputEofHook>,
) {
    let eof = loop {
        let value = if framing.recover {
            match recovering_line(&mut reader, framing.max_wire_bytes).await {
                Ok(Line::Bytes(line)) => match serde_json::from_slice::<Value>(&line) {
                    Ok(value) if value.is_object() => Ok(value),
                    _ => {
                        discarded.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                },
                Ok(Line::Discarded) => {
                    discarded.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                Ok(Line::Eof) => break true,
                Err(error) => Err(error),
            }
        } else {
            match bounded_line(&mut reader).await {
                Ok(Some(line)) => serde_json::from_slice(&line)
                    .map_err(|_| anyhow::anyhow!("invalid subprocess JSON")),
                Ok(None) => break true,
                Err(error) => Err(error),
            }
        };
        let failed = value.is_err();
        if sender.send(value).await.is_err() || failed {
            break false;
        }
    };
    // A dropped/closed consumer cannot manufacture output completion when EOF
    // arrives later (including after stop). A later consumer drop does not
    // erase EOF already witnessed while it was live.
    if eof && !sender.is_closed() {
        completion.eof.store(true, Ordering::Release);
        #[cfg(test)]
        if let Some(hook) = hook {
            match hook {
                OutputEofHook::Panic => panic!("synthetic stdout reader panic after EOF"),
                OutputEofHook::Pause(entered) => {
                    entered.notify_one();
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}

async fn collect_stderr<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    count: Arc<AtomicU64>,
    tail: Option<Arc<Mutex<StderrTail>>>,
) {
    let mut bytes = [0u8; 8192];
    while let Ok(read) = reader.read(&mut bytes).await {
        if read == 0 {
            if let Some(tail) = &tail {
                tail.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .eof = true;
            }
            break;
        }
        if let Some(tail) = &tail {
            tail.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .append(&bytes[..read]);
        }
        let _ = count.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            Some(value.saturating_add(read as u64))
        });
    }
}

// An interrupted write can already have delivered a prefix. Retrying another
// frame would corrupt framing, so cancellation closes input just like timeout.
struct WriteGuard<'a> {
    stdin: &'a mut Option<ChildStdin>,
    failed: &'a mut bool,
    armed: bool,
}
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            *self.failed = true;
            self.stdin.take();
        }
    }
}

enum Line {
    Bytes(Vec<u8>),
    Discarded,
    Eof,
}
async fn recovering_line<R: AsyncBufRead + Unpin>(reader: &mut R, limit: usize) -> Result<Line> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let bytes = reader
            .fill_buf()
            .await
            .context("worker output read failed")?;
        if bytes.is_empty() {
            return Ok(if line.is_empty() && !oversized {
                Line::Eof
            } else {
                Line::Discarded
            });
        }
        let count = bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(bytes.len(), |n| n + 1);
        let ended = bytes[count - 1] == b'\n';
        if !oversized {
            if line.len() + count > limit {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&bytes[..count]);
            }
        }
        reader.consume(count);
        if ended {
            return Ok(if oversized {
                Line::Discarded
            } else {
                Line::Bytes(line)
            });
        }
    }
}

async fn bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let bytes = reader
            .fill_buf()
            .await
            .context("worker output read failed")?;
        if bytes.is_empty() {
            ensure!(line.is_empty(), "truncated subprocess frame");
            return Ok(None);
        }
        let count = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |offset| offset + 1);
        ensure!(
            line.len() + count <= MAX_FRAME,
            "subprocess frame exceeds 1 MiB"
        );
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail(limit: usize) -> Arc<Mutex<StderrTail>> {
        Arc::new(Mutex::new(StderrTail {
            bytes: VecDeque::with_capacity(limit),
            limit,
            eof: false,
        }))
    }
    struct ErrorReader;
    impl tokio::io::AsyncRead for ErrorReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            _: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other("PRIVATE_READ_FAILURE")))
        }
    }
    #[tokio::test]
    async fn output_completion_requires_successful_join_even_after_eof_reader_panic() {
        crate::panic_guard::install();
        let completion = Arc::new(OutputCompletion::default());
        let (sender, mut output) = mpsc::channel(1);
        let mut task = tokio::spawn(collect_output(
            BufReader::new(&b"{}\n"[..]),
            sender,
            Framing::strict(),
            Arc::new(AtomicU64::new(0)),
            completion.clone(),
            Some(OutputEofHook::Panic),
        ));
        assert!(output.recv().await.unwrap().is_ok());
        assert!(output.recv().await.is_none());
        assert!(completion.eof.load(Ordering::Acquire));
        let joined = join_reader(&mut task).await;
        completion.joined.store(joined, Ordering::Release);
        assert!(!joined);
        assert!(!completion.finished_cleanly());
    }
    #[tokio::test]
    async fn output_completion_requires_successful_join_even_after_eof_reader_abort() {
        let completion = Arc::new(OutputCompletion::default());
        let (sender, mut output) = mpsc::channel(1);
        let entered = Arc::new(tokio::sync::Notify::new());
        let mut task = tokio::spawn(collect_output(
            BufReader::new(&b"{}\n"[..]),
            sender,
            Framing::strict(),
            Arc::new(AtomicU64::new(0)),
            completion.clone(),
            Some(OutputEofHook::Pause(entered.clone())),
        ));
        assert!(output.recv().await.unwrap().is_ok());
        entered.notified().await;
        assert!(completion.eof.load(Ordering::Acquire));
        task.abort();
        let joined = join_reader(&mut task).await;
        completion.joined.store(joined, Ordering::Release);
        assert!(output.recv().await.is_none());
        assert!(!joined);
        assert!(!completion.finished_cleanly());
    }
    #[tokio::test]
    async fn output_reader_read_error_never_records_eof() {
        let completion = Arc::new(OutputCompletion::default());
        let (sender, mut output) = mpsc::channel(1);
        let mut task = tokio::spawn(collect_output(
            BufReader::new(ErrorReader),
            sender,
            Framing::strict(),
            Arc::new(AtomicU64::new(0)),
            completion.clone(),
            None,
        ));
        assert!(output.recv().await.unwrap().is_err());
        assert!(output.recv().await.is_none());
        let joined = join_reader(&mut task).await;
        completion.joined.store(joined, Ordering::Release);
        assert!(joined);
        assert!(!completion.eof.load(Ordering::Acquire));
        assert!(!completion.finished_cleanly());
    }
    #[tokio::test]
    async fn private_stderr_read_error_is_not_eof_evidence() {
        let tail = tail(32);
        collect_stderr(ErrorReader, Arc::new(AtomicU64::new(0)), Some(tail.clone())).await;
        assert!(!tail.lock().unwrap().eof);
    }
    #[tokio::test]
    async fn private_stderr_aborted_reader_is_not_eof_evidence() {
        let (read, mut write) = tokio::io::duplex(1);
        let tail = tail(32);
        let collector = tokio::spawn(collect_stderr(
            read,
            Arc::new(AtomicU64::new(0)),
            Some(tail.clone()),
        ));
        write.write_all(b"x").await.unwrap();
        collector.abort();
        assert!(collector.await.unwrap_err().is_cancelled());
        assert!(!tail.lock().unwrap().eof);
    }
    #[test]
    fn private_stderr_chunking_keeps_actual_allocation_bounded() {
        for limit in [1, 37, MAX_PRIVATE_STDERR] {
            let mut tail = StderrTail {
                bytes: VecDeque::with_capacity(limit),
                limit,
                eof: false,
            };
            let capacity = tail.bytes.capacity();
            for size in [1, 8192, 100_000, 2, 50_000] {
                tail.append(&vec![b'x'; size]);
                assert!(tail.bytes.len() <= limit);
                assert_eq!(tail.bytes.capacity(), capacity);
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn filesystem_launch_validation_does_not_block_runtime_heartbeat() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let arriving = entered.clone();
        let release = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let checking = release.clone();
        let (started, observed) = std::sync::mpsc::channel();
        let (heartbeat, responsive) = std::sync::mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            let started = observed.recv_timeout(Duration::from_secs(5)).is_ok();
            let responsive = started && responsive.recv_timeout(Duration::from_secs(5)).is_ok();
            *release.0.lock().unwrap() = true;
            release.1.notify_all();
            responsive
        });
        let launch = Launch {
            holder: "/fixture/holder".into(),
            program: "/fixture/provider".into(),
            args: vec![],
            cwd: "/fixture".into(),
            env: Default::default(),
        };
        let validation = tokio::spawn(validated_launch(launch, move |_| {
            let _ = started.send(());
            arriving.notify_one();
            let mut ready = checking.0.lock().unwrap();
            while !*ready {
                ready = checking.1.wait(ready).unwrap();
            }
            Ok(())
        }));
        entered.notified().await;
        let _ = heartbeat.send(());
        assert!(validation.await.unwrap().is_ok());
        assert!(
            watchdog.join().unwrap(),
            "launch filesystem validation blocked the Tokio worker"
        );
    }

    #[tokio::test]
    async fn recovery_drains_fragmented_oversize_and_discards_unterminated_tail() {
        let bytes = b"123456789\n{}\n{broken";
        let mut reader = BufReader::with_capacity(1, &bytes[..]);
        assert!(matches!(
            recovering_line(&mut reader, 4).await.unwrap(),
            Line::Discarded
        ));
        assert!(
            matches!(recovering_line(&mut reader, 4).await.unwrap(), Line::Bytes(line) if line == b"{}\n")
        );
        assert!(matches!(
            recovering_line(&mut reader, 4).await.unwrap(),
            Line::Discarded
        ));
        assert!(matches!(
            recovering_line(&mut reader, 4).await.unwrap(),
            Line::Eof
        ));
    }

    #[test]
    fn launch_debug_exposes_only_counts_not_paths_arguments_or_credentials() {
        let launch = Launch {
            holder: "/private/HOLDER_SECRET".into(),
            program: "/private/PROGRAM_SECRET".into(),
            cwd: "/private/CWD_SECRET".into(),
            args: vec!["ARGUMENT_SECRET".into()],
            env: BTreeMap::from([("PULT_MEMORY_KEY".into(), "MEMORY_SECRET".into())]),
        };
        let diagnostic = format!("{launch:?}");
        assert!(diagnostic.contains("argument_count: 1"));
        assert!(diagnostic.contains("environment_count: 1"));
        for secret in [
            "HOLDER_SECRET",
            "PROGRAM_SECRET",
            "CWD_SECRET",
            "ARGUMENT_SECRET",
            "PULT_MEMORY_KEY",
            "MEMORY_SECRET",
        ] {
            assert!(!diagnostic.contains(secret));
        }
    }
}
