use std::time::Duration;

#[tokio::test]
async fn registry_recovery_and_mutations_interoperate_with_node() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/registry-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(75), command.output())
        .await
        .expect("registry interoperability exceeded its cleanup watchdog")
        .expect("could not launch Node registry interoperability script");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("registry interop passed 20"));
}
