#![forbid(unsafe_code)]
//! Internal process-group owner. This binary is never an RPC command dispatcher.
use anyhow::{Context, Result, ensure};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, getppid};
use rustix::process::{WaitId, WaitIdOptions, waitid};
use std::io::{Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    pult_core::panic_guard::install();
    // Arguments, spawn failures and provider stderr may contain private data.
    // No diagnostics are copied into the holder's own protocol or stderr.
    let code = run().await.unwrap_or(125);
    std::process::exit(code);
}

/// Keep the leader unreaped until the last group signal has been sent. Reaping
/// it early could release its PID for an unrelated new process group.
struct Group {
    child: Child,
    id: Pid,
    reaped: bool,
}
impl Group {
    fn exited_without_reaping(&self) -> Result<bool> {
        let id = rustix::process::Pid::from_raw(self.id.as_raw()).context("invalid child pid")?;
        // nix 0.30 exposes waitid only on some platforms, not Apple. rustix has
        // this safe POSIX wrapper on both supported Linux and macOS targets.
        match waitid(
            WaitId::Pid(id),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT | WaitIdOptions::NOHANG,
        ) {
            Ok(status) => Ok(status.is_some()),
            Err(rustix::io::Errno::INTR) => Ok(false),
            Err(error) => Err(anyhow::Error::new(error).context("peek status failed")),
        }
    }
    async fn signal(&self, signal: Signal) -> Result<()> {
        match killpg(self.id, signal) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
            // Darwin returns EPERM even for our own all-zombie group. Do not
            // confuse that with permission denial against executing members.
            #[cfg(target_os = "macos")]
            Err(nix::errno::Errno::EPERM) => {
                ensure!(self.exited_without_reaping()?, "leader still executing");
                confirm_zombie_group(self.id.as_raw()).await
            }
            Err(error) => Err(error.into()),
        }
    }
    async fn cleanup(&mut self) -> Result<ExitStatus> {
        self.signal(Signal::SIGTERM)
            .await
            .context("group TERM failed")?;
        // Do not try_wait during the grace period: even an exited leader must
        // retain its PID until after SIGKILL finishes addressing its group.
        tokio::time::sleep(Duration::from_millis(200)).await;
        self.signal(Signal::SIGKILL)
            .await
            .context("group KILL failed")?;
        let status = self.child.wait().context("leader reap failed")?;
        self.reaped = true;
        reap_adopted().await?;
        Ok(status)
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        if !self.reaped {
            // All fallible startup/forwarding paths still own this same leader.
            // Never signal a group after wait() has released that ownership.
            let _ = killpg(self.id, Signal::SIGKILL);
            let _ = self.child.wait();
        }
    }
}

#[cfg(target_os = "linux")]
async fn reap_adopted() -> Result<()> {
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::StillAlive) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok(WaitStatus::StillAlive) => anyhow::bail!("adopted child cleanup unconfirmed"),
            Err(nix::errno::Errno::ECHILD) => return Ok(()),
            Err(nix::errno::Errno::EINTR) => (),
            Ok(_) => (),
            Err(error) => return Err(error.into()),
        }
    }
}
#[cfg(not(target_os = "linux"))]
async fn reap_adopted() -> Result<()> {
    // On macOS orphaned descendants belong to launchd. A briefly retained
    // zombie cannot execute. Detached setsid descendants are outside this group.
    Ok(())
}

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
    use tokio::io::AsyncReadExt;
    const MAX_SNAPSHOT: u64 = 2 * 1024 * 1024;
    let mut child = tokio::process::Command::new("/bin/ps")
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
            // Only this trusted ps child is affected. Never leave a timed-out
            // inspection executable behind or turn inspection failure into ack.
            let _ = child.start_kill();
            let _ = child.wait().await;
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
    // Two identical zombie-only sets exclude a fork crossing a single process
    // enumeration. The unreaped leader retains the PGID throughout both reads.
    let first = zombie_members(&process_snapshot(deadline).await?, leader)?;
    let second = zombie_members(&process_snapshot(deadline).await?, leader)?;
    ensure!(
        first == second,
        "process group membership changed during proof"
    );
    Ok(())
}

