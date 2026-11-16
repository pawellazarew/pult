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

#[tokio::test]
async fn codex_remote_preserves_legacy_static_error_projection() {
    for (code, expected) in [
        ("invalid_params", "invalid tool arguments"),
        ("not_found", "tool operation is not permitted"),
        ("forbidden", "tool operation is not permitted"),
        ("capacity", "tool operation capacity reached"),
        ("internal", "tool service is unavailable"),
    ] {
        let home = tempfile::Builder::new()
            .prefix("cmerrors-")
            .tempdir_in("/tmp")
            .unwrap();
        let account = tempfile::tempdir().unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.path().join("run")).unwrap();
        let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_pult-memory-mcp"))
            .env_clear()
            .env("HOME", account.path())
            .env("PULT_CODEX_MEMORY_KEY", format!("cm_{}", "a".repeat(64)))
            .args(["--home", home.path().to_str().unwrap(), "--codex-bridge"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (mut heartbeat, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut line = String::new();
        let mut header = BufReader::new(&mut heartbeat);
        header.read_line(&mut line).await.unwrap();
        drop(header);
        heartbeat
            .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
            .await
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_list\",\"arguments\":{},\"_meta\":{}}}\n").await.unwrap();
        input.flush().await.unwrap();
        let (call, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let (read, mut write) = call.into_split();
        let mut reader = BufReader::new(read);
        let mut hello = String::new();
        reader.read_line(&mut hello).await.unwrap();
        assert!(
            serde_json::from_str::<Value>(&hello)
                .unwrap()
                .get("token")
                .is_none()
        );
        write
            .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
            .await
            .unwrap();
        let mut request = String::new();
        reader.read_line(&mut request).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&request).unwrap()["method"],
            "codex.memory.call"
        );
        let mut reply = serde_json::to_vec(
            &json!({"id":1,"error":{"code":code,"message":"SYNTHETIC_REFLECTED_SECRET"}}),
        )
        .unwrap();
        reply.push(b'\n');
        write.write_all(&reply).await.unwrap();
        let mut answer = String::new();
        tokio::time::timeout(Duration::from_secs(3), output.read_line(&mut answer))
            .await
            .unwrap()
            .unwrap();
        let answer: Value = serde_json::from_str(&answer).unwrap();
        assert_eq!(answer["result"]["isError"], true);
        assert_eq!(answer["result"]["content"][0]["text"], expected);
        assert!(!answer.to_string().contains("SYNTHETIC"));
        drop(heartbeat);
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .unwrap()
                .unwrap()
                .code(),
            Some(0)
        );
        drop(input);
    }
}
#[tokio::test]
async fn both_memory_helper_modes_reject_mixed_purpose_presence_before_home_io() {
    for codex in [false, true] {
        for foreign in [
            "PULT_MEMORY_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY",
            if codex {
                "PULT_MEMORY_TURN_KEY"
            } else {
                "PULT_CODEX_MEMORY_KEY"
            },
        ] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_pult-memory-mcp"));
            command
                .env_clear()
                .env(foreign, "")
                .args(["--home", "relative-invalid-home"])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if codex {
                command
                    .arg("--codex-bridge")
                    .env("PULT_CODEX_MEMORY_KEY", format!("cm_{}", "a".repeat(64)));
            } else {
                command.env("PULT_MEMORY_TURN_KEY", format!("mt_{}", "a".repeat(64)));
            }
            let result = tokio::time::timeout(Duration::from_secs(3), command.output())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.status.code(), Some(1));
            assert!(result.stdout.is_empty());
            assert_eq!(result.stderr, b"memory MCP is unavailable\n");
        }
    }
}
