//! Real processes and process groups. Fixtures do not call a provider or use an
//! account; a separate child test process is the owner in SIGKILL scenarios.
use pult_core::worker_process::{Launch, Process};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::task::{Context, Poll, Waker};
use std::time::Duration;
use tokio::process::Command;

const SECRET: &str = "PULT_PRIVATE_STDERR_8d413f";
const CHILD_MODE: &str = "PULT_WORKER_PROCESS_TEST_MODE";
const CHILD_HOME: &str = "PULT_WORKER_PROCESS_TEST_HOME";
const DEADLINE: Duration = Duration::from_secs(12);

fn python() -> PathBuf {
    let primary = PathBuf::from("/usr/bin/python3");
    if primary.is_file() {
        return primary;
    }
    let found = std::process::Command::new("/usr/bin/which")
        .arg("python3")
        .output()
        .unwrap();
    assert!(
        found.status.success(),
        "Python 3 fixture runtime unavailable"
    );
    PathBuf::from(String::from_utf8(found.stdout).unwrap().trim())
}
fn launch(home: &Path, mode: &str) -> Launch {
    Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: python(),
        args: vec![
            "-B".into(),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/process_worker.py")
                .into_os_string(),
            mode.into(),
            home.as_os_str().to_owned(),
        ],
        cwd: home.to_owned(),
        env: BTreeMap::from([
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), home.as_os_str().to_owned()),
            (OsString::from("LANG"), OsString::from("C.UTF-8")),
        ]),
    }
}
async fn spawn(home: &Path, mode: &str) -> Process {
    tokio::time::timeout(DEADLINE, Process::spawn(launch(home, mode)))
        .await
        .expect("spawn watchdog")
        .expect("fixture process startup")
}
async fn receive(process: &mut Process) -> Value {
    tokio::time::timeout(DEADLINE, process.recv())
        .await
        .expect("receive watchdog")
        .expect("fixture protocol")
        .expect("unexpected fixture EOF")
}
async fn stop(process: &mut Process) -> pult_core::worker_process::Exit {
    tokio::time::timeout(DEADLINE, process.stop())
        .await
        .expect("stop watchdog")
        .expect("confirmed fixture cleanup")
}
fn command_line(pid: u32) -> String {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}
fn running(pid: u32) -> bool {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}
async fn assert_gone(pids: &[u32], marker: &Path) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    loop {
        if pids.iter().all(|pid| !running(*pid)) {
            return;
        }
        if tokio::time::Instant::now() >= deadline {
            // Failure cleanup is not success evidence. Never signal a reused or
            // unrelated PID: every fixture/holder argv contains this unique path.
            for pid in pids {
                if command_line(*pid).contains(marker.to_str().unwrap()) {
                    let _ = nix::sys::signal::kill(
                        nix::unistd::Pid::from_raw(*pid as i32),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                }
            }
            panic!("owned process survived confirmed cleanup");
        }
        // OS exit/reparent/reap state, not an assumed protocol delay.
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
#[cfg(target_os = "linux")]
fn assert_reaped_children(pids: &[u32]) {
    // The holder owns/reaps provider and adopted descendants. Its own orphan
    // may briefly be a zombie under the host init, which is outside this proof.
    for pid in &pids[1..] {
        assert!(
            command_line(*pid).is_empty(),
            "holder left an unreaped child"
        );
    }
}

async fn tree(home: &Path, stubborn: bool) -> (Process, Vec<u32>) {
    let mut config = launch(home, "tree");
    if stubborn {
        config.args.push("stubborn".into());
    }
    let mut process = tokio::time::timeout(DEADLINE, Process::spawn(config))
        .await
        .unwrap()
        .unwrap();
    let row = receive(&mut process).await;
    let pids = vec![
        process.pid().expect("holder pid"),
        row["provider"].as_u64().unwrap() as u32,
        row["descendant"].as_u64().unwrap() as u32,
    ];
    assert!(pids.iter().all(|pid| *pid > 1 && running(*pid)));
    assert_ne!(pids[0], pids[1]);
    assert_ne!(pids[1], pids[2]);
    (process, pids)
}

#[tokio::test]
async fn unicode_roundtrip_and_only_explicit_environment_reach_the_provider() {
    let home = tempfile::tempdir().unwrap();
    let mut config = launch(home.path(), "echo");
    let key = format!("mem_{}", "a".repeat(64));
    config
        .env
        .insert("PULT_MEMORY_KEY".into(), key.clone().into());
    let mut process = Process::spawn(config).await.unwrap();
    let ready = receive(&mut process).await;
    assert_eq!(
        ready,
        json!({"ready":true,"memory":key,"owner_secret":null})
    );
    let request = json!({"text":"Пульт 🌊","nested":[true,7]});
    process.send(&request).await.unwrap();
    assert_eq!(receive(&mut process).await, json!({"echo":request}));
    stop(&mut process).await;
}

#[tokio::test]
async fn natural_exit_drains_all_messages_before_eof_and_keeps_the_exit_code() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "many").await;
    for number in 0..100 {
        assert_eq!(receive(&mut process).await, json!({"number":number}));
    }
    assert!(
        tokio::time::timeout(DEADLINE, process.recv())
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    assert_eq!(stop(&mut process).await.code, Some(7));
}

#[tokio::test]
async fn malformed_json_reports_no_raw_payload_and_still_cleans_the_provider() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "bad-json").await;
    let provider = receive(&mut process).await["provider"].as_u64().unwrap() as u32;
    let error = tokio::time::timeout(DEADLINE, process.recv())
        .await
        .unwrap()
        .unwrap_err();
    assert!(!format!("{error:#}").contains(SECRET));
    let _ = tokio::time::timeout(DEADLINE, process.stop())
        .await
        .unwrap();
    drop(process);
    assert_gone(&[provider], home.path()).await;
}

