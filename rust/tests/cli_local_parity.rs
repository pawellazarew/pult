//! Actual CLI, real scratch log files and one local daemon. No providers/accounts.
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::process::Command;

const WAIT: Duration = Duration::from_secs(12);
const KEYS: [&str; 4] = [
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
];

fn command(args: &[&str]) -> Command {
    let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
    c.args(args)
        .env_remove("PULT_HOME")
        .env_remove("PULT_TEST")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    for key in KEYS {
        c.env_remove(key);
    }
    c
}

async fn output(mut c: Command) -> Output {
    tokio::time::timeout(WAIT, c.output())
        .await
        .expect("CLI must finish without daemon/FIFO hangs")
        .unwrap()
}

fn ok(out: &Output) -> &str {
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    std::str::from_utf8(&out.stdout).unwrap()
}

fn failure(out: &Output, text: &str) {
    assert!(!out.status.success());
    assert!(
        out.stdout.is_empty(),
        "failure must not publish partial logs"
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains(text));
}

struct Logs(tempfile::TempDir);
impl Logs {
    fn new(bytes: &[u8]) -> Self {
        let home = tempfile::Builder::new()
            .prefix("r4l-")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.path().join("logs")).unwrap();
        std::fs::write(home.path().join("logs/pultd.log"), bytes).unwrap();
        Self(home)
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = command(&[]);
        c.arg("--home")
            .arg(self.0.path())
            .args(["daemon", "logs"])
            .args(args);
        c
    }
    fn path(&self) -> std::path::PathBuf {
        self.0.path().join("logs/pultd.log")
    }
}

#[tokio::test]
async fn versions_need_no_home_or_owner_state_even_with_scoped_credentials() {
    let scratch = Logs::new(b"private-log-sentinel\n");
    for form in ["version", "--version", "-v"] {
        let mut c = command(&["--home", "relative-invalid-home", form]);
        for key in KEYS {
            c.env(key, "fixture-only-private-credential");
        }
        assert_eq!(
            ok(&output(c).await),
            concat!(env!("CARGO_PKG_VERSION"), "\n")
        );
        assert_eq!(
            ok(&output(command(&[form])).await),
            concat!(env!("CARGO_PKG_VERSION"), "\n")
        );
    }
    assert_eq!(
        std::fs::read(scratch.path()).unwrap(),
        b"private-log-sentinel\n"
    );
    assert!(!scratch.0.path().join("run").exists());
}

#[tokio::test]
async fn logs_default_tail_filters_js_blank_lines_and_never_starts_daemon() {
    let mut bytes = String::new();
    for n in 0..62 {
        bytes.push_str(&format!("line-{n}\n  \t\r\n\u{feff}\n"));
    }
    let log = Logs::new(bytes.as_bytes());
    let expected: String = (12..62).map(|n| format!("line-{n}\n")).collect();
    assert_eq!(ok(&output(log.command(&[])).await), expected);
    assert!(!log.0.path().join("run").exists());
    assert_eq!(std::fs::read(log.path()).unwrap(), bytes.as_bytes());
}

#[tokio::test]
async fn counts_follow_parseint_and_slice_zero_negative_and_invalid_semantics() {
    let log = Logs::new(b"A\n \nB\nC\nD");
    for (args, expected) in [
        (vec!["-n", "2"], "C\nD\n"),
        (vec!["--lines", "2junk"], "C\nD\n"),
        (vec!["--lines=+2.9"], "C\nD\n"),
        (vec!["--lines", "\u{feff}2tail"], "C\nD\n"),
        (vec!["-n", "0"], "A\nB\nC\nD\n"),
        (vec!["--lines=-2"], "C\nD\n"),
        (vec!["-n", "-2"], "C\nD\n"),
        (vec!["--lines=-99"], "\n"),
        (vec!["--lines", "not-a-number"], "A\nB\nC\nD\n"),
        (vec!["--lines"], "A\nB\nC\nD\n"),
        (vec!["--lines="], "A\nB\nC\nD\n"),
        (vec!["--lines", "4", "-n", "1"], "D\n"),
    ] {
        assert_eq!(ok(&output(log.command(&args)).await), expected, "{args:?}");
    }
    let many = Logs::new(
        (0..60)
            .map(|n| format!("{n}\n"))
            .collect::<String>()
            .as_bytes(),
    );
    let last_50: String = (10..60).map(|n| format!("{n}\n")).collect();
    assert_eq!(ok(&output(many.command(&["-n", "bad"])).await), last_50);
    assert_eq!(
        ok(&output(many.command(&["-n", &"9".repeat(400)])).await),
        last_50
    );
}

#[tokio::test]
async fn utf8_replacement_crlf_and_empty_output_match_ts_text_contract() {
    let log = Logs::new(b"\xef\xbb\xbf\n\r\n\xc2\x85\nhello\r\nbad:\xf0(\x8c(\n");
    assert_eq!(
        ok(&output(log.command(&["-n", "0"])).await),
        "\u{85}\nhello\r\nbad:\u{fffd}(\u{fffd}(\n"
    );
    let empty = Logs::new(b" \n\t\r\n");
    assert_eq!(ok(&output(empty.command(&[])).await), "\n");
    // A multibyte line crossing read-block boundaries must remain complete.
    let wide = format!("prefix\n{}\nlast", "Ж".repeat(40_000));
    std::fs::write(log.path(), &wide).unwrap();
    assert_eq!(
        ok(&output(log.command(&["-n", "2"])).await),
        format!("{}\nlast\n", "Ж".repeat(40_000))
    );
}

