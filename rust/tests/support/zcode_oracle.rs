use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command};
pub async fn oracle(input: Value) -> Value {
    let bytes = serde_json::to_vec(&input).unwrap();
    assert!(bytes.len() <= 2 * 1024 * 1024);
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/zcode-surface-interop.mjs");
    let home = tempfile::tempdir().unwrap();
    let mut child = Command::new("node")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home.path())
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(&bytes).await.unwrap();
        stdin.shutdown().await.unwrap();
        drop(stdin);
        child.wait_with_output().await.unwrap()
    })
    .await
    .expect("Node oracle watchdog");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
