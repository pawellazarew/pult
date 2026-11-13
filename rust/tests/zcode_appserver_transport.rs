//! Actual holder + fake native process + actual bounded codec/raw bytes.
//! Constructed protocol qualification, not live-provider, memory-MCP, Worker or Driver proof.
use pult_core::worker_process::{Framing, Launch, Process, RawFrame};
use pult_core::zcode_appserver_protocol::{
    self as codec, DeliveryKind, Incoming, OutboundRequest, ProtocolError, RequestId, SessionMode,
    SnapshotMethod, StdioMcpServer, Workspace,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(20);
const SID: &str = "host-reserved-native-sid";
const KEY: &str = "private-zcode-wire-key-fixture";
const PROMPT: &str = "private-zcode-wire-prompt-fixture";

fn id(value: &str) -> RequestId {
    RequestId::string(value).unwrap()
}
fn framing() -> Framing {
    Framing::raw_ndjson(codec::MAX_FRAME_BYTES, codec::MAX_OUTBOUND_FRAME_BYTES).unwrap()
}
fn python() -> PathBuf {
    let primary = PathBuf::from("/usr/bin/python3");
    if primary.is_file() {
        return primary;
    }
    let output = std::process::Command::new("/usr/bin/which")
        .arg("python3")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "Python 3 fixture runtime unavailable"
    );
    PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
}
fn launch(home: &Path, case: &str) -> Launch {
    // Fixture control stays in scratch storage, not the real worker environment allowlist.
    std::fs::write(home.join("zcode-wire-case"), case).unwrap();
    let mut args = vec![
        OsString::from("-B"),
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/zcode_appserver_profile.py")
            .into_os_string(),
    ];
    args.extend(codec::APP_SERVER_ARGV.map(OsString::from));
    let launch = Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: python(),
        args,
        cwd: home.into(),
        env: BTreeMap::from([
            (OsString::from("PATH"), OsString::from("/usr/bin:/bin")),
            (OsString::from("HOME"), home.as_os_str().into()),
            (OsString::from("LANG"), OsString::from("C.UTF-8")),
        ]),
    };
    assert!(!launch.env.contains_key(&OsString::from("PULT_MEMORY_KEY")));
    for value in launch.args.iter().chain(launch.env.values()) {
        let value = value.to_string_lossy();
        assert!(
            !value.contains(KEY) && !value.contains(PROMPT),
            "private fixture data entered launch"
        );
    }
    launch
}
async fn spawn(home: &Path, case: &str) -> Process {
    tokio::time::timeout(
        DEADLINE,
        Process::spawn_with_framing(launch(home, case), framing()),
    )
    .await
    .expect("holder spawn watchdog")
    .expect("holder startup")
}
async fn send(process: &mut Process, request: OutboundRequest) {
    send_bytes(process, request.encode().unwrap()).await;
}
async fn send_bytes(process: &mut Process, bytes: Vec<u8>) {
    let input = framing().prepare_raw(bytes).unwrap();
    tokio::time::timeout(DEADLINE, process.send_prepared(input))
        .await
        .expect("write watchdog")
        .expect("raw transport send");
}
async fn receive(process: &mut Process) -> RawFrame {
    tokio::time::timeout(DEADLINE, process.recv_raw())
        .await
        .expect("raw receive watchdog")
        .expect("raw frame IO")
        .expect("unexpected EOF")
}
async fn create(process: &mut Process, home: &Path) {
    let workspace = Workspace::new(home.to_str().unwrap(), "fixture-workspace").unwrap();
    let helper = StdioMcpServer::new(
        "pult-memory-fixture",
        "/fixture/never-executed-memory-helper",
        home.to_str().unwrap(),
        &["--stdio".into()],
        &[("PULT_MEMORY_KEY".into(), KEY.into())],
    )
    .unwrap();
    send(
        process,
        OutboundRequest::create(id("create-1"), SID, workspace, vec![helper])
            .unwrap()
            .with_mode(SessionMode::Guarded)
            .unwrap(),
    )
    .await;
}
async fn bootstrap(process: &mut Process, home: &Path) {
    create(process, home).await;
    let reverse = receive(process).await;
    match codec::decode_frame(reverse.as_bytes()).unwrap() {
        Incoming::Reverse(request) => send_bytes(process, request.default_deny().unwrap()).await,
        _ => panic!("runtime preferences reverse must precede create reply"),
    }
    let snapshot = receive(process).await;
    match codec::decode_frame(snapshot.as_bytes()).unwrap() {
        Incoming::Response(response) => {
            let ack = response
                .snapshot_ack(&id("create-1"), SID, SnapshotMethod::Create)
                .unwrap();
            assert_eq!(ack.session_mode, SessionMode::Guarded);
            assert_eq!(ack.workspace_path, home.to_str().unwrap());
        }
        _ => panic!("expected create snapshot"),
    }
    send(
        process,
        OutboundRequest::subscribe(
            id("subscribe-1"),
            SID,
            DeliveryKind::DesktopContinuous,
            None,
        )
        .unwrap(),
    )
    .await;
    let subscribe = receive(process).await;
    match codec::decode_frame(subscribe.as_bytes()).unwrap() {
        Incoming::Response(response) => {
            let ack = response.subscribe_ack(&id("subscribe-1"), SID).unwrap();
            assert_eq!(ack.event_seq, 0);
            assert!(ack.untrusted_events().is_empty());
        }
        _ => panic!("expected subscribe ACK"),
    }
}
async fn send_prompt(process: &mut Process) {
    send(
        process,
        OutboundRequest::send(id("send-1"), SID, "host-input-1", "host-query-1", PROMPT).unwrap(),
    )
    .await;
}
fn audit(home: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(home.join("zcode-wire-audit.json")).unwrap()).unwrap()
}
async fn observed_send_barrier(home: &Path) {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(bytes) = std::fs::read(home.join("zcode-wire-audit.json"))
                && let Ok(state) = serde_json::from_slice::<Value>(&bytes)
                && state["send_count"] == 1
                && state["native_stdout_closed"] == true
            {
                return;
            }
            // Observe fixture IO completion; never infer delivery merely from a fixed sleep.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native observed-send audit barrier");
}
fn running(pid: u32) -> bool {
    let result = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&result.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}
