#![forbid(unsafe_code)]

use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

pub const MAX_LINE: usize = 1024 * 1024;
pub const MAX_JOURNAL: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct Record {
    pub sequence: u64,
    pub kind: String,
    pub data: Value,
}

/// A single writer acknowledges only after sync_data. This experiment does not
/// promise directory-entry durability under power loss or compatibility with Pult's journal.
pub struct Journal {
    file: File,
    _lock: File,
    next: u64,
    poisoned: bool,
}

impl Drop for Journal {
    fn drop(&mut self) {
        // Release ownership explicitly: concurrent fork/exec may briefly inherit a CLOEXEC
        // descriptor; closing only our descriptor can otherwise prolong the shared flock.
        let _ = FileExt::unlock(&self._lock);
    }
}

impl Journal {
    pub fn open(home: &Path) -> Result<Self> {
        ensure!(home.is_absolute(), "--home must be absolute");
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        builder.mode(0o700);
        builder.create(home)?;
        #[cfg(unix)]
        ensure!(
            home.metadata()?.permissions().mode() & 0o077 == 0,
            "scratch home must be private (mode 0700); choose a fresh mktemp directory"
        );
        let canonical = home.canonicalize()?;
        if let Some(user_home) = std::env::var_os("HOME") {
            let production = Path::new(&user_home).join(".pult");
            let production = production.canonicalize().unwrap_or(production);
            ensure!(
                !canonical.starts_with(&production),
                "production Pult home is forbidden"
            );
            ensure!(canonical != Path::new(&user_home), "user home is forbidden");
        }
        if let Some(production) = std::env::var_os("PULT_HOME") {
            let production = Path::new(&production);
            let production = production
                .canonicalize()
                .unwrap_or_else(|_| production.to_path_buf());
            ensure!(
                !canonical.starts_with(production),
                "configured production Pult home is forbidden"
            );
        }
        for name in ["r1.lock", "r1.ndjson"] {
            if let Ok(metadata) = std::fs::symlink_metadata(home.join(name)) {
                ensure!(
                    metadata.is_file() && !metadata.file_type().is_symlink(),
                    "prototype files must be regular files, not symlinks"
                );
                #[cfg(unix)]
                ensure!(
                    metadata.permissions().mode() & 0o077 == 0,
                    "prototype files must be private (mode 0600)"
                );
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let lock = options.open(home.join("r1.lock"))?;
        lock.try_lock_exclusive()
            .context("another prototype owns this home")?;
        let mut file = options.open(home.join("r1.ndjson"))?;
        ensure!(
            file.metadata()?.len() <= MAX_JOURNAL,
            "prototype journal exceeds 32 MiB"
        );
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let (records, valid) = decode(&bytes)?;
        if valid < bytes.len() {
            // A torn final write is not acknowledged. Only the incomplete tail is discarded.
            file.set_len(valid as u64)?;
            file.sync_data()?;
        }
        file.seek(SeekFrom::End(0))?;
        let next = records.last().map_or(1, |r| r.sequence + 1);
        Ok(Self {
            file,
            _lock: lock,
            next,
            poisoned: false,
        })
    }

    pub fn append(&mut self, kind: &str, data: Value) -> Result<u64> {
        ensure!(
            !self.poisoned,
            "journal is poisoned after an uncertain IO failure; reopen to recover"
        );
        let record = Record {
            sequence: self.next,
            kind: kind.into(),
            data,
        };
        let mut bytes = serde_json::to_vec(&record)?;
        ensure!(bytes.len() <= MAX_LINE, "journal record exceeds 1 MiB");
        bytes.push(b'\n');
        ensure!(
            self.file.metadata()?.len() + bytes.len() as u64 <= MAX_JOURNAL,
            "prototype journal exceeds 32 MiB"
        );
        if let Err(error) = self
            .file
            .write_all(&bytes)
            .and_then(|_| self.file.sync_data())
        {
            self.poisoned = true;
            return Err(error).context("journal append failed; further writes are disabled");
        }
        self.next += 1;
        Ok(record.sequence)
    }

    pub fn records(&mut self) -> Result<Vec<Record>> {
        let mut reader = self.file.try_clone()?;
        reader.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes)?;
        self.file.seek(SeekFrom::End(0))?;
        Ok(decode(&bytes)?.0)
    }
}

pub fn decode(bytes: &[u8]) -> Result<(Vec<Record>, usize)> {
    let valid = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |n| n + 1);
    let mut records: Vec<Record> = Vec::new();
    for line in BufReader::new(&bytes[..valid]).split(b'\n') {
        let line = line?;
        ensure!(line.len() <= MAX_LINE, "oversized journal record");
        let record: Record =
            serde_json::from_slice(&line).context("corrupt complete journal record")?;
        ensure!(
            record.sequence == records.last().map_or(1, |r| r.sequence + 1),
            "non-contiguous journal sequence"
        );
        records.push(record);
    }
    Ok((records, valid))
}

pub async fn bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            ensure!(line.is_empty(), "truncated subprocess frame");
            return Ok(None);
        }
        let count = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |n| n + 1);
        ensure!(
            line.len() + count <= MAX_LINE,
            "subprocess frame exceeds 1 MiB"
        );
        line.extend_from_slice(&buf[..count]);
        reader.consume(count);
        if line.last() == Some(&b'\n') {
            return Ok(Some(line));
        }
    }
}

