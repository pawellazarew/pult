use std::time::Duration;

#[tokio::test]
async fn session_queries_interoperate_with_current_typescript_manager() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/session-query-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(100), command.output())
        .await
        .expect("session query interoperability exceeded its cleanup watchdog")
        .expect("could not launch Node session query interoperability script");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("session query interop passed 18"));
}
