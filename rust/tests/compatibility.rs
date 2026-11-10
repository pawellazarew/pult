use std::time::Duration;

#[tokio::test]
async fn current_typescript_client_and_raw_wire_preserve_foundation_contracts() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("interop passed 15"));
}
