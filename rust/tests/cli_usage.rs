//! Real CLI/Node oracle. All sessions and owner peers are private fixtures.
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;
#[tokio::test]
async fn actual_node_manager_baseline_stays_current() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let out = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new("node")
            .arg("scripts/usage-node-oracle.mjs")
            .current_dir(&root)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.stdout,
        include_bytes!("../../test/fixtures/usage/manager.json")
    );
}
#[tokio::test]
async fn actual_public_node_cli_usage_matches_rust() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let out = tokio::time::timeout(
        Duration::from_secs(60),
        Command::new("node")
            .arg("rust/tests/cli-usage-oracle.mjs")
            .arg(env!("CARGO_BIN_EXE_pultd-rust"))
            .current_dir(&root)
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.stdout,
        b"usage presentation oracle: 64 paired Node/Rust cases\n"
    );
}
#[tokio::test]
async fn all_scoped_keys_are_rejected_before_owner_io() {
    let home = tempfile::tempdir().unwrap();
    let missing = home.path().join("must-not-be-read");
    for key in [
        "PULT_ASK_KEY",
        "PULT_RUNTIME_KEY",
        "PULT_CODEX_MEMORY_KEY",
        "PULT_MEMORY_KEY",
        "PULT_MEMORY_TURN_KEY",
    ] {
        for json in [false, true] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
            command
                .env_clear()
                .env("HOME", &missing)
                .env(key, "")
                .arg("--home")
                .arg(&missing)
                .arg("usage");
            if json {
                command.arg("--json");
            }
            let out = tokio::time::timeout(Duration::from_secs(3), command.output())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
            assert!(String::from_utf8_lossy(&out.stderr).contains("forbidden"));
            assert!(!missing.exists());
        }
    }
}
