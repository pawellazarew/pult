//! Actual CLI against a controlled protocol-1 socket. No daemon/provider/account.
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::process::{Output, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;

const WAIT: Duration = Duration::from_secs(12);
const KEYS: [&str; 4] = [
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
];
struct Fake {
    home: tempfile::TempDir,
    listener: UnixListener,
}
impl Fake {
    fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("r4w-")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.path().join("run")).unwrap();
        std::fs::write(home.path().join("run/token"), "a".repeat(64)).unwrap();
        let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        Self { home, listener }
    }
    fn command(&self, args: &[&str], locale: &str) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.arg("--home")
            .arg(self.home.path())
            .args(args)
            .env("PULT_LANG", locale)
            .env_remove("PULT_HOME")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        for key in KEYS {
            c.env_remove(key);
        }
        c
    }
}
async fn output(mut command: Command) -> Output {
    tokio::time::timeout(WAIT, command.output())
        .await
        .expect("CLI hung")
        .unwrap()
}
async fn frame(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    assert_ne!(reader.read_line(&mut line).await.unwrap(), 0);
    serde_json::from_str(&line).unwrap()
}
async fn send(reader: &mut BufReader<UnixStream>, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await.unwrap();
}
async fn accept(listener: UnixListener) -> BufReader<UnixStream> {
    let (socket, _) = listener.accept().await.unwrap();
    let mut reader = BufReader::new(socket);
    let hello = frame(&mut reader).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["token"], "a".repeat(64));
    send(&mut reader, json!({"type":"hello_ok","protocol":1})).await;
    reader
}
async fn eof(reader: &mut BufReader<UnixStream>) {
    let mut rest = Vec::new();
    if let Err(error) = tokio::time::timeout(WAIT, reader.read_to_end(&mut rest))
        .await
        .unwrap()
    {
        assert_eq!(error.kind(), std::io::ErrorKind::ConnectionReset);
    }
    assert!(rest.is_empty(), "unexpected extra request/cancel/retry");
}
async fn reply(args: &[&str], locale: &str, result: Value) -> (Output, Value) {
    let fake = Fake::new();
    let command = fake.command(args, locale);
    let peer = tokio::spawn(async move {
        let mut reader = accept(fake.listener).await;
        let request = frame(&mut reader).await;
        send(&mut reader, json!({"id":request["id"],"result":result})).await;
        eof(&mut reader).await;
        request
    });
    let out = output(command).await;
    (
        out,
        tokio::time::timeout(WAIT, peer).await.unwrap().unwrap(),
    )
}
fn assert_output(out: &Output, code: i32, stdout: &str, stderr: &str) {
    assert_eq!(
        out.status.code(),
        Some(code),
        "stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), stdout);
    assert_eq!(String::from_utf8_lossy(&out.stderr), stderr);
}

#[tokio::test]
async fn wait_accepts_response_after_three_seconds_but_ordinary_deadline_is_unchanged() {
    let fake = Fake::new();
    let command = fake.command(&["agent", "wait", "chat"], "en");
    let peer = tokio::spawn(async move {
        let mut reader = accept(fake.listener).await;
        let request = frame(&mut reader).await;
        assert_eq!(request["method"], "agent.wait");
        assert_eq!(request["params"], json!({"name":"chat"}));
        assert_eq!(request["locale"], "en");
        tokio::time::sleep(Duration::from_millis(3400)).await;
        send(&mut reader, json!({"id":1,"result":{"name":"chat","status":"idle","reason":"matched","text":"delayed answer"}})).await;
        eof(&mut reader).await;
    });
    assert_output(&output(command).await, 0, "delayed answer\n", "");
    peer.await.unwrap();

    let fake = Fake::new();
    let command = fake.command(&["catalog"], "en");
    let peer = tokio::spawn(async move {
        let mut reader = accept(fake.listener).await;
        assert_eq!(frame(&mut reader).await["method"], "protocol.catalog");
        let start = Instant::now();
        eof(&mut reader).await;
        assert!(start.elapsed() >= Duration::from_millis(2800));
        assert!(start.elapsed() < Duration::from_secs(8));
    });
    assert!(!output(command).await.status.success());
    peer.await.unwrap();

    // The new composed path must not give prompt delivery the wait-only policy.
    for wait in [false, true] {
        let fake = Fake::new();
        let mut args = vec!["agent", "prompt", "chat", "hello"];
        if wait {
            args.push("--wait");
        }
        let command = fake.command(&args, "en");
        let peer = tokio::spawn(async move {
            let mut reader = accept(fake.listener).await;
            assert_eq!(frame(&mut reader).await["method"], "agent.prompt");
            let start = Instant::now();
            eof(&mut reader).await;
            assert!(start.elapsed() >= Duration::from_millis(2800));
            assert!(start.elapsed() < Duration::from_secs(8));
        });
        assert_output(
            &output(command).await,
            2,
            "",
            "pult agent: timeout — daemon response timed out\n",
        );
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn raw_json_keeps_lone_utf16_and_unknown_fields_while_text_uses_terminal_replacement() {
    for json in [true, false] {
        let fake = Fake::new();
        let mut args = vec!["agent", "wait", "chat"];
        if json {
            args.push("--json");
        }
        let command = fake.command(&args, "en");
        let peer = tokio::spawn(async move {
            let mut reader = accept(fake.listener).await;
            frame(&mut reader).await;
            reader.get_mut().write_all(br#"{"id":1,"result":{"name":"chat","status":"idle","reason":"matched","text":"\ud800","extension":{"raw":"\udfff"}}}
"#).await.unwrap();
            eof(&mut reader).await;
        });
        let out = output(command).await;
        if json {
            assert_output(
                &out,
                0,
                "{\"name\":\"chat\",\"status\":\"idle\",\"reason\":\"matched\",\"text\":\"\\ud800\",\"extension\":{\"raw\":\"\\udfff\"}}\n",
                "",
            );
        } else {
            assert_output(&out, 0, "\u{fffd}\n", "");
        }
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn early_eof_or_wrong_protocol_during_shared_handshake_never_sends_wait() {
    for respond in [false, true] {
        let fake = Fake::new();
        let command = fake.command(&["agent", "wait", "chat"], "en");
        let peer = tokio::spawn(async move {
            let (socket, _) = fake.listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            frame(&mut reader).await;
            if respond {
                send(&mut reader, json!({"type":"hello_ok","protocol":2})).await;
            }
            let _ = reader.get_mut().shutdown().await;
            eof(&mut reader).await;
        });
        let out = output(command).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn json_is_printed_for_every_exit_and_precedence_matches_node() {
    for (status, reason, ok, error, expected) in [
        ("idle", "matched", true, None, 0),
        ("failed", "matched", false, None, 1),
        (
            "blocked_question",
            "timeout",
            false,
            Some("blocked_network"),
            2,
        ),
        ("blocked_permission", "matched", false, Some("timeout"), 3),
        ("failed", "matched", false, Some("timeout"), 2),
        ("failed", "matched", false, Some("blocked_network"), 4),
        ("failed", "matched", false, Some("provider_unavailable"), 5),
        ("failed", "matched", false, Some("limited"), 5),
        ("idle", "matched", true, Some(""), 1),
    ] {
        let mut result = json!({"name":"chat","status":status,"reason":reason,"ok":ok,"extension":{"kept":true}});
        if let Some(error) = error {
            result["errorCode"] = json!(error);
        }
        let (out, _) = reply(&["agent", "wait", "chat", "--json"], "en", result.clone()).await;
        assert_eq!(out.status.code(), Some(expected));
        assert!(out.stderr.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&out.stdout).unwrap(),
            result
        );
        assert_eq!(out.stdout.iter().filter(|b| **b == b'\n').count(), 1);
    }
}

#[tokio::test]
async fn localized_text_preserves_message_priority_fallback_and_js_coercion() {
    for (locale, result, code, stdout, stderr) in [
        (
            "ru",
            json!({"status":"working","reason":"timeout"}),
            2,
            "",
            "таймаут: агент в состоянии working\n",
        ),
        (
            "en",
            json!({"status":null,"reason":"timeout"}),
            2,
            "",
            "Timed out: agent status is ?\n",
        ),
        (
            "ru",
            json!({"status":"blocked_question","reason":"matched"}),
            3,
            "",
            "ждёт человека: blocked_question — смотри pult perm list\n",
        ),
        (
            "en",
            json!({"status":"blocked_permission","reason":"matched"}),
            3,
            "",
            "Waiting for you: blocked_permission — see pult perm list\n",
        ),
        (
            "ru",
            json!({"status":"failed","ok":false,"message":"причина","text":"ignored"}),
            1,
            "",
            "ход не удался: failed — причина\n",
        ),
        (
            "en",
            json!({"status":"failed","ok":false,"message":"","text":"ignored"}),
            1,
            "",
            "Turn failed: failed — Provider did not give a reason\n",
        ),
        (
            "ru",
            json!({"status":"failed","ok":false}),
            1,
            "",
            "ход не удался: failed — провайдер не объяснил причину\n",
        ),
        (
            "en",
            json!({"status":"failed","ok":false,"errorCode":"limited","text":"fallback"}),
            5,
            "",
            "Turn failed: limited — fallback\n",
        ),
        (
            "en",
            json!({"status":"idle","text":[1,true,null,["two"],{}]}),
            0,
            "1,true,,two,[object Object]\n",
            "",
        ),
        (
            "en",
            json!({"status":"idle","text":"already\n"}),
            0,
            "already\n",
            "",
        ),
    ] {
        let (out, _) = reply(&["session", "wait", "chat"], locale, result).await;
        assert_output(&out, code, stdout, stderr);
    }
}

#[tokio::test]
async fn until_and_timeout_keep_cli_comma_trim_parseint_and_negative_flag_edges() {
    for (args, until, timeout) in [
        (vec![], None, None),
        (
            vec!["--until", "\u{feff} idle, blocked ,,DONE,unknown "],
            Some(json!(["idle", "blocked", "DONE", "unknown"])),
            None,
        ),
        (vec!["--until", " , \u{feff}, "], None, None),
        (vec!["--until"], None, None),
        (vec!["--timeout", "12ms"], None, Some(12.0)),
        (vec!["--timeout", "1.9"], None, Some(1.0)),
        (vec!["--timeout=-5"], None, Some(-5.0)),
        (vec!["--timeout", "-5"], None, Some(600_000.0)),
        (vec!["--timeout", " -5"], None, Some(-5.0)),
        (vec!["--timeout", "0"], None, Some(0.0)),
        (vec!["--timeout"], None, Some(600_000.0)),
        (vec!["--timeout="], None, Some(600_000.0)),
        (vec!["--timeout", "bad"], None, Some(600_000.0)),
    ] {
        let mut command = vec!["agent", "wait", "chat"];
        command.extend(args);
        let (out, request) =
            reply(&command, "en", json!({"status":"idle","reason":"matched"})).await;
        assert_output(&out, 0, "", "");
        assert_eq!(request["params"].get("until"), until.as_ref());
        assert_eq!(
            request["params"].get("timeoutMs").and_then(Value::as_f64),
            timeout
        );
        assert_eq!(request["params"]["name"], "chat");
    }
    let huge = "9".repeat(400);
    let (_, request) = reply(
        &["agent", "wait", "chat", "--timeout", &huge],
        "en",
        json!({"status":"idle"}),
    )
    .await;
    assert_eq!(request["params"]["timeoutMs"].as_f64(), Some(600_000.0));
}

#[tokio::test]
async fn typed_rpc_errors_keep_code_exit_mapping_and_never_fabricate_json_result() {
    for (code, expected) in [
        ("timeout", 2),
        ("blocked_network", 4),
        ("provider_unavailable", 5),
        ("limited", 5),
        ("not_found", 1),
        ("closed", 1),
        ("invalid_params", 1),
    ] {
        let fake = Fake::new();
        let command = fake.command(&["agent", "wait", "chat", "--json"], "ru");
        let peer = tokio::spawn(async move {
            let mut reader = accept(fake.listener).await;
            assert_eq!(frame(&mut reader).await["method"], "agent.wait");
            send(
                &mut reader,
                json!({"id":1,"error":{"code":code,"message":"remote reason"}}),
            )
            .await;
            eof(&mut reader).await;
        });
        assert_output(
            &output(command).await,
            expected,
            "",
            &format!("pult agent: {code} — remote reason\n"),
        );
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn eof_wrong_id_malformed_and_oversized_frames_fail_closed_without_retry() {
    for bytes in [
        Vec::new(),
        b"{\"id\":9,\"result\":{\"status\":\"idle\"}}\n".to_vec(),
        b"{\"id\":1,\"result\":{\"status\":\"idle\"}}".to_vec(),
        b"{private-fixture-sentinel\n".to_vec(),
        b"{\"id\":1,\"result\":{},\"error\":{}}\n".to_vec(),
        vec![b'x'; pult_core::MAX_LINE + 2],
    ] {
        let fake = Fake::new();
        let command = fake.command(&["agent", "wait", "chat", "--json"], "en");
        let peer = tokio::spawn(async move {
            let mut reader = accept(fake.listener).await;
            frame(&mut reader).await;
            let _ = reader.get_mut().write_all(&bytes).await;
            let _ = reader.get_mut().shutdown().await;
            eof(&mut reader).await;
        });
        let out = output(command).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("private-fixture-sentinel"));
        peer.await.unwrap();
    }
}

#[tokio::test]
async fn prompt_wait_composes_once_by_session_name_and_keeps_dispatch_flags() {
    let fake = Fake::new();
    let command = fake.command(
        &[
            "agent",
            "prompt",
            "chat",
            "hello",
            "--attachments",
            "[]",
            "--steer",
            "--wait",
            "--until",
            "idle",
            "--timeout=0",
        ],
        "en",
    );
    let peer = tokio::spawn(async move {
        let mut reader = accept(fake.listener).await;
        let prompt = frame(&mut reader).await;
        assert_eq!(prompt["method"], "agent.prompt");
        assert_eq!(
            prompt["params"],
            json!({"name":"chat","text":"hello","attachments":[],"steer":true})
        );
        send(&mut reader, json!({"id":1,"result":{"turnId":"turn-A"}})).await;
        let wait = frame(&mut reader).await;
        assert_eq!(wait["id"], 2);
        assert_eq!(wait["method"], "agent.wait");
        assert_eq!(
            wait["params"],
            json!({"name":"chat","until":["idle"],"timeoutMs":0.0})
        );
        send(
            &mut reader,
            json!({"id":2,"result":{"status":"idle","reason":"matched","text":"final answer"}}),
        )
        .await;
        eof(&mut reader).await;
    });
    assert_output(&output(command).await, 0, "final answer\n", "");
    peer.await.unwrap();
}

#[tokio::test]
async fn queued_prompt_never_waits_and_bare_prompt_uses_node_started_format() {
    for (locale, json, expected) in [
        (
            "en",
            false,
            "Message queued (queue-A): will send when turn chat ends\n",
        ),
        (
            "ru",
            false,
            "реплика в очереди (queue-A): уйдёт, когда ход chat кончится\n",
        ),
        ("en", true, "{\"id\":\"queue-A\",\"queued\":true}\n"),
    ] {
        let mut args = vec![
            "agent",
            "prompt",
            "chat",
            "hello",
            "--queue",
            "--wait",
            "--until",
            "blocked",
            "--timeout=-5",
        ];
        if json {
            args.push("--json");
        }
        let (out, request) = reply(&args, locale, json!({"queued":true,"id":"queue-A"})).await;
        assert_eq!(request["method"], "agent.prompt");
        assert_eq!(
            request["params"],
            json!({"name":"chat","text":"hello","queue":true})
        );
        assert_output(&out, 0, expected, "");
    }
    let (out, request) = reply(
        &[
            "agent",
            "prompt",
            "chat",
            "hello",
            "--until",
            "blocked",
            "--timeout=-5",
            "--json",
        ],
        "en",
        json!({"turnId":"turn-A"}),
    )
    .await;
    assert_eq!(request["method"], "agent.prompt");
    assert_eq!(request["params"], json!({"name":"chat","text":"hello"}));
    assert_output(&out, 0, "{\"turnId\":\"turn-A\",\"waiting\":false}\n", "");
}

#[tokio::test]
async fn prompt_ack_requires_a_nonempty_string_identity_before_start_or_wait() {
    for result in [
        json!({}),
        json!({"turnId":null}),
        json!({"turnId":5}),
        json!({"turnId":""}),
        json!({"turnId":{}}),
    ] {
        for wait in [false, true] {
            let mut args = vec!["agent", "prompt", "chat", "hello"];
            if wait {
                args.push("--wait");
            }
            let (out, request) = reply(&args, "en", result.clone()).await;
            assert_eq!(request["method"], "agent.prompt");
            assert_output(
                &out,
                1,
                "",
                "pult agent: invalid_response — invalid agent prompt response\n",
            );
        }
    }
}

#[tokio::test]
async fn bare_prompt_preserves_modes_attachments_and_existing_attachment_only_input() {
    for mode in ["--queue", "--interrupt", "--steer"] {
        let (out, request) = reply(
            &[
                "agent",
                "prompt",
                "chat",
                "first",
                "second",
                "--attachments",
                "[]",
                mode,
            ],
            "en",
            json!({"turnId":"turn-A"}),
        )
        .await;
        assert_eq!(
            request["params"],
            json!({"name":"chat","text":"first second","attachments":[],&mode[2..]:true})
        );
        assert_output(&out, 0, "Turn turn-A started\n", "");
    }
    let (out, request) = reply(
        &[
            "agent",
            "prompt",
            "chat",
            "",
            "--attachments",
            "[]",
            "--json",
        ],
        "en",
        json!({"turnId":"turn-A"}),
    )
    .await;
    assert_eq!(
        request["params"],
        json!({"name":"chat","text":"","attachments":[]})
    );
    assert_output(&out, 0, "{\"turnId\":\"turn-A\",\"waiting\":false}\n", "");
}

#[tokio::test]
async fn actual_node_cli_and_rust_prompt_output_share_the_source_oracle() {
    let mut command = Command::new("node");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cli-prompt-oracle.mjs"
        ))
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .expect("prompt oracle watchdog")
        .expect("Node24 prompt oracle");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stdout).contains(
            "prompt oracle passed 14 paired Node/Rust cases + malformed Node observation"
        )
    );
}

#[tokio::test]
async fn scoped_keys_fail_before_owner_files_and_never_connect() {
    for key in KEYS {
        let fake = Fake::new();
        std::fs::remove_file(fake.home.path().join("run/token")).unwrap();
        assert!(
            std::process::Command::new("/usr/bin/mkfifo")
                .arg(fake.home.path().join("run/token"))
                .status()
                .unwrap()
                .success()
        );
        let mut command = fake.command(&["agent", "wait", "chat"], "en");
        command.env(key, "private-sentinel");
        let out = output(command).await;
        assert_output(
            &out,
            1,
            "",
            "pult agent: forbidden — agent wait requires owner authentication\n",
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), fake.listener.accept())
                .await
                .is_err()
        );
        let mut bare = fake.command(&["agent", "prompt", "chat", "hello"], "en");
        bare.env(key, "private-sentinel");
        assert_output(
            &output(bare).await,
            1,
            "",
            "pult agent: forbidden — agent wait requires owner authentication\n",
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(50), fake.listener.accept())
                .await
                .is_err()
        );
        let mut command = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        command
            .args([
                "--home",
                "relative-invalid-home",
                "agent",
                "prompt",
                "chat",
                "hello",
                "--wait",
            ])
            .env(key, "private-sentinel")
            .kill_on_drop(true);
        let out = output(command).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&out.stderr).contains("requires owner authentication"));
        assert!(!String::from_utf8_lossy(&out.stderr).contains("private-sentinel"));
        let mut bare = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        for credential in KEYS {
            bare.env_remove(credential);
        }
        bare.args([
            "--home",
            "relative-invalid-home",
            "agent",
            "prompt",
            "chat",
            "hello",
        ])
        .env(key, "private-sentinel")
        .kill_on_drop(true);
        let out = output(bare).await;
        assert_output(
            &out,
            1,
            "",
            "pult agent: forbidden — agent wait requires owner authentication\n",
        );
    }
}

#[tokio::test]
async fn ctrl_c_closes_only_wait_socket_without_sending_stop_or_replaying_prompt() {
    let fake = Fake::new();
    let mut child = fake
        .command(&["agent", "prompt", "chat", "hello", "--wait"], "en")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (socket, _) = fake.listener.accept().await.unwrap();
    let mut reader = BufReader::new(socket);
    let hello = frame(&mut reader).await;
    assert_eq!(hello["type"], "hello");
    send(&mut reader, json!({"type":"hello_ok","protocol":1})).await;
    assert_eq!(frame(&mut reader).await["method"], "agent.prompt");
    send(
        &mut reader,
        json!({"id":1,"result":{"turnId":"accepted-A"}}),
    )
    .await;
    assert_eq!(frame(&mut reader).await["method"], "agent.wait");
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    eof(&mut reader).await;
    assert_eq!(
        tokio::time::timeout(WAIT, child.wait())
            .await
            .unwrap()
            .unwrap()
            .code(),
        Some(130)
    );
}
