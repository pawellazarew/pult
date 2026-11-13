//! Actual CLI → scratch daemon → controlled native peers.
//! Test-only ownership harness copied from zcode_memory_compatibility.rs at
//! 2fa8e310dd2d862bd324e11248df14b64132eb09; preserve WNOWAIT/group pin proof.
#![forbid(unsafe_code)]
use anyhow::{Context, Result, ensure};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;
use rustix::process::{WaitId, WaitIdOptions, waitid};
use std::io;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;

const CAPTURE: u64 = 64 * 1024;
const CLEANUP: Duration = Duration::from_secs(10);

fn capture(reader: impl AsyncRead + Unpin + Send + 'static) -> JoinHandle<io::Result<Vec<u8>>> {
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        reader.take(CAPTURE + 1).read_to_end(&mut bytes).await?;
        if bytes.len() as u64 > CAPTURE {
            return Err(io::Error::other("offline harness output exceeds limit"));
        }
        Ok(bytes)
    })
}

// Same proof boundary as worker_holder: Darwin may return EPERM for an owned
// all-zombie group. A dead leader alone does not prove the other members stopped.
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

#[cfg(target_os = "macos")]
#[test]
fn zombie_snapshot_requires_owned_leader_and_rejects_live_or_ambiguous_members() {
    assert_eq!(
        zombie_members(b"71 71 Z\n72 71 ZN\n80 80 R\n", 71).unwrap(),
        [71, 72].into_iter().collect()
    );
    for bytes in [
        &b"71 71 Z\n72 71 S\n"[..], // Live member even though the leader exited.
        &b"72 71 Z\n"[..],          // Missing leader.
        &b"71 71 Z\n71 71 Z\n"[..], // Duplicate PID.
        &b"71 71 Z extra\n"[..],    // Ambiguous row.
        &b"71 71 ?\n"[..],          // Unknown state is not a zombie.
        &b"2147483648 71 Z\n"[..],  // PID overflow.
        &b"\xff\n"[..],             // Invalid encoding.
    ] {
        assert!(zombie_members(bytes, 71).is_err());
    }
}

/// Node and its scratch daemon share one fresh group. Native holders own their
/// provider groups separately and observe daemon/parent-FD death themselves.
/// No wait/try_wait may reap Node before the last group signal: its PID pins PGID.
struct Harness {
    child: Child,
    group: Pid,
    may_signal: bool,
    stdout: Option<JoinHandle<io::Result<Vec<u8>>>>,
    stderr: Option<JoinHandle<io::Result<Vec<u8>>>>,
}
impl Harness {
    fn start(script: &std::path::Path) -> Result<Self> {
        let child = Command::new("node")
            .arg(script)
            .arg(env!("CARGO_BIN_EXE_pultd-rust"))
            .env("PULT_COMPLETION_WAIT_E2E", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .context("could not start offline wait E2E")?;
        let group = Pid::from_raw(i32::try_from(child.id().context("missing harness pid")?)?);
        let mut harness = Self {
            child,
            group,
            may_signal: true,
            stdout: None,
            stderr: None,
        };
        harness.stdout = Some(capture(
            harness
                .child
                .stdout
                .take()
                .context("missing harness stdout")?,
        ));
        harness.stderr = Some(capture(
            harness
                .child
                .stderr
                .take()
                .context("missing harness stderr")?,
        ));
        Ok(harness)
    }
    async fn exited_without_reaping(&mut self) -> Result<()> {
        let pid =
            rustix::process::Pid::from_raw(self.group.as_raw()).context("invalid harness pid")?;
        loop {
            match waitid(
                WaitId::Pid(pid),
                WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG,
            ) {
                Ok(Some(_)) => return Ok(()),
                Ok(None) | Err(rustix::io::Errno::INTR) => {}
                Err(error) => {
                    // Lost ownership must never turn into a signal to a reused PGID.
                    self.may_signal = false;
                    return Err(error).context("harness exit ownership is unknown");
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    async fn finish(&mut self) -> Result<Output> {
        ensure!(
            self.may_signal,
            "harness process-group ownership is unknown"
        );
        // Do not reap even on signal failure. The guard still pins the leader
        // and can retry KILL on Drop. EPERM alone is NOT cleanup confirmation.
        match killpg(self.group, Signal::SIGKILL) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
            #[cfg(target_os = "macos")]
            Err(nix::errno::Errno::EPERM) => confirm_zombie_group(self.group.as_raw()).await,
            Err(error) => Err(anyhow::Error::from(error)),
        }
        .context("harness process-group cleanup is unconfirmed")?;
        // No await intervenes between the last signal and disabling Drop's
        // group signal. Only now may wait release the leader PID.
        self.may_signal = false;
        let status = tokio::time::timeout(CLEANUP, self.child.wait())
            .await
            .context("harness leader cleanup timed out")?
            .context("harness leader reap failed")?;
        // Keep join handles in this guard while awaiting: cancellation aborts the
        // still-owned readers rather than detaching them with open pipe handles.
        let stdout = tokio::time::timeout(
            CLEANUP,
            self.stdout.as_mut().context("missing stdout reader")?,
        )
        .await
        .context("harness stdout join timed out")??
        .context("harness stdout read failed")?;
        self.stdout.take();
        let stderr = tokio::time::timeout(
            CLEANUP,
            self.stderr.as_mut().context("missing stderr reader")?,
        )
        .await
        .context("harness stderr join timed out")??
        .context("harness stderr read failed")?;
        self.stderr.take();
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        if self.may_signal {
            // Includes outer-future cancellation/panic before explicit finish.
            // Node has not been reaped, so this cannot target a replacement group.
            let _ = killpg(self.group, Signal::SIGKILL);
        }
        for reader in [&mut self.stdout, &mut self.stderr].into_iter().flatten() {
            reader.abort();
        }
    }
}

#[tokio::test]
async fn actual_cli_wait_uses_qualified_native_completion_and_never_rehydrates_old_answers() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/final-completion-interop.mjs");
    let mut harness = Harness::start(&script).expect("could not start offline wait E2E");
    let completed =
        tokio::time::timeout(Duration::from_secs(240), harness.exited_without_reaping()).await;
    // Always finish known owned cleanup before interpreting body/watchdog. The
    // same actual holder handles separate native groups on daemon/parent-FD loss.
    let output = harness
        .finish()
        .await
        .expect("offline wait E2E cleanup failed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "stdout={stdout}\nstderr={stderr}");
    completed
        .expect("wait E2E watchdog")
        .expect("could not observe wait E2E leader");
    assert!(stdout.contains(
        "PASS 17 paired actual adapter/daemon cases, 17 actual Node rollback roundtrips"
    ));
    assert!(stdout.contains(
        "PASS WAIT E2E 17 actual CLI waits, 3 prompt --wait, 17 UNKNOWN-zero, 17 restart-no-answer"
    ));
}
