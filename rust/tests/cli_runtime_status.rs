//! Actual CLI/owned-child tests; all homes/executables/sockets are private fakes.
use serde_json::{Value, json};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};
const KEYS: [&str; 5] = [
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
    "PULT_CODEX_MEMORY_KEY",
];
struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
    fake: PathBuf,
    calls: PathBuf,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix("prs-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = root.path().join("home");
        for path in [
            &home,
            &home.join("run"),
            &home.join("runtime"),
            &root.path().join("user"),
        ] {
            std::fs::create_dir(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let fake = home.join("runtime/node-v0-foreign");
        let calls = root.path().join("calls");
        let f = Self {
            root,
            home,
            fake,
            calls,
        };
        f.write(".rust-core-scratch", b"pult-rust-scratch-v1\n");
        f.write("config.json", br#"{"language":"ru"}"#);
        f.write(
            "runtime/active",
            format!("{}\n", f.fake.display()).as_bytes(),
        );
        let settings = json!({"mode":mode,"calls":f.calls,"version":"v24.21.0\n"});
        std::fs::write(
            &f.fake,
            include_str!("fixtures/runtime_node.py").replace(
                "settings = SETTINGS",
                &format!("settings = json.loads({:?})", settings.to_string()),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&f.fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        f
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.home.join(name);
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.env_clear()
            .env("HOME", self.root.path().join("user"))
            .env("PULT_HOME", self.root.path().join("protected"))
            .env("PULT_TEST", "1")
            .env("PULT_TEST_RUNTIME_EXEC", &self.fake)
            .env("PULT_TEST_RUNTIME_CALLS", &self.calls)
            .env("PULT_LANG", "ru")
            .env("LANG", "C")
            .env("PATH", "/usr/bin:/bin")
            .env("TMPDIR", self.root.path())
            .env("NODE_OPTIONS", "synthetic-must-not-pass")
            .env("OPENAI_API_KEY", "synthetic-must-not-pass")
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        c
    }
    async fn calls(&self) -> Value {
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if let Ok(bytes) = std::fs::read(&self.calls)
                    && let Ok(value) = serde_json::from_slice(&bytes)
                {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
}
async fn finish(mut child: Child, duration: Duration, calls: Option<&std::path::Path>) -> Output {
    let pid = child.id().unwrap();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(stream) = stdout {
            stream
                .take(8 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .await
                .unwrap();
        }
        bytes
    });
    let err = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(stream) = stderr {
            stream
                .take(8 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .await
                .unwrap();
        }
        bytes
    });
    let status = match tokio::time::timeout(duration, child.wait()).await {
        Ok(status) => status.unwrap(),
        Err(_) => {
            // Stop the known fake query while its owning CLI still retains the
            // leader. Never signal a recorded PID after releasing the CLI.
            if let Some(calls) = calls
                .and_then(|path| std::fs::read(path).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                && let Some(leader) = calls["leader"].as_u64()
            {
                let parent = Command::new("/bin/ps")
                    .args(["-o", "ppid=", "-p", &leader.to_string()])
                    .output()
                    .await
                    .unwrap();
                if String::from_utf8_lossy(&parent.stdout)
                    .trim()
                    .parse::<u32>()
                    .ok()
                    == Some(pid)
                {
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(leader as i32),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                    stopped(&calls).await;
                }
            }
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
            child.wait().await.unwrap();
            out.await.unwrap();
            err.await.unwrap();
            panic!("runtime CLI watchdog killed and joined child");
        }
    };
    Output {
        status,
        stdout: out.await.unwrap(),
        stderr: err.await.unwrap(),
    }
}
async fn output(mut command: Command) -> Output {
    let calls = command
        .as_std()
        .get_envs()
        .find(|(name, _)| *name == "PULT_TEST_RUNTIME_CALLS")
        .and_then(|(_, value)| value)
        .map(PathBuf::from);
    finish(
        command.spawn().unwrap(),
        Duration::from_secs(10),
        calls.as_deref(),
    )
    .await
}
fn report(out: &Output) -> Value {
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    serde_json::from_slice(&out.stdout).unwrap()
}
async fn stopped(calls: &Value) {
    for pid in [calls["leader"].as_u64(), calls["child"].as_u64()]
        .into_iter()
        .flatten()
    {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let output = Command::new("/bin/ps")
                    .args(["-o", "stat=", "-p", &pid.to_string()])
                    .output()
                    .await
                    .unwrap();
                if !output.status.success()
                    || String::from_utf8_lossy(&output.stdout)
                        .trim()
                        .starts_with('Z')
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("known fake child remains executing");
    }
}
#[tokio::test]
async fn actual_public_node_oracle_matches_both_status_spellings_and_locales() {
    let mut command = Command::new("node");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cli-runtime-status-oracle.mjs"
        ))
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(100), command.output())
        .await
        .expect("runtime oracle watchdog")
        .unwrap();
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.stdout,
        b"runtime status oracle: 88 exact paired Node/Rust cases\n"
    );
}
#[tokio::test]
async fn version_query_cleans_descendants_with_inherited_pipes_or_early_eof() {
    for mode in ["fork", "fork-eof"] {
        let f = Fixture::new(mode);
        let out = output(f.command(&["runtime", "status", "--json"])).await;
        assert_eq!(report(&out)["activeVersion"], "v24.21.0");
        let calls = f.calls().await;
        assert_eq!(calls["argv"], json!(["-v"]));
        assert_eq!(calls["secret"], false);
        stopped(&calls).await;
    }
}
#[tokio::test]
async fn nonzero_and_stdout_or_stderr_overflow_are_null_after_confirmed_cleanup() {
    for mode in ["nonzero", "stdout", "stderr"] {
        let f = Fixture::new(mode);
        let out = output(f.command(&["runtime", "--json"])).await;
        assert_eq!(report(&out)["activeVersion"], Value::Null);
        stopped(&f.calls().await).await;
    }
}
#[tokio::test]
async fn source_sixty_second_deadline_cleans_group_and_keeps_status_exit_zero() {
    let f = Fixture::new("hang");
    let start = std::time::Instant::now();
    let child = f.command(&["runtime", "--json"]).spawn().unwrap();
    let out = finish(child, Duration::from_secs(70), Some(&f.calls)).await;
    assert_eq!(report(&out)["activeVersion"], Value::Null);
    assert!(start.elapsed() >= Duration::from_secs(59));
    stopped(&f.calls().await).await;
}
#[tokio::test]
async fn sigint_joins_version_query_before_exit_and_never_connects_to_daemon() {
    let f = Fixture::new("hang");
    f.write(
        "run/token",
        b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    let peer = tokio::net::UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
    let child = f.command(&["runtime", "--json"]).spawn().unwrap();
    let calls = f.calls().await;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = finish(child, Duration::from_secs(6), Some(&f.calls)).await;
    assert_eq!(out.status.code(), Some(130));
    assert!(out.stdout.is_empty());
    assert_eq!(out.stderr, b"Error: runtime status interrupted\n");
    stopped(&calls).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), peer.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn data_fifo_symlink_directory_and_pointer_limit_are_fatal_not_missing() {
    for kind in ["fifo", "symlink", "directory", "oversize", "parent-symlink"] {
        let f = Fixture::new("normal");
        let path = f.home.join("runtime/active");
        match kind {
            "fifo" => {
                std::fs::remove_file(&path).unwrap();
                assert!(
                    std::process::Command::new("/usr/bin/mkfifo")
                        .arg(&path)
                        .status()
                        .unwrap()
                        .success()
                );
            }
            "symlink" => {
                std::fs::remove_file(&path).unwrap();
                symlink(&f.fake, &path).unwrap();
            }
            "directory" => {
                std::fs::remove_file(&path).unwrap();
                std::fs::create_dir(&path).unwrap();
            }
            "oversize" => f.write("runtime/active", &vec![b'x'; 16 * 1024 + 1]),
            "parent-symlink" => {
                let target = f.root.path().join("external-runtime");
                std::fs::rename(f.home.join("runtime"), &target).unwrap();
                symlink(target, f.home.join("runtime")).unwrap();
            }
            _ => unreachable!(),
        }
        let out = output(f.command(&["runtime", "--json"])).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(!out.stderr.is_empty());
        assert!(!f.calls.exists());
    }
}
#[tokio::test]
async fn all_scoped_purposes_precede_fifo_data_and_invalid_home() {
    let f = Fixture::new("normal");
    let path = f.home.join("runtime/active");
    std::fs::remove_file(&path).unwrap();
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(path)
            .status()
            .unwrap()
            .success()
    );
    std::fs::set_permissions(&f.home, std::fs::Permissions::from_mode(0o755)).unwrap();
    for key in KEYS {
        for value in ["", "synthetic-private-key"] {
            let mut command = f.command(&["runtime", "--json"]);
            command.env(key, value);
            let out = output(command).await;
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            assert_eq!(
                out.stderr,
                b"Error: runtime status requires owner authentication\n"
            );
            assert!(!f.calls.exists());
        }
    }
    use std::os::unix::ffi::OsStringExt;
    let mut command = f.command(&["runtime", "--json"]);
    command.env(KEYS[0], std::ffi::OsString::from_vec(vec![0xff]));
    for key in &KEYS[1..] {
        command.env(key, "");
    }
    let out = output(command).await;
    assert_eq!(
        out.stderr,
        b"Error: runtime status requires owner authentication\n"
    );
    assert!(out.stdout.is_empty());
    assert!(!f.calls.exists());
}
#[tokio::test]
async fn test_mode_never_falls_back_to_a_copied_real_executable_pointer() {
    let f = Fixture::new("normal");
    let mut command = f.command(&["runtime", "--json"]);
    command.env_remove("PULT_TEST_RUNTIME_EXEC");
    let out = output(command).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(!f.calls.exists());
}
#[tokio::test]
async fn blocked_actual_stdout_has_bounded_exit_after_query_cleanup() {
    let f = Fixture::new("fork");
    for n in 0..1000 {
        f.write(&format!("runtime/node-v{n:04}{}", "x".repeat(180)), b"");
    }
    let mut child = f.command(&["runtime", "--json"]).spawn().unwrap();
    let pipe = child.stdout.take().unwrap();
    let calls = f.calls().await;
    let out = finish(child, Duration::from_secs(7), Some(&f.calls)).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stderr
            .windows(b"output failed".len())
            .any(|w| w == b"output failed")
    );
    drop(pipe);
    stopped(&calls).await;
}