#[tokio::test]
async fn scoped_credentials_are_rejected_before_invalid_home_or_private_log_access() {
    let log = Logs::new(b"private-log-sentinel\n");
    for key in KEYS {
        let mut c = command(&["--home", "relative-invalid-home", "daemon", "logs"]);
        c.env(key, "private-credential-sentinel");
        let out = output(c).await;
        failure(
            &out,
            "local daemon logs are unavailable to scoped credentials",
        );
        let error = String::from_utf8_lossy(&out.stderr);
        assert!(!error.contains("--home"));
        assert!(!error.contains("private-credential-sentinel"));
        let mut c = log.command(&[]);
        c.env(key, ""); // Presence, including an empty credential, is enough.
        failure(&output(c).await, "unavailable to scoped credentials");
    }
    assert!(!log.0.path().join("run").exists());
}

#[tokio::test]
async fn unsafe_home_missing_logs_and_unknown_flags_fail_locally() {
    failure(
        &output(command(&["--home", "relative", "daemon", "logs"])).await,
        "--home must be absolute",
    );
    failure(
        &output(command(&["daemon", "logs"])).await,
        "--home is required",
    );
    let log = Logs::new(b"not emitted\n");
    failure(
        &output(log.command(&["--unknown-log-flag"])).await,
        "unexpected argument",
    );
    std::fs::remove_file(log.path()).unwrap();
    failure(
        &output(log.command(&[])).await,
        "local log cannot be opened",
    );
    std::fs::set_permissions(log.0.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    failure(&output(log.command(&[])).await, "directory must be private");
    std::fs::set_permissions(log.0.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut c = log.command(&[]);
    c.env("PULT_HOME", log.0.path());
    failure(&output(c).await, "separate from production Pult");
    assert!(!log.0.path().join("run").exists());
}

#[tokio::test]
async fn symlink_components_and_fifo_are_rejected_without_open_hangs() {
    let log = Logs::new(b"inside\n");
    let outside = Logs::new(b"outside-private-sentinel\n");
    std::fs::remove_file(log.path()).unwrap();
    symlink(outside.path(), log.path()).unwrap();
    failure(
        &output(log.command(&[])).await,
        "local log cannot be opened",
    );
    std::fs::remove_file(log.path()).unwrap();
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(log.path())
            .status()
            .unwrap()
            .success()
    );
    failure(
        &output(log.command(&[])).await,
        "local log must be a regular file",
    );
    std::fs::remove_file(log.path()).unwrap();
    std::fs::remove_dir(log.0.path().join("logs")).unwrap();
    symlink(outside.0.path().join("logs"), log.0.path().join("logs")).unwrap();
    failure(
        &output(log.command(&[])).await,
        "local log directory cannot be opened",
    );
    assert_eq!(
        std::fs::read(outside.path()).unwrap(),
        b"outside-private-sentinel\n"
    );
}

#[tokio::test]
async fn large_file_tail_succeeds_but_scan_and_output_limits_never_publish_partial_data() {
    let log = Logs::new(b"");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(log.path())
        .unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    file.seek(SeekFrom::End(0)).unwrap();
    file.write_all(b"\n").unwrap();
    for n in 0..60 {
        writeln!(file, "tail-{n}").unwrap();
    }
    let expected: String = (10..60).map(|n| format!("tail-{n}\n")).collect();
    assert_eq!(ok(&output(log.command(&[])).await), expected);
    for args in [vec!["-n", "0"], vec!["-n", "-1"], vec!["-n", "999"]] {
        failure(
            &output(log.command(&args)).await,
            "scan exceeds 16 MiB limit",
        );
    }
    file.set_len(0).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file.write_all(&vec![b'x'; 4 * 1024 * 1024]).unwrap();
    failure(
        &output(log.command(&["-n", "1"])).await,
        "output exceeds 4 MiB limit",
    );
}

#[tokio::test]
async fn session_alias_uses_actual_agent_rpc_and_help_preserves_preview_boundary() {
    let log = Logs::new(b"local\n");
    let mut c = command(&[]);
    c.arg("--home")
        .arg(log.0.path())
        .args(["daemon", "serve"])
        .env("PULT_TEST", "1")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut daemon = c.spawn().unwrap();
    tokio::time::timeout(WAIT, async {
        loop {
            if log.0.path().join("run/token").is_file()
                && pult_core::request(log.0.path(), "daemon.status")
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
    let mut implicit = command(&[]);
    implicit.arg("--home").arg(log.0.path());
    let implicit = output(implicit).await;
    assert!(ok(&implicit).starts_with("pultd "));
    let mut explicit = command(&[]);
    explicit
        .arg("--home")
        .arg(log.0.path())
        .args(["daemon", "status", "--json"]);
    let explicit = output(explicit).await;
    let status: serde_json::Value = serde_json::from_str(ok(&explicit)).unwrap();
    assert_eq!(status["pid"].as_u64(), daemon.id().map(u64::from));
    assert_eq!(status["nativeRuntime"]["initialized"], false);
    let mut outputs = Vec::new();
    for verb in ["agent", "session"] {
        let mut c = command(&[]);
        c.arg("--home").arg(log.0.path()).args([verb, "list"]);
        outputs.push(ok(&output(c).await).to_owned());
        let help = output(command(&[verb, "prompt", "--help"])).await;
        let help = ok(&help);
        for flag in ["--queue", "--interrupt", "--steer", "--attachments"] {
            assert!(help.contains(flag));
        }
    }
    assert_eq!(outputs[0], outputs[1]);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&outputs[0]).unwrap()["sessions"],
        serde_json::json!([])
    );
    pult_core::request(log.0.path(), "daemon.stop")
        .await
        .unwrap();
    tokio::time::timeout(WAIT, daemon.wait())
        .await
        .unwrap()
        .unwrap();
    let help = output(command(&["--help"])).await;
    assert!(ok(&help).contains("production cutover are not enabled"));
}
