use std::time::Duration;

#[tokio::test]
async fn memory_turn_interoperates_with_real_node_client_and_real_rust_mcp() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/memory-turn-interop.mjs");
    let binary = env!("CARGO_BIN_EXE_pultd-rust");
    let mcp = std::path::Path::new(env!("CARGO_BIN_EXE_pult-memory-mcp"));
    assert_eq!(std::path::Path::new(binary).parent(), mcp.parent());
    let output = tokio::time::timeout(
        Duration::from_secs(180),
        tokio::process::Command::new("node")
            .arg(script)
            .arg(binary)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("memory turn interoperability exceeded its cleanup watchdog")
    .expect("could not launch memory turn interoperability");
    assert!(
        output.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(String::from_utf8_lossy(&output.stdout).contains("memory turn interop passed 13"));
}
