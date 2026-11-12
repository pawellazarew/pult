//! Node rollback reads actual Rust-owned metadata without replaying uncertain input.
use pult_core::{journal::EventStore, registry::Registry, turn_snapshot::SessionKey};
use std::{os::unix::fs::PermissionsExt, path::Path, process::Command};
#[test]
fn pretty_future_marker_survives_rust_node_mutations_and_blocks_node_dispatch() {
    pult_core::panic_guard::install();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let doc = format!(
        r#"{{"version":2,"sessions":[{{"name":"chat","provider":"claude","cwd":{},"createdAt":"2026-11-12T00:00:00Z","lastStatus":"working","approval":"read-only","claudeReservedSessionId":{{
        "future": ["\ud800", 1e+030],
        "nested": {{ "message": "a\nb" }}
    }},"queue":[{{"id":"queued","at":"2026-11-12T00:00:00Z","text":"must not replay"}}]}}]}}"#,
        serde_json::to_string(&home).unwrap()
    );
    let path = home.join("sessions.json");
    std::fs::write(&path, doc).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let key = SessionKey {
        name: "chat".into(),
        created_at: "2026-11-12T00:00:00Z".into(),
    };
    {
        let mut store = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut store).unwrap();
        let record = registry
            .update_checked(&key, |record| {
                record.set_string("title", "rust-title");
                Ok(())
            })
            .unwrap();
        let raw = record.raw().unwrap();
        assert!(!raw.get().contains('\n'));
        assert!(raw.get().contains("1e+030"));
        assert!(raw.get().contains("\\ud800"));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let output = Command::new("node")
        .arg(root.join("test/oracles/claude-reservation.mjs"))
        .arg(&home)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "metadata-only Node rollback oracle failed"
    );
    let proof: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(proof["blocked"], true);
    assert_eq!(proof["markerRetained"], true);
    let mut store = EventStore::open(&home.join("events")).unwrap();
    let mut registry = Registry::open(&home, &mut store).unwrap();
    let record = registry
        .update_checked(&key, |r| {
            r.set_string("title", "rust-again");
            Ok(())
        })
        .unwrap();
    assert!(record.get("claudeReservedSessionId").is_some());
    assert!(record.raw().unwrap().get().contains("\\ud800"));
    assert_eq!(record.scalar("lastStatus").as_deref(), Some("failed"));
    assert!(record.get("queue").is_some());
}
