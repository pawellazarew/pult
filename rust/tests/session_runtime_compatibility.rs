use std::time::Duration;

#[tokio::test]
async fn session_commands_interoperate_with_real_node_client_and_fake_provider() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/session-runtime-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(90), command.output())
        .await
        .expect("session command script exceeded its cleanup watchdog")
        .expect("could not launch session command interoperability script");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("session runtime interop passed 18"));
}
