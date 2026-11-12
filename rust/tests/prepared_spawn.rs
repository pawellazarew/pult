//! Real holder fixtures, no provider/account/network. Host seals are deliberately
//! test-owned: an ordinary preflight callback is not a cancellation seal.
use pult_core::worker_process::{
    Framing, Launch, Process, SpawnDenied, SpawnGate, SpawnPermit, StderrPolicy, StderrUnavailable,
};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::Notify;

const WATCHDOG: Duration = Duration::from_secs(12);
fn launch(home: &Path, mode: &str) -> Launch {
    Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: "/usr/bin/python3".into(),
        args: vec![
            "-B".into(),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/process_worker.py")
                .into_os_string(),
            mode.into(),
            home.as_os_str().to_owned(),
        ],
        cwd: home.into(),
        env: BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.as_os_str().to_owned()),
        ]),
    }
}
#[derive(Default)]
struct Flags {
    cancelled: bool,
    failed: bool,
}
struct Permit<'a> {
    _guard: MutexGuard<'a, Flags>,
}
impl SpawnPermit for Permit<'_> {}
struct Gate(Mutex<Flags>);
impl SpawnGate for Gate {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        let guard = self.0.lock().map_err(|_| SpawnDenied)?;
        if guard.cancelled || guard.failed {
            return Err(SpawnDenied);
        }
        Ok(Box::new(Permit { _guard: guard }))
    }
}
struct BeforeSeal {
    entered: Arc<Notify>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    gate: Gate,
}
impl SpawnGate for BeforeSeal {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        self.entered.notify_one();
        self.release.lock().unwrap().recv_timeout(WATCHDOG).unwrap();
        self.gate.enter()
    }
}
async fn stopped(process: &mut Process) {
    tokio::time::timeout(WATCHDOG, process.stop())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_or_fault_while_waiting_for_fresh_seal_prevents_actual_spawn() {
    // The same host admission lock publishes either cancellation or fault.
    for fault in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let marker = home.path().join("provider-marker");
        let mut config = launch(home.path(), "touch");
        *config.args.last_mut().unwrap() = marker.as_os_str().to_owned();
        let prepared = Process::prepare_launch(config, Framing::strict(), StderrPolicy::CountOnly)
            .await
            .unwrap();
        let (release, receive) = std::sync::mpsc::channel();
        let entered = Arc::new(Notify::new());
        let gate = Arc::new(BeforeSeal {
            entered: entered.clone(),
            release: Mutex::new(receive),
            gate: Gate(Mutex::new(Flags::default())),
        });
        let checking = gate.clone();
        let task =
            tokio::spawn(async move { Process::spawn_prepared_owned(prepared, &*checking).await });
        tokio::time::timeout(WATCHDOG, entered.notified())
            .await
            .unwrap();
        {
            let mut flags = gate.gate.0.lock().unwrap();
            if fault {
                flags.failed = true;
            } else {
                flags.cancelled = true;
            }
        }
        release.send(()).unwrap();
        let failure = tokio::time::timeout(WATCHDOG, task)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap();
        assert!(failure.process.is_none());
        assert!(!marker.exists());
    }
}

struct PanicGate;
impl SpawnGate for PanicGate {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        panic!("PRIVATE_GATE_PANIC");
    }
}
#[tokio::test]
async fn gate_panic_is_static_denial_without_pid() {
    pult_core::panic_guard::install();
    let home = tempfile::tempdir().unwrap();
    let prepared = Process::prepare_launch(
        launch(home.path(), "echo"),
        Framing::strict(),
        StderrPolicy::CountOnly,
    )
    .await
    .unwrap();
    let failure = Process::spawn_prepared_owned(prepared, &PanicGate)
        .await
        .err()
        .unwrap();
    assert!(failure.process.is_none());
    assert!(!format!("{failure:?}").contains("PRIVATE_GATE_PANIC"));
}
struct PanicPermit;
impl SpawnPermit for PanicPermit {}
impl Drop for PanicPermit {
    fn drop(&mut self) {
        panic!("PRIVATE_RELEASE_PANIC");
    }
}
struct ReleasePanic;
impl SpawnGate for ReleasePanic {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        Ok(Box::new(PanicPermit))
    }
}
#[tokio::test]
async fn release_panic_after_os_spawn_retains_pid_until_confirmed_cleanup() {
    pult_core::panic_guard::install();
    let home = tempfile::tempdir().unwrap();
    let prepared = Process::prepare_launch(
        launch(home.path(), "echo"),
        Framing::strict(),
        StderrPolicy::CountOnly,
    )
    .await
    .unwrap();
    let failure = Process::spawn_prepared_owned(prepared, &ReleasePanic)
        .await
        .err()
        .unwrap();
    assert!(!format!("{failure:?}").contains("PRIVATE_RELEASE_PANIC"));
    let mut process = *failure
        .process
        .expect("post-spawn failure lost its PID owner");
    assert!(process.pid().is_some());
    let signal = process.stop_signal();
    stopped(&mut process).await;
    assert!(
        !signal.request_stop(),
        "cleanup did not invalidate the PID signal"
    );
}

