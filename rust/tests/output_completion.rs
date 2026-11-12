//! Actual holder/local child evidence. No provider, account, network or env hook.
use pult_core::worker_process::{
    Framing, Launch, Process, SpawnDenied, SpawnGate, SpawnPermit, StderrPolicy,
};
use serde_json::json;
use std::{collections::BTreeMap, path::Path, time::Duration};
const WAIT: Duration = Duration::from_secs(12);

fn launch(home: &Path, script: &str) -> Launch {
    Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: "/usr/bin/python3".into(),
        args: vec!["-B".into(), "-c".into(), script.into()],
        cwd: home.into(),
        env: BTreeMap::from([
            ("HOME".into(), home.as_os_str().into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
    }
}
async fn stop(process: &mut Process) {
    tokio::time::timeout(WAIT, process.stop())
        .await
        .unwrap()
        .unwrap();
}
#[tokio::test]
async fn clean_stdout_eof_is_not_completion_until_the_reader_was_joined() {
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let mut process = Process::spawn(launch(home.path(), "print('{\"ok\":true}', flush=True)"))
            .await
            .unwrap();
        assert!(!process.output_finished_cleanly());
        assert_eq!(process.recv().await.unwrap(), Some(json!({"ok":true})));
        assert!(process.recv().await.unwrap().is_none());
        assert!(
            !process.output_finished_cleanly(),
            "ReceiverNone is not reader join proof"
        );
        stop(&mut process).await;
        assert!(process.output_finished_cleanly());
        stop(&mut process).await;
        assert!(process.output_finished_cleanly());
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn dropping_the_consumer_before_eof_cannot_create_output_completion() {
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let script = "import json,pathlib,sys\nprint('{\"ready\":true}',flush=True)\nfor line in sys.stdin:\n print('{\"last\":true}',flush=True)\n pathlib.Path('child-exiting').write_text('local fixture reached EOF')\n break\n";
        let mut process = Process::spawn(launch(home.path(), script)).await.unwrap();
        let mut output = process.take_output().unwrap();
        assert_eq!(output.recv().await.unwrap().unwrap(), json!({"ready":true}));
        drop(output);
        assert!(!process.output_finished_cleanly());
        process.send(&json!({"exit":true})).await.unwrap();
        while !home.path().join("child-exiting").exists() { tokio::task::yield_now().await; }
        stop(&mut process).await;
        assert!(!process.output_finished_cleanly());
    }).await.unwrap();
}
#[tokio::test]
async fn eof_already_observed_before_a_later_consumer_drop_remains_valid_after_join() {
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let mut process = Process::spawn(launch(home.path(), "print('{}', flush=True)"))
            .await
            .unwrap();
        let mut output = process.take_output().unwrap();
        assert_eq!(output.recv().await.unwrap().unwrap(), json!({}));
        assert!(output.recv().await.is_none());
        drop(output);
        assert!(!process.output_finished_cleanly());
        stop(&mut process).await;
        assert!(process.output_finished_cleanly());
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn strict_parse_failure_closes_the_receiver_without_clean_eof_proof() {
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let mut process = Process::spawn(launch(home.path(), "print('invalid-json', flush=True)"))
            .await
            .unwrap();
        assert!(process.recv().await.is_err());
        assert!(process.recv().await.unwrap().is_none());
        stop(&mut process).await;
        assert!(!process.output_finished_cleanly());
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn recovering_eof_proof_does_not_claim_every_discarded_frame_was_valid() {
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let mut process = Process::spawn_with_framing(
            launch(
                home.path(),
                "import sys\nsys.stdout.write('noise\\n{}\\ntruncated')\nsys.stdout.flush()",
            ),
            Framing::codex(),
        )
        .await
        .unwrap();
        assert_eq!(process.recv().await.unwrap(), Some(json!({})));
        assert!(process.recv().await.unwrap().is_none());
        assert_eq!(process.discarded_frames(), 2);
        assert!(!process.output_finished_cleanly());
        stop(&mut process).await;
        assert!(process.output_finished_cleanly());
    })
    .await
    .unwrap();
}
struct Permit;
impl SpawnPermit for Permit {}
struct Gate;
impl SpawnGate for Gate {
    fn enter(&self) -> Result<Box<dyn SpawnPermit + '_>, SpawnDenied> {
        Ok(Box::new(Permit))
    }
}
#[tokio::test]
async fn stopping_an_unacknowledged_actual_holder_is_never_stdout_completion() {
    tokio::time::timeout(WAIT, async {
        let home = tempfile::tempdir().unwrap();
        let script = "import pathlib\npathlib.Path('provider-started').write_text('local child exists')\nprint('{}',flush=True)";
        let prepared = Process::prepare_launch(launch(home.path(), script), Framing::strict(), StderrPolicy::CountOnly).await.unwrap();
        let starting = Process::begin_spawn(prepared, &Gate).unwrap();
        while !home.path().join("provider-started").exists() { tokio::task::yield_now().await; }
        let mut process = starting.into_process();
        assert!(!process.output_finished_cleanly());
        stop(&mut process).await;
        assert!(!process.output_finished_cleanly());
    }).await.unwrap();
}
