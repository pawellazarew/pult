//! Real queued/steered memory delivery through the daemon, a local fake Codex
//! app-server and the actual Rust MCP binary. No provider/account/network call.
use std::time::Duration;
#[tokio::test]
async fn queued_memory_uses_real_receipts_exact_hosts_and_durable_pause() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/queue-memory-interop.mjs");
    let output = tokio::time::timeout(
        Duration::from_secs(180),
        tokio::process::Command::new("node")
            .arg(script)
            .arg(env!("CARGO_BIN_EXE_pultd-rust"))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("composed memory watchdog")
    .expect("start composed memory fixture");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(String::from_utf8_lossy(&output.stdout).contains("queue memory composed passed 10"));
}
