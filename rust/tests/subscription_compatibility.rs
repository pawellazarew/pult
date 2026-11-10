use std::time::Duration;

#[tokio::test]
async fn subscriptions_interoperate_with_current_typescript_client() {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/subscription-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(95), command.output())
        .await
        .expect("subscription interoperability script exceeded its cleanup watchdog")
        .expect("could not launch Node subscription interoperability script");
    assert!(
        result.status.success(),
        "stdout={}\nstderr={}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let stdout = String::from_utf8_lossy(&result.stdout);
    for line in stdout
        .lines()
        .filter(|line| line.starts_with("non-reader metrics "))
    {
        println!("{line}");
    }
    assert!(stdout.contains("subscription interop passed 14"));
}
