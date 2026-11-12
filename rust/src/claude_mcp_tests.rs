use super::*;
use crate::{
    claude_worker::ScopedMcp,
    turn_driver::{Started, Worker},
    turn_snapshot::{Approval, Provider, SessionKey, TurnSettings, TurnSnapshot},
};
use std::{
    future::Future,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::mpsc,
    time::Duration,
};
#[derive(Default)]
pub(super) struct Hooks {
    io: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    publish: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    cleanup: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl Hooks {
    fn fire(slot: &Mutex<Option<Box<dyn FnOnce() + Send>>>) {
        let hook = slot.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
    }
    pub(super) fn before_io(&self) {
        Self::fire(&self.io)
    }
    pub(super) fn before_publish(&self) {
        Self::fire(&self.publish)
    }
    pub(super) fn before_cleanup(&self) {
        Self::fire(&self.cleanup)
    }
}
struct Barrier {
    entered: Arc<Notify>,
    release: Option<mpsc::Sender<()>>,
}
impl Barrier {
    fn new(slot: &Mutex<Option<Box<dyn FnOnce() + Send>>>) -> Self {
        let entered = Arc::new(Notify::new());
        let signal = entered.clone();
        let (send, recv) = mpsc::channel();
        *slot.lock().unwrap() = Some(Box::new(move || {
            signal.notify_one();
            recv.recv_timeout(Duration::from_secs(12)).unwrap();
        }));
        Self {
            entered,
            release: Some(send),
        }
    }
    fn release(mut self) {
        self.release.take().unwrap().send(()).unwrap();
    }
}
impl Drop for Barrier {
    fn drop(&mut self) {
        if let Some(send) = self.release.take() {
            let _ = send.send(());
        }
    }
}
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("factory watchdog")
}
struct FixtureWorker {
    factory: Arc<Factory>,
    path: Arc<Mutex<Option<PathBuf>>>,
}
impl Worker for FixtureWorker {
    fn start(
        &self,
        ticket: Ticket,
        snapshot: TurnSnapshot,
        _: String,
    ) -> Task<Result<Started, WorkerError>> {
        let factory = self.factory.clone();
        let path = self.path.clone();
        Box::pin(async move {
            let file = factory
                .prepare(McpContext {
                    session: snapshot.key,
                    ticket,
                    generation: 1,
                    approval: Approval::Ask,
                })
                .await?;
            *path.lock().unwrap() = Some(file);
            Ok(Started {
                turn_id: "factory-input".into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, ticket: Ticket) -> Task<Result<(), WorkerError>> {
        self.factory.revoke(&ticket, 1);
        self.factory.cleanup(ticket, 1)
    }
}
struct Fixture {
    _home: tempfile::TempDir,
    state: Arc<crate::State>,
    factory: Arc<Factory>,
    path: Arc<Mutex<Option<PathBuf>>>,
}
impl Fixture {
    fn new(extras: Map<String, Value>) -> Self {
        let (home, state, _) = crate::runtime_journal::tests::fixture();
        std::fs::create_dir(state.home.join("run")).unwrap();
        std::fs::set_permissions(
            state.home.join("run"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let backend = Backend::new(Arc::downgrade(&state));
        let gate: Arc<dyn DispatchGate> =
            Arc::new(|_: &Ticket, _: &TurnSnapshot| crate::turn_driver::DispatchDecision::Allow);
        let factory = Factory::new(backend, gate, "/synthetic/pultd-rust".into(), extras).unwrap();
        Self {
            _home: home,
            state,
            factory,
            path: Arc::new(Mutex::new(None)),
        }
    }
    fn start(&self) -> crate::turn_driver::Handle {
        let key = SessionKey {
            name: "factory".into(),
            created_at: "2026-11-12T12:00:00Z".into(),
        };
        let mut record = crate::registry::Record::default();
        for (k, v) in [
            ("name", key.name.as_str()),
            ("createdAt", key.created_at.as_str()),
            ("provider", "claude"),
            ("scope", "project"),
            ("cwd", self.state.home.to_str().unwrap()),
            ("approval", "ask"),
            ("status", "cold"),
        ] {
            record.set_string(k, v);
        }
        if self
            .state
            .registry
            .lock()
            .unwrap()
            .find("factory")
            .is_none()
        {
            self.state.registry.lock().unwrap().insert(record).unwrap();
        }
        self.state
            .driver
            .get()
            .unwrap()
            .start(
                TurnSnapshot {
                    key,
                    provider: Provider::Claude,
                    cwd: self.state.home.clone(),
                    settings: TurnSettings {
                        approval: Approval::Ask,
                        ..Default::default()
                    },
                },
                "fixture".into(),
                Arc::new(FixtureWorker {
                    factory: self.factory.clone(),
                    path: self.path.clone(),
                }),
            )
            .unwrap()
    }
    async fn close(&self, handle: &mut crate::turn_driver::Handle) {
        self.state.driver.get().unwrap().cancel(handle.ticket());
        bounded(handle.wait()).await.unwrap();
        bounded(self.state.host_jobs.wait()).await;
        assert!(self.factory.entries.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn immutable_private_file_contains_helper_and_preserves_other_servers() {
    let mut extras = Map::new();
    extras.insert(
        "docs".into(),
        serde_json::json!({"command":"/synthetic/docs","args":["read"]}),
    );
    let f = Fixture::new(extras.clone());
    let mut h = f.start();
    bounded(h.accepted()).await.unwrap();
    let path = f.path.lock().unwrap().clone().unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert_eq!(
        std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777,
        0o700
    );
    let config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(config["mcpServers"]["docs"], extras["docs"]);
    assert_eq!(
        config["mcpServers"]["pult"]["command"],
        "/synthetic/pultd-rust"
    );
    let key = config["mcpServers"]["pult"]["env"]["PULT_ASK_KEY"]
        .as_str()
        .unwrap();
    assert!(f.factory.backend.lookup(key).is_some());
    assert_eq!(
        config["mcpServers"]["pult"]["args"],
        serde_json::json!(["--home", f.state.home, "mcp-ask"])
    );
    let original = std::fs::read(&path).unwrap();
    assert_eq!(original, std::fs::read(&path).unwrap());
    f.close(&mut h).await;
    assert!(!path.exists());
    assert!(f.factory.backend.lookup(key).is_none());
}
#[tokio::test]
async fn reserved_pult_namespace_is_rejected() {
    let f = Fixture::new(Map::new());
    let mut extras = Map::new();
    extras.insert("pult".into(), Value::Null);
    assert!(
        Factory::new(
            f.factory.backend.clone(),
            f.factory.gate.clone(),
            "/synthetic/helper".into(),
            extras
        )
        .is_err()
    );
}
#[tokio::test]
async fn cancel_during_written_file_io_holds_ticket_and_never_publishes_path() {
    let f = Fixture::new(Map::new());
    let barrier = Barrier::new(&f.factory.hooks.publish);
    let mut h = f.start();
    bounded(barrier.entered.notified()).await;
    f.state.driver.get().unwrap().cancel(h.ticket());
    assert_eq!(f.state.driver.get().unwrap().active_count(), 1);
    let mut cleanup = f.factory.cleanup(h.ticket().clone(), 1);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(cleanup.as_mut().poll(cx).is_pending()))
            .await
    );
    barrier.release();
    bounded(cleanup).await.unwrap();
    bounded(h.wait()).await.unwrap();
    assert!(f.path.lock().unwrap().is_none());
    assert!(f.factory.entries.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(f.state.home.join("run")).unwrap().count(),
        0
    );
}
#[tokio::test]
async fn symlink_run_is_rejected_without_touching_target() {
    let f = Fixture::new(Map::new());
    std::fs::remove_dir(f.state.home.join("run")).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), f.state.home.join("run")).unwrap();
    let mut h = f.start();
    assert!(bounded(h.accepted()).await.is_err());
    bounded(h.wait()).await.unwrap();
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn foreign_replaced_file_is_retained_and_cleanup_is_unconfirmed() {
    let f = Fixture::new(Map::new());
    let mut h = f.start();
    bounded(h.accepted()).await.unwrap();
    let path = f.path.lock().unwrap().clone().unwrap();
    let saved = path.with_file_name("owned-original");
    std::fs::rename(&path, &saved).unwrap();
    std::fs::write(&path, b"foreign").unwrap();
    f.factory.revoke(h.ticket(), 1);
    assert!(
        bounded(f.factory.cleanup(h.ticket().clone(), 1))
            .await
            .is_err()
    );
    assert!(!std::fs::read(&saved).unwrap().is_empty());
    let retired = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .find(|p| p.file_name().to_string_lossy().starts_with("claude-mcp-"))
        .unwrap()
        .path();
    assert_eq!(std::fs::read(&retired).unwrap(), b"foreign");
    assert_eq!(f.state.driver.get().unwrap().active_count(), 1); /* Restore only our synthetic fixture to permit owned cleanup. */
    std::fs::remove_file(&retired).unwrap();
    std::fs::rename(saved, retired).unwrap();
    f.close(&mut h).await;
}

#[tokio::test]
async fn dropped_unpolled_prepare_keeps_written_io_owned_until_cleanup() {
    let f = Fixture::new(Map::new());
    let mut h = f.start();
    bounded(h.accepted()).await.unwrap();
    bounded(f.factory.cleanup(h.ticket().clone(), 1))
        .await
        .unwrap();
    let snapshot = f
        .state
        .driver
        .get()
        .unwrap()
        .snapshot_for_dispatch(h.ticket())
        .unwrap();
    let barrier = Barrier::new(&f.factory.hooks.publish);
    let pending = f.factory.prepare(McpContext {
        session: snapshot.key,
        ticket: h.ticket().clone(),
        generation: 2,
        approval: Approval::Ask,
    });
    bounded(barrier.entered.notified()).await;
    drop(pending);
    let mut cleanup = f.factory.cleanup(h.ticket().clone(), 2);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(cleanup.as_mut().poll(cx).is_pending()))
            .await
    );
    assert!(f.state.host_jobs.active() > 0);
    barrier.release();
    bounded(cleanup).await.unwrap();
    assert_eq!(
        std::fs::read_dir(f.state.home.join("run")).unwrap().count(),
        0
    );
    f.close(&mut h).await;
}
#[tokio::test]
async fn dropped_cleanup_waiter_does_not_abandon_file_removal() {
    let f = Fixture::new(Map::new());
    let mut h = f.start();
    bounded(h.accepted()).await.unwrap();
    let path = f.path.lock().unwrap().clone().unwrap();
    let barrier = Barrier::new(&f.factory.hooks.cleanup);
    let cleanup = f.factory.cleanup(h.ticket().clone(), 1);
    bounded(barrier.entered.notified()).await;
    drop(cleanup);
    assert!(path.exists());
    assert!(f.state.host_jobs.active() > 0);
    let joined = f.factory.cleanup(h.ticket().clone(), 1);
    barrier.release();
    bounded(joined).await.unwrap();
    assert!(!path.exists());
    f.close(&mut h).await;
}
#[tokio::test]
async fn run_directory_replacement_cannot_publish_path_or_delete_foreign_contents() {
    let f = Fixture::new(Map::new());
    let barrier = Barrier::new(&f.factory.hooks.publish);
    let mut h = f.start();
    bounded(barrier.entered.notified()).await;
    std::fs::rename(f.state.home.join("run"), f.state.home.join("old-run")).unwrap();
    std::fs::create_dir(f.state.home.join("run")).unwrap();
    std::fs::set_permissions(
        f.state.home.join("run"),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    std::fs::write(f.state.home.join("run/foreign"), b"keep").unwrap();
    barrier.release();
    assert!(bounded(h.accepted()).await.is_err());
    bounded(h.wait()).await.unwrap();
    assert!(f.path.lock().unwrap().is_none());
    assert_eq!(
        std::fs::read(f.state.home.join("run/foreign")).unwrap(),
        b"keep"
    );
    assert_eq!(
        std::fs::read_dir(f.state.home.join("old-run"))
            .unwrap()
            .count(),
        0
    );
}
#[tokio::test]
async fn foreign_symlink_is_preserved_and_never_followed_during_cleanup() {
    let f = Fixture::new(Map::new());
    let mut h = f.start();
    bounded(h.accepted()).await.unwrap();
    let path = f.path.lock().unwrap().clone().unwrap();
    let saved = path.with_file_name("original");
    std::fs::rename(&path, &saved).unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(outside.path(), b"foreign target").unwrap();
    std::os::unix::fs::symlink(outside.path(), &path).unwrap();
    assert!(
        bounded(f.factory.cleanup(h.ticket().clone(), 1))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(outside.path()).unwrap(), b"foreign target");
    let retired = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .find(|p| p.file_name().to_string_lossy().starts_with("claude-mcp-"))
        .unwrap()
        .path();
    assert!(
        std::fs::symlink_metadata(&retired)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    std::fs::remove_file(&retired).unwrap();
    std::fs::rename(saved, retired).unwrap();
    f.close(&mut h).await;
}
#[tokio::test]
async fn foreign_extra_file_causes_unconfirmed_cleanup_until_explicit_fixture_repair() {
    let f = Fixture::new(Map::new());
    let mut h = f.start();
    bounded(h.accepted()).await.unwrap();
    let path = f.path.lock().unwrap().clone().unwrap();
    let foreign = path.with_file_name("foreign");
    std::fs::write(&foreign, b"keep").unwrap();
    assert!(
        bounded(f.factory.cleanup(h.ticket().clone(), 1))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&foreign).unwrap(), b"keep");
    assert!(!path.exists());
    assert_eq!(f.factory.entries.lock().unwrap().len(), 1);
    std::fs::remove_file(foreign).unwrap();
    f.close(&mut h).await;
}
