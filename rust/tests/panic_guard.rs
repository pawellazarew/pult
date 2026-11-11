//! Panic-hook isolation is tested in a child test process. The parent retains
//! its normal hook and never mutates its process-wide environment.
use std::time::Duration;
use tokio::process::Command;

const CHILD_MARKER: &str = "PULT_PANIC_GUARD_FIXTURE";
const SECRET: &str = "PULT_PANIC_SECRET_73f59c1a\"\\\n🌊";

#[test]
fn panic_hook_child_fixture() {
    if std::env::var(CHILD_MARKER).as_deref() != Ok("run") {
        return;
    }
    pult_core::panic_guard::install();
    // Installation is process-wide and idempotent, not a temporary hook swap.
    pult_core::panic_guard::install();

    // Hold stderr on another thread until both panic boundaries have unwound.
    // A hook that even writes a static diagnostic would deadlock here: it
    // could not acquire this lock, and release is sent only after the catches.
    let (locked_tx, locked_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let locker = std::thread::spawn(move || {
        let stderr = std::io::stderr();
        let _guard = stderr.lock();
        locked_tx.send(()).unwrap();
        release_rx.recv().unwrap();
    });
    locked_rx.recv().unwrap();

    let caught = std::panic::catch_unwind(|| panic!("{SECRET}"));
    assert!(caught.is_err());

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .thread_name(SECRET)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let joined = tokio::spawn(async {
            let escaped = serde_json::to_string(SECRET).unwrap();
            panic!("{escaped}");
        })
        .await;
        // Formatting JoinError would re-expose the panic payload independently
        // of the hook. Observe its classification only.
        assert!(joined.is_err_and(|error| error.is_panic()));
    });
    release_tx.send(()).unwrap();
    locker.join().unwrap();
}

#[tokio::test]
async fn caught_and_spawned_panics_do_not_print_payloads_thread_names_or_backtraces() {
    let executable = std::env::current_exe().unwrap();
    let mut command = Command::new(executable);
    command
        .args([
            "--exact",
            "panic_hook_child_fixture",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_MARKER, "run")
        .env("RUST_BACKTRACE", "full")
        .env("RUST_LIB_BACKTRACE", "full")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .expect("panic-hook child exceeded cleanup watchdog")
        .expect("could not launch panic-hook child");
    assert!(output.status.success(), "panic-hook child failed");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let escaped = serde_json::to_string(SECRET).unwrap();
    for text in [&stdout, &stderr] {
        assert!(
            !text.contains(SECRET),
            "raw panic payload escaped the guard"
        );
        assert!(
            !text.contains(&escaped),
            "JSON-escaped panic payload escaped the guard"
        );
        assert!(
            !text.contains("PULT_PANIC_SECRET_73f59c1a"),
            "panic payload or thread name escaped the guard"
        );
    }
    assert!(stderr.is_empty(), "the panic hook must remain silent");
    assert!(stdout.contains("1 passed"));
}
