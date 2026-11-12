//! Shared-memory delivery through real daemon/holder/MCP, synthetic providers only.
use std::time::Duration;

#[tokio::test]
async fn claude_approved_memory_is_readable_by_codex_without_scope_or_policy_bypass() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/claude-memory-interop.mjs");
    let output = tokio::time::timeout(
        Duration::from_secs(150),
        tokio::process::Command::new("node")
            .arg(script)
            .arg(env!("CARGO_BIN_EXE_pultd-rust"))
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("Claude shared-memory interoperability watchdog")
    .expect("could not start offline memory interoperability script");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("Claude shared memory interop passed 6")
    );
}
