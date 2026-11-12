//! Exercise the actual Rust CLI and local socket. No provider/model/account.
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};
const KEY: &str = "abababababababababababababababababababababababababababababababab";
async fn frame(reader: &mut BufReader<tokio::process::ChildStdout>) -> Value {
    let raw = tokio::time::timeout(Duration::from_secs(8), pult_core::read_line(reader))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_slice(&raw).unwrap()
}
async fn scenario(mode: &str) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    std::fs::create_dir(home.join("run")).unwrap();
    // Poisoned owner-only files: the helper must not read or authenticate with them.
    std::fs::write(home.join("run/token"), "OWNER_TOKEN_MUST_NOT_BE_READ").unwrap();
    std::fs::write(home.join("config.json"), "{").unwrap();
    let server = if mode == "missing-key" {
        None
    } else {
        Some(UnixListener::bind(home.join("run/pultd.sock")).unwrap())
    };
    let entered = std::sync::Arc::new(tokio::sync::Notify::new());
    let request_entered = entered.clone();
    let mode_owned = mode.to_owned();
    let server=server.map(|listener|tokio::spawn(async move {
        let (socket,_)=listener.accept().await.unwrap();let (input,mut output)=socket.into_split();let mut input=BufReader::new(input);
        let hello:Value=serde_json::from_slice(&pult_core::read_line(&mut input).await.unwrap().unwrap()).unwrap();
        let expected_key = if mode_owned=="prefixed-allow" {format!("pa_{KEY}")} else {KEY.into()};
        assert_eq!(hello["ask"],expected_key);assert!(hello.get("token").is_none());assert_eq!(hello["client"],"mcp-ask");
        if mode_owned=="rejected-key"{output.write_all(b"{\"type\":\"error\",\"code\":\"bad_token\",\"message\":\"DO_NOT_REFLECT_SERVER_ERROR\"}\n").await.unwrap();return;}
        output.write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n").await.unwrap();
        let request:Value=serde_json::from_slice(&pult_core::read_line(&mut input).await.unwrap().unwrap()).unwrap();
        assert_eq!(request["method"],"perm.request");assert_eq!(request["params"]["sessionId"],"fixture");assert_eq!(request["params"]["toolName"],"Bash");assert_eq!(request["params"]["toolUseId"],"tool-one");assert_eq!(request["params"]["input"]["command"],"original");
        if mode_owned=="disconnect"{return;}
        if mode_owned=="cancel-pending" {
            request_entered.notify_one();
            assert!(pult_core::read_line(&mut input).await.unwrap().is_none(),"MCP EOF must close the pending question socket");
            return;
        }
        let result=if mode_owned=="deny"{json!({"behavior":"deny","message":"human declined"})}else if mode_owned=="malformed-update"{json!({"behavior":"allow","updatedInput":"invalid restriction"})}else{json!({"behavior":"allow","updatedInput":{"command":"narrow approved command"}})};
        let mut bytes=serde_json::to_vec(&json!({"id":1,"result":result})).unwrap();bytes.push(b'\n');output.write_all(&bytes).await.unwrap();
    }));
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
    cmd.kill_on_drop(true);
    cmd.arg("--home")
        .arg(home)
        .arg("mcp-ask")
        .env_clear()
        .env("HOME", home)
        .env("PULT_ASK_SESSION", "fixture")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if mode != "missing-key" {
        cmd.env(
            "PULT_ASK_KEY",
            if mode == "prefixed-allow" {
                format!("pa_{KEY}")
            } else {
                KEY.into()
            },
        );
    }
    let mut child = cmd.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n")
        .await
        .unwrap();
    assert_eq!(
        frame(&mut output).await["result"]["serverInfo"]["name"],
        "pult"
    );
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n")
        .await
        .unwrap();
    assert_eq!(
        frame(&mut output).await["result"]["tools"][0]["name"],
        "ask"
    );
    let call = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"tool_name":"Bash","tool_use_id":"tool-one","input":{"command":"original"},"sessionId":"foreign-session-is-not-authority"}}});
    let mut bytes = serde_json::to_vec(&call).unwrap();
    bytes.push(b'\n');
    input.write_all(&bytes).await.unwrap();
    if mode == "cancel-pending" {
        entered.notified().await;
        drop(input);
        assert!(child.wait().await.unwrap().success());
        server.unwrap().await.unwrap();
        return;
    }
    let reply = frame(&mut output).await;
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    let decision: Value = serde_json::from_str(text).unwrap();
    if matches!(mode, "allow" | "prefixed-allow") {
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(
            decision["updatedInput"]["command"],
            "narrow approved command"
        );
    } else {
        assert_eq!(decision["behavior"], "deny");
        if mode == "deny" {
            assert_eq!(decision["message"], "human declined");
        }
        assert!(!text.contains("DO_NOT_REFLECT_SERVER_ERROR"));
    }
    assert!(!text.contains(KEY));
    assert!(!text.contains("OWNER_TOKEN_MUST_NOT_BE_READ"));
    drop(input);
    let status = child.wait().await.unwrap();
    assert!(status.success());
    if let Some(server) = server {
        server.await.unwrap();
    }
    use tokio::io::AsyncReadExt;
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .await
        .unwrap();
    assert!(stderr.is_empty());
}
macro_rules! case {
    ($name:ident,$mode:literal) => {
        #[tokio::test]
        async fn $name() {
            tokio::time::timeout(Duration::from_secs(15), scenario($mode))
                .await
                .unwrap();
        }
    };
}
case!(
    permission_cli_uses_only_scoped_key_and_preserves_approved_input,
    "allow"
);
case!(
    permission_cli_accepts_exact_turn_purpose_key,
    "prefixed-allow"
);
case!(
    missing_key_denies_without_owner_token_fallback,
    "missing-key"
);
case!(rejected_key_does_not_reflect_server_errors, "rejected-key");
case!(permission_socket_disconnect_denies, "disconnect");
case!(
    malformed_updated_input_cannot_approve_the_broader_original,
    "malformed-update"
);

case!(explicit_daemon_denial_preserves_its_message, "deny");
case!(mcp_eof_cancels_pending_question_socket, "cancel-pending");
