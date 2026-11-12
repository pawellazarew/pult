//! Bounded JSON transport for an explicitly selected, supervised subprocess.
//! This is a trusted host API, not permission to execute a client command.
use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

pub const MAX_FRAME: usize = 1024 * 1024;
const QUEUE: usize = 16;
const CODEX_FRAME: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy, Debug)]
pub struct Framing {
    max_wire_bytes: usize,
    recover: bool,
}
impl Framing {
    pub fn strict() -> Self {
        Self {
            max_wire_bytes: MAX_FRAME,
            recover: false,
        }
    }
    pub fn codex() -> Self {
        Self {
            max_wire_bytes: CODEX_FRAME + 1,
            recover: true,
        }
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

pub struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    output: mpsc::Receiver<Result<Value>>,
    output_taken: bool,
    readers: Vec<Option<JoinHandle<()>>>,
    stderr_bytes: Arc<AtomicU64>,
    write_failed: bool,
    exit: Option<Exit>,
    framing: Framing,
    discarded: Arc<AtomicU64>,
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
        let child = command
            .spawn()
            .context("worker holder spawn failed")
            .map_err(SpawnFailure::before_spawn)?;
        let (sender, output) = mpsc::channel(if framing.recover { 1 } else { QUEUE });
        let discarded = Arc::new(AtomicU64::new(0));
        let stderr_bytes = Arc::new(AtomicU64::new(0));
        // The guard exists before any await: cancelling the startup handshake
        // sends TERM to the holder, whose handler precedes provider launch.
        let mut process = Self {
            child,
            stdin: None,
            output,
            output_taken: false,
            readers: Vec::new(),
            stderr_bytes: stderr_bytes.clone(),
            write_failed: false,
            exit: None,
            framing,
            discarded: discarded.clone(),
        };
        process.stdin = process.child.stdin.take();
        let Some(stdout) = process.child.stdout.take() else {
            return Err(SpawnFailure::after_spawn(
                process,
                anyhow::anyhow!("worker stdout unavailable"),
            ));
        };
        let Some(mut stderr) = process.child.stderr.take() else {
            return Err(SpawnFailure::after_spawn(
                process,
                anyhow::anyhow!("worker stderr unavailable"),
            ));
        };
        process.readers.push(Some(tokio::spawn(async move {
            let mut bytes = [0u8; 8192];
            while let Ok(count) = stderr.read(&mut bytes).await {
                if count == 0 {
                    break;
                }
                let _ = stderr_bytes.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    Some(value.saturating_add(count as u64))
                });
            }
        })));
        let mut reader = BufReader::new(stdout);
        let ready: Result<()> = async {
            let line = tokio::time::timeout(START_TIMEOUT, bounded_line(&mut reader))
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
            Ok(())
        }
        .await;
        if let Err(error) = ready {
            return Err(SpawnFailure::after_spawn(process, error));
        }
        process.readers.push(Some(tokio::spawn(async move {
            loop {
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
                        Ok(Line::Eof) => break,
                        Err(error) => Err(error),
                    }
                } else {
                    match bounded_line(&mut reader).await {
                        Ok(Some(line)) => serde_json::from_slice(&line)
                            .map_err(|_| anyhow::anyhow!("invalid subprocess JSON")),
                        Ok(None) => break,
                        Err(error) => Err(error),
                    }
                };
                let failed = value.is_err();
                if sender.send(value).await.is_err() || failed {
                    break;
                }
            }
        })));
        Ok(process)
    }

    pub fn discarded_frames(&self) -> u64 {
        self.discarded.load(Ordering::Relaxed)
    }
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn send(&mut self, value: &Value) -> Result<()> {
        ensure!(
            !self.write_failed && self.exit.is_none(),
            "worker input is unavailable"
        );
        let mut bytes = serde_json::to_vec(value).context("worker request serialization failed")?;
        ensure!(
            bytes.len() < self.framing.max_wire_bytes,
            "worker request exceeds framing limit"
        );
        bytes.push(b'\n');
        let mut write = WriteGuard {
            stdin: &mut self.stdin,
            failed: &mut self.write_failed,
            armed: true,
        };
        let input = write.stdin.as_mut().context("worker input is closed")?;
        let result = tokio::time::timeout(WRITE_TIMEOUT, async {
            input.write_all(&bytes).await?;
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
        self.output.close();
        for reader in &mut self.readers {
            if let Some(task) = reader.as_mut() {
                if tokio::time::timeout(Duration::from_secs(1), &mut *task)
                    .await
                    .is_err()
                {
                    task.abort();
                    let _ = task.await;
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
        self.stdin.take();
        self.term_holder();
        for task in self.readers.iter().flatten() {
            task.abort();
        }
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