async fn stop(process: &mut Process) {
    tokio::time::timeout(DEADLINE, process.stop())
        .await
        .expect("cleanup watchdog")
        .expect("confirmed holder cleanup");
    assert!(process.pid().is_none());
}

#[tokio::test]
async fn actual_holder_bootstrap_accepts_both_native_ack_started_orders_and_keeps_close_separate() {
    for case in ["ack-first", "started-first"] {
        let home = tempfile::tempdir().unwrap();
        let mut process = spawn(home.path(), case).await;
        bootstrap(&mut process, home.path()).await;
        send_prompt(&mut process).await;
        let mut order = Vec::new();
        let mut notifications = 0;
        for _ in 0..3 {
            let frame = receive(&mut process).await;
            match codec::decode_frame(frame.as_bytes()).unwrap() {
                Incoming::Notification(notification) => {
                    assert_eq!(notification.method(), "state.updated");
                    notifications += 1;
                }
                Incoming::Response(response) => {
                    let ack = response.send_ack(&id("send-1"), SID).unwrap();
                    assert_eq!(ack.state_revision, 2);
                    order.push("ack");
                }
                Incoming::TurnStarted(candidate) => {
                    assert_eq!(candidate.session_id, SID);
                    assert_eq!(candidate.turn_id.as_deref(), Some("turn_fixture_1"));
                    assert_eq!(candidate.input_id.as_deref(), Some("host-input-1"));
                    assert_eq!(candidate.query_id.as_deref(), Some("host-query-1"));
                    order.push("started");
                }
                Incoming::Reverse(_) => panic!("unexpected reverse after bootstrap"),
            }
        }
        assert_eq!(notifications, 1);
        assert_eq!(
            order,
            if case == "ack-first" {
                vec!["ack", "started"]
            } else {
                vec!["started", "ack"]
            }
        );
        send(
            &mut process,
            OutboundRequest::close(id("close-1"), SID).unwrap(),
        )
        .await;
        let close = receive(&mut process).await;
        match codec::decode_frame(close.as_bytes()).unwrap() {
            Incoming::Response(response) => assert_eq!(
                response.close_ack(&id("close-1")).unwrap().closed,
                Some(true)
            ),
            _ => panic!("expected native close ACK"),
        }
        let state = audit(home.path());
        assert_eq!(state["create_count"], 1);
        assert_eq!(state["subscribe_count"], 1);
        assert_eq!(state["send_count"], 1);
        assert_eq!(state["close_count"], 1);
        assert_eq!(state["private_mcp_on_stdin"], true);
        assert_eq!(state["private_launch_env_absent"], true);
        assert_eq!(state["argv_profile_exact"], true);
        assert_eq!(state["runtime_preferences_replied"], true);
        assert!(
            running(process.pid().unwrap()),
            "native close ACK became OS cleanup"
        );
        assert!(running(state["pid"].as_u64().unwrap() as u32));
        stop(&mut process).await;
        assert!(!running(state["pid"].as_u64().unwrap() as u32));
    }
}

