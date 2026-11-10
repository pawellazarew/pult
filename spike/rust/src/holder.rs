#![forbid(unsafe_code)]
use anyhow::{Context, Result, ensure};
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, getppid};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// Own only the group created here. Blocking forwarding threads never own cleanup.
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let code = match run().await {
        Ok(code) => code,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "holder: {error:#}");
            125
        }
    };
    std::process::exit(code);
}

async fn run() -> Result<i32> {
    let mut args = std::env::args().skip(1);
    let parent: i32 = args.next().context("missing owner pid")?.parse()?;
    let program = args.next().context("missing program")?;
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    ensure!(
        getppid().as_raw() == parent,
        "owner disappeared before launch"
    );
    #[cfg(target_os = "linux")]
    nix::sys::prctl::set_child_subreaper(true)?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .context("holder spawn provider")?;
    let group = Pid::from_raw(child.id() as i32);
    let ready = serde_json::json!({"holder_ready":true,"providerPid":child.id()});
    if let Err(error) = writeln!(std::io::stdout().lock(), "{ready}") {
        let _ = killpg(group, Signal::SIGKILL);
        let _ = child.wait();
        return Err(error.into());
    }
    let mut input = child.stdin.take().context("provider stdin")?;
    let mut output = child.stdout.take().context("provider stdout")?;
    let mut errors = child.stderr.take().context("provider stderr")?;
    std::thread::spawn(move || {
        let mut bytes = [0; 8192];
        let mut stdin = std::io::stdin().lock();
        while let Ok(n) = stdin.read(&mut bytes) {
            if n == 0 || input.write_all(&bytes[..n]).is_err() {
                break;
            }
        }
    });
    let stdout_worker =
        std::thread::spawn(move || std::io::copy(&mut output, &mut std::io::stdout().lock()));
    let stderr_worker =
        std::thread::spawn(move || std::io::copy(&mut errors, &mut std::io::stderr().lock()));
    let mut natural_status = None;
    let mut drain_failed = false;
    loop {
        if getppid().as_raw() != parent {
            break;
        }
        if let Some(status) = child.try_wait()? {
            natural_status = Some(status);
            let deadline = Instant::now() + Duration::from_secs(1);
            while !(stdout_worker.is_finished() && stderr_worker.is_finished()) {
                if getppid().as_raw() != parent || Instant::now() >= deadline {
                    drain_failed = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            break;
        }
        tokio::select! {
            _ = term.recv() => break,
            _ = tokio::signal::ctrl_c() => break,
            _ = tokio::time::sleep(Duration::from_millis(20)) => (),
        }
    }
    let _ = killpg(group, Signal::SIGTERM);
    let deadline = Instant::now() + Duration::from_millis(200);
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = killpg(group, Signal::SIGKILL);
    let _ = child.wait();
    #[cfg(target_os = "linux")]
    {
        use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::StillAlive) if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                Ok(WaitStatus::StillAlive) => {
                    anyhow::bail!("adopted child remained alive after cleanup deadline")
                }
                Err(nix::errno::Errno::ECHILD) => break,
                Ok(_) => (),
                Err(e) => return Err(e.into()),
            }
        }
    }
    // launchd can briefly retain reparented zombies on macOS; they cannot execute.
    ensure!(
        !drain_failed,
        "provider output could not be drained before deadline"
    );
    if natural_status.is_some() {
        stdout_worker
            .join()
            .map_err(|_| anyhow::anyhow!("stdout forwarding panicked"))??;
        stderr_worker
            .join()
            .map_err(|_| anyhow::anyhow!("stderr forwarding panicked"))??;
    }
    if let Some(status) = natural_status {
        use std::os::unix::process::ExitStatusExt;
        return Ok(status.code().unwrap_or(128 + status.signal().unwrap_or(0)));
    }
    Ok(0)
}
