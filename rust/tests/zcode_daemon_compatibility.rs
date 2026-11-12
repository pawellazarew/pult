//! Real daemon + built Node client + supervised argv-only synthetic ZCode.
use std::time::Duration;

#[tokio::test]
async fn zcode_daemon_owns_ordinary_queue_stop_and_uncertain_delivery_without_other_clis() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/zcode-daemon-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("ZCode daemon interoperability cleanup watchdog")
        .expect("could not start ZCode daemon interoperability script");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("ZCode daemon interop passed 7"));
}
