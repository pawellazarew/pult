//! Actual executable owner transport and output lifetime; no provider execution.
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::Command,
};

const KEYS: [&str; 5] = [
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
    "PULT_CODEX_MEMORY_KEY",
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
];
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    user: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("r4agent-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = temp.path().join("pult");
        let user = temp.path().join("user");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&user).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.join("run")).unwrap();
        std::fs::set_permissions(home.join("run"), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(home.join(".rust-core-scratch"), "pult-rust-scratch-v1\n").unwrap();
        std::fs::write(home.join("config.json"), "{}").unwrap();
        std::fs::write(home.join("run/token"), "a".repeat(64)).unwrap();
        for name in [".rust-core-scratch", "config.json", "run/token"] {
            std::fs::set_permissions(home.join(name), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        Self {
            _temp: temp,
            home,
            user,
        }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.env_clear()
            .env("HOME", &self.user)
            .env("PATH", "/usr/bin:/bin")
            .env("PULT_HOME", self.user.join("protected"))
            .env("PULT_LANG", "en")
            .env("PULT_TEST", "1")
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }
    fn listener(&self) -> UnixListener {
        UnixListener::bind(self.home.join("run/pultd.sock")).unwrap()
    }
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("agent CLI fixture watchdog")
}
async fn output(mut c: Command) -> Output {
    bounded(c.output()).await.unwrap()
}
async fn accepted(listener: UnixListener) -> (BufReader<UnixStream>, Value) {
    let (socket, _) = listener.accept().await.unwrap();
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    let hello: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(hello["token"], "a".repeat(64));
    reader
        .get_mut()
        .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
        .await
        .unwrap();
    line.clear();
    reader.read_line(&mut line).await.unwrap();
    let request: Value = serde_json::from_str(&line).unwrap();
    (reader, request)
}
async fn reply(listener: UnixListener, result: Value) -> Value {
    let (mut reader, request) = accepted(listener).await;
    let frame = json!({"id":request["id"],"result":result});
    let _ = reader
        .get_mut()
        .write_all(format!("{frame}\n").as_bytes())
        .await;
    request
}
fn json_output(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[tokio::test]
async fn scoped_stop_preserves_false_and_extensions_with_or_without_json() {
    for json in [false, true] {
        let f = Fixture::new();
        let result = json!({"stopped":false,"future":{"exact":true}});
        let task = tokio::spawn(reply(f.listener(), result.clone()));
        let mut args = vec!["session", "stop", "one", "--turn-id", "old-turn"];
        if json {
            args.push("--json");
        }
        let out = output(f.command(&args)).await;
        assert_eq!(json_output(&out), result);
        let request = bounded(task).await.unwrap();
        assert_eq!(request["method"], "agent.stop");
        assert_eq!(request["params"], json!({"name":"one","turnId":"old-turn"}));
    }
}
#[tokio::test]
async fn four_purposes_empty_and_mixed_deny_before_any_fifo_or_home_validation() {
    let mut f = Fixture::new();
    for file in [f.home.join("config.json"), f.home.join("run/token")] {
        std::fs::remove_file(&file).unwrap();
        assert!(
            std::process::Command::new("/usr/bin/mkfifo")
                .arg(file)
                .status()
                .unwrap()
                .success()
        );
    }
    let commands: [&[&str]; 6] = [
        &["list"],
        &["stop", "one"],
        &["rename", "one"],
        &["archive", "one"],
        &["unarchive", "one"],
        &["seen", "one"],
    ];
    for key in KEYS {
        for mixed in [false, true] {
            for args in commands {
                let mut c = f.command(&["agent"]);
                c.args(args).env(key, "");
                if mixed {
                    c.env("PULT_MEMORY_KEY", "synthetic")
                        .env("PULT_RUNTIME_KEY", "")
                        .env("PULT_CODEX_MEMORY_KEY", "");
                }
                let out = output(c).await;
                assert_eq!(out.status.code(), Some(1));
                assert!(out.stdout.is_empty());
                assert!(String::from_utf8_lossy(&out.stderr).contains("owner authentication"));
            }
        }
    }
    f.home = PathBuf::from("relative");
    let mut c = f.command(&["agent", "list"]);
    c.env("PULT_ASK_KEY", "");
    let out = output(c).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
}
#[tokio::test]
async fn malformed_text_profile_fails_but_json_retains_original_opaque_value() {
    for json in [false, true] {
        let f = Fixture::new();
        let result = json!({"sessions":[{"name":{"toString":null}}],"future":true});
        let task = tokio::spawn(reply(f.listener(), result.clone()));
        let args = if json {
            vec!["agent", "list", "--json"]
        } else {
            vec!["agent", "list"]
        };
        let out = output(f.command(&args)).await;
        if json {
            assert_eq!(json_output(&out), result);
        } else {
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            assert!(String::from_utf8_lossy(&out.stderr).contains("invalid_response"));
        }
        bounded(task).await.unwrap();
    }
}
#[tokio::test]
async fn deep_text_arrays_are_bounded_while_json_stays_opaque() {
    // RawValue deliberately skips nested opaque values. Construct raw bytes so
    // the fixture itself never recursively allocates/destructs a Value tree.
    for name in [
        format!("{}\"leaf\"{}", "[".repeat(8192), "]".repeat(8192)),
        format!("[{}]", vec!["1"; 5000].join(",")),
    ] {
        let result = format!("{{\"sessions\":[{{\"name\":{name}}}]}}");
        assert!(result.len() < pult_core::MAX_LINE);
        for json in [true, false] {
            let f = Fixture::new();
            let listener = f.listener();
            let sending = result.clone();
            let task = tokio::spawn(async move {
                let (mut reader, request) = accepted(listener).await;
                let _ = reader
                    .get_mut()
                    .write_all(
                        format!("{{\"id\":{},\"result\":{sending}}}\n", request["id"]).as_bytes(),
                    )
                    .await;
            });
            let args = if json {
                vec!["agent", "list", "--json"]
            } else {
                vec!["agent", "list"]
            };
            let out = output(f.command(&args)).await;
            if json {
                assert!(
                    out.status.success(),
                    "{}",
                    String::from_utf8_lossy(&out.stderr)
                );
                assert_eq!(out.stdout, format!("{result}\n").as_bytes());
            } else {
                assert_eq!(
                    out.status.code(),
                    Some(1),
                    "text renderer must fail closed: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
                assert!(out.stdout.is_empty());
                assert_eq!(
                    out.stderr,
                    "pult agent: capacity — agent display exceeds rendering limits\n".as_bytes()
                );
            }
            bounded(task).await.unwrap();
        }
    }
}
#[tokio::test]
async fn list_text_capacity_never_emits_partial_rows() {
    let f = Fixture::new();
    let result = json!({"sessions":vec![json!({"name":"x"});20_000]});
    assert!(serde_json::to_vec(&result).unwrap().len() < pult_core::MAX_LINE);
    let task = tokio::spawn(reply(f.listener(), result));
    let out = output(f.command(&["agent", "list"])).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        out.stderr,
        "pult agent: capacity — agent display exceeds rendering limits\n".as_bytes()
    );
    bounded(task).await.unwrap();
}
#[tokio::test]
async fn rpc_error_cannot_publish_stop_success() {
    let f = Fixture::new();
    let listener = f.listener();
    let task = tokio::spawn(async move {
        let (mut reader, request) = accepted(listener).await;
        reader.get_mut().write_all(format!("{}\n",json!({"id":request["id"],"error":{"code":"not_found","message":"Controlled missing"}})).as_bytes()).await.unwrap();
    });
    let out = output(f.command(&["agent", "stop", "one", "--json"])).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        out.stderr,
        "pult agent: not_found — Controlled missing\n".as_bytes()
    );
    bounded(task).await.unwrap();
}
#[tokio::test]
async fn wrong_id_eof_timeout_and_oversize_fail_without_replay() {
    for mode in ["wrong", "eof", "timeout", "oversize"] {
        let f = Fixture::new();
        let listener = f.listener();
        let task = tokio::spawn(async move {
            let (mut reader, _) = accepted(listener).await;
            match mode {
                "wrong" => reader
                    .get_mut()
                    .write_all(b"{\"id\":999,\"result\":{}}\n")
                    .await
                    .unwrap(),
                "timeout" => {
                    let mut line = String::new();
                    assert_eq!(reader.read_line(&mut line).await.unwrap(), 0);
                }
                "oversize" => {
                    let _ = reader
                        .get_mut()
                        .write_all(&vec![b'x'; pult_core::MAX_LINE + 2])
                        .await;
                }
                _ => {}
            }
        });
        let out = output(f.command(&["agent", "archive", "one"])).await;
        assert_eq!(
            out.status.code(),
            Some(if mode == "timeout" { 2 } else { 1 })
        );
        assert!(out.stdout.is_empty());
        bounded(task).await.unwrap();
    }
}
#[tokio::test]
async fn ctrl_c_pending_mutation_closes_socket_without_success_or_retry() {
    let f = Fixture::new();
    let listener = f.listener();
    let (ready, entered) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut reader, request) = accepted(listener).await;
        assert_eq!(request["method"], "agent.rename");
        ready.send(()).unwrap();
        let mut line = String::new();
        assert_eq!(reader.read_line(&mut line).await.unwrap(), 0);
    });
    let child = f
        .command(&["agent", "rename", "one", "Title"])
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    bounded(entered).await.unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = bounded(child.wait_with_output()).await.unwrap();
    assert_eq!(out.status.code(), Some(130));
    assert!(out.stdout.is_empty());
    bounded(task).await.unwrap();
}
async fn blocked_output(error: bool, interrupt: bool) {
    let f = Fixture::new();
    let listener = f.listener();
    let task = tokio::spawn(async move {
        let (mut reader, request) = accepted(listener).await;
        let frame = if error {
            json!({"id":request["id"],"error":{"code":"internal","message":"x".repeat(512*1024)}})
        } else {
            json!({"id":request["id"],"result":{"title":"x".repeat(512*1024)}})
        };
        let _ = reader
            .get_mut()
            .write_all(format!("{frame}\n").as_bytes())
            .await;
    });
    let mut c = f.command(&["agent", "rename", "one", "Title"]);
    if error {
        c.stdout(Stdio::null());
    } else {
        c.stderr(Stdio::null());
    }
    let mut child = c.spawn().unwrap();
    let pid = child.id().unwrap();
    // Both cases retain a real unread OS pipe, not a fake future.
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();
    if interrupt {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let available = if error {
                rustix::io::ioctl_fionread(err_pipe.as_ref().unwrap())
            } else {
                rustix::io::ioctl_fionread(out_pipe.as_ref().unwrap())
            }
            .unwrap();
            if available > 0 {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "writer did not reach pipe"
            );
            tokio::task::yield_now().await;
        }
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGINT,
        )
        .unwrap();
    }
    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("blocked writer held RuntimeDrop")
        .unwrap();
    assert_eq!(status.code(), Some(if interrupt { 130 } else { 1 }));
    bounded(task).await.unwrap();
    drop((out_pipe, err_pipe));
}
#[tokio::test]
async fn blocked_success_and_error_writers_have_bounded_explicit_exit() {
    for error in [false, true] {
        blocked_output(error, false).await;
    }
}
#[tokio::test]
async fn ctrl_c_success_and_error_writers_exit_130() {
    for error in [false, true] {
        blocked_output(error, true).await;
    }
}
#[tokio::test]
async fn actual_public_node_cli_oracle_matches_rust() {
    let mut c = Command::new("node");
    c.arg("rust/tests/cli-agent-presentation-oracle.mjs")
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = tokio::time::timeout(Duration::from_secs(60), c.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.stdout,
        b"agent presentation oracle: 96 paired Node/Rust cases\n"
    );
}
