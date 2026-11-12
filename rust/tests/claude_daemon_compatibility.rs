//! Actual daemon + built Node client + supervised synthetic Claude and Rust MCP.
use std::time::Duration;

#[tokio::test]
async fn claude_daemon_uses_real_scoped_mcp_without_a_codex_installation() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/claude-daemon-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("Claude daemon interoperability cleanup watchdog")
        .expect("could not start Claude daemon interoperability script");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Claude daemon interop passed 9"));
}
