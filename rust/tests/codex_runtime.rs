use pult_core::codex_runtime::{
    CodexRuntime, Dependencies, Limits, Network, RuntimeError, TrustedCommand,
};
use pult_core::consent_store::ConsentStore;
use pult_core::journal::EventStore;
use pult_core::network_guard::{NetworkGuard, Probe, ProbeFuture, ProbeResult};
use pult_core::permission_broker::{Decision, Scope};
use pult_core::registry::{Record, Registry};
use pult_core::runtime_config::RuntimeConfig;
use pult_core::turn_coordinator::Outcome;
use pult_core::turn_driver::{Driver, Input, InputMetadata, Options};
use pult_core::turn_journal::JournalSink;
use pult_core::turn_snapshot::SessionKey;
use pult_core::worker_env::Environment;
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
const WAIT: Duration = Duration::from_secs(20);

// Keep payloads/backtraces secret while making CI assertion locations useful.
// This hook exists only in this isolated synthetic integration-test process.
fn test_panic_guard() {
    pult_core::panic_guard::install();
    static LOCATION_HOOK: std::sync::Once = std::sync::Once::new();
    LOCATION_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if let Some(location) = info.location() {
                eprintln!(
                    "runtime fixture panic at {}:{}",
                    location.file(),
                    location.line()
                );
            }
        }));
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_stops_warm_process_before_waiting_for_owned_registry_check() {
    test_panic_guard();
    let mut f = Fixture::new();
    let entered = Arc::new(tokio::sync::Notify::new());
    let arriving = entered.clone();
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    struct Release(Arc<(Mutex<bool>, std::sync::Condvar)>);
    impl Drop for Release {
        fn drop(&mut self) {
            *self.0.0.lock().unwrap() = true;
            self.0.1.notify_all();
        }
    }
    let unblock = Release(release.clone());
    let barrier = release.clone();
    let registry = f.registry.clone();
    f.driver = Arc::new(
        Driver::new(
            f.sink.clone(),
            Arc::new(move |text| {
                if text == "block-admission" {
                    let _registry = registry.lock().unwrap();
                    arriving.notify_one();
                    let (lock, changed) = &*barrier;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = changed.wait(released).unwrap();
                    }
                }
                pult_core::redaction::redact_string(text)
            }),
            Options::default(),
        )
        .unwrap(),
    );
    let (runtime, _) = f.runtime(probe("US"), RuntimeConfig::default());
    let mut first = runtime.execute(key("one"), input("normal")).await.unwrap();
    first.wait().await.unwrap();
    let pids: Vec<u32> =
        serde_json::from_slice(&std::fs::read(f.home.join("pids.json")).unwrap()).unwrap();
    let preparation = runtime.execute(key("one"), input("block-admission"));
    tokio::time::timeout(WAIT, entered.notified())
        .await
        .unwrap();
    let mut stopping = runtime.shutdown();
    let stopped_before_release = tokio::time::timeout(
        Duration::from_secs(3),
        until(|| {
            pids.iter().all(|pid| {
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(*pid as i32), None).is_err()
            })
        }),
    )
    .await
    .is_ok();
    let retained = stopping
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()))
        .is_pending();
    drop(unblock);
    let rejected = tokio::time::timeout(WAIT, preparation)
        .await
        .unwrap()
        .is_err();
    tokio::time::timeout(WAIT, stopping).await.unwrap().unwrap();
    eprintln!(
        "stop_before_release={stopped_before_release}; check_retained={retained}; preparation_rejected={rejected}"
    );
    assert!(
        stopped_before_release,
        "shutdown delayed process stop behind owned registry IO"
    );
    assert!(
        retained,
        "shutdown abandoned a still-blocked registry check"
    );
    assert!(rejected, "stopped preparation was still admitted to Driver");
    assert_eq!(
        f.logs()
            .iter()
            .filter(|row| row["method"] == "turn/start")
            .count(),
        1
    );
    assert_eq!(
        f.journal()
            .iter()
            .filter(|row| row["kind"] == "message.user")
            .count(),
        1
    );
}
macro_rules! case {($name:ident,$body:block)=>{#[tokio::test]async fn $name(){test_panic_guard();tokio::time::timeout(WAIT,async $body).await.expect("runtime watchdog");}};}
struct ScriptProbe {
    loc: &'static str,
    calls: AtomicUsize,
    block: bool,
    entered: tokio::sync::Notify,
}
impl Probe for ScriptProbe {
    fn probe<'a>(&'a self, _: &'a str, _: Option<&'a str>, _: Duration) -> ProbeFuture<'a> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.entered.notify_one();
            if self.block {
                std::future::pending::<()>().await;
            }
            ProbeResult {
                status: Some(0),
                stdout: format!("loc={}\n", self.loc).into_bytes(),
                stderr_bytes: 0,
            }
        })
    }
}
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    cwd: PathBuf,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
    sink: Arc<JournalSink>,
    driver: Arc<Driver>,
}
impl Fixture {
    fn new() -> Self {
        // Ordinary integration uses the production cleanup contract, not a
        // 200 ms Driver deadline below the host's 300 ms interrupt + IO drain.
        // A shorter deadline belongs only in an explicit quarantine/retry case.
        Self::with_options(Options::default())
    }
    fn with_options(options: Options) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let mut journal = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut journal).unwrap();
        for name in ["one", "two"] {
            let mut record = Record::default();
            for (k, v) in [
                ("name", name),
                ("createdAt", "2026-11-12T00:00:00Z"),
                ("cwd", cwd.to_str().unwrap()),
                ("provider", "codex"),
                ("approval", "ask"),
            ] {
                record.set_string(k, v);
            }
            registry.insert(record).unwrap();
        }
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        let sink = Arc::new(JournalSink::new(Arc::new(Mutex::new(journal))).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(pult_core::redaction::redact_string),
                options,
            )
            .unwrap(),
        );
        Self {
            _temp: temp,
            home,
            cwd,
            registry: Arc::new(Mutex::new(registry)),
            consent,
            sink,
            driver,
        }
    }
    fn runtime(
        &self,
        probe: Arc<ScriptProbe>,
        cfg: RuntimeConfig,
    ) -> (Arc<CodexRuntime>, Arc<NetworkGuard>) {
        self.runtime_with_sink(probe, cfg, self.sink.clone())
    }
    fn runtime_with_sink(
        &self,
        probe: Arc<ScriptProbe>,
        cfg: RuntimeConfig,
        sink: Arc<dyn pult_core::turn_driver::EventSink>,
    ) -> (Arc<CodexRuntime>, Arc<NetworkGuard>) {
        let source=include_str!("fixtures/codex_worker.py")
            .replace("output = threading.Lock()", "(home / 'environment.json').write_text(json.dumps(dict(os.environ)))\noutput = threading.Lock()")
            .replace("elif method == 'config/read':\n","elif method == 'config/read':\n        if (home / 'block-config').exists():\n            (home / 'config-entered').write_text('yes')\n            while not (home / 'release-config').exists():\n                threading.Event().wait(0.01)\n")
            .replace("elif method == 'turn/start':\n","elif method == 'turn/start':\n        records = json.loads((home / 'sessions.json').read_text())['sessions']\n        assert any(r.get('providerSessionId') == params['threadId'] for r in records), 'no durable thread ID'\n")
            .replace("elif method is None:\n","elif method is None:\n        if frame.get('result', {}).get('decision') in ('accept', 'acceptForSession'):\n            journal = [json.loads(row) for row in (home / 'events/journal.jsonl').read_text().splitlines()]\n            assert any(e['kind'] == 'permission.resolved' and e['data'].get('decision') == 'allow' for e in journal), 'grant before journal'\n            (home / 'grant-proof').write_text('durable')\n")
            .replace("'command': 'true'","'command': 'true', 'availableDecisions': ['accept', 'decline', 'cancel']");
        let script = self.home.join("app_server.py");
        std::fs::write(&script, source).unwrap();
        let guard = Arc::new(NetworkGuard::new(probe));
        let parent: Environment = [
            ("HOME".into(), self.home.clone().into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HTTPS_PROXY".into(), "http://ambient.invalid".into()),
            ("PULT_MEMORY_KEY".into(), "ambient-secret".into()),
            ("OPENAI_API_KEY".into(), "ambient-secret".into()),
        ]
        .into_iter()
        .collect();
        let runtime = CodexRuntime::new(
            Dependencies {
                home: self.home.clone(),
                registry: self.registry.clone(),
                consent: self.consent.clone(),
                driver: self.driver.clone(),
                sink,
            },
            cfg,
            TrustedCommand {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program: "/usr/bin/python3".into(),
                prefix_args: vec![
                    "-B".into(),
                    script.into_os_string(),
                    self.home.clone().into_os_string(),
                ],
            },
            parent,
            Network::Shared(guard.clone()),
            Limits {
                timeouts: pult_core::codex_worker::Timeouts {
                    control: Duration::from_secs(2),
                    interrupt: Duration::from_millis(300),
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        (runtime, guard)
    }
    fn logs(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("messages.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|v| serde_json::from_str(v).unwrap())
            .collect()
    }
    fn journal(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("events/journal.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|v| serde_json::from_str(v).unwrap())
            .collect()
    }
}
fn key(name: &str) -> SessionKey {
    SessionKey {
        name: name.into(),
        created_at: "2026-11-12T00:00:00Z".into(),
    }
}
fn input(text: &str) -> Input {
    Input {
        text: text.into(),
        metadata: InputMetadata::default(),
    }
}
fn probe(loc: &'static str) -> Arc<ScriptProbe> {
    Arc::new(ScriptProbe {
        loc,
        calls: AtomicUsize::new(0),
        block: false,
        entered: tokio::sync::Notify::new(),
    })
}
async fn until(check: impl Fn() -> bool) {
    loop {
        if check() {
            return;
        }
        tokio::task::yield_now().await;
    }
}
case!(
    parallel_sessions_share_one_host_and_stop_exact_public_turn_only,
    {
        let f = Fixture::new();
        let (rt, _) = f.runtime(probe("US"), RuntimeConfig::default());
        let (a, b) = tokio::join!(
            rt.execute(key("one"), input("hold")),
            rt.execute(key("two"), input("hold"))
        );
        let mut a = a.unwrap();
        let mut b = b.unwrap();
        let aa = a.accepted().await.unwrap();
        b.accepted().await.unwrap();
        assert_eq!(rt.host_count(), 1);
        let env: Value =
            serde_json::from_slice(&std::fs::read(f.home.join("environment.json")).unwrap())
                .unwrap();
        for key in [
            "HTTPS_PROXY",
            "ALL_PROXY",
            "OPENAI_API_KEY",
            "PULT_MEMORY_KEY",
        ] {
            assert!(env.get(key).is_none());
        }
        assert!(!rt.stop(&key("one"), Some("native-turn-2")).unwrap());
        assert!(rt.stop(&key("one"), Some(&aa.turn_id)).unwrap());
        let stopped = a.wait().await;
        if let Err(error) = &stopped {
            eprintln!("exact public stop wait error: {error:?}");
        }
        let outcome = stopped.unwrap().turn.outcome;
        if outcome != Outcome::Interrupted {
            eprintln!(
                "exact public stop outcome kind: {}",
                match &outcome {
                    Outcome::Success => "success",
                    Outcome::Failure { .. } => "failure",
                    Outcome::Interrupted => "interrupted",
                }
            );
        }
        assert_eq!(outcome, Outcome::Interrupted);
        assert_eq!(f.driver.active_count(), 1);
        std::fs::write(f.home.join("release"), "yes").unwrap();
        assert_eq!(b.wait().await.unwrap().turn.outcome, Outcome::Success);
        assert_eq!(
            f.logs()
                .iter()
                .filter(|v| v["method"] == "initialize")
                .count(),
            1
        );
        rt.shutdown().await.unwrap();
        rt.shutdown().await.unwrap();
    }
);
case!(
    blocked_route_has_no_spawn_and_no_user_or_accepted_receipt,
    {
        let f = Fixture::new();
        let (rt, _) = f.runtime(probe("RU"), RuntimeConfig::default());
        assert!(matches!(
            rt.execute(key("one"), input("normal")).await,
            Err(RuntimeError::NetworkDenied)
        ));
        assert_eq!(rt.host_count(), 0);
        assert!(!f.home.join("pids.json").exists());
        assert!(f.journal().is_empty());
        rt.shutdown().await.unwrap();
    }
);
case!(
    warm_second_turn_uses_fresh_frozen_attachment_and_same_thread,
    {
        use base64::Engine;
        use pult_core::prompt_attachments::{AttachmentKind, PromptAttachment};
        let f = Fixture::new();
        let (rt, _) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut first = rt.execute(key("one"), input("normal")).await.unwrap();
        assert_eq!(first.wait().await.unwrap().turn.outcome, Outcome::Success);
        let png=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jt0AAAAASUVORK5CYII=").unwrap();
        let path = f.home.join("attachments/one/day/image.png");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &png).unwrap();
        let mut next = input("");
        next.metadata.attachments = vec![PromptAttachment {
            path: path.to_str().unwrap().into(),
            name: "image.png".into(),
            bytes: png.len() as u64,
            mime: "image/png".into(),
            kind: AttachmentKind::File,
        }];
        let mut second = rt.execute(key("one"), next).await.unwrap();
        assert_eq!(second.wait().await.unwrap().turn.outcome, Outcome::Success);
        let logs = f.logs();
        let turns: Vec<_> = logs
            .iter()
            .filter(|v| v["method"] == "turn/start")
            .collect();
        assert_eq!(turns.len(), 2);
        assert_eq!(
            turns[1]["params"]["input"][0],
            json!({"type":"localImage","path":path})
        );
        assert_eq!(
            logs.iter()
                .filter(|v| v["method"] == "thread/start")
                .count(),
            1
        );
        assert!(!f.journal().iter().any(|v| v.to_string().contains("iVBOR")));
        rt.shutdown().await.unwrap();
    }
);
case!(
    broker_grant_is_durable_before_native_reply_and_cancel_revokes_late_answer,
    {
        let f = Fixture::new();
        let (rt, _) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut turn = rt.execute(key("one"), input("permit")).await.unwrap();
        turn.accepted().await.unwrap();
        until(|| !rt.list_permissions(Some("one")).is_empty()).await;
        let id = rt.list_permissions(Some("one"))[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(
            rt.resolve_permission(&id, Decision::allow(Scope::Once), "test")
                .unwrap()
                .wait()
                .await
                .unwrap()
        );
        assert_eq!(turn.wait().await.unwrap().turn.outcome, Outcome::Success);
        assert_eq!(
            std::fs::read_to_string(f.home.join("grant-proof")).unwrap(),
            "durable"
        );
        let mut next = rt.execute(key("one"), input("permit")).await.unwrap();
        next.accepted().await.unwrap();
        until(|| !rt.list_permissions(Some("one")).is_empty()).await;
        let late = rt.list_permissions(Some("one"))[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        rt.stop(&key("one"), None).unwrap();
        let _ = next.wait().await;
        if let Ok(resolution) = rt.resolve_permission(&late, Decision::allow(Scope::Once), "late") {
            assert!(!resolution.wait().await.unwrap());
        }
        assert_eq!(
            f.logs()
                .iter()
                .filter(|v| v["result"]["decision"] == "accept")
                .count(),
            1
        );
        rt.shutdown().await.unwrap();
        assert!(rt.list_permissions(None).is_empty());
    }
);
case!(
    generation_change_during_prepare_denies_model_and_pin_survives_new_entry,
    {
        let f = Fixture::new();
        std::fs::write(f.home.join("block-config"), "yes").unwrap();
        let (rt, guard) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut turn = rt.execute(key("one"), input("normal")).await.unwrap();
        until(|| f.home.join("config-entered").exists()).await;
        guard.clear_cache().unwrap();
        std::fs::write(f.home.join("release-config"), "yes").unwrap();
        assert!(!matches!(
            turn.wait().await.unwrap().turn.outcome,
            Outcome::Success
        ));
        assert!(f.logs().iter().all(|v| v["method"] != "turn/start"));
        std::fs::rename(&f.cwd, f.home.join("old-project")).unwrap();
        std::fs::create_dir(&f.cwd).unwrap();
        assert!(matches!(
            rt.execute(key("one"), input("normal")).await,
            Err(RuntimeError::Session)
        ));
        assert_eq!(rt.host_count(), 1);
        rt.shutdown().await.unwrap();
    }
);
case!(
    drop_runtime_cancels_owned_blocked_preparation_without_waiting_for_caller,
    {
        let f = Fixture::new();
        let probe = Arc::new(ScriptProbe {
            loc: "US",
            calls: AtomicUsize::new(0),
            block: true,
            entered: tokio::sync::Notify::new(),
        });
        let (rt, _) = f.runtime(probe.clone(), RuntimeConfig::default());
        let future = rt.execute(key("one"), input("normal"));
        probe.entered.notified().await;
        drop(rt);
        assert!(matches!(future.await, Err(RuntimeError::Closed)));
        assert!(!f.home.join("pids.json").exists());
        f.driver.shutdown(Duration::from_secs(1)).await.unwrap();
    }
);
case!(
    forged_deferred_metadata_is_rejected_before_probe_or_receipt,
    {
        let f = Fixture::new();
        let probe = probe("US");
        let (rt, _) = f.runtime(probe.clone(), RuntimeConfig::default());
        let mut forged = input("normal");
        forged.metadata.question_id = Some(1);
        assert!(matches!(
            rt.execute(key("one"), forged).await,
            Err(RuntimeError::Unsupported)
        ));
        assert_eq!(probe.calls.load(Ordering::Acquire), 0);
        assert!(f.journal().is_empty());
        rt.shutdown().await.unwrap();
    }
);
case!(
    stop_cancels_network_preparation_before_any_driver_receipt,
    {
        let f = Fixture::new();
        let probe = Arc::new(ScriptProbe {
            loc: "US",
            calls: AtomicUsize::new(0),
            block: true,
            entered: tokio::sync::Notify::new(),
        });
        let (rt, _) = f.runtime(probe.clone(), RuntimeConfig::default());
        let future = rt.execute(key("one"), input("normal"));
        probe.entered.notified().await;
        assert!(rt.stop(&key("one"), None).unwrap());
        assert!(matches!(future.await, Err(RuntimeError::Cancelled)));
        assert!(!f.home.join("pids.json").exists());
        assert!(f.journal().is_empty());
        rt.shutdown().await.unwrap();
    }
);
struct BlockPermissionSink {
    sink: Arc<JournalSink>,
    entered: tokio::sync::Notify,
    release: Arc<tokio::sync::Semaphore>,
}
impl pult_core::turn_driver::EventSink for BlockPermissionSink {
    fn append(
        &self,
        draft: Value,
    ) -> pult_core::turn_driver::Task<
        Result<pult_core::turn_driver::Receipt, pult_core::turn_driver::SinkError>,
    > {
        let blocked = draft["kind"] == "permission.requested";
        let sink = self.sink.clone();
        let release = self.release.clone();
        if blocked {
            self.entered.notify_one();
        }
        Box::pin(async move {
            if blocked {
                release.acquire_owned().await.unwrap().forget();
                return Err(pult_core::turn_driver::SinkError {
                    message: "test late unknown write".into(),
                });
            }
            sink.append(draft).await
        })
    }
}
case!(
    shutdown_waits_for_cancelled_broker_write_and_latches_its_late_failure,
    {
        let f = Fixture::new();
        let sink = Arc::new(BlockPermissionSink {
            sink: f.sink.clone(),
            entered: tokio::sync::Notify::new(),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
        });
        let (rt, _) = f.runtime_with_sink(probe("US"), RuntimeConfig::default(), sink.clone());
        let mut turn = rt.execute(key("one"), input("permit")).await.unwrap();
        turn.accepted().await.unwrap();
        sink.entered.notified().await;
        let mut shutdown = rt.shutdown();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), shutdown.as_mut())
                .await
                .is_err()
        );
        sink.release.add_permits(1);
        shutdown.await.unwrap();
        assert!(f.driver.storage_failed());
        assert!(rt.list_permissions(None).is_empty());
        assert!(f.logs().iter().all(|v| v["result"]["decision"] != "accept"));
    }
);
case!(
    owned_curl_shutdown_joins_a_stalled_probe_before_returning,
    {
        let f = Fixture::new();
        let program = f.home.join("fake-curl");
        let pidfile = f.home.join("curl.pid");
        std::fs::write(&program,format!("#!/usr/bin/python3\nimport os,pathlib,threading\npathlib.Path({:?}).write_text(str(os.getpid()))\nthreading.Event().wait()\n",pidfile.to_str().unwrap())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let parent: Environment = [
            ("HOME".into(), f.home.clone().into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]
        .into_iter()
        .collect();
        let curl =
            Arc::new(pult_core::network_guard::CurlProbe::with_program(&program, &parent).unwrap());
        let rt = CodexRuntime::new(
            Dependencies {
                home: f.home.clone(),
                registry: f.registry.clone(),
                consent: f.consent.clone(),
                driver: f.driver.clone(),
                sink: f.sink.clone(),
            },
            RuntimeConfig::default(),
            TrustedCommand {
                holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
                program: "/usr/bin/python3".into(),
                prefix_args: vec![
                    "-c".into(),
                    "raise RuntimeError('unexpected provider spawn')".into(),
                ],
            },
            parent,
            Network::OwnedCurl(curl.clone()),
            Limits::default(),
        )
        .unwrap();
        let result = rt.execute(key("one"), input("normal"));
        until(|| pidfile.exists()).await;
        let pid = std::fs::read_to_string(&pidfile).unwrap();
        assert!(curl.active_jobs() > 0);
        rt.shutdown().await.unwrap();
        assert_eq!(curl.active_jobs(), 0);
        assert!(matches!(result.await, Err(RuntimeError::Closed)));
        assert!(f.journal().is_empty());
        let status = std::process::Command::new("/bin/ps")
            .args(["-p", pid.trim(), "-o", "stat="])
            .output()
            .unwrap();
        assert!(status.stdout.is_empty());
    }
);
case!(
    new_generation_gets_a_distinct_host_and_shutdown_proves_all_warm_processes_stopped,
    {
        let f = Fixture::new();
        let (rt, guard) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut first = rt.execute(key("one"), input("normal")).await.unwrap();
        first.wait().await.unwrap();
        let mut pids: Vec<u32> =
            serde_json::from_slice(&std::fs::read(f.home.join("pids.json")).unwrap()).unwrap();
        guard.clear_cache().unwrap();
        let mut second = rt.execute(key("one"), input("normal")).await.unwrap();
        second.wait().await.unwrap();
        let latest: Vec<u32> =
            serde_json::from_slice(&std::fs::read(f.home.join("pids.json")).unwrap()).unwrap();
        pids.extend(latest);
        assert_eq!(rt.host_count(), 2);
        assert_eq!(
            f.logs()
                .iter()
                .filter(|v| v["method"] == "initialize")
                .count(),
            2
        );
        rt.shutdown().await.unwrap();
        for pid in pids {
            let status = std::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .unwrap();
            assert!(status.stdout.is_empty());
        }
        assert!(matches!(
            rt.execute(key("one"), input("normal")).await,
            Err(RuntimeError::Closed)
        ));
    }
);
case!(stale_stop_is_a_noop_for_finished_missing_or_reused_turns, {
    let f = Fixture::new();
    let (rt, _) = f.runtime(probe("US"), RuntimeConfig::default());
    let mut first = rt.execute(key("one"), input("normal")).await.unwrap();
    let old = first.accepted().await.unwrap().turn_id;
    first.wait().await.unwrap();
    let mut next = rt.execute(key("one"), input("hold")).await.unwrap();
    let current = next.accepted().await.unwrap().turn_id;
    let mut other = rt.execute(key("two"), input("hold")).await.unwrap();
    other.accepted().await.unwrap();
    assert_ne!(old, current);
    assert!(!rt.stop(&key("one"), Some(&old)).unwrap());
    assert!(!rt.stop(&key("missing"), Some(&old)).unwrap());
    assert_eq!(f.driver.active_count(), 2);
    assert!(rt.stop(&key("one"), Some(&current)).unwrap());
    assert_eq!(
        next.wait().await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
    assert!(!rt.stop(&key("one"), Some(&old)).unwrap());
    assert_eq!(f.driver.active_count(), 1);
    rt.shutdown().await.unwrap();
    assert_eq!(
        other.wait().await.unwrap().turn.outcome,
        Outcome::Interrupted
    );
});
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_shutdown_callers_cannot_erase_terminal_success() {
    test_panic_guard();
    tokio::time::timeout(WAIT, async {
        let f = Fixture::new();
        let probe = Arc::new(ScriptProbe {
            loc: "US",
            calls: AtomicUsize::new(0),
            block: true,
            entered: tokio::sync::Notify::new(),
        });
        let (rt, _) = f.runtime(probe.clone(), RuntimeConfig::default());
        let preparation = rt.execute(key("one"), input("normal"));
        probe.entered.notified().await;
        let first = rt.shutdown();
        let barrier = Arc::new(tokio::sync::Barrier::new(17));
        let mut callers = vec![];
        for _ in 0..16 {
            let rt = rt.clone();
            let barrier = barrier.clone();
            callers.push(tokio::spawn(async move {
                barrier.wait().await;
                for _ in 0..64 {
                    rt.shutdown().await.unwrap();
                    tokio::task::yield_now().await;
                }
            }));
        }
        barrier.wait().await;
        first.await.unwrap();
        for caller in callers {
            caller.await.unwrap();
        }
        assert!(matches!(preparation.await, Err(RuntimeError::Closed)));
        rt.shutdown().await.unwrap();
    })
    .await
    .expect("concurrent shutdown watchdog");
}
case!(
    stop_reentered_from_driver_redactor_cancels_the_new_ticket,
    {
        let mut f = Fixture::new();
        let slot = Arc::new(Mutex::new(None::<std::sync::Weak<CodexRuntime>>));
        let reference = slot.clone();
        let once = Arc::new(AtomicUsize::new(0));
        let mark = once.clone();
        f.driver = Arc::new(
            Driver::new(
                f.sink.clone(),
                Arc::new(move |text| {
                    if mark.fetch_add(1, Ordering::AcqRel) == 0 {
                        assert!(
                            reference
                                .lock()
                                .unwrap()
                                .as_ref()
                                .unwrap()
                                .upgrade()
                                .unwrap()
                                .stop(&key("one"), None)
                                .unwrap()
                        );
                    }
                    pult_core::redaction::redact_string(text)
                }),
                Options::default(),
            )
            .unwrap(),
        );
        let (rt, _) = f.runtime(probe("US"), RuntimeConfig::default());
        *slot.lock().unwrap() = Some(Arc::downgrade(&rt));
        let mut turn = rt.execute(key("one"), input("normal")).await.unwrap();
        assert_eq!(
            turn.wait().await.unwrap().turn.outcome,
            Outcome::Interrupted
        );
        assert!(f.logs().iter().all(|v| v["method"] != "turn/start"));
        rt.shutdown().await.unwrap();
    }
);

case!(
    steering_is_exact_active_ticket_no_fallback_or_fake_receipt,
    {
        let f = Fixture::new();
        let (runtime, _) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut one = runtime
            .execute(key("one"), input("hold one"))
            .await
            .unwrap();
        let accepted = one.accepted().await.unwrap();
        let mut two = runtime
            .execute(key("two"), input("hold two"))
            .await
            .unwrap();
        two.accepted().await.unwrap();
        let mut forged = input("forged steering receipt");
        forged.metadata.queue_item_id = Some("untrusted".into());
        forged.metadata.queue_item_at = Some("untrusted".into());
        assert_eq!(
            runtime.steer(&key("one"), forged).await.unwrap_err().code,
            "invalid_params"
        );
        let before = f
            .journal()
            .iter()
            .filter(|e| e["kind"] == "message.user")
            .count();
        assert_eq!(
            runtime
                .steer(&key("one"), input("reject-steer"))
                .await
                .unwrap_err()
                .code,
            "invalid_params"
        );
        assert_eq!(
            f.journal()
                .iter()
                .filter(|e| e["kind"] == "message.user")
                .count(),
            before
        );
        assert_eq!(
            runtime.steer(&key("one"), input("clarify")).await.unwrap(),
            accepted.turn_id
        );
        let sent = f
            .logs()
            .into_iter()
            .find(|e| e["method"] == "turn/steer")
            .unwrap();
        assert_eq!(sent["params"]["expectedTurnId"], "native-turn-2");
        assert_eq!(
            f.logs()
                .iter()
                .filter(|e| e["method"] == "turn/start")
                .count(),
            2
        );
        let outside = runtime.clone();
        let response = std::thread::spawn(move || {
            outside.steer(&key("one"), input("outside runtime context"))
        })
        .join()
        .unwrap();
        assert_eq!(response.await.unwrap(), accepted.turn_id);
        runtime.stop(&key("one"), None).unwrap();
        one.wait().await.unwrap();
        assert!(runtime.steer(&key("one"), input("late")).await.is_err());
        assert!(f.driver.active_ticket(&key("two")).is_some());
        runtime.stop(&key("two"), None).unwrap();
        two.wait().await.unwrap();
        runtime.shutdown().await.unwrap();
    }
);

case!(
    unknown_steer_is_not_receipted_or_replayed_and_other_session_survives,
    {
        let f = Fixture::new();
        let (runtime, _) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut one = runtime
            .execute(key("one"), input("hold one"))
            .await
            .unwrap();
        one.accepted().await.unwrap();
        let mut two = runtime
            .execute(key("two"), input("hold two"))
            .await
            .unwrap();
        two.accepted().await.unwrap();
        assert_eq!(
            runtime
                .steer(&key("one"), input("unknown-steer"))
                .await
                .unwrap_err()
                .code,
            "send_unknown"
        );
        assert_eq!(
            f.logs()
                .iter()
                .filter(|e| e["method"] == "turn/steer")
                .count(),
            1
        );
        assert!(
            !f.journal()
                .iter()
                .any(|e| e["kind"] == "message.user" && e["data"]["text"] == "unknown-steer")
        );
        assert!(f.driver.active_ticket(&key("two")).is_some());
        runtime.stop(&key("one"), None).unwrap();
        one.wait().await.unwrap();
        runtime.stop(&key("two"), None).unwrap();
        two.wait().await.unwrap();
        runtime.shutdown().await.unwrap();
    }
);

case!(
    steer_uses_exact_lease_host_after_same_route_host_replacement,
    {
        let f = Fixture::new();
        let (runtime, _) = f.runtime(probe("US"), RuntimeConfig::default());
        let mut first = runtime.execute(key("one"), input("normal")).await.unwrap();
        first.wait().await.unwrap();
        let thread = f
            .registry
            .lock()
            .unwrap()
            .find("one")
            .unwrap()
            .scalar("providerSessionId")
            .unwrap();
        let pids: Vec<i32> =
            serde_json::from_slice(&std::fs::read(f.home.join("pids.json")).unwrap()).unwrap();
        std::fs::write(f.home.join("autoturn"), thread).unwrap();
        until(|| {
            pids.iter()
                .all(|pid| nix::sys::signal::kill(nix::unistd::Pid::from_raw(*pid), None).is_err())
        })
        .await;
        std::fs::remove_file(f.home.join("autoturn")).unwrap();
        let mut second = runtime
            .execute(key("one"), input("hold replacement"))
            .await
            .unwrap();
        let accepted = second.accepted().await.unwrap();
        assert_eq!(runtime.host_count(), 2);
        assert_eq!(
            runtime
                .steer(&key("one"), input("clarify replacement"))
                .await
                .unwrap(),
            accepted.turn_id
        );
        assert_eq!(
            f.logs()
                .iter()
                .filter(|r| r["method"] == "turn/steer")
                .count(),
            1
        );
        runtime.stop(&key("one"), None).unwrap();
        second.wait().await.unwrap();
        runtime.shutdown().await.unwrap();
    }
);

struct BlockInterruptTail {
    sink: Arc<JournalSink>,
    entered: tokio::sync::Notify,
    committed: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
}
impl pult_core::turn_driver::EventSink for BlockInterruptTail {
    fn append(
        &self,
        draft: Value,
    ) -> pult_core::turn_driver::Task<
        Result<pult_core::turn_driver::Receipt, pult_core::turn_driver::SinkError>,
    > {
        let blocked = draft["sessionId"] == "one" && draft["kind"] == "message.done";
        let sink = self.sink.clone();
        let release = self.release.clone();
        let committed = self.committed.clone();
        if blocked {
            self.entered.notify_one();
        }
        Box::pin(async move {
            if blocked {
                release.acquire_owned().await.unwrap().forget();
            }
            let result = sink.append(draft).await;
            if blocked {
                committed.notify_one();
            }
            result
        })
    }
}
case!(
    short_close_budget_quarantines_owned_tail_then_explicit_retry_finishes,
    {
        let f = Fixture::with_options(Options {
            close_timeout: Duration::from_millis(200),
            ..Default::default()
        });
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        // A failed assertion must not leave the deliberately held append alive.
        struct Release(Arc<tokio::sync::Semaphore>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.add_permits(1);
            }
        }
        let unblock = Release(release.clone());
        let sink = Arc::new(BlockInterruptTail {
            sink: f.sink.clone(),
            entered: tokio::sync::Notify::new(),
            committed: Arc::new(tokio::sync::Notify::new()),
            release,
        });
        let (rt, _) = f.runtime_with_sink(probe("US"), RuntimeConfig::default(), sink.clone());
        // A native terminal does not finish ownership while an earlier event's
        // durable append is still pending. Inject a real routed tail frame.
        let script = f.home.join("app_server.py");
        let source = std::fs::read_to_string(&script).unwrap();
        let source = source.replace("        if item and item['turn'] == params['turnId'] and item['mode'] != 'never-interrupt':\n            finish(thread, status='interrupted')", "        if item and item['turn'] == params['turnId'] and item['mode'] != 'never-interrupt':\n            notification('item/completed', thread, params['turnId'], item={'type':'agentMessage','id':'interrupt-tail','text':'owned interrupt tail','phase':'final_answer'})\n            finish(thread, status='interrupted')");
        assert!(source.contains("owned interrupt tail"));
        std::fs::write(&script, source).unwrap();
        let mut a = rt.execute(key("one"), input("hold")).await.unwrap();
        let aa = a.accepted().await.unwrap();
        let mut b = rt.execute(key("two"), input("hold")).await.unwrap();
        b.accepted().await.unwrap();
        assert!(rt.stop(&key("one"), Some(&aa.turn_id)).unwrap());
        sink.entered.notified().await;
        let result = a.wait().await;
        if let Err(error) = &result {
            eprintln!("controlled owned tail wait error: {error:?}");
        }
        // A timeout is not a terminal outcome or proof that the owned append ended.
        assert!(matches!(
            result,
            Err(pult_core::turn_driver::DriverError::CleanupUnconfirmed)
        ));
        assert!(
            matches!(a.progress(), pult_core::turn_driver::Progress::Quarantined(Outcome::Failure { code, .. }) if code == "cleanup_timeout")
        );
        assert!(matches!(
            b.progress(),
            pult_core::turn_driver::Progress::Running(_)
        ));
        assert_eq!(f.driver.active_count(), 2);
        assert!(!f.journal().iter().any(|row| row["sessionId"] == "one"
            && row["kind"] == "status.changed"
            && row["data"]["status"] == "done"));
        assert_eq!(
            f.logs()
                .iter()
                .filter(|row| row["method"] == "turn/interrupt")
                .count(),
            1
        );
        drop(unblock);
        sink.committed.notified().await;
        // The same public turn identity explicitly retries cleanup, never model IO.
        assert!(rt.stop(&key("one"), Some(&aa.turn_id)).unwrap());
        assert_eq!(a.wait().await.unwrap().turn.outcome, Outcome::Interrupted);
        assert_eq!(f.driver.active_count(), 1);
        assert!(matches!(
            b.progress(),
            pult_core::turn_driver::Progress::Running(_)
        ));
        assert_eq!(
            f.logs()
                .iter()
                .filter(|row| row["method"] == "turn/start")
                .count(),
            2
        );
        assert_eq!(rt.host_count(), 1);
        std::fs::write(f.home.join("release"), "yes").unwrap();
        assert_eq!(b.wait().await.unwrap().turn.outcome, Outcome::Success);
        rt.shutdown().await.unwrap();
    }
);

// Exact-ticket native approval journal ownership regressions.
struct AuditResolvedSink {
    sink: Arc<JournalSink>,
    serial: Arc<tokio::sync::Mutex<()>>,
    live: Arc<Mutex<pult_core::session_live::Cache>>,
    blocked: std::sync::atomic::AtomicBool,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
    committed: Arc<tokio::sync::Notify>,
}
impl AuditResolvedSink {
    fn new(sink: Arc<JournalSink>) -> Arc<Self> {
        let mut live = pult_core::session_live::Cache::new(4).unwrap();
        live.seed(key("one"), pult_core::session_live::Status::Cold, 0)
            .unwrap();
        live.seed(key("two"), pult_core::session_live::Status::Cold, 0)
            .unwrap();
        Arc::new(Self {
            sink,
            serial: Arc::new(tokio::sync::Mutex::new(())),
            live: Arc::new(Mutex::new(live)),
            blocked: std::sync::atomic::AtomicBool::new(false),
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Arc::new(tokio::sync::Semaphore::new(0)),
            committed: Arc::new(tokio::sync::Notify::new()),
        })
    }
    fn status(&self, name: &str) -> pult_core::session_live::Status {
        self.live.lock().unwrap().view(&key(name)).unwrap().status
    }
}
impl pult_core::turn_driver::EventSink for AuditResolvedSink {
    fn append(
        &self,
        draft: Value,
    ) -> pult_core::turn_driver::Task<
        Result<pult_core::turn_driver::Receipt, pult_core::turn_driver::SinkError>,
    > {
        let block = draft["sessionId"] == "one"
            && draft["kind"] == "permission.resolved"
            && !self.blocked.swap(true, Ordering::SeqCst);
        let sink = self.sink.clone();
        let serial = self.serial.clone();
        let live = self.live.clone();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let committed = self.committed.clone();
        Box::pin(async move {
            if block {
                entered.notify_one();
                release.acquire_owned().await.unwrap().forget();
            }
            // This is only the host's normal global journal/projection ordering.
            // The test barrier is before it so unrelated/new events can commit.
            let _serial = serial.lock().await;
            let receipt = sink.append(draft.clone()).await?;
            live.lock().unwrap().note(
                draft["sessionId"].as_str().unwrap(),
                receipt.id,
                draft["kind"].as_str().unwrap(),
                &draft["data"],
            );
            if block {
                committed.notify_one();
            }
            Ok(receipt)
        })
    }
}
struct AuditRelease(Arc<tokio::sync::Semaphore>);
impl Drop for AuditRelease {
    fn drop(&mut self) {
        self.0.add_permits(1);
    }
}
fn audit_fixture() -> (Fixture, Arc<AuditResolvedSink>) {
    let mut fixture = Fixture::new();
    let sink = AuditResolvedSink::new(fixture.sink.clone());
    fixture.driver = Arc::new(
        Driver::new(
            sink.clone(),
            Arc::new(pult_core::redaction::redact_string),
            Options::default(),
        )
        .unwrap(),
    );
    (fixture, sink)
}

fn audit_unique_native_ids(fixture: &Fixture) {
    // The baseline fake numbers threads from one in each process. A retired
    // host plus a new shared neighbor would otherwise alias a resumed ID.
    let path = fixture.home.join("app_server.py");
    let source = std::fs::read_to_string(&path).unwrap().replace(
        "'native-thread-' + str(sequence)",
        "'native-audit-' + str(os.getpid()) + '-' + str(sequence)",
    );
    std::fs::write(path, source).unwrap();
}

async fn audit_process_stopped(fixture: &Fixture) {
    let pids: Vec<u32> =
        serde_json::from_slice(&std::fs::read(fixture.home.join("pids.json")).unwrap()).unwrap();
    until(|| {
        pids.iter().all(|pid| {
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(*pid as i32), None).is_err()
        })
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_codex_permission_resolved_io_must_hold_exact_ticket_until_drained() {
    test_panic_guard();
    tokio::time::timeout(WAIT, async {
        let (f, sink) = audit_fixture();
        let release = AuditRelease(sink.release.clone());
        let (runtime, _) = f.runtime_with_sink(probe("US"), RuntimeConfig::default(), sink.clone());
        audit_unique_native_ids(&f);
        let mut turn = runtime.execute(key("one"), input("permit")).await.unwrap();
        turn.accepted().await.unwrap();
        until(|| !runtime.list_permissions(Some("one")).is_empty()).await;
        let ticket = turn.ticket().clone();
        assert!(f.driver.cancel(&ticket));
        sink.entered.notified().await;
        audit_process_stopped(&f).await;
        let returned_while_blocked = matches!(tokio::time::timeout(Duration::from_secs(1), turn.wait()).await, Ok(Ok(_)));
        let active_before_release = f.driver.active_count();
        eprintln!("AUDIT host_stopped=true; returned_while_resolved_blocked={returned_while_blocked}; active_before_release={active_before_release}");
        drop(release);
        sink.committed.notified().await;
        if turn.wait().await.is_err() { f.driver.cancel(&ticket); turn.wait().await.unwrap(); }
        runtime.shutdown().await.unwrap();
        assert!(!returned_while_blocked, "Driver wait returned while old permission.resolved IO remained owned");
        assert_eq!(active_before_release, 1, "old exact Ticket was released before its permission journal outcome");
        assert!(f.logs().iter().all(|row| row["result"]["decision"] != "accept"));
    }).await.expect("audit watchdog");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_codex_next_ticket_waits_old_resolution_but_other_session_is_independent() {
    test_panic_guard();
    tokio::time::timeout(WAIT, async {
        let (f, sink) = audit_fixture();
        let release = AuditRelease(sink.release.clone());
        let (runtime, _) = f.runtime_with_sink(probe("US"), RuntimeConfig::default(), sink.clone());
        audit_unique_native_ids(&f);
        let mut first = runtime.execute(key("one"), input("permit")).await.unwrap();
        first.accepted().await.unwrap();
        until(|| !runtime.list_permissions(Some("one")).is_empty()).await;
        let old_id = runtime.list_permissions(Some("one"))[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(f.driver.cancel(first.ticket()));
        sink.entered.notified().await;
        audit_process_stopped(&f).await;
        assert_eq!(f.driver.active_count(), 1);
        assert!(matches!(
            runtime.execute(key("one"), input("must-not-start")).await,
            Err(RuntimeError::Busy)
        ));
        assert_eq!(
            f.journal()
                .iter()
                .filter(|row| row["sessionId"] == "one" && row["kind"] == "message.user")
                .count(),
            1
        );
        // A different session can acquire its own real question while the old
        // session's IO remains blocked; cleanup must not use global Broker.drain.
        let mut neighbor = runtime.execute(key("two"), input("permit")).await.unwrap();
        neighbor.accepted().await.unwrap();
        until(|| !runtime.list_permissions(Some("two")).is_empty()).await;
        let neighbor_id = runtime.list_permissions(Some("two"))[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(
            sink.status("two"),
            pult_core::session_live::Status::BlockedPermission
        );
        drop(release);
        sink.committed.notified().await;
        if first.wait().await.is_err() {
            f.driver.cancel(first.ticket());
            first.wait().await.unwrap();
        }
        assert!(
            runtime
                .list_permissions(Some("two"))
                .iter()
                .any(|card| card["id"] == neighbor_id)
        );
        assert_eq!(
            sink.status("two"),
            pult_core::session_live::Status::BlockedPermission
        );
        let mut second = runtime.execute(key("one"), input("permit")).await.unwrap();
        second.accepted().await.unwrap();
        until(|| !runtime.list_permissions(Some("one")).is_empty()).await;
        let new_id = runtime.list_permissions(Some("one"))[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(new_id, old_id);
        assert_eq!(
            sink.status("one"),
            pult_core::session_live::Status::BlockedPermission
        );
        eprintln!(
            "AUDIT early_next=busy; neighbor_pending_through_old_drain=true; next_status={}",
            sink.status("one").as_str()
        );
        assert!(f.driver.cancel(second.ticket()));
        second.wait().await.unwrap();
        assert!(
            runtime
                .list_permissions(Some("two"))
                .iter()
                .any(|card| card["id"] == neighbor_id)
        );
        assert!(f.driver.cancel(neighbor.ticket()));
        neighbor.wait().await.unwrap();
        runtime.shutdown().await.unwrap();
        assert!(
            f.logs()
                .iter()
                .all(|row| row["result"]["decision"] != "accept")
        );
    })
    .await
    .expect("audit watchdog");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_codex_provider_terminal_drops_handler_but_still_joins_question_io() {
    test_panic_guard();
    tokio::time::timeout(WAIT, async {
        let (f, sink) = audit_fixture();
        let release = AuditRelease(sink.release.clone());
        let (runtime, _) = f.runtime_with_sink(probe("US"), RuntimeConfig::default(), sink.clone());
        audit_unique_native_ids(&f);
        let mut turn = runtime
            .execute(key("one"), input("permit-terminal"))
            .await
            .unwrap();
        turn.accepted().await.unwrap();
        until(|| !runtime.list_permissions(Some("one")).is_empty()).await;
        std::fs::write(f.home.join("terminal"), "release actual provider terminal").unwrap();
        sink.entered.notified().await;
        audit_process_stopped(&f).await;
        let released_early = matches!(
            tokio::time::timeout(Duration::from_secs(1), turn.wait()).await,
            Ok(Ok(_))
        );
        let active = f.driver.active_count();
        drop(release);
        sink.committed.notified().await;
        if turn.wait().await.is_err() {
            f.driver.cancel(turn.ticket());
            turn.wait().await.unwrap();
        }
        runtime.shutdown().await.unwrap();
        assert!(
            !released_early,
            "native terminal dropped question ownership before journal drain"
        );
        assert_eq!(active, 1);
        assert!(
            f.logs()
                .iter()
                .all(|row| row["result"]["decision"] != "accept")
        );
    })
    .await
    .expect("audit watchdog");
}
