use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

#[tokio::test]
async fn replay_preserves_every_unicode_record_across_output_batches() {
    let home = tempfile::tempdir().unwrap();
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let fixture = (1..=1000)
        .map(|sequence| {
            format!(
                "{}\n",
                json!({"sequence":sequence,"kind":"message","data":{"text":"Привет".repeat(50)}})
            )
        })
        .collect::<String>();
    assert!(fixture.len() > 64 * 1024);
    std::fs::write(home.path().join("r1.ndjson"), &fixture).unwrap();
    std::fs::set_permissions(
        home.path().join("r1.ndjson"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(env!("CARGO_BIN_EXE_pult-r1"))
            .arg("--home")
            .arg(home.path())
            .arg("replay")
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, fixture.as_bytes());
}