#[tokio::test]
async fn private_tail_is_bounded_exact_and_independent_from_stdout() {
    let home = tempfile::tempdir().unwrap();
    let gate = Gate(Mutex::new(Flags::default()));
    let prepared = Process::prepare_launch(
        launch(home.path(), "stderr"),
        Framing::strict(),
        StderrPolicy::PrivateTail { max_bytes: 37 },
    )
    .await
    .unwrap();
    assert!(!format!("{prepared:?}").contains(&home.path().to_string_lossy().to_string()));
    let mut process = Process::spawn_prepared_owned(prepared, &gate)
        .await
        .unwrap();
    assert_eq!(
        process.take_private_stderr().err(),
        Some(StderrUnavailable::Incomplete)
    );
    let frame = tokio::time::timeout(WATCHDOG, process.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(frame, serde_json::json!({"ready":true}));
    let exit = tokio::time::timeout(WATCHDOG, process.stop())
        .await
        .unwrap()
        .unwrap();
    let bytes = "PULT_PRIVATE_STDERR_8d413f\n".repeat(8192).into_bytes();
    assert_eq!(exit.stderr_bytes, bytes.len() as u64);
    let tail = process.take_private_stderr().unwrap();
    assert_eq!(tail.as_bytes(), &bytes[bytes.len() - 37..]);
    assert!(!format!("{tail:?}").contains("PULT_PRIVATE_STDERR"));
    assert_eq!(
        process.take_private_stderr().err(),
        Some(StderrUnavailable::Taken)
    );
}

#[tokio::test]
async fn invalid_capture_policy_and_failed_validation_never_reach_gate() {
    let home = tempfile::tempdir().unwrap();
    for max_bytes in [0, 65537, usize::MAX] {
        let failure = Process::prepare_launch(
            launch(home.path(), "echo"),
            Framing::strict(),
            StderrPolicy::PrivateTail { max_bytes },
        )
        .await
        .err()
        .unwrap();
        assert!(failure.process.is_none());
    }
    let mut invalid = launch(home.path(), "echo");
    invalid.program = home.path().join("missing-private-program");
    let failure = Process::prepare_launch(invalid, Framing::strict(), StderrPolicy::CountOnly)
        .await
        .err()
        .unwrap();
    assert!(failure.process.is_none());
}

#[tokio::test]
async fn default_count_only_exposes_no_private_receipt() {
    let home = tempfile::tempdir().unwrap();
    let mut process = Process::spawn(launch(home.path(), "stderr")).await.unwrap();
    let _ = tokio::time::timeout(WATCHDOG, process.recv())
        .await
        .unwrap()
        .unwrap();
    stopped(&mut process).await;
    assert_eq!(
        process.take_private_stderr().err(),
        Some(StderrUnavailable::Disabled)
    );
}

struct Sealed<'a> {
    _permit: Box<dyn SpawnPermit + 'a>,
    spawned: Arc<Notify>,
    release: &'a Mutex<std::sync::mpsc::Receiver<()>>,
}
impl SpawnPermit for Sealed<'_> {}
impl Drop for Sealed<'_> {
    fn drop(&mut self) {
        self.spawned.notify_one();
        self.release.lock().unwrap().recv_timeout(WATCHDOG).unwrap();
    }
}
struct AfterSeal {
    gate: Gate,
    spawned: Arc<Notify>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}
impl SpawnGate for AfterSeal {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        Ok(Box::new(Sealed {
            _permit: self.gate.enter()?,
            spawned: self.spawned.clone(),
            release: &self.release,
        }))
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_after_seal_keeps_spawn_owned_and_joins_readers() {
    let home = tempfile::tempdir().unwrap();
    let prepared = Process::prepare_launch(
        launch(home.path(), "echo"),
        Framing::strict(),
        StderrPolicy::PrivateTail { max_bytes: 32 },
    )
    .await
    .unwrap();
    let spawned = Arc::new(Notify::new());
    let (release, receive) = std::sync::mpsc::channel();
    let gate = Arc::new(AfterSeal {
        gate: Gate(Mutex::new(Flags::default())),
        spawned: spawned.clone(),
        release: Mutex::new(receive),
    });
    let checking = gate.clone();
    let task =
        tokio::spawn(async move { Process::spawn_prepared_owned(prepared, &*checking).await });
    tokio::time::timeout(WATCHDOG, spawned.notified())
        .await
        .unwrap();
    assert!(
        matches!(
            gate.gate.0.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ),
        "seal was released before actual spawn"
    );
    release.send(()).unwrap();
    // Publish cancellation immediately after the linearization boundary. This
    // cannot deny the already sealed spawn: the returned PID must be retained.
    gate.gate.0.lock().unwrap().cancelled = true;
    let mut process = tokio::time::timeout(WATCHDOG, task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_or_else(|_| panic!("sealed launch failed"));
    assert!(process.pid().is_some());
    let signal = process.stop_signal();
    stopped(&mut process).await;
    assert!(!signal.request_stop());
    assert!(
        process.take_private_stderr().is_ok(),
        "stderr EOF/readers were not joined after cancellation"
    );
}

#[tokio::test]
async fn prepared_holder_ack_failure_retains_process_and_denies_stderr_receipt() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let mut config = launch(home.path(), "echo");
    let holder = home.path().join("bad-holder");
    std::fs::write(
        &holder,
        "#!/bin/sh\nprintf 'invalid acknowledgement\\n'\nexit 125\n",
    )
    .unwrap();
    std::fs::set_permissions(&holder, std::fs::Permissions::from_mode(0o700)).unwrap();
    config.holder = holder;
    let prepared = Process::prepare_launch(
        config,
        Framing::strict(),
        StderrPolicy::PrivateTail { max_bytes: 16 },
    )
    .await
    .unwrap();
    let gate = Gate(Mutex::new(Flags::default()));
    let failure = Process::spawn_prepared_owned(prepared, &gate)
        .await
        .err()
        .unwrap();
    let mut process = *failure.process.expect("ACK failure lost OS child owner");
    assert!(process.pid().is_some());
    assert!(
        process.stop().await.is_err(),
        "unconfirmed holder cleanup was accepted"
    );
    assert_eq!(
        process.take_private_stderr().err(),
        Some(StderrUnavailable::Incomplete)
    );
}
