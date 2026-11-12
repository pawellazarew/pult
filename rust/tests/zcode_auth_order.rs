//! Real holder/Owner/Driver/runtime + a journal publication barrier; no account.
use pult_core::{
    consent_store::ConsentStore,
    journal::EventStore,
    network_guard::{NetworkGuard, Probe, ProbeFuture, ProbeResult},
    registry::{Record, Registry},
    runtime_config::RuntimeConfig,
    turn_coordinator::Outcome,
    turn_driver::{Driver, EventSink, Input, InputMetadata, Options, Receipt, SinkError, Task},
    turn_journal::JournalSink,
    turn_snapshot::SessionKey,
    worker_env::Environment,
    zcode_runtime::{Dependencies, Limits, RuntimeError, TrustedCommand, ZcodeRuntime},
};
use serde_json::Value;
use std::sync::Mutex;
use std::{os::unix::fs::PermissionsExt, path::PathBuf, sync::Arc, time::Duration};
struct Country;
impl Probe for Country {
    fn probe<'a>(&'a self, _: &'a str, _: Option<&'a str>, _: Duration) -> ProbeFuture<'a> {
        Box::pin(async {
            ProbeResult {
                status: Some(0),
                stdout: b"loc=US\n".to_vec(),
                stderr_bytes: 0,
            }
        })
    }
}
struct BarrierSink {
    inner: Arc<JournalSink>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Semaphore>,
}
impl EventSink for BarrierSink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let blocked = draft["kind"] == "provider.blocked";
        let task = self.inner.append(draft);
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            if blocked {
                entered.notify_one();
                let _permit = release.acquire().await.unwrap();
            }
            task.await
        })
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_auth_latches_before_blocked_event_publication_or_slow_receipt() {
    pult_core::panic_guard::install();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().canonicalize().unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut journal = EventStore::open(&home.join("events")).unwrap();
    let mut registry = Registry::open(&home, &mut journal).unwrap();
    for name in ["one", "two"] {
        let cwd = home.join(name);
        std::fs::create_dir(&cwd).unwrap();
        let mut row = Record::default();
        for (k, v) in [
            ("name", name),
            ("createdAt", key(name).created_at.as_str()),
            ("provider", "zcode"),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
        ] {
            row.set_string(k, v);
        }
        registry.insert(row).unwrap();
    }
    let journal = Arc::new(Mutex::new(journal));
    let inner = Arc::new(JournalSink::new(journal.clone()).unwrap());
    let sink = Arc::new(BarrierSink {
        inner,
        entered: Default::default(),
        release: Arc::new(tokio::sync::Semaphore::new(0)),
    });
    let driver = Arc::new(
        Driver::new(
            sink.clone(),
            Arc::new(pult_core::redaction::redact_string),
            Options::default(),
        )
        .unwrap(),
    );
    let python = ["/usr/bin/python3", "/opt/homebrew/bin/python3"]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .unwrap();
    let program = home.join("fake-zcode");
    let fixture = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/zcode_runtime.py"),
    )
    .unwrap();
    std::fs::write(&program, format!("#!{}\n{}", python.display(), fixture)).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = ZcodeRuntime::new(
        Dependencies {
            home: home.clone(),
            registry: Arc::new(Mutex::new(registry)),
            consent: Arc::new(Mutex::new(ConsentStore::open(&home).unwrap())),
            driver: driver.clone(),
            sink: sink.clone(),
        },
        TrustedCommand {
            holder: env!("CARGO_BIN_EXE_pult-worker-holder").into(),
            program,
            prefix_args: vec![],
        },
        RuntimeConfig::default(),
        Environment::from([
            ("HOME".into(), home.clone().into_os_string()),
            ("PATH".into(), "/usr/bin:/bin".into()),
        ]),
        Environment::new(),
        Arc::new(NetworkGuard::new(Arc::new(Country))),
        Limits::default(),
    )
    .unwrap();
    let mut auth = runtime.execute(key("one"), input("auth")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(30), sink.entered.notified())
        .await
        .unwrap();
    let latched_before_publication = runtime.blocked();
    let blocked_event_published = journal
        .lock()
        .unwrap()
        .read_session(&"one".encode_utf16().collect::<Vec<_>>())
        .unwrap()
        .iter()
        .any(|r| {
            serde_json::from_str::<Value>(r.json.get()).unwrap()["kind"] == "provider.blocked"
        });
    let second = runtime
        .execute(key("two"), input("must not dispatch"))
        .await;
    let refused = matches!(&second, Err(RuntimeError::ObservedAuthBlocked));
    if let Ok(mut h) = second {
        tokio::time::timeout(Duration::from_secs(30), h.wait())
            .await
            .unwrap()
            .unwrap();
    }
    let reset_was_busy = runtime.reset_auth() == Err(RuntimeError::Busy);
    // Join the intentional IO barrier on both RED and GREEN, before assertions.
    sink.release.add_permits(1);
    let outcome = tokio::time::timeout(Duration::from_secs(30), auth.wait())
        .await
        .unwrap()
        .unwrap()
        .turn
        .outcome;
    tokio::time::timeout(Duration::from_secs(30), runtime.shutdown())
        .await
        .unwrap()
        .unwrap();
    let launches = std::fs::read_to_string(home.join("launches.jsonl")).unwrap();
    let count = launches.lines().count();
    eprintln!(
        "SAFE_AUTH_ORDER latched={} event_published={} second_refused={} native_launches={} reset_busy={}",
        latched_before_publication, blocked_event_published, refused, count, reset_was_busy
    );
    assert!(latched_before_publication);
    assert!(!blocked_event_published);
    assert!(refused);
    assert!(reset_was_busy);
    assert_eq!(count, 1);
    assert!(matches!(outcome,Outcome::Failure{code,..}if code=="provider_unavailable"));
    assert!(!driver.storage_failed());
}
