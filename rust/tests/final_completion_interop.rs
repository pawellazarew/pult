//! Installed providers are never used: repository fakes and a private scratch daemon.
#[test]
fn final_text_and_actual_node_rollback_roundtrip() {
    let status = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/final-completion-interop.mjs"
        ))
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .status()
        .expect("Node final-completion fixture");
    assert!(
        status.success(),
        "actual final-completion/rollback fixture failed"
    );
}
