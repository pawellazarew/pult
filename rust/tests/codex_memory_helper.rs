//! Actual helper heartbeat lifetime with open stdin and an unread/flooded stdout.
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};
async fn helper_exit_with_open_pipes(flood: bool) {
    let home = tempfile::Builder::new()
        .prefix("cmhelper-")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::create_dir(home.path().join("run")).unwrap();
    let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
    let account = tempfile::Builder::new()
        .prefix("cmaccount-")
        .tempdir_in("/tmp")
        .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_pult-memory-mcp"))
        .env_clear()
        .env("HOME", account.path())
        .env("PULT_CODEX_MEMORY_KEY", format!("cm_{}", "a".repeat(64)))
        .arg("--home")
        .arg(home.path())
        .arg("--codex-bridge")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let (socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let (read, mut out) = socket.into_split();
    let mut read = BufReader::new(read);
    let mut line = String::new();
    read.read_line(&mut line).await.unwrap();
    let hello: Value = serde_json::from_str(&line).unwrap();
    assert!(hello.get("codexMemory").is_some());
    assert!(hello.get("token").is_none());
    out.write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
        .await
        .unwrap();
    out.flush().await.unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
        .await
        .unwrap();
    input.flush().await.unwrap();
    let mut ready = String::new();
    tokio::time::timeout(Duration::from_secs(3), output.read_line(&mut ready))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&ready).unwrap()["id"], 1);
    let writer = if flood {
        Some(tokio::spawn(async move {
            let request = serde_json::to_vec(
                &json!({"jsonrpc":"2.0","id":"x".repeat(512),"method":"tools/list"}),
            )
            .unwrap();
            for _ in 0..2048 {
                if input.write_all(&request).await.is_err() || input.write_all(b"\n").await.is_err()
                {
                    break;
                }
            }
            input
        }))
    } else {
        None
    };
    // No output consumer exists after initialize. Each list response contains
    // the full five-tool catalog; flooding exceeds the platform pipe budget.
    if flood {
        tokio::time::timeout(Duration::from_secs(3), async {
            while rustix::io::ioctl_fionread(output.get_ref()).unwrap() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("catalog output did not reach unread pipe");
        assert!(
            !writer.as_ref().unwrap().is_finished(),
            "flood must remain pending without output consumer"
        );
    }
    drop(read);
    drop(out);
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .expect("revoked helper waited for open input/output pipe")
        .unwrap();
    assert_eq!(status.code(), Some(0));
    if let Some(writer) = writer {
        let _ = writer.await;
    }
    drop(output);
}
#[tokio::test]
async fn heartbeat_close_exits_while_provider_keeps_stdin_open() {
    helper_exit_with_open_pipes(false).await;
}
#[tokio::test]
async fn heartbeat_close_exits_with_unread_flooded_stdout() {
    helper_exit_with_open_pipes(true).await;
}