#[tokio::test]
async fn sigint_on_actual_blocked_stdout_joins_query_before_exit_130() {
    let f = Fixture::new("fork");
    for n in 0..1000 {
        f.write(&format!("runtime/node-v{n:04}{}", "x".repeat(180)), b"");
    }
    let mut child = f.command(&["runtime", "--json"]).spawn().unwrap();
    let mut pipe = child.stdout.take().unwrap();
    let mut first = [0];
    tokio::time::timeout(Duration::from_secs(5), pipe.read_exact(&mut first))
        .await
        .unwrap()
        .unwrap();
    // A report byte proves the query has finished its owned cleanup. Stop
    // reading now so the rest of the actual report fills the OS pipe.
    assert_eq!(first, [b'{']);
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let out = finish(child, Duration::from_secs(6), Some(&f.calls)).await;
    assert_eq!(out.status.code(), Some(130));
    assert_eq!(out.stderr, b"Error: runtime status interrupted\n");
    drop(pipe);
    stopped(&f.calls().await).await;
}

#[tokio::test]
async fn missing_runtime_does_not_create_layout_and_directory_cap_never_looks_empty() {
    let f = Fixture::new("normal");
    std::fs::remove_dir_all(f.home.join("runtime")).unwrap();
    let out = output(f.command(&["runtime", "--json"])).await;
    let value = report(&out);
    assert_eq!(value["active"], Value::Null);
    assert_eq!(value["installed"], json!([]));
    assert!(!f.home.join("runtime").exists());
    let f = Fixture::new("normal");
    for n in 0..4096 {
        f.write(&format!("runtime/node-v{n}"), b"");
    }
    let out = output(f.command(&["runtime", "--json"])).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert!(!f.calls.exists());
    assert!(String::from_utf8_lossy(&out.stderr).contains("observation limits"));
}

