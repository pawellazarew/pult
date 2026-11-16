//! Actual owner CLI against private files and a fake Unix peer. No daemon/provider/manager.
use nix::{
    sys::signal::{Signal, killpg},
    unistd::Pid,
};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    process::Command,
};

const KEYS: [&str; 4] = [
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
];
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("poi-")
            .tempdir_in("/tmp")
            .unwrap();
        let home = root.path().join("home");
        for dir in [
            &home,
            &home.join("run"),
            &root.path().join("user"),
            &root.path().join("services"),
        ] {
            std::fs::create_dir(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let fixture = Self { root, home };
        fixture.write(".rust-core-scratch", b"pult-rust-scratch-v1\n");
        fixture.write("config.json", br#"{"language":"ru"}"#);
        fixture.write("run/token", TOKEN.as_bytes());
        fixture
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.home.join(name);
        std::fs::write(&path, bytes).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        command
            .env_clear()
            .env("HOME", self.root.path().join("user"))
            .env("PULT_HOME", self.root.path().join("protected"))
            .env("PULT_LANG", "ru")
            .env("LANG", "C")
            .env("PATH", "/usr/bin:/bin")
            .env("TMPDIR", self.root.path())
            .env("PULT_TEST", "1")
            .env("PULT_SERVICE_DIR", self.root.path().join("services"))
            .env("PULT_LAUNCHCTL", self.root.path().join("forbidden-manager"))
            .env("PULT_SYSTEMCTL", self.root.path().join("forbidden-manager"))
            .arg("--home")
            .arg(&self.home)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        command
    }
    fn fifo(&self, name: &str) {
        let path = self.home.join(name);
        std::fs::remove_file(&path).unwrap();
        assert!(
            std::process::Command::new("/usr/bin/mkfifo")
                .arg("-m")
                .arg("600")
                .arg(path)
                .status()
                .unwrap()
                .success()
        );
    }
}
async fn output(mut command: Command) -> Output {
    let mut child = command.spawn().unwrap();
    let group = Pid::from_raw(i32::try_from(child.id().unwrap()).unwrap());
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take(2 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        bytes
    });
    let err = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr
            .take(2 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .await
            .unwrap();
        bytes
    });
    let status = match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
        Ok(status) => status.unwrap(),
        Err(_) => {
            killpg(group, Signal::SIGKILL).unwrap();
            child.wait().await.unwrap();
            out.await.unwrap();
            err.await.unwrap();
            panic!("owner CLI hung; watchdog killed and joined it");
        }
    };
    Output {
        status,
        stdout: out.await.unwrap(),
        stderr: err.await.unwrap(),
    }
}
fn fatal(out: &Output) {
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stdout.is_empty(),
        "unsafe input became an offline report: {}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(out.stderr, b"Error: daemon connection or response failed\n");
}
fn offline(out: &Output) {
    assert_eq!(out.status.code(), Some(1));
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["running"],
        false
    );
}
#[tokio::test]
async fn token_fifo_fails_locally_without_watchdog_or_offline_report() {
    let f = Fixture::new();
    f.fifo("run/token");
    fatal(&output(f.command(&["daemon", "status", "--json"])).await);
}
#[tokio::test]
async fn token_symlink_directory_and_limit_are_local_errors() {
    for kind in ["symlink", "directory", "oversize", "parent-symlink"] {
        let f = Fixture::new();
        let token = f.home.join("run/token");
        match kind {
            "symlink" => {
                let target = f.root.path().join("other");
                std::fs::rename(&token, &target).unwrap();
                symlink(target, &token).unwrap();
            }
            "directory" => {
                std::fs::remove_file(&token).unwrap();
                std::fs::create_dir(&token).unwrap();
            }
            "oversize" => f.write("run/token", format!("{TOKEN}\n").as_bytes()),
            "parent-symlink" => {
                let target = f.root.path().join("run-real");
                std::fs::rename(f.home.join("run"), &target).unwrap();
                symlink(target, f.home.join("run")).unwrap();
            }
            _ => unreachable!(),
        }
        fatal(&output(f.command(&["daemon", "status", "--json"])).await);
    }
}
#[tokio::test]
async fn readable_regular_token_permissions_and_hardlinks_keep_existing_acceptance() {
    for permissions in [0o600, 0o644] {
        let f = Fixture::new();
        std::fs::set_permissions(
            f.home.join("run/token"),
            std::fs::Permissions::from_mode(permissions),
        )
        .unwrap();
        std::fs::hard_link(f.home.join("run/token"), f.root.path().join("same-token")).unwrap();
        offline(&output(f.command(&["daemon", "status", "--json"])).await);
    }
}
#[tokio::test]
async fn missing_empty_short_and_nonhex_regular_tokens_keep_offline_contract() {
    let f = Fixture::new();
    for bytes in [
        b"".as_slice(),
        b"short",
        b"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ] {
        f.write("run/token", bytes);
        offline(&output(f.command(&["daemon", "status", "--json"])).await);
    }
    std::fs::remove_file(f.home.join("run/token")).unwrap();
    offline(&output(f.command(&["daemon", "status", "--json"])).await);
}
#[tokio::test]
async fn purpose_guard_precedes_hostile_token_and_config_for_all_owner_clients() {
    let f = Fixture::new();
    f.fifo("run/token");
    f.fifo("config.json");
    for key in KEYS {
        let mut command = f.command(&["daemon", "status", "--json"]);
        command.env(key, "");
        let out = output(command).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        let error = String::from_utf8(out.stderr).unwrap();
        assert!(
            error.contains("credentials cannot use owner CLI commands")
                || error.contains("requires owner authentication")
        );
    }
}
#[tokio::test]
async fn admitted_token_still_reaches_exact_owner_handshake_and_status() {
    let f = Fixture::new();
    let peer = UnixListener::bind(f.home.join("run/pultd.sock")).unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = peer.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut line = String::new();
        socket.read_line(&mut line).await.unwrap();
        let hello: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(hello["token"], TOKEN);
        assert_eq!(hello["type"], "hello");
        socket
            .get_mut()
            .write_all(b"{\"type\":\"hello_ok\",\"protocol\":1,\"daemon\":{}}\n")
            .await
            .unwrap();
        line.clear();
        socket.read_line(&mut line).await.unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "daemon.status");
        assert_eq!(request["locale"], "ru");
        socket
            .get_mut()
            .write_all(
                format!(
                    "{{\"id\":{},\"result\":{{\"version\":\"fixture\"}}}}\n",
                    request["id"]
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });
    let out = output(f.command(&["daemon", "status", "--json"])).await;
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["running"],
        true
    );
    tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn unsafe_or_oversize_config_is_fatal_even_with_explicit_language_override() {
    for kind in [
        "fifo",
        "symlink",
        "hardlink",
        "directory",
        "permissions",
        "oversize",
    ] {
        let f = Fixture::new();
        let config = f.home.join("config.json");
        match kind {
            "fifo" => f.fifo("config.json"),
            "symlink" => {
                let target = f.root.path().join("private-config");
                std::fs::rename(&config, &target).unwrap();
                symlink(target, &config).unwrap();
            }
            "hardlink" => {
                std::fs::hard_link(&config, f.root.path().join("private-config")).unwrap()
            }
            "directory" => {
                std::fs::remove_file(&config).unwrap();
                std::fs::create_dir(&config).unwrap();
            }
            "permissions" => {
                std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o644)).unwrap()
            }
            "oversize" => f.write("config.json", &vec![b' '; 1024 * 1024 + 1]),
            _ => unreachable!(),
        }
        let out = output(f.command(&["daemon", "status", "--json"])).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty(), "{kind} was hidden as auto/offline");
        assert_eq!(out.stderr, b"Error: service status locale is unavailable\n");
    }
}

