//! Real Driver/Owner metadata with deliberately unused process/resources.
//! Actual daemon/holder/shared-MCP acceptance is a separate Root suite.
use super::*;
use crate::{
    journal::EventStore,
    registry::Record,
    turn_driver::{Options, Started},
    turn_journal::JournalSink,
    zcode_host_services::{AppServerInputFrontier, HostInputIds, ReserveRequest},
};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use zcode_appserver_worker::{PreparedResources, ResourceContext, ResourcePermit, ScopedResources};
struct NeverResources;
impl ScopedResources for NeverResources {
    fn prepare(&self, _: ResourceContext) -> Task<Result<PreparedResources, WorkerError>> {
        unreachable!("gate fixture never starts app-server worker")
    }
    fn catalog(&self, _: Ticket, _: u64) -> Task<Result<Option<String>, WorkerError>> {
        unreachable!()
    }
    fn check<'a>(
        &'a self,
        _: &'a AppServerInputFrontier<'_>,
        _: &Ticket,
        _: u64,
    ) -> Result<Box<dyn ResourcePermit + 'a>, WorkerError> {
        unreachable!()
    }
    fn revoke(&self, _: &Ticket, _: u64) {}
    fn drain(&self, _: Ticket, _: u64) -> Task<Result<(), WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
struct HoldingWorker(Arc<Notify>);
impl Worker for HoldingWorker {
    fn start(&self, _: Ticket, _: TurnSnapshot, _: String) -> Task<Result<Started, WorkerError>> {
        let entered = self.0.clone();
        Box::pin(async move {
            entered.notify_one();
            std::future::pending().await
        })
    }
    fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
struct ProbeFixture;
impl crate::network_guard::Probe for ProbeFixture {
    fn probe<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
        _: Duration,
    ) -> crate::network_guard::ProbeFuture<'a> {
        Box::pin(async {
            crate::network_guard::ProbeResult {
                status: Some(0),
                stdout: b"loc=US\n".to_vec(),
                stderr_bytes: 0,
            }
        })
    }
}
struct Rig {
    _temp: tempfile::TempDir,
    runtime: ZcodeRuntime,
    owner: Arc<ZcodeOwner>,
    source: Arc<Source>,
    snapshot: TurnSnapshot,
    handle: Handle,
}
impl Rig {
    async fn new(selected: DispatchRoute) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let mut events = EventStore::open(&home.join("events")).unwrap();
        let mut registry = Registry::open(&home, &mut events).unwrap();
        let key = SessionKey {
            name: "one".into(),
            created_at: "2026-11-13T00:00:00Z".into(),
        };
        let mut record = Record::default();
        for (k, v) in [
            ("name", key.name.as_str()),
            ("createdAt", key.created_at.as_str()),
            ("provider", "zcode"),
            ("approval", "ask"),
            ("cwd", cwd.to_str().unwrap()),
        ] {
            record.set_string(k, v);
        }
        record.set_raw(
            "memory",
            serde_json::value::to_raw_value(
                &json!({"read":selected==DispatchRoute::AppServer,"write":"off"}),
            )
            .unwrap(),
        );
        registry.insert(record).unwrap();
        let registry = Arc::new(Mutex::new(registry));
        let sink = Arc::new(JournalSink::new(Arc::new(Mutex::new(events))).unwrap());
        let driver = Arc::new(
            Driver::new(
                sink.clone(),
                Arc::new(crate::redaction::redact_string),
                Options::default(),
            )
            .unwrap(),
        );
        let guard = Arc::new(NetworkGuard::new(Arc::new(ProbeFixture)));
        let config = RuntimeConfig::default();
        let check = guard
            .check(
                Provider::Zcode,
                &config.network.zcode,
                &config.guard.as_network_rule(),
                false,
            )
            .await
            .unwrap();
        let program = std::env::current_exe().unwrap();
        let runtime = ZcodeRuntime::new(
            Dependencies {
                home: home.clone(),
                registry: registry.clone(),
                consent: Arc::new(Mutex::new(ConsentStore::open(&home).unwrap())),
                driver: driver.clone(),
                sink: sink.clone(),
            },
            TrustedCommand {
                holder: program.clone(),
                program: program.clone(),
                prefix_args: vec![],
            },
            config,
            Environment::from([
                ("HOME".into(), home.clone().into_os_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
            Environment::new(),
            guard,
            Limits::default(),
        )
        .unwrap();
        // Separate trusted Owner avoids a synthetic Runtime route callback while
        // constructing exact metadata; RuntimeInput itself is tested below.
        let owner = ZcodeOwner::new(
            home.clone(),
            registry,
            Arc::downgrade(&driver),
            runtime.inner.deps.consent.clone(),
            Arc::new(|_, _| true),
            Arc::new(|| {}),
        )
        .unwrap();
        let snapshot = owner.snapshot(&key).unwrap();
        let entered = Arc::new(Notify::new());
        let handle = driver
            .start_input(
                snapshot.clone(),
                Input {
                    text: "gate fixture".into(),
                    metadata: Default::default(),
                },
                Arc::new(HoldingWorker(entered.clone())),
                Arc::new(|_: &Ticket, _: &TurnSnapshot| {
                    crate::turn_driver::DispatchDecision::Allow
                }),
            )
            .unwrap();
        entered.notified().await;
        let request = ReserveRequest::new(
            handle.ticket().clone(),
            snapshot.clone(),
            1,
            "pult-gate-fixture".into(),
            Instant::now() + Duration::from_secs(30),
        );
        let attempt = if selected == DispatchRoute::AppServer {
            owner
                .reserve_app_server(
                    request,
                    HostInputIds::new("input-fixture".into(), "query-fixture".into()).unwrap(),
                )
                .unwrap()
                .attempt()
                .clone()
        } else {
            owner
                .reserve(
                    handle.ticket().clone(),
                    snapshot.clone(),
                    1,
                    "pult-gate-fixture".into(),
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap()
        };
        let source = Arc::new(Source {
            key: key.clone(),
            nonce: Arc::new(()),
            attempt: OnceLock::new(),
            selected,
        });
        source.attempt.set(attempt.clone()).unwrap();
        let launch = Launch {
            holder: program.clone(),
            program,
            args: vec![],
            cwd: cwd.clone(),
            env: Environment::from([
                ("HOME".into(), home.clone().into_os_string()),
                ("PATH".into(), "/usr/bin:/bin".into()),
            ]),
        };
        let worker = if selected == DispatchRoute::AppServer {
            RuntimeWorker::AppServer(
                ZcodeAppServerWorker::new(
                    zcode_appserver_worker::Config {
                        session: key.clone(),
                        home: home.clone(),
                        launch,
                        workspace_key: cwd.to_str().unwrap().into(),
                        native_mode: SessionMode::Guarded,
                        captured_approval: snapshot.settings.approval,
                        start_deadline: Instant::now() + Duration::from_secs(30),
                        reverse_timeout: Duration::from_secs(1),
                        permission_timeout: None,
                        attachments: vec![],
                        language: ContextLanguage::En,
                    },
                    zcode_appserver_worker::Services {
                        driver: Arc::downgrade(&driver),
                        owner: owner.clone(),
                        store: owner.app_server_store(),
                        sink,
                        gate: Arc::new(|_: &Ticket, _: &TurnSnapshot| {
                            crate::turn_driver::DispatchDecision::Allow
                        }),
                        spawn_gate: Arc::new(|_, _, _| Err(runtime_worker_error())),
                        reply_gate: None,
                        permission_slots: None,
                        input_gate: Arc::new(|_, _| Err(runtime_worker_error())),
                        resources: Arc::new(NeverResources),
                        interactions: Arc::new(zcode_appserver_worker::DenyInteractions),
                        redactors: Arc::new(|| Box::new(crate::zcode_events::LogRedactor)),
                        fatal_storage: Arc::new(|| {}),
                    },
                )
                .unwrap(),
            )
        } else {
            RuntimeWorker::Ordinary(
                ZcodeWorker::new(
                    Config {
                        session: key.clone(),
                        home: home.clone(),
                        launch,
                        attachments: vec![],
                        broker_context: true,
                        language: ContextLanguage::En,
                        start_timeout: Duration::from_secs(30),
                        terminal_grace: Duration::from_secs(1),
                    },
                    Services {
                        driver: Arc::downgrade(&driver),
                        sink,
                        gate: Arc::new(|_: &Ticket, _: &TurnSnapshot| {
                            crate::turn_driver::DispatchDecision::Allow
                        }),
                        store: owner.store(),
                        spawn_gate: Arc::new(|_, _, _| Err(runtime_worker_error())),
                        redactors: Arc::new(|| Box::new(crate::zcode_events::LogRedactor)),
                        fatal_storage: Arc::new(|| {}),
                        provider_signal: Arc::new(|_| {}),
                    },
                )
                .unwrap(),
            )
        };
        runtime.inner.shared.state.lock().unwrap().insert(
            key,
            Entry {
                worker: Some(worker),
                expected_resume: Some(None),
                recovery_slot: None,
                recovering: None,
                attempt: Some(attempt),
                source: Some(source.clone()),
                nonce: source.nonce.clone(),
                cancel: watch::channel(false).0,
                ticket: Some(handle.ticket().clone()),
                route: Some((check, Environment::new())),
                quarantined: false,
                progress: Some(handle.subscribe_progress()),
            },
        );
        Self {
            _temp: temp,
            runtime,
            owner,
            source,
            snapshot,
            handle,
        }
    }
    fn input(&self) -> RuntimeInput {
        RuntimeInput {
            shared: self.runtime.inner.shared.clone(),
            source: self.source.clone(),
            initial: self.snapshot.clone(),
            deadline: Instant::now() + Duration::from_secs(30),
        }
    }
    fn spawn(&self) -> RuntimeSpawn {
        RuntimeSpawn {
            shared: self.runtime.inner.shared.clone(),
            registry: self.runtime.inner.deps.registry.clone(),
            owner: self.owner.clone(),
            source: self.source.clone(),
            initial: self.snapshot.clone(),
        }
    }
    fn policy(&self, read: bool) {
        self.runtime
            .inner
            .deps
            .registry
            .lock()
            .unwrap()
            .update_checked(&self.source.key, |r| {
                r.set_raw(
                    "memory",
                    serde_json::value::to_raw_value(&json!({"read":read,"write":"off"})).unwrap(),
                );
                Ok(())
            })
            .unwrap();
    }
}
#[tokio::test]
async fn runtime_input_rejects_exact_nonce_source_resume_network_cancel_and_fault() {
    use zcode_appserver_worker::InputGate;
    for fault in 0..8 {
        let r = Rig::new(DispatchRoute::AppServer).await;
        assert!(r.input().enter().is_ok());
        {
            let mut entries = r.runtime.inner.shared.state.lock().unwrap();
            let e = entries.get_mut(&r.source.key).unwrap();
            match fault {
                0 => e.nonce = Arc::new(()),
                1 => e.expected_resume = Some(Some("foreign".into())),
                2 => {
                    e.cancel.send_replace(true);
                }
                3 => e.quarantined = true,
                4 => {
                    e.source = Some(Arc::new(Source {
                        key: r.source.key.clone(),
                        nonce: r.source.nonce.clone(),
                        attempt: OnceLock::new(),
                        selected: DispatchRoute::AppServer,
                    }))
                }
                _ => {}
            }
        }
        match fault {
            5 => {
                r.runtime.inner.shared.guard.clear_cache().unwrap();
            }
            6 => {
                r.runtime.inner.deps.driver.report_storage_failure();
            }
            7 => {
                r.runtime.inner.shared.closed.send_replace(true);
            }
            _ => {}
        }
        assert!(r.input().enter().is_err());
        r.runtime.inner.deps.driver.cancel(r.handle.ticket());
    }
}
#[tokio::test]
async fn borrowed_runtime_permit_holds_state_through_handoff_and_cancel_wins_before_enter() {
    use zcode_appserver_worker::InputGate;
    let r = Rig::new(DispatchRoute::AppServer).await;
    let gate = r.input();
    let permit = gate.enter().unwrap();
    assert!(matches!(
        r.runtime.inner.shared.state.try_lock(),
        Err(std::sync::TryLockError::WouldBlock)
    ));
    drop(permit);
    r.runtime.stop(&r.source.key, None).unwrap();
    assert!(gate.enter().is_err());
}
#[tokio::test]
async fn expired_input_deadline_rejects_before_waiting_for_runtime_state() {
    use zcode_appserver_worker::InputGate;
    let r = Rig::new(DispatchRoute::AppServer).await;
    let mut gate = r.input();
    gate.deadline = Instant::now() - Duration::from_secs(1);
    let _held = r.runtime.inner.shared.state.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let t = std::thread::spawn(move || {
        tx.send(gate.enter().is_err()).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
    t.join().unwrap();
}
#[tokio::test]
async fn ordinary_and_appserver_spawn_hold_registry_before_state_and_reject_policy_flip() {
    for route in [DispatchRoute::Ordinary, DispatchRoute::AppServer] {
        let r = Rig::new(route).await;
        let gate = r.spawn();
        r.policy(route != DispatchRoute::AppServer);
        assert!(gate.enter().is_err());
        r.policy(route == DispatchRoute::AppServer);
        let permit = gate.enter().unwrap();
        assert!(matches!(
            r.runtime.inner.deps.registry.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        assert!(matches!(
            r.runtime.inner.shared.state.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ));
        drop(permit);
    }
}

#[tokio::test]
async fn runtime_input_rejects_wrong_snapshot_incarnation_and_worker_route() {
    use zcode_appserver_worker::InputGate;
    let r = Rig::new(DispatchRoute::AppServer).await;
    let mut gate = r.input();
    gate.initial.settings.approval = crate::turn_snapshot::Approval::ReadOnly;
    assert!(gate.enter().is_err());
    let mut gate = r.input();
    let mut key = r.source.key.clone();
    key.created_at = "foreign-incarnation".into();
    let wrong = Arc::new(Source {
        key,
        nonce: r.source.nonce.clone(),
        attempt: OnceLock::new(),
        selected: DispatchRoute::AppServer,
    });
    wrong
        .attempt
        .set(r.source.attempt.get().unwrap().clone())
        .unwrap();
    gate.source = wrong;
    assert!(gate.enter().is_err());
    let ordinary = Rig::new(DispatchRoute::Ordinary).await;
    let other = ordinary
        .runtime
        .inner
        .shared
        .state
        .lock()
        .unwrap()
        .get_mut(&ordinary.source.key)
        .unwrap()
        .worker
        .take()
        .unwrap();
    r.runtime
        .inner
        .shared
        .state
        .lock()
        .unwrap()
        .get_mut(&r.source.key)
        .unwrap()
        .worker = Some(other);
    assert!(r.input().enter().is_err());
}
#[tokio::test]
async fn poisoned_registry_mutex_is_rejected_before_runtime_state_acquisition() {
    let r = Rig::new(DispatchRoute::Ordinary).await;
    let registry = r.runtime.inner.deps.registry.clone();
    assert!(
        std::thread::spawn(move || {
            let _guard = registry.lock().unwrap();
            panic!("static registry poison fixture");
        })
        .join()
        .is_err()
    );
    let gate = r.spawn();
    let _state = r.runtime.inner.shared.state.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let t = std::thread::spawn(move || {
        tx.send(gate.enter().is_err()).unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
    t.join().unwrap();
}

#[tokio::test]
async fn no_backend_memory_on_is_explicitly_unsupported_before_dispatch() {
    let mut r = Rig::new(DispatchRoute::Ordinary).await;
    let attempt = r.source.attempt.get().unwrap().clone();
    assert!(attempt.cancel_before_spawn());
    r.runtime.inner.deps.driver.cancel(r.handle.ticket());
    r.handle.wait().await.unwrap();
    // The holding fixture has no native PID or external IO and Driver has joined it.
    r.owner
        .clear_never_sent(
            &attempt,
            crate::zcode_host_services::JoinedCleanup::from_owned_join(&attempt),
        )
        .unwrap();
    r.runtime.inner.shared.state.lock().unwrap().clear();
    r.runtime.inner.owner.set(r.owner.clone()).ok().unwrap();
    r.policy(true);
    let error = r
        .runtime
        .execute(
            r.source.key.clone(),
            Input {
                text: "must not silently run ordinary".into(),
                metadata: Default::default(),
            },
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error, RuntimeError::Unsupported);
    assert_eq!(r.runtime.inner.deps.driver.active_count(), 0);
    assert!(
        r.runtime
            .inner
            .deps
            .registry
            .lock()
            .unwrap()
            .find(&r.source.key.name)
            .unwrap()
            .get("zcodePendingInput")
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_native_approval_cannot_cross_replaced_current_source_or_worker_route() {
    use crate::permission_broker::{Decision, Scope};
    for fault in 0..6 {
        let f = crate::zcode_native_permissions::tests::Fixture::new().await;
        let mut handle = f.start().await;
        let card = f.card().await;
        {
            let mut entries = f.runtime.inner.shared.state.lock().unwrap();
            let entry = entries.get_mut(&f.key).unwrap();
            match fault {
                0 => {
                    let current = entry.source.as_ref().unwrap();
                    let replacement = Arc::new(Source {
                        key: current.key.clone(),
                        nonce: current.nonce.clone(),
                        attempt: OnceLock::new(),
                        selected: current.selected,
                    });
                    replacement
                        .attempt
                        .set(current.attempt.get().unwrap().clone())
                        .ok()
                        .unwrap();
                    entry.source = Some(replacement);
                }
                1 => entry.expected_resume = Some(Some("foreign-native-resume".into())),
                2 => {
                    entry.worker = None;
                }
                3 => {
                    f.runtime.inner.shared.guard.clear_cache().unwrap();
                }
                4 => {
                    entry.quarantined = true;
                }
                5 => {
                    entry.nonce = Arc::new(());
                }
                _ => unreachable!(),
            }
        }
        crate::permission_state::resolve(
            &f.state,
            card["id"].as_str().unwrap(),
            Decision::allow(Scope::Once),
            "fixture-owner",
        )
        .unwrap();
        let terminal = tokio::time::timeout(Duration::from_secs(15), handle.wait())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(
            terminal.turn.outcome,
            crate::turn_coordinator::Outcome::Success,
            "fault={fault}"
        );
        assert!(
            !f.proof().is_some_and(|p| p["decision"] == "allow"),
            "fault={fault}"
        );
        // Restore metadata-only diagnostics after exact Worker close so the
        // owning runtime can reap its original nonce normally.
        f.finish().await;
    }
}
