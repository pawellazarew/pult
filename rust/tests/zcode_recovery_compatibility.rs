//! Authenticated owner RPC + built Node SDK + actual daemon/holder, synthetic ZCode only.
use std::time::Duration;

#[tokio::test]
async fn owner_recovery_is_explicit_metadata_only_and_cold_restart_does_not_forge_proof() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/zcode-recovery-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("ZCode recovery daemon interoperability cleanup watchdog")
        .expect("could not start ZCode recovery interoperability script");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("ZCode recovery interop passed 6"));
}