#[tokio::test]
async fn missing_malformed_and_unsupported_config_preserve_auto_language_fallback() {
    for bytes in [
        None,
        Some(b"{broken".as_slice()),
        Some(br#"{"language":"unknown"}"#),
        Some(br#"["en"]"#),
    ] {
        let f = Fixture::new();
        if let Some(bytes) = bytes {
            f.write("config.json", bytes);
        } else {
            std::fs::remove_file(f.home.join("config.json")).unwrap();
        }
        let mut command = f.command(&["daemon", "status"]);
        command.env_remove("PULT_LANG").env("LANG", "ru_RU.UTF-8");
        let out = output(command).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stderr.is_empty());
        assert!(
            String::from_utf8(out.stdout)
                .unwrap()
                .starts_with("демон не запущен\n")
        );
    }
    let f = Fixture::new();
    f.write("config.json", br#"{"language":"en"}"#);
    let mut command = f.command(&["daemon", "status"]);
    command.env_remove("PULT_LANG").env("LANG", "ru_RU.UTF-8");
    let out = output(command).await;
    assert!(out.stderr.is_empty());
    assert!(
        String::from_utf8(out.stdout)
            .unwrap()
            .starts_with("Daemon is not running\n")
    );
}

#[tokio::test]
async fn config_exact_one_mib_is_accepted() {
    let f = Fixture::new();
    let mut config = br#"{"language":"ru"}"#.to_vec();
    config.resize(1024 * 1024, b' ');
    f.write("config.json", &config);
    offline(&output(f.command(&["daemon", "status", "--json"])).await);
}

#[tokio::test]
async fn shared_wait_and_event_owner_transports_reject_fifo_without_hanging() {
    let f = Fixture::new();
    f.fifo("run/token");
    for args in [
        vec!["agent", "wait", "fixture", "--json"],
        vec!["events", "tail", "--no-follow", "--json"],
    ] {
        let out = output(f.command(&args)).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert!(!out.stderr.is_empty());
    }
}
