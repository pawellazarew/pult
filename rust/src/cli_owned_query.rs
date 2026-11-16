//! Binary-private owned query lifecycle, shared by closed service and Node-version queries.
use anyhow::{Context as _, Result, ensure};
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use rustix::process::{WaitId, WaitIdOptions, waitid};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
};
const CLEANUP: Duration = Duration::from_secs(2);
const LIMIT: usize = 1024 * 1024;
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Service,
    NodeVersion,
    DoctorShell,
    DoctorVersion,
    DoctorAuth,
    DoctorSchema,
    DoctorSavedNode,
    DoctorNetwork,
}
impl Kind {
    fn deadline(self) -> Duration {
        match self {
            Self::Service => Duration::from_secs(20),
            Self::NodeVersion => Duration::from_secs(60),
            Self::DoctorShell => Duration::from_secs(3),
            Self::DoctorVersion | Self::DoctorSchema => Duration::from_secs(30),
            Self::DoctorAuth => Duration::from_secs(20),
            Self::DoctorSavedNode => Duration::from_secs(10),
            Self::DoctorNetwork => Duration::from_secs(8),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub(super) enum Error {
    Spawn,
    PidUnavailable,
    PidInvalid,
    StdoutUnavailable,
    StderrUnavailable,
    Ownership,
    Timeout,
    Interrupted,
    Output,
    Overflow,
    Cleanup,
    OutputCleanup,
    OutputUnavailable,
}
pub(super) struct Output {
    pub status: std::process::ExitStatus,
    pub failure: Option<Error>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
// Bounded all-zombie proof copied from the reviewed memory acceptance harness;
// the query leader remains unreaped until the last group signal.
#[cfg(target_os = "macos")]
fn zombie_members(bytes: &[u8], leader: i32) -> Result<std::collections::BTreeSet<u32>> {
    use std::collections::BTreeSet;
    let output = std::str::from_utf8(bytes).context("invalid process snapshot")?;
    let mut pids = BTreeSet::new();
    let mut members = BTreeSet::new();
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_whitespace().collect();
        ensure!(fields.len() == 3, "ambiguous process snapshot");
        let pid: u32 = fields[0].parse().context("invalid process pid")?;
        let group: u32 = fields[1].parse().context("invalid process group")?;
        ensure!(
            pid <= i32::MAX as u32 && group <= i32::MAX as u32,
            "process id overflow"
        );
        ensure!(pids.insert(pid), "duplicate process snapshot pid");
        let status = fields[2];
        ensure!(
            !status.is_empty() && status.bytes().all(|b| b.is_ascii_graphic()),
            "invalid process status"
        );
        if group == leader as u32 {
            ensure!(
                pid > 0 && status.starts_with('Z'),
                "group member still executing"
            );
            members.insert(pid);
        }
    }
    ensure!(
        members.contains(&(leader as u32)),
        "owned zombie leader missing"
    );
    Ok(members)
}

#[cfg(target_os = "macos")]
async fn process_snapshot(deadline: tokio::time::Instant) -> Result<Vec<u8>> {
    const MAX_SNAPSHOT: u64 = 2 * 1024 * 1024;
    let mut child = Command::new("/bin/ps")
        .args(["-axo", "pid=,pgid=,stat="])
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .context("process snapshot unavailable")?;
    let result = tokio::time::timeout_at(deadline, async {
        let output = child
            .stdout
            .take()
            .context("process snapshot stdout missing")?;
        let mut bytes = Vec::new();
        output
            .take(MAX_SNAPSHOT + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(
            bytes.len() as u64 <= MAX_SNAPSHOT,
            "process snapshot exceeds budget"
        );
        ensure!(child.wait().await?.success(), "process snapshot failed");
        Ok(bytes)
    })
    .await;
    match result {
        Ok(Ok(bytes)) => Ok(bytes),
        result => {
            // Only the inspection child is reaped here, never the pinned Node
            // leader. Failure/timeout cannot become group cleanup confirmation.
            let _ = child.start_kill();
            let _ = tokio::time::timeout(CLEANUP, child.wait()).await;
            match result {
                Ok(Err(error)) => Err(error),
                Err(_) => anyhow::bail!("process snapshot deadline"),
                Ok(Ok(_)) => unreachable!(),
            }
        }
    }
}

#[cfg(target_os = "macos")]
async fn confirm_zombie_group(leader: i32) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    // Retain the unreaped leader through two bounded enumerations. Any live,
    // missing, ambiguous or changing membership stays cleanup-unconfirmed.
    let first = zombie_members(&process_snapshot(deadline).await?, leader)?;
    let second = zombie_members(&process_snapshot(deadline).await?, leader)?;
    ensure!(
        first == second,
        "process group membership changed during proof"
    );
    Ok(())
}

struct Query {
    child: Child,
    group: Pid,
    may_signal: bool,
}
impl Query {
    fn exited(&mut self) -> anyhow::Result<bool> {
        let pid =
            rustix::process::Pid::from_raw(self.group.as_raw()).context("invalid query pid")?;
        match waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG,
        ) {
            Ok(status) => Ok(status.is_some()),
            Err(rustix::io::Errno::INTR) => Ok(false),
            Err(_) => {
                self.may_signal = false;
                anyhow::bail!("query ownership is unknown")
            }
        }
    }
    async fn cleanup(&mut self) -> anyhow::Result<std::process::ExitStatus> {
        ensure!(self.may_signal, "query ownership is unknown");
        match killpg(self.group, Signal::SIGKILL) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => (),
            #[cfg(target_os = "macos")]
            Err(nix::errno::Errno::EPERM) => {
                ensure!(self.exited()?, "query leader is still executing");
                confirm_zombie_group(self.group.as_raw()).await?;
            }
            Err(_) => anyhow::bail!("query group cleanup is unconfirmed"),
        }
        // No signal may target this group after releasing the leader PID.
        self.may_signal = false;
        Ok(tokio::time::timeout(CLEANUP, self.child.wait()).await??)
    }
}
impl Drop for Query {
    fn drop(&mut self) {
        if self.may_signal {
            let _ = killpg(self.group, Signal::SIGKILL);
        }
    }
}
async fn capture_pipe(
    pipe: impl AsyncRead + Unpin,
    combined: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut bytes = Vec::new();
    let mut pipe = pipe.take(limit as u64 + 1);
    if let Some(combined) = combined {
        let mut buffer = [0; 8192];
        loop {
            let count = pipe.read(&mut buffer).await.map_err(|_| Error::Output)?;
            if count == 0 {
                break;
            }
            let before = combined.fetch_add(count, std::sync::atomic::Ordering::Relaxed);
            if before + count > LIMIT {
                return Err(Error::Overflow);
            }
            bytes.extend_from_slice(&buffer[..count]);
        }
    } else {
        // Keep the reviewed service per-pipe capture contract unchanged.
        pipe.read_to_end(&mut bytes)
            .await
            .map_err(|_| Error::Output)?;
    }
    if bytes.len() > limit {
        return Err(Error::Overflow);
    }
    Ok(bytes)
}
pub(super) fn failure_kind(
    kind: Kind,
    primary: Option<Error>,
    reader: Option<Error>,
) -> Option<Error> {
    if matches!(kind, Kind::Service | Kind::NodeVersion) {
        return primary.or(reader);
    }
    // A deadline may win select while a completed reader error is still queued.
    // Preserve independently observed capture failure through auth projection.
    for error in [primary, reader].into_iter().flatten() {
        if matches!(
            error,
            Error::Interrupted | Error::Ownership | Error::Cleanup | Error::OutputCleanup
        ) {
            return Some(error);
        }
    }
    if [primary, reader]
        .into_iter()
        .flatten()
        .any(|e| matches!(e, Error::Overflow))
    {
        return Some(Error::Overflow);
    }
    if matches!(primary, Some(Error::Timeout)) && reader.is_some() {
        return reader;
    }
    primary.or(reader)
}
pub(super) async fn run(
    command: &mut Command,
    kind: Kind,
    cancelled: &mut bool,
    cleanup_failed: &mut bool,
    interrupt: &mut tokio::signal::unix::Signal,
) -> Result<Output, Error> {
    run_with_cancel(command, kind, cancelled, cleanup_failed, async {
        interrupt.recv().await;
    })
    .await
}
pub(super) async fn run_with_cancel(
    command: &mut Command,
    kind: Kind,
    cancelled: &mut bool,
    cleanup_failed: &mut bool,
    cancellation: impl std::future::Future<Output = ()>,
) -> Result<Output, Error> {
    tokio::pin!(cancellation);
    tokio::select! { biased;
        _ = &mut cancellation => { *cancelled = true; return Err(Error::Interrupted); },
        _ = std::future::ready(()) => (),
    }
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| Error::Spawn)?;
    let group = Pid::from_raw(
        i32::try_from(child.id().ok_or(Error::PidUnavailable)?).map_err(|_| Error::PidInvalid)?,
    );
    let mut owner = Query {
        child,
        group,
        may_signal: true,
    };
    let mut reads = tokio::task::JoinSet::new();
    let stdout = owner.child.stdout.take().ok_or(Error::StdoutUnavailable)?;
    let stderr = owner.child.stderr.take().ok_or(Error::StderrUnavailable)?;
    let combined = matches!(kind, Kind::NodeVersion)
        .then(|| std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)));
    let limit = match kind {
        Kind::Service | Kind::NodeVersion => LIMIT,
        Kind::DoctorNetwork => 64 * 1024,
        _ => 4 * LIMIT,
    };
    let stdout_budget = combined.clone();
    reads.spawn(async move { (true, capture_pipe(stdout, stdout_budget, limit).await) });
    reads.spawn(async move { (false, capture_pipe(stderr, combined, limit).await) });
    let mut output = None;
    let mut error_output = None;
    let deadline = tokio::time::Instant::now() + kind.deadline();
    let result = loop {
        match owner.exited() {
            Ok(true) => break Ok(()),
            Ok(false) => (),
            Err(_) => break Err(Error::Ownership),
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break Err(Error::Timeout),
            _ = &mut cancellation => { *cancelled = true; break Err(Error::Interrupted); },
            item = reads.join_next(), if !reads.is_empty() => match item {
                Some(Ok((out, Ok(bytes)))) => if out { output = Some(bytes); } else { error_output = Some(bytes); },
                Some(Ok((_, Err(error)))) => break Err(error),
                _ => break Err(Error::Output),
            },
            _ = tokio::time::sleep(Duration::from_millis(10)) => (),
        }
    };
    // Even EOF/timeout/overflow/cancellation must kill descendants before reap.
    let cleanup = owner.cleanup().await;
    if cleanup.is_err() {
        *cleanup_failed = true;
        reads.abort_all();
    }
    let mut read_error = None;
    loop {
        match tokio::time::timeout(CLEANUP, reads.join_next()).await {
            Ok(Some(Ok((out, Ok(bytes))))) => {
                if out {
                    output = Some(bytes);
                } else {
                    error_output = Some(bytes);
                }
            }
            Ok(Some(Ok((_, Err(error))))) => {
                read_error = failure_kind(kind, read_error, Some(error));
            }
            Ok(Some(Err(_))) => {
                *cleanup_failed = true;
                read_error = failure_kind(kind, read_error, Some(Error::Output));
            }
            Ok(None) => break,
            Err(_) => {
                *cleanup_failed = true;
                reads.abort_all();
                while reads.join_next().await.is_some() {}
                read_error = Some(Error::OutputCleanup);
                break;
            }
        }
    }
    let status = cleanup.map_err(|_| Error::Cleanup)?;
    let diagnostic = !matches!(kind, Kind::Service | Kind::NodeVersion);
    let failure = failure_kind(kind, result.err(), read_error);
    if let Some(error) = failure
        && (!diagnostic
            || matches!(
                error,
                Error::Interrupted | Error::Ownership | Error::OutputCleanup
            ))
    {
        return Err(error);
    }
    Ok(Output {
        status,
        failure,
        stdout: if failure.is_some() {
            output.unwrap_or_default()
        } else {
            output.ok_or(Error::OutputUnavailable)?
        },
        stderr: if failure.is_some() {
            error_output.unwrap_or_default()
        } else {
            error_output.ok_or(Error::OutputUnavailable)?
        },
    })
}
