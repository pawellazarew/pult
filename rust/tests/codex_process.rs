use pult_core::codex_process::{self, CleanupStatus, Connection, Error, Timeouts};
use pult_core::codex_rpc::{Event, MAX_PAYLOAD};
use pult_core::worker_process::Launch;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
const WAIT: Duration = Duration::from_secs(20);
macro_rules! case {
    ($name:ident, $body:block) => {
        #[tokio::test]
        async fn $name() { tokio::time::timeout(WAIT, async $body).await.expect("20 second watchdog"); }
    };
}
fn python() -> PathBuf {
    let primary = PathBuf::from("/usr/bin/python3");
    if primary.is_file() {
        return primary;
    }
    let output = std::process::Command::new("/usr/bin/which")
        .arg("python3")
        .output()
        .unwrap();
    assert!(output.status.success());
    PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
}
fn launch(home: &Path, mode: &str) -> Launch {
    Launch {
        holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
        program: python(),
        args: vec![
            "-B".into(),
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/codex_app_server.py")
                .into_os_string(),
            mode.into(),
            home.as_os_str().to_owned(),
        ],
        cwd: home.into(),
        env: BTreeMap::from([
            ("HOME".into(), home.as_os_str().to_owned()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
        ]),
    }
}
fn start(home: &Path, mode: &str) -> Connection {
    codex_process::start(launch(home, mode), Timeouts::default()).unwrap()
}
async fn notification(connection: &mut Connection, want: &str) {
    loop {
        if matches!(connection.events.recv().await,Some(Event::Notification{method,..}) if method==want)
        {
            return;
        }
    }
}
fn running(pid: u32) -> bool {
    let output = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    !state.trim().is_empty() && !state.trim_start().starts_with('Z')
}
fn assert_gone(home: &Path) {
    let pids: Vec<u32> =
        serde_json::from_slice(&std::fs::read(home.join("pids.json")).unwrap()).unwrap();
    for pid in pids {
        assert!(!running(pid), "owned fixture survived confirmed cleanup");
    }
}
case!(handshake_precedes_requests_and_multiplexes_out_of_order, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = start(home.path(), "normal");
    assert!(matches!(connection.client(), Err(Error::NotReady)));
    let client = connection.ready().await.unwrap();
    notification(&mut connection, "fixture/ready").await;
    let first = {
        let client = client.clone();
        tokio::spawn(async move { client.request("first", json!({}), WAIT).await })
    };
    let second = client.request("second", json!({}), WAIT);
    // Queuing order matters for the fixture; first has its task polled explicitly.
    tokio::task::yield_now().await;
    assert_eq!(second.await.unwrap(), "second");
    assert_eq!(first.await.unwrap().unwrap(), "first");
    let messages = std::fs::read_to_string(home.path().join("messages.jsonl")).unwrap();
    let frames: Vec<Value> = messages
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames[0]["method"], "initialize");
    assert_eq!(frames[1]["method"], "initialized");
    connection.shutdown();
    assert_eq!(
        connection.cleanup().finished().await,
        CleanupStatus::Stopped
    );
    assert_gone(home.path());
});
case!(server_request_drop_denies_through_real_process, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = start(home.path(), "normal");
    let client = connection.ready().await.unwrap();
    notification(&mut connection, "fixture/ready").await;
    let job = {
        let client = client.clone();
        tokio::spawn(async move { client.request("permission", Value::Null, WAIT).await })
    };
    match connection.events.recv().await.unwrap() {
        Event::ServerRequest { permit, .. } => drop(permit),
        _ => panic!("server request"),
    }
    assert_eq!(job.await.unwrap().unwrap()["denied"], true);
    connection.shutdown();
    assert_eq!(
        connection.cleanup().finished().await,
        CleanupStatus::Stopped
    );
});
case!(natural_eof_stops_and_invalidates_external_clients, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = start(home.path(), "normal");
    let client = connection.ready().await.unwrap();
    assert!(client.request("exit", Value::Null, WAIT).await.is_err());
    assert_eq!(
        connection.cleanup().finished().await,
        CleanupStatus::Stopped
    );
    assert!(client.notify("late", Value::Null).await.is_err());
    assert_gone(home.path());
});
case!(bad_framing_recovers_without_ending_connection, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = start(home.path(), "bad-framing");
    let client = connection.ready().await.unwrap();
    notification(&mut connection, "fixture/ready").await;
    assert_eq!(
        client
            .request("echo", json!({"ok":true}), WAIT)
            .await
            .unwrap()["ok"],
        true
    );
    connection.shutdown();
    assert_eq!(
        connection.cleanup().finished().await,
        CleanupStatus::Stopped
    );
});
case!(dropping_during_hanging_initialize_retains_cleanup_owner, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = start(home.path(), "hang-init");
    let mut cleanup = connection.cleanup();
    notification(&mut connection, "fixture/init-stalled").await;
    drop(connection);
    assert_eq!(cleanup.finished().await, CleanupStatus::Stopped);
    assert_gone(home.path());
});
case!(
    cancelling_only_ready_future_does_not_stop_owned_connection,
    {
        let home = tempfile::tempdir().unwrap();
        let mut connection = start(home.path(), "normal");
        {
            let mut ready = std::pin::pin!(connection.ready());
            std::future::poll_fn(|cx| {
                use std::future::Future;
                let _ = ready.as_mut().poll(cx);
                std::task::Poll::Ready(())
            })
            .await;
        }
        let client = connection.ready().await.unwrap();
        assert_eq!(
            client.request("echo", json!(true), WAIT).await.unwrap(),
            true
        );
        connection.shutdown();
        assert_eq!(
            connection.cleanup().finished().await,
            CleanupStatus::Stopped
        );
    }
);
case!(
    handshake_timeout_and_bad_result_cleanup_without_event_consumer,
    {
        for mode in ["hang-init", "bad-init"] {
            let home = tempfile::tempdir().unwrap();
            let mut connection = codex_process::start(
                launch(home.path(), mode),
                Timeouts {
                    handshake: Duration::from_millis(500),
                    ..Timeouts::default()
                },
            )
            .unwrap();
            assert!(connection.ready().await.is_err());
            assert_eq!(
                connection.cleanup().finished().await,
                CleanupStatus::Stopped
            );
            // Timeout may win before Python reports its PID; the holder
            // stop acknowledgement still proves cleanup in that case.
            if home.path().join("pids.json").exists() {
                assert_gone(home.path());
            }
        }
    }
);
case!(shutdown_interrupts_stalled_write_before_stop, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = codex_process::start(
        launch(home.path(), "stall-write"),
        Timeouts {
            send: Duration::from_secs(60),
            ..Timeouts::default()
        },
    )
    .unwrap();
    let client = connection.ready().await.unwrap();
    notification(&mut connection, "fixture/ready").await;
    let request = {
        let client = client.clone();
        tokio::spawn(async move {
            client
                .request("large", json!("x".repeat(MAX_PAYLOAD - 1024)), WAIT)
                .await
        })
    };
    notification(&mut connection, "fixture/write-started").await;
    connection.shutdown();
    assert_eq!(
        connection.cleanup().finished().await,
        CleanupStatus::Stopped
    );
    assert!(request.await.unwrap().is_err());
    assert_gone(home.path());
});
case!(write_timeout_cleans_up_without_event_consumer, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = codex_process::start(
        launch(home.path(), "stall-write"),
        Timeouts {
            send: Duration::from_millis(100),
            ..Timeouts::default()
        },
    )
    .unwrap();
    let client = connection.ready().await.unwrap();
    assert!(
        client
            .request("large", json!("x".repeat(MAX_PAYLOAD - 1024)), WAIT)
            .await
            .is_err()
    );
    assert_eq!(
        connection.cleanup().finished().await,
        CleanupStatus::Stopped
    );
    assert_gone(home.path());
});
case!(drop_owner_revokes_cloned_client_and_confirms_cleanup, {
    let home = tempfile::tempdir().unwrap();
    let mut connection = start(home.path(), "normal");
    let client = connection.ready().await.unwrap();
    notification(&mut connection, "fixture/ready").await;
    let mut cleanup = connection.cleanup();
    drop(connection);
    assert!(client.request("late", Value::Null, WAIT).await.is_err());
    assert_eq!(cleanup.finished().await, CleanupStatus::Stopped);
    assert_gone(home.path());
});
case!(
    unconfirmed_cleanup_is_quarantined_and_retry_is_single_slot,
    {
        let home = tempfile::tempdir().unwrap();
        let mut connection = start(home.path(), "normal");
        let client = connection.ready().await.unwrap();
        notification(&mut connection, "fixture/ready").await;
        assert!(
            client
                .request("kill-holder", Value::Null, WAIT)
                .await
                .is_err()
        );
        let mut cleanup = connection.cleanup();
        assert_eq!(cleanup.finished().await, CleanupStatus::Unconfirmed);
        let mut changed = cleanup.subscribe();
        assert!(cleanup.retry());
        assert!(!cleanup.retry());
        changed.changed().await.unwrap();
        loop {
            if *changed.borrow() == CleanupStatus::Unconfirmed {
                break;
            }
            changed.changed().await.unwrap();
        }
        assert_eq!(cleanup.status(), CleanupStatus::Unconfirmed);
    }
);
case!(
    owned_startup_failure_quarantines_child_and_invalid_options_do_not_launch,
    {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        assert!(matches!(
            codex_process::start(
                launch(home.path(), "normal"),
                Timeouts {
                    handshake: Duration::ZERO,
                    ..Timeouts::default()
                }
            ),
            Err(Error::InvalidOptions)
        ));
        assert!(!home.path().join("pids.json").exists());
        let holder = home.path().join("bad-holder");
        std::fs::write(
            &holder,
            "#!/bin/sh\ntrap '' TERM\nprintf 'not-ready\\n'\nexit 125\n",
        )
        .unwrap();
        std::fs::set_permissions(&holder, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut selected = launch(home.path(), "normal");
        selected.holder = holder;
        let mut connection = codex_process::start(selected, Timeouts::default()).unwrap();
        assert!(matches!(connection.ready().await, Err(Error::Launch)));
        let mut cleanup = connection.cleanup();
        assert_eq!(cleanup.finished().await, CleanupStatus::Unconfirmed);
        assert!(cleanup.retry());
        assert!(!cleanup.retry());
    }
);

case!(
    missing_files_fail_owned_startup_without_synchronous_pool_io,
    {
        let home = tempfile::tempdir().unwrap();
        let mut selected = launch(home.path(), "normal");
        selected.program = home.path().join("missing-provider");
        let mut connection = codex_process::start(selected, Timeouts::default())
            .expect("structural admission must not perform filesystem metadata IO");
        assert!(matches!(connection.ready().await, Err(Error::Launch)));
        let mut cleanup = connection.cleanup();
        assert_eq!(cleanup.finished().await, CleanupStatus::Stopped);
        assert!(!home.path().join("pids.json").exists());
    }
);

#[test]
fn starting_without_runtime_is_fallible_and_never_launches() {
    let home = tempfile::tempdir().unwrap();
    assert!(matches!(
        codex_process::start(launch(home.path(), "normal"), Timeouts::default()),
        Err(Error::RuntimeUnavailable)
    ));
    assert!(!home.path().join("pids.json").exists());
}
case!(
    natural_exit_preserves_all_queued_replies_and_last_notification,
    {
        let home = tempfile::tempdir().unwrap();
        let mut connection = start(home.path(), "tail-exit");
        let client = connection.ready().await.unwrap();
        notification(&mut connection, "fixture/ready").await;
        let mut jobs = Vec::new();
        for index in 0..3 {
            let client = client.clone();
            jobs.push(tokio::spawn(async move {
                client.request("tail", json!(index), WAIT).await
            }));
        }
        for (index, job) in jobs.into_iter().enumerate() {
            assert_eq!(job.await.unwrap().unwrap(), json!(index));
        }
        notification(&mut connection, "fixture/last-notification").await;
        assert_eq!(
            connection.cleanup().finished().await,
            CleanupStatus::Stopped
        );
        assert_gone(home.path());
    }
);
