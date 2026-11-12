use pult_core::worker_env::{self, Environment};
use pult_core::worker_process::{Framing, Launch, Process};
use serde_json::json;
use std::time::Duration;
fn launch(home: &std::path::Path, script: &str) -> Launch {
    Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: "/usr/bin/python3".into(),
        args: vec!["-B".into(), "-c".into(), script.into()],
        cwd: home.into(),
        env: worker_env::from_parent(&std::env::vars_os().collect(), &Environment::new()).unwrap(),
    }
}
#[tokio::test]
async fn codex_recovers_bad_and_oversized_lines_then_preserves_large_healthy_replies() {
    let home = tempfile::tempdir().unwrap();
    let script = r#"import json,sys
sys.stdout.write('not-json-private-sentinel\nnull\n[]\n42\n')
sys.stdout.write('x'*(16*1024*1024+100)+'\n')
print(json.dumps({'id':1,'result':{'text':'я🌊'*(300000)}}),flush=True)
print(json.dumps({'id':2,'result':{'ok':True}}),flush=True)
sys.exit(7)
"#;
    let mut process = Process::spawn_with_framing(launch(home.path(), script), Framing::codex())
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(10), process.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(first["id"], 1);
    assert_eq!(
        first["result"]["text"].as_str().unwrap().chars().count(),
        600000
    );
    let second = tokio::time::timeout(Duration::from_secs(10), process.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(second, json!({"id":2,"result":{"ok":true}}));
    assert!(
        tokio::time::timeout(Duration::from_secs(10), process.recv())
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    assert_eq!(process.discarded_frames(), 5);
    assert_eq!(process.stop().await.unwrap().code, Some(7));
}
#[tokio::test]
async fn codex_writer_and_transferred_reader_support_large_frames_without_a_process_mutex() {
    let home = tempfile::tempdir().unwrap();
    let script = "import json,sys\nfor line in sys.stdin:\n print(json.dumps(json.loads(line)),flush=True)\n";
    let mut process = Process::spawn_with_framing(launch(home.path(), script), Framing::codex())
        .await
        .unwrap();
    let mut output = process.take_output().unwrap();
    assert!(process.take_output().is_err());
    assert!(process.recv().await.is_err());
    let value = json!({"text":"x".repeat(2*1024*1024)});
    process.send(&value).await.unwrap();
    let received = tokio::time::timeout(Duration::from_secs(10), output.recv())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(received, value);
    process.stop().await.unwrap();
}

#[tokio::test]
async fn cleanup_finishes_with_a_full_or_dropped_transferred_receiver() {
    for drop_receiver in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let script = "import json,time\nfor i in range(100):\n print(json.dumps({'id':i,'result':'x'*65536}),flush=True)\ntime.sleep(60)\n";
        let mut process =
            Process::spawn_with_framing(launch(home.path(), script), Framing::codex())
                .await
                .unwrap();
        let output = process.take_output().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while output.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if drop_receiver {
            drop(output);
        }
        tokio::time::timeout(Duration::from_secs(8), process.stop())
            .await
            .unwrap()
            .unwrap();
    }
}
