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
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.holder.is_absolute() && self.program.is_absolute() && self.cwd.is_absolute(),
            "worker paths must be absolute"
        );
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
    readers: Vec<Option<JoinHandle<()>>>,
    stderr_bytes: Arc<AtomicU64>,
    write_failed: bool,
    exit: Option<Exit>,
}

impl Process {
    pub async fn spawn(launch: Launch) -> Result<Self> {
        launch.validate()?;
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
        let child = command.spawn().context("worker holder spawn failed")?;
        let (sender, output) = mpsc::channel(QUEUE);
        let stderr_bytes = Arc::new(AtomicU64::new(0));
        // The guard exists before any await: cancelling the startup handshake
        // sends TERM to the holder, whose handler precedes provider launch.
        let mut process = Self {
            child,
            stdin: None,
            output,
            readers: Vec::new(),
            stderr_bytes: stderr_bytes.clone(),
            write_failed: false,
            exit: None,
        };
        process.stdin = process.child.stdin.take();
        let stdout = process
            .child
            .stdout
            .take()
            .context("worker stdout unavailable")?;
        let mut stderr = process
            .child
            .stderr
            .take()
            .context("worker stderr unavailable")?;
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
            // Failure is never an acknowledgement of cleanup. stop retains its
            // child until wait completes; Drop remains a final TERM fallback.
            if process.stop().await.is_err() {
                return Err(error.context("worker startup failed; cleanup unconfirmed"));
            }
            return Err(error.context("worker startup failed"));
        }
        process.readers.push(Some(tokio::spawn(async move {
            loop {
                let value = match bounded_line(&mut reader).await {
                    Ok(Some(line)) => serde_json::from_slice(&line)
                        .map_err(|_| anyhow::anyhow!("invalid subprocess JSON")),
                    Ok(None) => break,
                    Err(error) => Err(error),
                };
                let failed = value.is_err();
                if sender.send(value).await.is_err() || failed {
                    break;
                }
            }
        })));
        Ok(process)
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
        ensure!(bytes.len() < MAX_FRAME, "worker request exceeds 1 MiB");
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

    pub async fn recv(&mut self) -> Result<Option<Value>> {
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
