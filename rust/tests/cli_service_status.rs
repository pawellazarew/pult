//! Actual executable, private sockets and controlled manager descendants only.
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Output, Stdio},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};
const KEYS: [&str; 4] = [
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
];
struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
    services: PathBuf,
    manager: PathBuf,
    pids: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("r4ss-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = root.path().join("pult");
        let services = root.path().join("services");
        for path in [
            &home,
            &home.join("run"),
            &services,
            &root.path().join("user"),
        ] {
            std::fs::create_dir(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        for (path, text) in [
            (".rust-core-scratch", "pult-rust-scratch-v1\n".into()),
            ("config.json", "{\"language\":\"en\"}".into()),
            ("run/token", "a".repeat(64)),
        ] {
            let file = home.join(path);
            std::fs::write(&file, text).unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let manager = root.path().join("manager");
        std::fs::write(&manager, include_str!("fixtures/service_status.py")).unwrap();
        std::fs::set_permissions(&manager, std::fs::Permissions::from_mode(0o700)).unwrap();
        let pids = root.path().join("pids");
        Self {
            root,
            home,
            services,
            manager,
            pids,
        }
    }
    fn service(&self) {
        std::fs::write(
            self.services.join("pultd.service"),
            format!(
                "Environment=\"PULT_HOME={}\"\nExecStart=\"{}\"\n",
                self.home.display(),
                self.manager.display()
            ),
        )
        .unwrap();
    }
    fn command(&self, mode: &str, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        command
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .env_remove("PULT_HOME")
            .env_remove("PULT_SERVICE_NAME")
            .env_remove("NODE_OPTIONS")
            .env("HOME", self.root.path().join("user"))
            .env("PULT_LANG", "en")
            .env("PULT_TEST", "1")
            .env("PULT_SERVICE_PLATFORM", "linux")
            .env("PULT_SERVICE_DIR", &self.services)
            .env("PULT_SYSTEMCTL", &self.manager)
            .env("FAKE_MODE", mode)
            .env("FAKE_PIDS", &self.pids)
            .env("OPENAI_API_KEY", "synthetic-must-not-pass")
            .stdin(Stdio::null())
            .kill_on_drop(true);
        for key in KEYS {
            command.env_remove(key);
        }
        command
    }
    async fn started(&self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(bytes) = std::fs::read(&self.pids)
                && let Ok(value) = serde_json::from_slice(&bytes)
            {
                return value;
            }
            assert!(Instant::now() < deadline, "manager never started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
async fn output(mut command: Command) -> Output {
    let child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(28), child.wait_with_output()).await;
    result
        .expect("CLI process exceeded explicit contract watchdog")
        .unwrap()
}
fn parsed(out: &Output) -> Value {
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
async fn stopped(pids: &Value) {
    for key in ["leader", "child"] {
        if let Some(pid) = pids[key].as_u64() {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let out = Command::new("/bin/ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .await
                    .unwrap();
                let state = String::from_utf8_lossy(&out.stdout);
                if !out.status.success() || state.trim().starts_with('Z') {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "manager group member is still executing"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
}
#[tokio::test]
async fn offline_report_never_autostarts_or_queries_absent_service() {
    let f = Fixture::new();
    let out = output(f.command("normal", &["daemon", "status", "--json"])).await;
    assert_eq!(out.status.code(), Some(1));
    let data = parsed(&out);
    assert_eq!(data["running"], false);
    assert_eq!(data["home"], f.home.to_str().unwrap());
    assert_eq!(data["service"]["installed"], false);
    assert!(!f.pids.exists());
}
#[tokio::test]
async fn successful_query_cleans_intentionally_forked_fake_descendant_before_return() {
    let f = Fixture::new();
    f.service();
    let start = Instant::now();
    let out = output(f.command("descendant", &["daemon", "status", "--json"])).await;
    assert!(start.elapsed() < Duration::from_secs(6));
    let data = parsed(&out);
    assert_eq!(data["service"]["manager"]["running"], true);
    let pids = f.started().await;
    assert_eq!(pids["secret"], false);
    assert_eq!(
        pids["argv"],
        json!([
            "--user",
            "show",
            "pultd.service",
            "-p",
            "LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus"
        ])
    );
    stopped(&pids).await;
}
#[tokio::test]
async fn stdout_and_stderr_overflow_are_errors_not_truncated_valid_states() {
    for mode in ["overflow", "stderr"] {
        let f = Fixture::new();
        f.service();
        let out = output(f.command(mode, &["daemon", "status", "--json"])).await;
        let data = parsed(&out);
        assert_eq!(data["service"]["installed"], true);
        assert_eq!(data["service"]["ours"], true);
        assert_eq!(
            data["service"]["error"],
            "service manager output exceeds 1 MiB limit"
        );
        assert_eq!(
            data["service"]["manager"]["error"],
            data["service"]["error"]
        );
        stopped(&f.started().await).await;
    }
}
#[tokio::test]
async fn twenty_second_query_deadline_stops_and_joins_the_group() {
    let f = Fixture::new();
    f.service();
    let start = Instant::now();
    let out = output(f.command("timeout", &["daemon", "status", "--json"])).await;
    assert!(start.elapsed() >= Duration::from_secs(19));
    let data = parsed(&out);
    assert_eq!(data["service"]["error"], "service manager query timed out");
    stopped(&f.started().await).await;
}
#[tokio::test]
async fn ctrl_c_cleans_the_query_group_and_has_no_partial_json() {
    let f = Fixture::new();
    f.service();
    let child = f
        .command("hang", &["daemon", "status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pids = f.started().await;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out.status.code(), Some(130));
    assert!(out.stdout.is_empty());
    assert_eq!(out.stderr, b"Error: service status interrupted\n");
    stopped(&pids).await;
}
#[tokio::test]
async fn failed_manager_retains_safe_exit_label_and_hides_stderr() {
    let f = Fixture::new();
    f.service();
    let out = output(f.command("failure", &["daemon", "status", "--json"])).await;
    let data = parsed(&out);
    assert_eq!(data["service"]["installed"], true);
    assert_eq!(
        data["service"]["error"],
        "systemctl --user show pultd.service: код 7 — service manager query failed"
    );
    assert!(!String::from_utf8_lossy(&out.stdout).contains("private-manager-line"));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("abcdefghijklmnopqrstuvwxyz"));
}
#[tokio::test]
async fn all_scoped_purposes_fail_before_invalid_home_or_service_io_even_initialization() {
    let mut f = Fixture::new();
    f.service();
    f.home = PathBuf::from("relative");
    for key in KEYS {
        for value in ["", "synthetic"] {
            for initialize in [false, true] {
                let args = if initialize {
                    vec!["daemon", "status", "--initialize-runtime"]
                } else {
                    vec!["daemon", "status", "--json"]
                };
                let mut c = f.command("normal", &args);
                c.env(key, value);
                let out = output(c).await;
                assert_eq!(out.status.code(), Some(1));
                assert!(out.stdout.is_empty());
                let err = String::from_utf8_lossy(&out.stderr);
                assert!(
                    err == "Error: permission/runtime credentials cannot use owner CLI commands\n"
                        || err == "Error: service status requires owner authentication\n",
                    "{err}"
                );
                assert!(!f.pids.exists());
            }
        }
    }
}
#[tokio::test]
async fn scoped_denial_precedes_fifo_config_token_and_service_files() {
    let f = Fixture::new();
    f.service();
    for file in [
        f.home.join("config.json"),
        f.home.join("run/token"),
        f.services.join("pultd.service"),
    ] {
        std::fs::remove_file(&file).unwrap();
        assert!(
            std::process::Command::new("/usr/bin/mkfifo")
                .arg(&file)
                .status()
                .unwrap()
                .success()
        );
    }
    for key in KEYS {
        let mut c = f.command("normal", &["daemon", "status", "--json"]);
        c.env(key, "").env("PULT_MEMORY_KEY", "");
        let out = output(c).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(!f.pids.exists());
    }
}
#[tokio::test]
async fn unsafe_service_file_types_and_large_files_remain_explicitly_unknown() {
    for mode in ["fifo", "symlink", "large"] {
        let f = Fixture::new();
        let file = f.services.join("pultd.service");
        match mode {
            "fifo" => assert!(
                std::process::Command::new("/usr/bin/mkfifo")
                    .arg(&file)
                    .status()
                    .unwrap()
                    .success()
            ),
            "symlink" => std::os::unix::fs::symlink(&f.manager, &file).unwrap(),
            _ => std::fs::write(&file, vec![b'x'; 1024 * 1024 + 1]).unwrap(),
        };
        let out = output(f.command("normal", &["daemon", "status", "--json"])).await;
        let data = parsed(&out);
        assert_eq!(data["service"]["installed"], true);
        assert!(data["service"]["error"].is_string());
        assert_eq!(data["service"]["manager"], Value::Null);
        assert!(!f.pids.exists());
    }
}
async fn peer(listener: UnixListener, reply: Value, initialize: bool) {
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
    assert_eq!(request["method"], "daemon.status");
    assert_eq!(
        request["params"],
        if initialize {
            json!({"initializeRuntime":true})
        } else {
            json!({})
        }
    );
    let result = if reply.get("id").is_some() {
        reply
    } else {
        json!({"id":request["id"],"result":reply})
    };
    reader
        .get_mut()
        .write_all(format!("{result}\n").as_bytes())
        .await
        .unwrap();
}
#[tokio::test]
async fn explicit_initialization_keeps_raw_rpc_json_and_never_queries_manager() {
    let f = Fixture::new();
    f.service();
    let listener = UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
    let task = tokio::spawn(peer(
        listener,
        json!({"nativeRuntime":{"initialized":true}}),
        true,
    ));
    let out = output(f.command("normal", &["daemon", "status", "--initialize-runtime"])).await;
    task.await.unwrap();
    assert!(out.status.success());
    assert_eq!(parsed(&out), json!({"nativeRuntime":{"initialized":true}}));
    assert!(!f.pids.exists());
}
#[tokio::test]
async fn wrong_id_eof_and_slow_response_are_bounded_offline_observations() {
    for mode in ["wrong", "eof", "slow", "oversize"] {
        let f = Fixture::new();
        let listener = UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
        let mode = mode.to_owned();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            reader
                .get_mut()
                .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
                .await
                .unwrap();
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            match mode.as_str() {
                "wrong" => {
                    reader
                        .get_mut()
                        .write_all(b"{\"id\":999,\"result\":{}}\n")
                        .await
                        .unwrap();
                }
                "slow" => {
                    let mut eof = String::new();
                    assert_eq!(reader.read_line(&mut eof).await.unwrap(), 0);
                }
                "oversize" => {
                    let _ = reader
                        .get_mut()
                        .write_all(&vec![b'x'; pult_core::MAX_LINE + 2])
                        .await;
                }
                _ => (),
            }
        });
        let start = Instant::now();
        let out = output(f.command("normal", &["daemon", "status", "--json"])).await;
        assert_eq!(parsed(&out)["running"], false);
        assert_eq!(out.status.code(), Some(1));
        assert!(start.elapsed() < Duration::from_secs(5));
        task.await.unwrap();
        assert!(!f.pids.exists());
    }
}
#[tokio::test]
async fn broken_stdout_exits_after_query_cleanup() {
    let f = Fixture::new();
    f.service();
    let mut child = f
        .command("descendant", &["daemon", "status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .code(),
        Some(1)
    );
    stopped(&f.started().await).await;
}
#[tokio::test]
async fn missing_fake_manager_never_falls_back_to_the_real_os_manager() {
    let f = Fixture::new();
    f.service();
    let mut command = f.command("normal", &["daemon", "status", "--json"]);
    command.env_remove("PULT_SYSTEMCTL");
    let out = output(command).await;
    let data = parsed(&out);
    assert_eq!(
        data["service"]["error"],
        "test service query requires an explicit fake manager"
    );
    assert!(!f.pids.exists());
}

#[tokio::test]
async fn blocked_stdout_does_not_hold_exit_or_the_cleaned_query_group() {
    let f = Fixture::new();
    f.service();
    let listener = UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
    let task = tokio::spawn(peer(
        listener,
        json!({"version":"x".repeat(512*1024),"pid":1,"protocol":1,"uptimeMs":0,"home":"fixture","clients":1,"subscriptions":0,"lastEventId":0}),
        false,
    ));
    let mut child = f
        .command("descendant", &["daemon", "status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Keep an actual OS pipe open without draining it. A future-only timeout
    // would miss a writer that holds global stdout through process cleanup.
    let stdout = child.stdout.take().unwrap();
    let start = Instant::now();
    let status = tokio::time::timeout(Duration::from_secs(6), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(start.elapsed() < Duration::from_secs(5));
    task.await.unwrap();
    stopped(&f.started().await).await;
    drop(stdout);
}

#[tokio::test]
async fn ctrl_c_on_an_actual_blocked_stdout_pipe_exits_130_after_query_cleanup() {
    let f = Fixture::new();
    f.service();
    let listener = UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
    let task = tokio::spawn(peer(
        listener,
        json!({"version":"x".repeat(512*1024),"pid":1,"protocol":1,"uptimeMs":0,"home":"fixture","clients":1,"subscriptions":0,"lastEventId":0}),
        false,
    ));
    let mut child = f
        .command("descendant", &["daemon", "status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let pids = f.started().await;
    stopped(&pids).await;
    let deadline = Instant::now() + Duration::from_secs(1);
    while rustix::io::ioctl_fionread(&stdout).unwrap() == 0 {
        assert!(
            Instant::now() < deadline,
            "output never reached the unread OS pipe"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out.status.code(), Some(130));
    assert_eq!(out.stderr, b"Error: service status interrupted\n");
    task.await.unwrap();
    stopped(&pids).await;
    drop(stdout);
}

#[tokio::test]
async fn ctrl_c_during_status_rpc_closes_the_socket_without_query_or_retry() {
    let f = Fixture::new();
    f.service();
    let listener = UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
    let (sent, received) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(socket);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        reader
            .get_mut()
            .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1}\n")
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&line).unwrap()["method"],
            "daemon.status"
        );
        sent.send(()).unwrap();
        line.clear();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(4), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    });
    let child = f
        .command("normal", &["daemon", "status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    received.await.unwrap();
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out.status.code(), Some(130));
    assert!(out.stdout.is_empty());
    assert_eq!(out.stderr, b"Error: service status interrupted\n");
    assert!(!f.pids.exists());
    peer.await.unwrap();
}

#[tokio::test]
async fn invalid_owner_home_is_fatal_and_never_becomes_an_offline_service_probe() {
    let mut f = Fixture::new();
    f.service();
    f.home = PathBuf::from("relative");
    let out = output(f.command("normal", &["daemon", "status", "--json"])).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        out.stderr,
        b"Error: service status requires a private Rust scratch home\n"
    );
    assert!(!f.pids.exists());
}

#[tokio::test]
async fn relative_service_context_and_parent_components_are_resolved_before_reading() {
    let f = Fixture::new();
    f.service();
    let mut command = f.command("normal", &["daemon", "status", "--json"]);
    command
        .current_dir(f.root.path())
        .env("PULT_SERVICE_DIR", "unused/../services");
    let out = output(command).await;
    let data = parsed(&out);
    assert_eq!(data["service"]["ours"], true);
    assert_eq!(data["service"]["manager"]["running"], true);
    assert!(!data["service"]["file"].as_str().unwrap().contains(".."));
}

#[tokio::test]
async fn actual_public_node_cli_matches_the_complete_status_profile() {
    let mut command = Command::new("node");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cli-service-status-oracle.mjs"
        ))
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("status oracle watchdog")
        .expect("Node24 status oracle");
    assert!(
        out.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.stdout,b"service status oracle: 36 exact paired Node/Rust cases + 4 explicit opaque-stderr profile cases\n");
}