pub struct Process {
    child: Child,
    stdin: Option<ChildStdin>,
    pub output: mpsc::Receiver<Result<Value>>,
    readers: Vec<tokio::task::JoinHandle<()>>,
    stderr_bytes: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl Process {
    pub async fn spawn(program: &str, args: &[String], cwd: &Path) -> Result<Self> {
        let executable = std::env::current_exe()?;
        let directory = executable
            .parent()
            .context("executable directory unavailable")?;
        let directory = if directory.file_name().is_some_and(|n| n == "deps") {
            directory.parent().context("target directory unavailable")?
        } else {
            directory
        };
        let holder = directory.join("pult-r1-holder");
        ensure!(
            holder.is_file(),
            "missing companion pult-r1-holder; build both binaries"
        );
        let mut command = Command::new(holder);
        command.arg(std::process::id().to_string()).arg(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(false);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().context("spawn subprocess")?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().context("stdout unavailable")?;
        let mut stderr = child.stderr.take().context("stderr unavailable")?;
        let mut reader = tokio::io::BufReader::new(stdout);
        let ready: Result<()> = async {
            let bytes =
                tokio::time::timeout(std::time::Duration::from_secs(3), bounded_line(&mut reader))
                    .await??
                    .context("holder exited before provider startup")?;
            let value: Value = serde_json::from_slice(&bytes)?;
            ensure!(
                value["holder_ready"] == true && value["providerPid"].as_u64().is_some(),
                "invalid holder startup acknowledgement"
            );
            Ok(())
        }
        .await;
        if let Err(error) = ready {
            if let Some(pid) = child.id() {
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
            }
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await;
            return Err(error.context("provider startup failed"));
        }
        let (tx, output) = mpsc::channel(16);
        let out = tokio::spawn(async move {
            loop {
                let value = match bounded_line(&mut reader).await {
                    Ok(Some(bytes)) => {
                        serde_json::from_slice(&bytes).context("invalid subprocess JSON")
                    }
                    Ok(None) => break,
                    Err(e) => Err(e),
                };
                let failed = value.is_err();
                if tx.send(value).await.is_err() || failed {
                    break;
                }
            }
        });
        let stderr_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let count = stderr_bytes.clone();
        let err = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = [0; 8192];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                count.fetch_add(n as u64, std::sync::atomic::Ordering::Relaxed);
            }
        });
        Ok(Self {
            child,
            stdin,
            output,
            readers: vec![out, err],
            stderr_bytes,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn send(&mut self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        ensure!(bytes.len() < MAX_LINE, "request exceeds 1 MiB");
        bytes.push(b'\n');
        let input = self.stdin.as_mut().context("stdin closed")?;
        tokio::time::timeout(std::time::Duration::from_secs(5), input.write_all(&bytes)).await??;
        input.flush().await?;
        Ok(())
    }

    pub async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        journal: &mut Journal,
    ) -> Result<Value> {
        self.send(&json!({"id":id,"method":method,"params":params}))
            .await?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let value = tokio::time::timeout_at(deadline, self.output.recv())
                .await?
                .context("subprocess exited before response")??;
            journal.append("provider.message", value.clone())?;
            if value.get("id") == Some(&json!(id)) && value.get("method").is_none() {
                if let Some(error) = value.get("error") {
                    bail!("provider rejected {method}: {error}");
                }
                return Ok(value["result"].clone());
            }
            self.deny_server_request(&value).await?;
        }
    }

    pub async fn deny_server_request(&mut self, value: &Value) -> Result<()> {
        if value.get("id").is_some() && value.get("method").is_some() {
            self.send(&json!({"id":value["id"],"error":{"code":-32601,"message":"R1 prototype does not permit server requests"}})).await?;
        }
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<Value> {
        self.stdin.take();
        if let Some(pid) = self.child.id() {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        let status =
            tokio::time::timeout(std::time::Duration::from_secs(5), self.child.wait()).await??;
        // TERM before the holder installs its handler cannot leave a provider:
        // it registers the handler before spawning one. Other fatal signals do
        // not acknowledge cleanup. Nonzero codes preserve natural provider exits.
        use std::os::unix::process::ExitStatusExt;
        ensure!(
            status.code() != Some(125),
            "holder could not confirm cleanup"
        );
        ensure!(
            status.signal().is_none() || status.signal() == Some(15),
            "holder cleanup interrupted: {status}"
        );
        for task in &self.readers {
            task.abort();
        }
        Ok(
            json!({"code":status.code(),"stderrBytes":self.stderr_bytes.load(std::sync::atomic::Ordering::Relaxed)}),
        )
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        for task in &self.readers {
            task.abort();
        }
        if let Some(pid) = self.child.id() {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        // Await stop for acknowledgement; on owner death the holder observes reparenting.
    }
}

pub fn bounded_sync_line<R: BufRead>(reader: &mut R) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let count = reader
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut line)?;
    ensure!(count <= MAX_LINE, "control frame exceeds 1 MiB");
    if count == 0 {
        return Ok(None);
    }
    ensure!(line.last() == Some(&b'\n'), "truncated control frame");
    Ok(Some(line))
}

#[cfg(test)]
mod journal_failures {
    use super::*;

    #[test]
    fn failed_write_or_sync_permanently_disables_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("read-only");
        std::fs::write(&path, b"").unwrap();
        for file in [
            File::open(&path).unwrap(),
            OpenOptions::new().write(true).open("/dev/null").unwrap(),
        ] {
            let mut journal = Journal {
                file,
                _lock: File::create(dir.path().join("lock")).unwrap(),
                next: 1,
                poisoned: false,
            };
            assert!(journal.append("first", json!({})).is_err());
            let second = journal.append("cleanup", json!({})).unwrap_err();
            assert!(second.to_string().contains("poisoned"));
            assert_eq!(journal.next, 1);
        }
    }
}
