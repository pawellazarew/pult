use pult_r1::{Journal, MAX_LINE, Process, decode};
use serde_json::json;
use std::io::Write;
use std::time::Duration;

#[test]
fn acknowledged_records_survive_reopen_and_only_torn_tail_is_discarded() {
    let dir = private_home();
    {
        let mut journal = Journal::open(dir.path()).unwrap();
        assert_eq!(
            journal.append("message", json!({"text":"Привет"})).unwrap(),
            1
        );
        assert!(
            Journal::open(dir.path()).is_err(),
            "second writer must be refused"
        );
    }
    let path = dir.path().join("r1.ndjson");
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"sequence\":2,")
        .unwrap();
    let mut recovered = Journal::open(dir.path()).unwrap();
    assert_eq!(recovered.records().unwrap().len(), 1);
    assert_eq!(recovered.append("next", json!({})).unwrap(), 2);
    drop(recovered);
    assert_eq!(
        Journal::open(dir.path()).unwrap().records().unwrap().len(),
        2
    );
    std::fs::write(&path, b"{not valid}\n").unwrap();
    assert!(
        Journal::open(dir.path()).is_err(),
        "complete corrupt records must not be silently discarded"
    );
}

#[test]
fn sequence_gaps_are_rejected() {
    assert!(decode(b"{\"sequence\":2,\"kind\":\"x\",\"data\":{}}\n").is_err());
}

#[test]
fn journal_requires_private_home_and_creates_private_files() {
    use std::os::unix::fs::PermissionsExt;
    let parent = private_home();
    let home = parent.path().join("scratch");
    drop(Journal::open(&home).unwrap());
    for (path, expected) in [
        (home.clone(), 0o700),
        (home.join("r1.ndjson"), 0o600),
        (home.join("r1.lock"), 0o600),
    ] {
        assert_eq!(
            path.metadata().unwrap().permissions().mode() & 0o777,
            expected
        );
    }
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Journal::open(&home).is_err());
    assert_eq!(
        home.metadata().unwrap().permissions().mode() & 0o777,
        0o755,
        "existing directory is not silently chmodded"
    );
}

