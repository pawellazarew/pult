use std::time::Duration;

async fn run(private_mode: Option<&str>) {
    let script =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/session-runtime-interop.mjs");
    let mut command = tokio::process::Command::new("node");
    command
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .kill_on_drop(true);
    if let Some(mode) = private_mode {
        command.arg(mode);
    }
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
    let expected = match private_mode {
        None => "session runtime interop passed 18",
        Some("--cold-peer-site-barrier") => "session runtime interop passed 2",
        Some("--journal-unfinished-tail" | "--journal-corrupt-complete") => {
            "session runtime interop passed 2"
        }
        _ => panic!("unknown private fixture mode"),
    };
    assert!(String::from_utf8_lossy(&output.stdout).contains(expected));
}

#[tokio::test]
async fn session_commands_interoperate_with_real_node_client_and_fake_provider() {
    run(None).await;
}

#[tokio::test]
async fn edited_unknown_cold_retry_has_no_ambient_python_site_dependency() {
    run(Some("--cold-peer-site-barrier")).await;
}

#[tokio::test]
async fn actual_provider_reads_only_complete_copied_journal_rows() {
    run(Some("--journal-corrupt-complete")).await;
    run(Some("--journal-unfinished-tail")).await;
}
