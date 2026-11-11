use std::time::Duration;

#[tokio::test]
async fn scoped_memory_keys_pin_project_and_never_promote_to_owner() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scoped-memory-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(100), command.output())
        .await
        .expect("scoped memory interoperability exceeded its cleanup watchdog")
        .expect("could not launch Node scoped memory interoperability script");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(String::from_utf8_lossy(&result.stdout).contains("scoped memory interop passed 17"));
}
