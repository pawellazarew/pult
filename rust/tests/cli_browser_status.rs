//! Actual CLI, private package/Chrome fixtures and fake protocol-1 sockets.
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Output, Stdio},
    time::{Duration, Instant},
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
const PACKAGE: &str = "mcp/playwright-mcp-0.0.84/node_modules/@playwright/mcp";
struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("r4bs-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = root.path().join("pult");
        for dir in [&home, &home.join("run"), &root.path().join("user")] {
            std::fs::create_dir(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        for (path, body) in [
            (".rust-core-scratch", "pult-rust-scratch-v1\n".into()),
            ("config.json", "{\"language\":\"en\"}".into()),
            ("run/token", "a".repeat(64)),
        ] {
            let file = home.join(path);
            std::fs::write(&file, body).unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        Self { root, home }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.arg("--home")
            .arg(&self.home)
            .args(args)
            .env_remove("PULT_HOME")
            .env_remove("PULT_TEST_BROWSER_CHROME_FILE")
            .env_remove("NODE_OPTIONS")
            .env("HOME", self.root.path().join("user"))
            .env("PULT_TEST", "1")
            .env("PULT_LANG", "en")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        for key in KEYS {
            c.env_remove(key);
        }
        c
    }
    fn package(&self) -> PathBuf {
        let dir = self.home.join(PACKAGE);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), "{\"version\":\"0.0.84\"}").unwrap();
        std::fs::write(dir.join("cli.js"), "throw new Error('must not execute')").unwrap();
        dir
    }
    fn listener(&self) -> UnixListener {
        UnixListener::bind(self.home.join("run/pultd.sock")).unwrap()
    }
    fn chrome(&self) -> PathBuf {
        let file = self.home.join("fake-chrome");
        std::fs::write(
            &file,
            format!(
                "#!/bin/sh\nprintf invoked > '{}'\n",
                self.root.path().join("invoked").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        file
    }
}
async fn output(mut command: Command) -> Output {
    tokio::time::timeout(Duration::from_secs(7), command.output())
        .await
        .expect("bounded browser CLI process")
        .unwrap()
}
fn data(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    serde_json::from_slice(&out.stdout).unwrap()
}
async fn request(listener: UnixListener) -> (BufReader<UnixStream>, u64) {
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
    let req: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(req["method"], "daemon.status");
    assert_eq!(req["params"], json!({}));
    (reader, req["id"].as_u64().unwrap())
}
fn fifo(path: &std::path::Path) {
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(path)
            .status()
            .unwrap()
            .success()
    );
}
#[tokio::test]
async fn local_alias_json_and_text_observe_real_private_files_without_executing_them() {
    let f = Fixture::new();
    f.package();
    let chrome = f.chrome();
    for args in [
        vec!["browser", "--json"],
        vec!["browser", "status", "--json"],
        vec!["browser", "--json", "status"],
    ] {
        let mut c = f.command(&args);
        c.env("PULT_TEST_BROWSER_CHROME_FILE", &chrome);
        let value = data(&output(c).await);
        assert_eq!(value["installed"], true);
        assert_eq!(value["version"], "0.0.84");
        assert_eq!(value["chrome"], chrome.to_str().unwrap());
        assert_eq!(value["daemon"], Value::Null);
    }
    let out = output(f.command(&["browser", "status"])).await;
    assert!(out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stdout)
            .starts_with("[ok  ] Agent browser: @playwright/mcp 0.0.84 installed:")
    );
    assert!(!f.root.path().join("invoked").exists());
}
#[tokio::test]
async fn scoped_presence_empty_and_mixed_precedes_invalid_home_and_fifo_owner_package_reads() {
    let mut f = Fixture::new();
    let dir = f.package();
    for file in [
        f.home.join("config.json"),
        f.home.join("run/token"),
        dir.join("package.json"),
    ] {
        std::fs::remove_file(&file).unwrap();
        fifo(&file);
    }
    for key in KEYS {
        for value in ["", "synthetic"] {
            for alias in [false, true] {
                for mixed in [false, true] {
                    let args = if alias {
                        vec!["browser", "--json"]
                    } else {
                        vec!["browser", "status", "--json"]
                    };
                    let mut c = f.command(&args);
                    c.env(key, value);
                    if mixed {
                        c.env(
                            if key == "PULT_MEMORY_KEY" {
                                "PULT_ASK_KEY"
                            } else {
                                "PULT_MEMORY_KEY"
                            },
                            "",
                        );
                    }
                    let out = output(c).await;
                    assert_eq!(out.status.code(), Some(1));
                    assert!(out.stdout.is_empty());
                    assert_eq!(
                        out.stderr,
                        b"Error: browser status requires owner authentication\n"
                    );
                }
            }
        }
    }
    f.home = PathBuf::from("relative");
    for key in KEYS {
        let mut c = f.command(&["browser", "status", "--json"]);
        c.env(key, "");
        let out = output(c).await;
        assert_eq!(
            out.stderr,
            b"Error: browser status requires owner authentication\n"
        );
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
    }
}
#[tokio::test]
async fn unsafe_package_and_cli_inputs_error_explicitly_without_fifo_hang_or_partial_json() {
    for name in ["package.json", "cli.js"] {
        for mode in ["fifo", "symlink", "directory", "large"] {
            if name == "cli.js" && mode == "large" {
                continue;
            }
            let f = Fixture::new();
            let dir = f.package();
            let file = dir.join(name);
            std::fs::remove_file(&file).unwrap();
            match mode {
                "fifo" => fifo(&file),
                "symlink" => {
                    std::os::unix::fs::symlink(f.root.path().join("outside"), &file).unwrap()
                }
                "directory" => std::fs::create_dir(&file).unwrap(),
                _ => std::fs::write(&file, vec![b'x'; 1024 * 1024 + 1]).unwrap(),
            };
            let out = output(f.command(&["browser", "status", "--json"])).await;
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            let error = String::from_utf8_lossy(&out.stderr);
            assert!(error.starts_with("Error: browser "));
            assert!(!error.contains(&f.home.display().to_string()));
        }
    }
}
#[tokio::test]
async fn test_mode_has_no_real_chrome_fallback_and_explicit_fake_stays_inside_home() {
    let f = Fixture::new();
    let real_candidate = f
        .root
        .path()
        .join("user/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    std::fs::create_dir_all(real_candidate.parent().unwrap()).unwrap();
    std::fs::write(&real_candidate, "not executed").unwrap();
    std::fs::set_permissions(&real_candidate, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        data(&output(f.command(&["browser", "--json"])).await)["chrome"],
        Value::Null
    );
    for path in [
        real_candidate.clone(),
        PathBuf::from("relative"),
        f.home.join("../outside"),
    ] {
        let mut c = f.command(&["browser", "--json"]);
        c.env("PULT_TEST_BROWSER_CHROME_FILE", path);
        let out = output(c).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert_eq!(
            out.stderr,
            b"Error: browser fixture Chrome path must stay inside scratch home\n"
        );
    }
    let target = f.chrome();
    let alias = f.home.join("fake-alias");
    std::os::unix::fs::symlink(target, &alias).unwrap();
    let mut c = f.command(&["browser", "--json"]);
    c.env("PULT_TEST_BROWSER_CHROME_FILE", alias);
    let out = output(c).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
}
#[tokio::test]
async fn json_retains_bounded_raw_unknown_nested_browser_fields_and_lone_utf16() {
    let f = Fixture::new();
    let listener = f.listener();
    let raw = r#"{"state":"missing","sessions":0,"future":{"lone":"\ud800","other":[1,true,{"x":"\udfff"}]}}"#;
    let task = tokio::spawn(async move {
        let (mut reader, id) = request(listener).await;
        reader
            .get_mut()
            .write_all(
                format!("{{\"id\":{id},\"result\":{{\"browser\":{raw},\"ignored\":7}}}}\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
    });
    let out = output(f.command(&["browser", "status", "--json"])).await;
    task.await.unwrap();
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    assert!(String::from_utf8_lossy(&out.stdout).ends_with(&format!(",\"daemon\":{raw}}}\n")));
}
#[tokio::test]
async fn raw_numeric_zero_is_preserved_in_json_while_text_uses_disk_fallback() {
    for json in [false, true] {
        let f = Fixture::new();
        f.package();
        let listener = f.listener();
        let task = tokio::spawn(async move {
            let (mut reader, id) = request(listener).await;
            reader
                .get_mut()
                .write_all(format!("{{\"id\":{id},\"result\":{{\"browser\":0e0}}}}\n").as_bytes())
                .await
                .unwrap();
        });
        let out = output(f.command(if json {
            &["browser", "--json"]
        } else {
            &["browser"]
        }))
        .await;
        task.await.unwrap();
        assert!(out.status.success());
        if json {
            assert!(String::from_utf8_lossy(&out.stdout).ends_with(",\"daemon\":0e0}\n"));
        } else {
            assert!(String::from_utf8_lossy(&out.stdout).contains("installed:"));
        }
    }
}
#[tokio::test]
async fn wrong_id_eof_oversize_and_ordinary_deadline_are_offline_not_retries() {
    for mode in ["wrong", "eof", "oversize", "slow"] {
        let f = Fixture::new();
        let listener = f.listener();
        let task = tokio::spawn(async move {
            let (mut reader, _) = request(listener).await;
            match mode {
                "wrong" => reader
                    .get_mut()
                    .write_all(b"{\"id\":99,\"result\":{\"browser\":{\"state\":\"installed\"}}}\n")
                    .await
                    .unwrap(),
                "oversize" => {
                    let _ = reader
                        .get_mut()
                        .write_all(&vec![b'x'; pult_core::MAX_LINE + 2])
                        .await;
                }
                "slow" => {
                    let mut line = String::new();
                    assert_eq!(reader.read_line(&mut line).await.unwrap(), 0);
                }
                _ => (),
            }
        });
        let start = Instant::now();
        let value = data(&output(f.command(&["browser", "status", "--json"])).await);
        assert_eq!(value["daemon"], Value::Null);
        assert!(start.elapsed() < Duration::from_secs(5));
        task.await.unwrap();
    }
}
#[tokio::test]
async fn invalid_owner_home_and_malformed_status_fail_with_static_local_errors() {
    let mut f = Fixture::new();
    f.home = PathBuf::from("relative");
    let out = output(f.command(&["browser", "--json"])).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        out.stderr,
        b"Error: service status requires a private Rust scratch home\n"
    );
    let f = Fixture::new();
    let listener = f.listener();
    let task = tokio::spawn(async move {
        let (mut reader, id) = request(listener).await;
        reader
            .get_mut()
            .write_all(format!("{{\"id\":{id},\"result\":\"not-an-object\"}}\n").as_bytes())
            .await
            .unwrap();
    });
    let out = output(f.command(&["browser", "--json"])).await;
    task.await.unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(out.stderr, b"Error: invalid browser status response\n");
}
#[tokio::test]
async fn ctrl_c_only_disconnects_status_socket_and_never_sends_a_mutation() {
    let f = Fixture::new();
    let listener = f.listener();
    let (sent, received) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (mut reader, _) = request(listener).await;
        sent.send(()).unwrap();
        let mut line = String::new();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let child = f
        .command(&["browser", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    received.await.unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(i32::try_from(child.id().unwrap()).unwrap()),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out.status.code(), Some(130));
    assert!(out.stdout.is_empty());
    assert_eq!(out.stderr, b"Error: browser status interrupted\n");
    peer.await.unwrap();
}
#[tokio::test]
async fn actual_unread_output_pipe_is_bounded_and_ctrl_c_keeps_exit_130() {
    for interrupt in [false, true] {
        let f = Fixture::new();
        let listener = f.listener();
        let peer = tokio::spawn(async move {
            let (mut reader, id) = request(listener).await;
            reader.get_mut().write_all(format!("{{\"id\":{id},\"result\":{{\"browser\":{{\"state\":\"missing\",\"future\":\"{}\"}}}}}}\n","x".repeat(512*1024)).as_bytes()).await.unwrap();
        });
        let mut child = f
            .command(&["browser", "--json"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let start = Instant::now();
        if interrupt {
            let deadline = Instant::now() + Duration::from_secs(2);
            while rustix::io::ioctl_fionread(&stdout).unwrap() == 0 {
                assert!(Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(i32::try_from(child.id().unwrap()).unwrap()),
                nix::sys::signal::Signal::SIGINT,
            )
            .unwrap();
        }
        let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(out.status.code(), Some(if interrupt { 130 } else { 1 }));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert_eq!(
            out.stderr,
            if interrupt {
                b"Error: browser status interrupted\n".as_slice()
            } else {
                b"Error: browser status output failed\n".as_slice()
            }
        );
        peer.await.unwrap();
        drop(stdout);
    }
}
#[tokio::test]
async fn help_is_truthful_and_install_is_not_exposed_or_executed() {
    let f = Fixture::new();
    let out = output(f.command(&["browser", "--help"])).await;
    assert!(out.status.success());
    let help = String::from_utf8_lossy(&out.stdout);
    assert!(help.contains("status"));
    assert!(!help.contains("install  "));
    let out = output(f.command(&["browser", "install"])).await;
    assert_eq!(out.status.code(), Some(2));
    assert!(out.stdout.is_empty());
    assert!(!f.root.path().join("invoked").exists());
}
#[tokio::test]
async fn actual_public_node_cli_matches_browser_status_without_real_chrome_discovery() {
    let mut command = Command::new("node");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cli-browser-status-oracle.mjs"
        ))
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("browser oracle watchdog")
        .unwrap();
    assert!(
        out.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout,b"browser status oracle: 54 paired Node/Rust cases + explicit layout profile + 4 Node production Chrome symlink observations\n");
}