fn joined(worker: JoinHandle<std::io::Result<u64>>) -> Result<()> {
    worker
        .join()
        .map_err(|_| anyhow::anyhow!("forwarding failed"))??;
    Ok(())
}

async fn run() -> Result<i32> {
    let mut args = std::env::args_os().skip(1);
    let parent: i32 = args
        .next()
        .context("missing owner")?
        .to_str()
        .context("invalid owner")?
        .parse()?;
    ensure!(parent > 0, "invalid owner");
    let program = args.next().context("missing provider")?;
    // Install TERM handling before a provider can exist. A TERM before this
    // handler is installed cannot leave a provider behind.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    ensure!(
        getppid().as_raw() == parent,
        "owner unavailable before launch"
    );
    #[cfg(target_os = "linux")]
    nix::sys::prctl::set_child_subreaper(true)?;
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .context("provider launch failed")?;
    let mut group = Group {
        id: Pid::from_raw(child.id() as i32),
        child,
        reaped: false,
    };
    ensure!(
        getppid().as_raw() == parent,
        "owner unavailable after launch"
    );
    let mut input = group.child.stdin.take().context("provider stdin missing")?;
    let mut output = group
        .child
        .stdout
        .take()
        .context("provider stdout missing")?;
    let mut errors = group
        .child
        .stderr
        .take()
        .context("provider stderr missing")?;
    let ready = serde_json::json!({"holder_ready":true,"providerPid":group.child.id()});
    writeln!(std::io::stdout().lock(), "{ready}")?;
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        let mut stdin = std::io::stdin().lock();
        while let Ok(count) = stdin.read(&mut bytes) {
            if count == 0 || input.write_all(&bytes[..count]).is_err() {
                break;
            }
        }
    });
    let stdout =
        std::thread::spawn(move || std::io::copy(&mut output, &mut std::io::stdout().lock()));
    let stderr =
        std::thread::spawn(move || std::io::copy(&mut errors, &mut std::io::stderr().lock()));
    let mut natural = false;
    let mut drained = false;
    loop {
        if getppid().as_raw() != parent {
            break;
        }
        if group.exited_without_reaping()? {
            natural = true;
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                if stdout.is_finished() && stderr.is_finished() {
                    drained = true;
                    break;
                }
                if getppid().as_raw() != parent || Instant::now() >= deadline {
                    break;
                }
                tokio::select! {
                    _ = term.recv() => break,
                    _ = interrupt.recv() => break,
                    _ = tokio::time::sleep(Duration::from_millis(5)) => (),
                }
            }
            break;
        }
        // Pipe EOF alone is not an exit observation: a provider may close its
        // streams immediately before exiting with a nonzero code. Only waitid
        // (without reaping), explicit cancellation, or owner death ends this loop.
        tokio::select! {
            _ = term.recv() => break,
            _ = interrupt.recv() => break,
            _ = tokio::time::sleep(Duration::from_millis(20)) => (),
        }
    }
    let status = group.cleanup().await?;
    if natural {
        ensure!(drained, "provider output drain unconfirmed");
        joined(stdout)?;
        joined(stderr)?;
        return Ok(status.code().unwrap_or(128 + status.signal().unwrap_or(0)));
    }
    // A cancelled attempt may leave forwarding threads blocked on a reader.
    // They do not own cleanup; process::exit terminates them after group proof.
    Ok(0)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::zombie_members;

    #[test]
    fn zombie_proof_requires_owned_leader_and_every_member_stopped() {
        let valid = b"1 1 Ss\n42 42 Z\n43 42 Z+\n99 99 R\n";
        assert_eq!(
            zombie_members(valid, 42)
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            vec![42, 43]
        );
        for invalid in [
            b"42 42 S\n".as_slice(),
            b"42 42 Z\n43 42 R\n",
            b"43 42 Z\n",
            b"42 42 Z\n42 42 Z\n",
            b"42 42 Z extra\n",
            b"42 42\n",
            b"-42 42 Z\n",
            b"4294967295 42 Z\n42 42 Z\n",
            b"42 42 Z\ninvalid row\n",
        ] {
            assert!(zombie_members(invalid, 42).is_err());
        }
    }
}
