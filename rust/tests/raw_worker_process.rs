//! Actual holder and synthetic byte protocol. No provider/account/config access.
use pult_core::worker_process::{Framing, Launch, Process, RawFrame};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    path::{Path, PathBuf},
    task::Poll,
    time::Duration,
};

const MAX: usize = 16 * 1024 * 1024;
const WATCHDOG: Duration = Duration::from_secs(15);
const SECRET: &str = "PRIVATE_RAW_FRAME_FIXTURE";
fn framing() -> Framing {
    Framing::raw_ndjson(MAX, MAX).unwrap()
}
fn launch(home: &Path, mode: &str, size: Option<usize>) -> Launch {
    let python = [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
    .unwrap();
    let mut args = vec![
        "-B".into(),
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/raw_process_worker.py")
            .into_os_string(),
        mode.into(),
        home.as_os_str().to_owned(),
    ];
    if let Some(size) = size {
        args.push(size.to_string().into());
    }
    Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: python,
        args,
        cwd: home.to_owned(),
        env: BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), home.as_os_str().to_owned()),
        ]),
    }
}
async fn spawn(home: &Path, mode: &str, size: Option<usize>, profile: Framing) -> Process {
    tokio::time::timeout(
        WATCHDOG,
        Process::spawn_with_framing(launch(home, mode, size), profile),
    )
    .await
    .expect("raw fixture startup watchdog")
    .expect("raw fixture startup")
}
async fn recv(process: &mut Process) -> RawFrame {
    tokio::time::timeout(WATCHDOG, process.recv_raw())
        .await
        .expect("raw receive watchdog")
        .expect("raw framing")
        .expect("raw fixture EOF")
}
async fn stop(process: &mut Process) {
    tokio::time::timeout(WATCHDOG, process.stop())
        .await
        .expect("raw cleanup watchdog")
        .expect("raw confirmed cleanup");
}
fn gone(pid: u32) -> bool {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    state.trim().is_empty() || state.trim_start().starts_with('Z')
}

#[tokio::test]
async fn duplicate_keys_malformed_json_and_non_utf8_reach_the_codec_unchanged() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "exact", None, framing()).await;
    assert_eq!(
        recv(&mut process).await.as_bytes(),
        b"{\"id\":1,\"result\":{},\"result\":{\"private\":\"PRIVATE_RAW_FRAME_FIXTURE\"}}\r\n"
    );
    assert_eq!(
        recv(&mut process).await.as_bytes(),
        b"{\"private\":\"PRIVATE_RAW_FRAME_FIXTURE\", broken\n"
    );
    assert_eq!(
        recv(&mut process).await.as_bytes(),
        b"{\"invalidUtf8\":\"\xff\"}\n"
    );
    assert_eq!(process.discarded_frames(), 0);
    stop(&mut process).await;
}

#[tokio::test]
async fn fragmented_crlf_and_lf_are_distinct_exact_frames() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "fragmented", None, framing()).await;
    assert_eq!(
        recv(&mut process).await.as_bytes(),
        "{\"text\":\"Пульт 🌊\"}\r\n".as_bytes()
    );
    assert_eq!(recv(&mut process).await.as_bytes(), b"{}\n");
    assert!(process.recv_raw().await.unwrap().is_none());
    stop(&mut process).await;
    assert!(process.output_finished_cleanly());
}

#[tokio::test]
async fn large_native_frame_and_exact_sixteen_mib_boundary_preserve_the_tail() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "sized", Some(MAX), framing()).await;
    let frame = recv(&mut process).await;
    assert_eq!(frame.as_bytes().len(), MAX);
    assert!(frame.as_bytes().starts_with(b"{\"payload\":\""));
    assert!(frame.as_bytes().ends_with(b"\"}\n"));
    drop(frame);
    assert_eq!(recv(&mut process).await.as_bytes(), b"{\"tail\":true}\n");
    stop(&mut process).await;
}

#[tokio::test]
async fn oversize_is_terminal_and_never_resynchronizes_to_a_valid_tail() {
    let home = tempfile::tempdir().unwrap();
    let profile = Framing::raw_ndjson(1024 * 1024 + 1, 1024).unwrap();
    let mut process = spawn(home.path(), "sized", Some(1024 * 1024 + 2), profile).await;
    let failure = process
        .recv_raw()
        .await
        .err()
        .expect("oversized raw frame accepted");
    assert!(!format!("{failure:#}").contains(SECRET));
    assert!(process.recv_raw().await.unwrap().is_none());
    assert_eq!(process.discarded_frames(), 0);
    stop(&mut process).await;
    assert!(!process.output_finished_cleanly());
}