#[tokio::test]
async fn oversized_output_is_bounded_and_cleanup_does_not_require_a_reader() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "oversize").await;
    let provider = receive(&mut process).await["provider"].as_u64().unwrap() as u32;
    assert!(
        tokio::time::timeout(DEADLINE, process.recv())
            .await
            .unwrap()
            .is_err()
    );
    let _ = tokio::time::timeout(DEADLINE, process.stop())
        .await
        .unwrap();
    drop(process);
    assert_gone(&[provider], home.path()).await;
}

#[tokio::test]
async fn explicit_stop_cleans_cooperative_and_stubborn_process_groups() {
    for stubborn in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let (mut process, pids) = tree(home.path(), stubborn).await;
        stop(&mut process).await;
        assert_gone(&pids, home.path()).await;
        #[cfg(target_os = "linux")]
        assert_reaped_children(&pids);
    }
}

#[tokio::test]
async fn dropped_process_signals_holder_and_cleans_descendants() {
    let home = tempfile::tempdir().unwrap();
    let (process, pids) = tree(home.path(), true).await;
    drop(process);
    assert_gone(&pids, home.path()).await;
}

#[test]
fn owner_process_fixture() {
    let Ok(mode) = std::env::var(CHILD_MODE) else {
        return;
    };
    let home = PathBuf::from(std::env::var_os(CHILD_HOME).unwrap());
    pult_core::panic_guard::install();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        if mode == "stderr" {
            let mut process = spawn(&home, "stderr").await;
            assert_eq!(receive(&mut process).await, json!({"ready":true}));
            let exit = stop(&mut process).await;
            assert!(exit.stderr_bytes > 128 * 1024);
        } else {
            let (process, pids) = tree(&home, mode == "stubborn").await;
            let temporary = home.join("pids.tmp");
            std::fs::write(&temporary, serde_json::to_vec(&pids).unwrap()).unwrap();
            std::fs::rename(temporary, home.join("pids.json")).unwrap();
            std::future::pending::<()>().await;
            drop(process);
        }
    });
}
fn child_owner(home: &Path, mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "owner_process_fixture",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_MODE, mode)
        .env(CHILD_HOME, home)
        .kill_on_drop(true);
    command
}

#[tokio::test]
async fn heavy_private_stderr_is_drained_counted_and_never_forwarded_to_owner_logs() {
    let home = tempfile::tempdir().unwrap();
    let output = tokio::time::timeout(DEADLINE, child_owner(home.path(), "stderr").output())
        .await
        .unwrap()
        .unwrap();
    assert!(output.status.success(), "stderr fixture owner failed");
    assert!(!String::from_utf8_lossy(&output.stdout).contains(SECRET));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(SECRET));
}

