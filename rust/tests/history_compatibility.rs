use std::time::Duration;

#[tokio::test]
async fn history_interoperates_with_current_typescript_client_and_store() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/history-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(65), command.output())
        .await
        .expect("history interoperability script exceeded its cleanup watchdog")
        .expect("could not launch Node history interoperability script");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("history interop passed 15"));
}