#[tokio::test]
async fn unterminated_json_never_counts_as_a_frame_or_normal_eof() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "truncated", None, framing()).await;
    let failure = process
        .recv_raw()
        .await
        .err()
        .expect("unterminated frame accepted");
    assert!(!format!("{failure:#}").contains(SECRET));
    assert!(process.recv_raw().await.unwrap().is_none());
    stop(&mut process).await;
    assert!(!process.output_finished_cleanly());
}

#[tokio::test]
async fn wrong_profile_access_never_consumes_or_transfers_and_transfer_is_single_use() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "echo", None, framing()).await;
    assert!(process.take_output().is_err());
    assert!(process.recv().await.is_err());
    process
        .send_prepared(
            framing()
                .prepare_raw(b"{\"first\":true}\r\n".to_vec())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(recv(&mut process).await.as_bytes(), b"{\"first\":true}\r\n");
    let mut output = process.take_raw_output().unwrap();
    assert!(process.take_raw_output().is_err());
    assert!(process.recv_raw().await.is_err());
    process
        .send_prepared(
            framing()
                .prepare_raw(b"{\"second\":true}\n".to_vec())
                .unwrap(),
        )
        .await
        .unwrap();
    let frame = output.recv().await.unwrap().unwrap();
    assert_eq!(frame.as_bytes(), b"{\"second\":true}\n");
    drop(output);
    stop(&mut process).await;

    let mut json_process = spawn(home.path(), "echo", None, Framing::strict()).await;
    assert!(json_process.take_raw_output().is_err());
    assert!(json_process.recv_raw().await.is_err());
    json_process.send(&json!({"ok":true})).await.unwrap();
    assert_eq!(json_process.recv().await.unwrap(), Some(json!({"ok":true})));
    let mut output = json_process.take_output().unwrap();
    assert!(json_process.take_output().is_err());
    assert!(json_process.recv().await.is_err());
    json_process.send(&json!({"again":true})).await.unwrap();
    assert_eq!(output.recv().await.unwrap().unwrap(), json!({"again":true}));
    drop(output);
    stop(&mut json_process).await;
}

#[test]
fn raw_profile_and_preparation_are_bounded_pure_and_do_not_reflect_payloads() {
    for (wire, input) in [(0, 1), (1, 0), (MAX + 1, 1), (1, MAX + 1)] {
        assert!(Framing::raw_ndjson(wire, input).is_err());
    }
    assert!(Framing::strict().prepare_raw(b"{}\n".to_vec()).is_err());
    assert!(framing().encode(&json!({"private":SECRET})).is_err());
    for raw in [
        b"".to_vec(),
        b"{}".to_vec(),
        b"{}\n{}\n".to_vec(),
        b"\n".to_vec(),
        b"{\"private\":\"PRIVATE_RAW_FRAME_FIXTURE\", broken\n".to_vec(),
        b"{\"bad\":\"\xff\"}\n".to_vec(),
        b"{}\r{}\n".to_vec(),
        b"{} garbage\n".to_vec(),
    ] {
        let error = framing()
            .prepare_raw(raw)
            .expect_err("invalid raw request accepted");
        assert!(!format!("{error:#}").contains(SECRET));
    }
    let small = Framing::raw_ndjson(16, 4).unwrap();
    assert!(small.prepare_raw(b"{}\r\n".to_vec()).is_ok());
    assert!(small.prepare_raw(b"{} \r\n".to_vec()).is_err());
    let prepared = framing()
        .prepare_raw(format!("{{\"private\":\"{SECRET}\"}}\n").into_bytes())
        .unwrap();
    let debug = format!("{prepared:?}");
    assert!(debug.contains("bytes") && !debug.contains(SECRET));
}

#[tokio::test]
async fn prepared_inputs_cannot_cross_output_profiles_or_widen_raw_input_limit() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(
        home.path(),
        "echo",
        None,
        Framing::raw_ndjson(1024, 4).unwrap(),
    )
    .await;
    assert!(
        process
            .send_prepared(Framing::strict().encode(&json!({})).unwrap())
            .await
            .is_err()
    );
    assert!(process.send(&json!({})).await.is_err());
    assert!(
        process
            .send_prepared(
                framing()
                    .prepare_raw(b"{\"widen\":true}\n".to_vec())
                    .unwrap()
            )
            .await
            .is_err()
    );
    process
        .send_prepared(framing().prepare_raw(b"{}\r\n".to_vec()).unwrap())
        .await
        .unwrap();
    assert_eq!(recv(&mut process).await.as_bytes(), b"{}\r\n");
    stop(&mut process).await;
    let mut process = spawn(home.path(), "echo", None, Framing::strict()).await;
    assert!(
        process
            .send_prepared(framing().prepare_raw(b"{}\n".to_vec()).unwrap())
            .await
            .is_err()
    );
    process.send(&json!({"ok":true})).await.unwrap();
    assert_eq!(process.recv().await.unwrap(), Some(json!({"ok":true})));
    stop(&mut process).await;
}