#[tokio::test]
async fn runtime_status_keeps_separate_two_second_handshake_and_request_deadlines() {
    for (hello_delay, request_delay, online) in
        [(0, 2200, false), (2200, 0, false), (1000, 1300, true)]
    {
        let f = Fixture::new("normal");
        f.write(
            "run/token",
            b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        let peer = tokio::net::UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = peer.accept().await.unwrap();
            let mut socket = BufReader::new(socket);
            let mut line = String::new();
            socket.read_line(&mut line).await.unwrap();
            tokio::time::sleep(Duration::from_millis(hello_delay)).await;
            if socket
                .get_mut()
                .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1,\"daemon\":{}}\n")
                .await
                .is_err()
            {
                return;
            }
            line.clear();
            if socket.read_line(&mut line).await.unwrap() == 0 {
                return;
            }
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "daemon.status");
            tokio::time::sleep(Duration::from_millis(request_delay)).await;
            let response = json!({"id":request["id"],"result":{"node":{"alive":true,"own":true,"version":"vfixture","path":"/fixture/node"}}});
            let _ = socket
                .get_mut()
                .write_all(format!("{response}\n").as_bytes())
                .await;
        });
        let start = std::time::Instant::now();
        let out = output(f.command(&["runtime", "--json"])).await;
        let value = report(&out);
        assert_eq!(value["daemon"].is_object(), online);
        assert!(start.elapsed() >= Duration::from_millis(1900));
        assert!(start.elapsed() < Duration::from_secs(6));
        tokio::time::timeout(Duration::from_secs(4), server)
            .await
            .unwrap()
            .unwrap();
    }
}