#[tokio::test]
async fn sigkill_owner_cleans_provider_and_descendant_without_parent_intervention() {
    for mode in ["cooperative", "stubborn"] {
        let home = tempfile::tempdir().unwrap();
        let mut command = child_owner(home.path(), mode);
        let mut owner = command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = tokio::time::Instant::now() + DEADLINE;
        let evidence = home.path().join("pids.json");
        while !evidence.exists() {
            assert!(
                owner.try_wait().unwrap().is_none(),
                "owner exited before publishing pids"
            );
            assert!(
                tokio::time::Instant::now() < deadline,
                "owner startup watchdog"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pids: Vec<u32> = serde_json::from_slice(&std::fs::read(evidence).unwrap()).unwrap();
        assert_eq!(pids.len(), 3);
        assert!(pids.iter().all(|pid| running(*pid)));
        owner.start_kill().unwrap();
        tokio::time::timeout(DEADLINE, owner.wait())
            .await
            .unwrap()
            .unwrap();
        assert_gone(&pids, home.path()).await;
        #[cfg(target_os = "linux")]
        assert_reaped_children(&pids);
    }
}

#[tokio::test]
async fn missing_program_and_unauthorized_environment_never_acknowledge_launch() {
    let home = tempfile::tempdir().unwrap();
    let mut missing = launch(home.path(), "echo");
    missing.program = home.path().join("missing-program");
    assert!(Process::spawn(missing).await.is_err());
    let mut forbidden = launch(home.path(), "echo");
    forbidden
        .env
        .insert("ANTHROPIC_API_KEY".into(), SECRET.into());
    assert!(Process::spawn(forbidden).await.is_err());
}

#[tokio::test]
async fn holder_does_not_launch_when_its_claimed_owner_is_not_its_parent() {
    let home = tempfile::tempdir().unwrap();
    let marker = home.path().join("should-not-exist");
    let mut config = launch(home.path(), "touch");
    config.args[3] = marker.as_os_str().to_owned();
    let status = tokio::time::timeout(
        DEADLINE,
        Command::new(&config.holder)
            .arg("2147483647")
            .arg(&config.program)
            .args(config.args.drain(..))
            .env_clear()
            .envs(config.env)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!status.success());
    assert!(!marker.exists());
}

#[tokio::test]
async fn cancelling_a_pending_send_poison_closes_input_before_any_retry() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "blocked-input").await;
    let provider = receive(&mut process).await["provider"].as_u64().unwrap() as u32;
    let frame = json!("x".repeat(1024 * 1024 - 1024));
    let mut context = Context::from_waker(Waker::noop());
    let mut write = Box::pin(process.send(&frame));
    assert!(
        write.as_mut().poll(&mut context).is_pending(),
        "fixture input must be blocked before cancellation"
    );
    drop(write);
    let retry = json!({"must_not_be_sent":true});
    let mut second_write = Box::pin(process.send(&retry));
    match second_write.as_mut().poll(&mut context) {
        Poll::Ready(Err(error)) => assert!(
            error.to_string().contains("input is unavailable"),
            "cancelled frame must poison the transport before another write"
        ),
        _ => panic!("cancelled frame permitted another input attempt"),
    }
    drop(second_write);
    stop(&mut process).await;
    assert_gone(&[provider], home.path()).await;
}

#[tokio::test]
async fn cancelling_spawn_before_holder_ready_keeps_the_term_drop_guard() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let holder = home.path().join("stall-holder.sh");
    let pidfile = home.path().join("stall-holder.pid");
    let temporary = home.path().join("stall-holder.pid.tmp");
    let quote = |path: &Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\\''"));
    // The stub has no provider. EOF alone intentionally does not exit it: the
    // cancelled startup future must drop its owned Process and send TERM.
    let script = format!(
        "#!/bin/sh\ntrap 'exit 0' TERM INT\nprintf '%s\\n' \"$$\" > {}\n/bin/mv {} {}\nwhile :; do IFS= read -r ignored || :; done\n",
        quote(&temporary),
        quote(&temporary),
        quote(&pidfile)
    );
    std::fs::write(&holder, script).unwrap();
    std::fs::set_permissions(&holder, std::fs::Permissions::from_mode(0o700)).unwrap();
    let provider_marker = home.path().join("provider-must-not-launch");
    let mut config = launch(home.path(), "touch");
    config.holder = holder;
    config.args[3] = provider_marker.as_os_str().to_owned();
    let task = tokio::spawn(Process::spawn(config));
    let deadline = tokio::time::Instant::now() + DEADLINE;
    while !pidfile.exists() {
        assert!(
            !task.is_finished(),
            "stub startup finished without a ready acknowledgement"
        );
        assert!(
            tokio::time::Instant::now() < deadline,
            "stub startup watchdog"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pid = std::fs::read_to_string(pidfile)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    assert!(pid > 1 && running(pid));
    assert!(command_line(pid).contains(home.path().to_str().unwrap()));
    task.abort();
    let joined = tokio::time::timeout(DEADLINE, task).await.unwrap();
    assert!(joined.is_err_and(|error| error.is_cancelled()));
    assert_gone(&[pid], home.path()).await;
    assert!(!provider_marker.exists());
}

#[tokio::test]
async fn owned_startup_failure_retains_unconfirmed_process_for_quarantine() {
    use pult_core::worker_process::Framing;
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let holder = home.path().join("bad-holder");
    std::fs::write(&holder, "#!/bin/sh\nprintf 'not-json\\n'\nexit 125\n").unwrap();
    std::fs::set_permissions(&holder, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut request = launch(home.path(), "echo");
    request.holder = holder;
    let failure = match Process::spawn_owned(request, Framing::codex()).await {
        Ok(_) => panic!("bad holder acknowledged startup"),
        Err(failure) => failure,
    };
    assert!(format!("{failure:?}").contains("retained_process: true"));
    let mut process = failure
        .process
        .expect("startup must preserve child ownership");
    assert!(process.stop().await.is_err());
    assert!(
        process.stop().await.is_err(),
        "retry cannot turn exit 125 into proof"
    );
    let mut invalid = launch(home.path(), "echo");
    invalid.program = home.path().join("missing");
    let failure = match Process::spawn_owned(invalid, Framing::codex()).await {
        Ok(_) => panic!("missing program accepted"),
        Err(failure) => failure,
    };
    assert!(
        failure.process.is_none(),
        "validation failure created no child"
    );
}
