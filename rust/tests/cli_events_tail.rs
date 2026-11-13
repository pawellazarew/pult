//! Real Rust daemon/journal/CLI; no provider processes or account/config probes.
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
const WAIT: Duration = Duration::from_secs(12);
struct Daemon {
    home: tempfile::TempDir,
    child: Child,
}
impl Daemon {
    async fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("r4-")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_pultd-rust"))
            .args(["--home", home.path().to_str().unwrap(), "daemon", "serve"])
            .env("PULT_TEST", "1")
            .env_remove("PULT_HOME")
            .env_remove("PULT_MEMORY_KEY")
            .env_remove("PULT_MEMORY_TURN_KEY")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let daemon = Self { home, child };
        tokio::time::timeout(WAIT, async {
            loop {
                if daemon.home.path().join("run/token").is_file()
                    && pult_core::request(daemon.home.path(), "daemon.status")
                        .await
                        .is_ok()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        daemon
    }
    async fn rpc(&self, method: &str, params: Value) -> Value {
        let raw = pult_core::request_with_params(self.home.path(), method, params)
            .await
            .unwrap();
        serde_json::from_str(raw.get()).unwrap()
    }
    async fn seed(&self, session: &str, count: usize, text: &str) -> Value {
        self.rpc(
            "events.emit",
            json!({"sessionId":session,"kind":"message.done","count":count,"data":{"text":text}}),
        )
        .await
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.arg("--home")
            .arg(self.home.path())
            .args(["events", "tail"])
            .args(args)
            .env_remove("PULT_HOME")
            .env_remove("PULT_MEMORY_KEY")
            .env_remove("PULT_MEMORY_TURN_KEY")
            .kill_on_drop(true);
        c
    }
    async fn output(&self, args: &[&str]) -> std::process::Output {
        tokio::time::timeout(WAIT, self.command(args).output())
            .await
            .unwrap()
            .unwrap()
    }
    async fn subscribers(&self, want: u64) {
        tokio::time::timeout(WAIT, async {
            loop {
                if self.rpc("daemon.status", json!({})).await["subscriptions"] == want {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn stop(&mut self) {
        self.rpc("daemon.stop", json!({})).await;
        tokio::time::timeout(WAIT, self.child.wait())
            .await
            .unwrap()
            .unwrap();
    }
}
fn ndjson(bytes: &[u8]) -> Vec<Value> {
    String::from_utf8(bytes.into())
        .unwrap()
        .lines()
        .filter(|v| !v.is_empty())
        .map(|v| serde_json::from_str(v).unwrap())
        .collect()
}
async fn wait(child: &mut Child) -> std::process::ExitStatus {
    tokio::time::timeout(WAIT, child.wait())
        .await
        .expect("CLI exit watchdog")
        .unwrap()
}

#[tokio::test]
async fn backlog_formats_filter_cursor_limit_and_empty_tail_match_cli_contract() {
    let mut d = Daemon::new().await;
    d.seed("chat-a", 3, "привет").await;
    d.seed("chat-b", 1, "other").await;
    let expected = d
        .rpc(
            "events.tail",
            json!({"since":1,"sessionId":"chat-a","limit":2}),
        )
        .await;
    let out = d
        .output(&[
            "--json",
            "--no-follow",
            "--since",
            "1",
            "--session",
            "chat-a",
            "--limit",
            "2",
        ])
        .await;
    assert!(out.status.success());
    assert_eq!(
        ndjson(&out.stdout),
        expected["events"].as_array().unwrap().to_vec()
    );
    let empty = d.output(&["--json", "--no-follow", "--since", "999"]).await;
    assert!(empty.status.success());
    assert!(empty.stdout.is_empty());
    let text = d.output(&["--no-follow", "--limit", "1"]).await;
    assert!(text.status.success());
    let event = &d.rpc("events.tail", json!({"limit":1})).await["events"][0];
    assert_eq!(
        String::from_utf8(text.stdout).unwrap(),
        format!(
            "#{} {} {}/{} {} {}\n",
            event["id"],
            event["ts"].as_str().unwrap(),
            event["provider"].as_str().unwrap(),
            event["kind"].as_str().unwrap(),
            event["sessionId"].as_str().unwrap(),
            serde_json::to_string(&event["data"]).unwrap()
        )
    );
    d.subscribers(0).await;
    d.stop().await;
}

#[tokio::test]
async fn default_follow_delivers_new_commit_once_then_limit_releases_subscription() {
    let mut d = Daemon::new().await;
    let first = d.seed("live", 1, "first").await["lastEventId"]
        .as_u64()
        .unwrap();
    let mut child = d
        .command(&["--json", "--since", &first.to_string(), "--limit", "1"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    d.subscribers(1).await;
    assert!(child.try_wait().unwrap().is_none());
    let ids = d.seed("live", 1, "second").await;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = tokio::time::timeout(WAIT, lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&line).unwrap()["id"],
        ids["lastEventId"]
    );
    assert!(wait(&mut child).await.success());
    assert!(lines.next_line().await.unwrap().is_none());
    d.subscribers(0).await;
    d.stop().await;
}

#[tokio::test]
async fn follow_sigint_and_daemon_stop_close_without_reconnect() {
    let mut d = Daemon::new().await;
    let mut cli = d
        .command(&["--json"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    d.subscribers(1).await;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(cli.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    assert!(wait(&mut cli).await.success());
    d.subscribers(0).await;
    let mut cli = d
        .command(&["--json"])
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    d.subscribers(1).await;
    d.stop().await;
    assert!(wait(&mut cli).await.success());
}

#[tokio::test]
async fn blocked_actual_stdout_pipe_times_out_and_cleans_subscriber() {
    let mut d = Daemon::new().await;
    d.seed("large", 16, &"x".repeat(64 * 1024)).await;
    let mut cli = d
        .command(&["--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Retain the actual pipe read end without reading; output exceeds pipe capacity.
    let _unread_pipe = cli.stdout.take().unwrap();
    assert!(!wait(&mut cli).await.success());
    let mut diagnostic = String::new();
    cli.stderr
        .take()
        .unwrap()
        .read_to_string(&mut diagnostic)
        .await
        .unwrap();
    assert!(diagnostic.contains("event output could not be completed"));
    d.subscribers(0).await;
    d.stop().await;
}

#[tokio::test]
async fn blocked_actual_stdout_pipe_sigint_is_bounded_and_scope_keys_never_subscribe() {
    let mut d = Daemon::new().await;
    d.seed("large", 16, &"x".repeat(64 * 1024)).await;
    let mut cli = d
        .command(&["--json"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let _unread_pipe = cli.stdout.take().unwrap();
    d.subscribers(1).await;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(cli.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    assert!(wait(&mut cli).await.success());
    d.subscribers(0).await;
    let output = tokio::time::timeout(
        WAIT,
        d.command(&["--json", "--no-follow"])
            .env("PULT_MEMORY_KEY", "PRIVATE_SCOPE_FIXTURE")
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("PRIVATE_SCOPE_FIXTURE"));
    d.subscribers(0).await;
    d.stop().await;
}

#[tokio::test]
async fn broken_stdout_pipe_releases_actual_server_subscription() {
    let mut d = Daemon::new().await;
    let mut cli = d
        .command(&["--json"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    drop(cli.stdout.take());
    d.subscribers(1).await;
    d.seed("pipe", 1, "closed").await;
    assert!(!wait(&mut cli).await.success());
    d.subscribers(0).await;
    d.stop().await;
}

#[tokio::test]
async fn bounded_wire_and_coalesced_ack_events_do_not_leak_or_drop_frames() {
    for bad in [false, true] {
        let home = tempfile::Builder::new()
            .prefix("r4wire-")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.path().join("run")).unwrap();
        std::fs::write(home.path().join("run/token"), "a".repeat(64)).unwrap();
        let listener = tokio::net::UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            socket
                .get_mut()
                .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
                .await
                .unwrap();
            line.clear();
            socket.read_line(&mut line).await.unwrap();
            let mut bytes = b"{\"id\":1,\"result\":{\"sub\":1,\"cursor\":1}}\n".to_vec();
            if bad {
                bytes.extend_from_slice(b"PRIVATE_UNTRUSTED_FRAME");
                bytes.extend(vec![b'x'; pult_core::MAX_LINE + 1]);
                bytes.push(b'\n');
            } else {
                bytes.extend_from_slice(b"{\"sub\":1,\"event\":{\"id\":1,\"ts\":\"fixture\",\"provider\":\"pult\",\"kind\":\"message.done\",\"sessionId\":\"one\",\"data\":{}}}\n");
            }
            let _ = socket.get_mut().write_all(&bytes).await;
        });
        let out = tokio::time::timeout(
            WAIT,
            Command::new(env!("CARGO_BIN_EXE_pultd-rust"))
                .arg("--home")
                .arg(home.path())
                .args(["events", "tail", "--json", "--no-follow"])
                .env_remove("PULT_HOME")
                .env_remove("PULT_MEMORY_KEY")
                .env_remove("PULT_MEMORY_TURN_KEY")
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        if bad {
            assert!(!out.status.success());
            assert!(out.stdout.is_empty());
            assert!(!String::from_utf8_lossy(&out.stderr).contains("PRIVATE_UNTRUSTED_FRAME"));
        } else {
            assert!(out.status.success());
            assert_eq!(ndjson(&out.stdout).len(), 1);
        }
        server.await.unwrap();
    }
}
