//! Actual Rust -> built Node Registry/Manager -> Rust, no provider adapter.
use pult_core::{journal::EventStore, registry::Registry, turn_snapshot::SessionKey};
use std::{os::unix::fs::PermissionsExt, path::Path, process::Stdio, time::Duration};
use tokio::process::Command;
#[tokio::test]
async fn marker_known_identity_and_future_utf16_survive_actual_node_rollback() {
    pult_core::panic_guard::install();
    for marker in [
        Some("null"),
        Some("false"),
        Some("42"),
        Some(
            r#"{"version":1,"future":["\ud800",1e+030],
"line":"a\nb"}"#,
        ),
        None,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let field = marker
            .map(|m| format!(",\"zcodePendingInput\":{m}"))
            .unwrap_or_default();
        let doc = format!(
            r#"{{"version":2,"sessions":[{{"name":"chat","provider":"zcode","cwd":{},"createdAt":"2026-11-12T00:00:00Z","lastStatus":"working","approval":"read-only","providerSessionId":"sess_known"{field},"queue":[{{"id":"queued","at":"2026-11-12T00:00:00Z","text":"must not replay"}}]}}]}}"#,
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
            let mut journal = EventStore::open(&home.join("events")).unwrap();
            let mut registry = Registry::open(&home, &mut journal).unwrap();
            let record = registry
                .update_checked(&key, |r| {
                    r.set_string("title", "rust-title");
                    Ok(())
                })
                .unwrap();
            assert!(!record.raw().unwrap().get().contains('\n'));
            if marker.is_some_and(|v| v.contains("1e+030")) {
                assert!(record.raw().unwrap().get().contains("1e+030"));
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new("node")
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap_or_default())
                .env("HOME", &home)
                .arg(root.join("test/oracles/zcode-reservation.mjs"))
                .arg(&home)
                .arg(if marker.is_some() { "unknown" } else { "known" })
                .current_dir(root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap()
                .wait_with_output(),
        )
        .await
        .expect("Node rollback watchdog")
        .unwrap();
        assert!(
            output.status.success(),
            "metadata-only Node rollback oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let proof: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(proof["markerRetained"], true);
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        let record = registry
            .update_checked(&key, |r| {
                r.set_string("title", "rust-again");
                Ok(())
            })
            .unwrap();
        assert_eq!(record.get("zcodePendingInput").is_some(), marker.is_some());
        assert_eq!(
            record.scalar("providerSessionId").as_deref(),
            Some("sess_known")
        );
        if marker.is_some() {
            assert_eq!(record.scalar("lastStatus").as_deref(), Some("failed"));
        }
        if marker.is_some_and(|v| v.contains("\\ud800")) {
            assert!(record.raw().unwrap().get().contains("\\ud800"));
        }
        assert!(record.get("queue").is_some());
        assert!(!record.raw().unwrap().get().contains('\n'));
    }
}
