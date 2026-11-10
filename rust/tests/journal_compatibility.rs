use std::time::Duration;

#[tokio::test]
async fn journal_interoperates_with_current_typescript_store_and_client() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/journal-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(60), command.output())
        .await
        .expect("journal interoperability script exceeded its cleanup watchdog")
        .expect("could not launch Node journal interoperability script");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("journal interop passed 13"));
}