#[tokio::test]
async fn natural_eof_requires_real_reader_join_and_preserves_exit_status() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "natural", None, framing()).await;
    assert_eq!(recv(&mut process).await.as_bytes(), b"{\"one\":1}\n");
    assert_eq!(recv(&mut process).await.as_bytes(), b"{\"two\":2}\r\n");
    assert!(process.recv_raw().await.unwrap().is_none());
    assert!(!process.output_finished_cleanly());
    let exit = process.stop().await.unwrap();
    assert_eq!(exit.code, Some(7));
    assert!(process.output_finished_cleanly());
}

#[tokio::test]
async fn cancelled_first_write_retains_process_poisoned_input_and_descendant_cleanup() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "blocked-input-tree", None, framing()).await;
    let pids: Value = serde_json::from_slice(recv(&mut process).await.as_bytes()).unwrap();
    let provider = pids["provider"].as_u64().unwrap() as u32;
    let descendant = pids["descendant"].as_u64().unwrap() as u32;
    let signal = process.stop_signal();
    let original_pid = process.pid();
    let bytes = format!("{{\"payload\":\"{}\"}}\n", "x".repeat(2 * 1024 * 1024)).into_bytes();
    let frame = framing().prepare_raw(bytes).unwrap();
    let mut send = Box::pin(process.send_prepared(frame));
    let first = std::future::poll_fn(|cx| Poll::Ready(send.as_mut().poll(cx))).await;
    assert!(
        matches!(first, Poll::Pending),
        "fixture write did not block"
    );
    drop(send);
    assert_eq!(process.pid(), original_pid);
    assert!(!gone(provider));
    assert!(
        process
            .send_prepared(framing().prepare_raw(b"{}\n".to_vec()).unwrap())
            .await
            .is_err()
    );
    stop(&mut process).await;
    assert!(!signal.request_stop());
    let deadline = tokio::time::Instant::now() + WATCHDOG;
    while !gone(provider) || !gone(descendant) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "raw fixture tree survived confirmed cleanup"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn first_write_poll_panic_retains_the_borrowed_process_until_explicit_cleanup() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "blocked-input-tree", None, framing()).await;
    let pids: Value = serde_json::from_slice(recv(&mut process).await.as_bytes()).unwrap();
    let provider = pids["provider"].as_u64().unwrap() as u32;
    let descendant = pids["descendant"].as_u64().unwrap() as u32;
    let original_pid = process.pid();
    let frame = framing()
        .prepare_raw(format!("{{\"payload\":\"{}\"}}\n", "x".repeat(2 * 1024 * 1024)).into_bytes())
        .unwrap();
    let mut send = Box::pin(process.send_prepared(frame));
    pult_core::panic_guard::install();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let first = send
            .as_mut()
            .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
        assert!(
            matches!(first, Poll::Pending),
            "fixture write did not block"
        );
        panic!("synthetic raw writer wrapper panic after first pending poll");
    }));
    assert!(outcome.is_err());
    drop(send);
    assert_eq!(process.pid(), original_pid);
    assert!(!gone(provider));
    assert!(
        process
            .send_prepared(framing().prepare_raw(b"{}\n".to_vec()).unwrap())
            .await
            .is_err()
    );
    stop(&mut process).await;
    let deadline = tokio::time::Instant::now() + WATCHDOG;
    while !gone(provider) || !gone(descendant) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "raw fixture tree survived joined cleanup"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn stop_with_a_transferred_unconsumed_receiver_never_claims_normal_stdout_eof() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "saturated", None, framing()).await;
    let output = process.take_raw_output().unwrap();
    let deadline = tokio::time::Instant::now() + WATCHDOG;
    while !home.path().join("raw-written").is_file() || output.len() != 1 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "fixture did not saturate the raw channel"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    stop(&mut process).await;
    assert!(!process.output_finished_cleanly());
    drop(output);
}
