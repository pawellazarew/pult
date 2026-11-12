//! Scratch daemon lifecycle with a non-provider executable. No Codex or model calls.
use pult_core::request_with_params;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

async fn status(home: &Path, params: Value) -> anyhow::Result<Value> {
    let raw = request_with_params(home, "daemon.status", params).await?;
    Ok(serde_json::from_str(raw.get())?)
}
fn launch(home: &Path, codex: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_pultd-rust"))
        .args(["--home", home.to_str().unwrap(), "daemon", "serve"])
        .env("PULT_CODEX_BIN", codex)
        .env_remove("PULT_MEMORY_KEY")
        .env_remove("PULT_TEST")
        .env_remove("PULT_HOLDER_BIN")
        .env_remove("PULT_CURL_BIN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap()
}
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::Builder::new()
        .prefix("r3-native-")
        .tempdir_in("/tmp")
        .unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir(&home).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    (temp, home)
}
async fn ready(home: &Path, child: &mut Child) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "scratch daemon exited at startup"
            );
            if status(home, json!({})).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
async fn stop(home: &Path, child: &mut Child) {
    let raw = request_with_params(home, "daemon.stop", json!({}))
        .await
        .unwrap();
    let stopped: Value = serde_json::from_str(raw.get()).unwrap();
    assert_eq!(stopped["stopping"], true);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn opt_in_bootstrap_starts_no_hosts_or_turns_and_restarts_cold() {
    let (_temp, home) = scratch();
    // Even a regression cannot contact a provider: the executable is our holder.
    let stub = Path::new(env!("CARGO_BIN_EXE_pult-worker-holder"));
    let mut child = launch(&home, stub);
    ready(&home, &mut child).await;
    let cold = status(&home, json!({})).await.unwrap();
    assert_eq!(cold["nativeRuntime"]["initialized"], false);
    assert_eq!(
        status(&home, json!({"initializeRuntime":false}))
            .await
            .unwrap()["nativeRuntime"],
        cold["nativeRuntime"]
    );
    let (first, second) = tokio::join!(
        status(&home, json!({"initializeRuntime":true})),
        status(&home, json!({"initializeRuntime":true}))
    );
    for initialized in [first.unwrap(), second.unwrap()] {
        assert_eq!(
            initialized["nativeRuntime"],
            json!({"initialized":true,"hosts":0,"activeTurns":0})
        );
        assert_eq!(initialized["lastEventId"], 0);
        assert_eq!(initialized["journal"]["executionUnavailable"], false);
    }
    assert!(
        status(&home, json!({"initializeRuntime":"true"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("invalid_params")
    );
    stop(&home, &mut child).await;
    let mut restarted = launch(&home, stub);
    ready(&home, &mut restarted).await;
    assert_eq!(
        status(&home, json!({})).await.unwrap()["nativeRuntime"]["initialized"],
        false
    );
    let prepared = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(env!("CARGO_BIN_EXE_pultd-rust"))
            .args([
                "--home",
                home.to_str().unwrap(),
                "daemon",
                "status",
                "--initialize-runtime",
            ])
            .env_remove("PULT_MEMORY_KEY")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(prepared.status.success());
    let prepared: Value = serde_json::from_slice(&prepared.stdout).unwrap();
    assert_eq!(
        prepared["nativeRuntime"],
        json!({"initialized":true,"hosts":0,"activeTurns":0})
    );
    stop(&home, &mut restarted).await;
}

#[tokio::test]
async fn missing_native_executable_does_not_break_read_only_daemon_status() {
    let (_temp, home) = scratch();
    let mut child = launch(&home, &home.join("missing-native-executable"));
    ready(&home, &mut child).await;
    let failed = status(&home, json!({"initializeRuntime":true}))
        .await
        .unwrap_err()
        .to_string();
    assert!(failed.contains("runtime_unavailable"));
    assert!(!failed.contains("missing-native-executable"));
    let still_up = status(&home, json!({})).await.unwrap();
    assert_eq!(still_up["nativeRuntime"]["initialized"], false);
    assert_eq!(still_up["journal"]["executionUnavailable"], false);
    stop(&home, &mut child).await;
}

#[tokio::test]
async fn disconnected_stop_ack_cannot_leave_a_running_daemon_with_closed_admission() {
    use nix::sys::signal::{Signal, kill};
    use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
    use nix::unistd::Pid;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (_temp, home) = scratch();
    let mut child = launch(&home, Path::new(env!("CARGO_BIN_EXE_pult-worker-holder")));
    ready(&home, &mut child).await;
    let socket = tokio::net::UnixStream::connect(home.join("run/pultd.sock"))
        .await
        .unwrap();
    let (input, mut output) = socket.into_split();
    let mut input = BufReader::new(input);
    let token = std::fs::read_to_string(home.join("run/token")).unwrap();
    let hello = json!({"type":"hello","protocol":1,"token":token,"client":"cli"});
    output
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .unwrap();
    let mut ack = String::new();
    tokio::time::timeout(Duration::from_secs(2), input.read_line(&mut ack))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&ack).unwrap()["type"],
        "hello_ok"
    );
    // Stop our scratch process, queue a valid request, close the peer, resume.
    // The response must hit a closed socket, rather than racing a live reader.
    let pid = Pid::from_raw(child.id().unwrap() as i32);
    kill(pid, Signal::SIGSTOP).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match waitpid(pid, Some(WaitPidFlag::WUNTRACED | WaitPidFlag::WNOHANG)).unwrap() {
                WaitStatus::Stopped(_, Signal::SIGSTOP) => break,
                WaitStatus::StillAlive => tokio::time::sleep(Duration::from_millis(5)).await,
                unexpected => panic!("unexpected owned daemon state: {unexpected:?}"),
            }
        }
    })
    .await
    .unwrap();
    output
        .write_all(b"{\"id\":1,\"method\":\"daemon.stop\",\"params\":{}}\n")
        .await
        .unwrap();
    drop(input);
    drop(output);
    kill(pid, Signal::SIGCONT).unwrap();
    let exited = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    assert!(
        exited.is_ok(),
        "disconnected stop ACK left the daemon running"
    );
    assert!(exited.unwrap().unwrap().success());
}