#[tokio::test]
async fn duplicate_native_ack_survives_raw_receiver_transfer_and_is_rejected_by_actual_codec() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "duplicate-ack").await;
    bootstrap(&mut process, home.path()).await;
    let mut output = process.take_raw_output().unwrap();
    send_prompt(&mut process).await;
    let raw = tokio::time::timeout(DEADLINE, output.recv())
        .await
        .expect("transferred raw receiver watchdog")
        .expect("unexpected raw EOF")
        .expect("raw frame IO");
    let last_value: Value = serde_json::from_slice(raw.as_bytes()).unwrap();
    assert_eq!(
        last_value["result"]["sessionId"], SID,
        "constructed last-value is not valid"
    );
    assert!(
        matches!(
            codec::decode_frame(raw.as_bytes()),
            Err(ProtocolError::InvalidJson)
        ),
        "raw duplicate ACK was normalized before codec"
    );
    assert_eq!(audit(home.path())["send_count"], 1);
    stop(&mut process).await;
}

#[tokio::test]
async fn native_wrong_rpc_sid_and_privileged_trace_fail_closed() {
    for case in ["wrong-rpc", "wrong-sid", "malformed-trace"] {
        let home = tempfile::tempdir().unwrap();
        let mut process = spawn(home.path(), case).await;
        if case == "malformed-trace" {
            create(&mut process, home.path()).await;
            let raw = receive(&mut process).await;
            assert!(matches!(
                codec::decode_frame(raw.as_bytes()),
                Err(ProtocolError::InvalidShape)
            ));
            assert_eq!(audit(home.path())["send_count"], 0);
        } else {
            bootstrap(&mut process, home.path()).await;
            send_prompt(&mut process).await;
            let raw = receive(&mut process).await;
            match codec::decode_frame(raw.as_bytes()).unwrap() {
                Incoming::Response(response) => assert!(matches!(
                    response.send_ack(&id("send-1"), SID),
                    Err(ProtocolError::CorrelationMismatch)
                )),
                _ => panic!("expected invalidly correlated ACK"),
            }
            assert_eq!(audit(home.path())["send_count"], 1);
        }
        stop(&mut process).await;
    }
}

#[tokio::test]
async fn native_observed_send_with_lost_ack_is_not_replayed_by_raw_transport() {
    let home = tempfile::tempdir().unwrap();
    let mut process = spawn(home.path(), "lost-ack").await;
    bootstrap(&mut process, home.path()).await;
    let holder = process.pid().unwrap();
    send_prompt(&mut process).await;
    observed_send_barrier(home.path()).await;
    // Native stdout closure alone does not close the holder's stdout. The input
    // outcome is still unknown until the owner performs explicit cleanup.
    assert!(
        tokio::time::timeout(Duration::from_millis(100), process.recv_raw())
            .await
            .is_err(),
        "lost ACK unexpectedly produced a frame or holder EOF before cleanup"
    );
    let state = audit(home.path());
    assert_eq!(state["send_count"], 1);
    assert_eq!(state["create_count"], 1);
    assert_eq!(process.pid(), Some(holder));
    assert!(running(holder));
    // No retry or fallback is attempted. A missing ACK is not non-delivery/no-execution.
    stop(&mut process).await;
    let eof = tokio::time::timeout(DEADLINE, process.recv_raw())
        .await
        .expect("post-join raw EOF watchdog")
        .expect("post-join raw drain");
    assert!(
        eof.is_none(),
        "unexpected pending native evidence after join"
    );
    assert_eq!(audit(home.path())["send_count"], 1);
}
