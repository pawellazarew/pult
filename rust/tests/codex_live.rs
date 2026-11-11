//! Opt-in local handshake only: no model turn, login, or account mutation.
use pult_core::{codex_process, worker_env, worker_process::Launch};
use std::path::PathBuf;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires PULT_REAL_CODEX_BIN pointing to an explicitly selected installed Codex CLI"]
async fn installed_codex_initializes_and_confirms_process_cleanup() {
    let program =
        PathBuf::from(std::env::var_os("PULT_REAL_CODEX_BIN").expect("set PULT_REAL_CODEX_BIN"));
    assert!(program.is_absolute());
    let scratch = tempfile::tempdir().unwrap();
    let env = worker_env::from_parent(
        &std::env::vars_os().collect(),
        &worker_env::Environment::new(),
    )
    .unwrap();
    let mut connection = codex_process::start(
        Launch {
            holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
            program,
            args: vec!["app-server".into(), "--stdio".into()],
            cwd: scratch.path().into(),
            env,
        },
        codex_process::Timeouts::default(),
    )
    .unwrap();
    let mut cleanup = connection.cleanup();
    tokio::time::timeout(Duration::from_secs(35), connection.ready())
        .await
        .unwrap()
        .unwrap();
    assert!(connection.client().is_ok());
    connection.shutdown();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), cleanup.finished())
            .await
            .unwrap(),
        codex_process::CleanupStatus::Stopped
    );
}