#[tokio::test]
async fn sigterm_stops_and_reaps_the_running_child() {
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::process::Command;
    let dir = private_home();
    let mut daemon = Command::new(env!("CARGO_BIN_EXE_pult-r1"))
        .arg("--home")
        .arg(dir.path())
        .arg("serve")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = daemon.stdin.take().unwrap();
    let request =
        json!({"method":"start","program":"/bin/sh","args":["-c","sleep 30"],"cwd":dir.path()});
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let bytes = pult_r1::bounded_line(&mut BufReader::new(daemon.stdout.take().unwrap()))
        .await
        .unwrap()
        .unwrap();
    let acknowledgement: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let child_pid = acknowledgement["started"].as_u64().unwrap();
    assert!(
        Command::new("/bin/kill")
            .args(["-TERM", &daemon.id().unwrap().to_string()])
            .status()
            .await
            .unwrap()
            .success()
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(5), daemon.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    let probe = Command::new("/bin/kill")
        .args(["-0", &child_pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(
        !probe.success(),
        "direct provider child survived graceful termination"
    );
    assert_eq!(
        Journal::open(dir.path())
            .unwrap()
            .records()
            .unwrap()
            .last()
            .unwrap()
            .kind,
        "session.stopped"
    );
}

#[tokio::test]
async fn one_hundred_process_start_record_stop_replay_cycles() {
    let dir = private_home();
    for cycle in 0..100 {
        let mut journal = Journal::open(dir.path()).unwrap();
        let mut process = Process::spawn(
            "/bin/sh",
            &["-c".into(), "printf '{\"ok\":true}\\n'; sleep 30".into()],
            dir.path(),
        )
        .unwrap();
        let pid = process.pid().unwrap();
        journal
            .append("session.started", json!({"cycle":cycle,"pid":pid}))
            .unwrap();
        let value = tokio::time::timeout(Duration::from_secs(3), process.output.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(value, json!({"ok":true}));
        journal.append("provider.message", value).unwrap();
        journal
            .append("session.stopped", process.stop().await.unwrap())
            .unwrap();
        assert!(process.pid().is_none(), "direct child was not reaped");
        assert_eq!(journal.records().unwrap().len(), (cycle + 1) * 3);
    }
}

#[tokio::test]
async fn stderr_flood_is_drained_and_oversized_stdout_is_rejected() {
    let dir = private_home();
    let script =
        "import os,time; os.write(2,b'x'*2000000); os.write(1,b'x'*1100000); time.sleep(30)";
    let mut process = Process::spawn("python3", &["-c".into(), script.into()], dir.path()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), process.output.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(result.unwrap_err().to_string().contains("exceeds"));
    let stopped = process.stop().await.unwrap();
    assert_eq!(stopped["stderrBytes"], 2_000_000);
}

#[tokio::test]
async fn stopped_session_is_reaped_when_stdout_consumer_is_backed_up() {
    let dir = private_home();
    let script = "import os; line=b'{\"ok\":true}\\n'; [(os.write(1,line)) for _ in range(100000)]";
    let mut process = Process::spawn("python3", &["-c".into(), script.into()], dir.path()).unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    process.stop().await.unwrap();
    assert!(process.pid().is_none());
}

#[tokio::test]
async fn bounded_input_preserves_partial_unicode_frames() {
    let (mut sender, receiver) = tokio::io::duplex(32);
    let writer = tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        for byte in "{\"text\":\"Привет\"}\n".as_bytes() {
            sender.write_all(&[*byte]).await.unwrap();
        }
    });
    let mut reader = tokio::io::BufReader::new(receiver);
    let bytes = pult_r1::bounded_line(&mut reader).await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        json!({"text":"Привет"})
    );
    writer.await.unwrap();
    let oversized = vec![b'x'; MAX_LINE + 1];
    assert!(
        pult_r1::bounded_line(&mut tokio::io::BufReader::new(&oversized[..]))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn acknowledged_start_survives_sigkill_and_restart_marks_interruption() {
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::process::Command;
    let dir = private_home();
    let bin = env!("CARGO_BIN_EXE_pult-r1");
    let mut daemon = Command::new(bin)
        .arg("--home")
        .arg(dir.path())
        .arg("serve")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = daemon.stdin.take().unwrap();
    let request =
        json!({"method":"start","program":"/bin/sh","args":["-c","sleep 30"],"cwd":dir.path()});
    stdin
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let mut stdout = BufReader::new(daemon.stdout.take().unwrap());
    let bytes = tokio::time::timeout(Duration::from_secs(5), pult_r1::bounded_line(&mut stdout))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let acknowledgement: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(acknowledgement["acknowledged"], 1);
    let provider_pid = acknowledgement["started"].as_u64().unwrap();
    daemon.kill().await.unwrap();
    // SIGKILL orphan cleanup is an explicit prototype limitation, not an asserted guarantee.
    Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{provider_pid}")])
        .status()
        .await
        .unwrap();
    let mut restarted = Command::new(bin)
        .arg("--home")
        .arg(dir.path())
        .arg("serve")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    restarted
        .stdin
        .take()
        .unwrap()
        .write_all(b"{\"method\":\"quit\"}\n")
        .await
        .unwrap();
    assert!(restarted.wait().await.unwrap().success());
    let records = Journal::open(dir.path()).unwrap().records().unwrap();
    assert_eq!(records[0].kind, "session.started");
    assert_eq!(records[1].kind, "session.interrupted");
}

fn private_home() -> tempfile::TempDir {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    home
}

#[tokio::test]
async fn quit_and_broken_stdout_clean_up_without_waiting_for_stdin_eof() {
    use tokio::io::{AsyncWriteExt, BufReader};
    use tokio::process::Command;
    for broken_stdout in [false, true] {
        let dir = private_home();
        let mut daemon = Command::new(env!("CARGO_BIN_EXE_pult-r1"))
            .arg("--home")
            .arg(dir.path())
            .arg("serve")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = daemon.stdin.take().unwrap();
        let request = json!({"method":"start","program":"/bin/sh","args":["-c","sleep 0.2; printf '{\"ok\":true}\\n'; sleep 30"],"cwd":dir.path()});
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let mut stdout = BufReader::new(daemon.stdout.take().unwrap());
        let bytes = pult_r1::bounded_line(&mut stdout).await.unwrap().unwrap();
        let acknowledgement: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let child_pid = acknowledgement["started"].as_u64().unwrap();
        if broken_stdout {
            drop(stdout);
        } else {
            stdin.write_all(b"{\"method\":\"quit\"}\n").await.unwrap();
        }
        // Keep daemon.stdin open until the process has exited.
        let status = tokio::time::timeout(Duration::from_secs(5), daemon.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.success(), !broken_stdout);
        let probe = Command::new("/bin/kill")
            .args(["-0", &child_pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .unwrap();
        assert!(
            !probe.success(),
            "provider survived control transport shutdown"
        );
        assert_eq!(
            Journal::open(dir.path())
                .unwrap()
                .records()
                .unwrap()
                .last()
                .unwrap()
                .kind,
            "session.stopped"
        );
    }
}
