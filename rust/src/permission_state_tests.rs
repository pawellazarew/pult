use super::*;
use crate::{
    host_policy::ClientKind,
    permission_broker::Scope,
    turn_coordinator::Ticket,
    turn_driver::{Started, Task, Worker, WorkerError},
    turn_snapshot::{Approval, Provider, SessionKey, TurnSettings, TurnSnapshot},
};
use serde_json::json;
use std::{future::Future, os::unix::fs::PermissionsExt, time::Duration};
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(15), future)
        .await
        .expect("permission state watchdog")
}
fn request_data() -> PermissionRequest {
    PermissionRequest {
        session_id: "chat".into(),
        tool_name: "fixture".into(),
        tool_use_id: None,
        input: json!({"value":"visible"}),
        offers: Default::default(),
        concealed: false,
    }
}
#[tokio::test]
async fn inbox_initializes_without_any_provider_executable_or_runtime() {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    let path = state.home.join("config.json");
    std::fs::write(&path, "{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let broker = instance(&state).await.unwrap();
    assert!(state.native_runtime.get().is_none());
    assert!(state.memory_turns.get().is_none());
    assert!(state.claude_asks.get().is_none());
    assert_eq!(state.driver.get().unwrap().active_count(), 0);
    assert!(broker.list(None).is_empty());
    begin_shutdown(&state);
    bounded(drain(&state)).await;
}
#[tokio::test]
async fn owner_resolves_the_same_shared_inbox_without_codex_initialization() {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    instance(&state).await.unwrap();
    let mut question = request(&state, request_data()).unwrap();
    let result = bounded(crate::session_runtime_api::execute(
        state.clone(),
        "perm.resolve",
        json!({"id":question.id(),"decision":"allow"}),
        ClientKind::Shell,
        "human",
    ))
    .await
    .unwrap();
    let result: Value = serde_json::from_str(result.get()).unwrap();
    assert_eq!(result["resolved"], true);
    assert!(matches!(
        question.decision().await,
        Decision::Allow {
            scope: Scope::Once,
            ..
        }
    ));
    question.drained().await;
    assert!(state.native_runtime.get().is_none());
    begin_shutdown(&state);
    bounded(drain(&state)).await;
}
#[tokio::test]
async fn malformed_configuration_never_initializes_a_broker_or_provider() {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    let path = state.home.join("config.json");
    std::fs::write(&path, "{").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(instance(&state).await.is_err());
    assert!(state.permissions.get().is_none());
    assert!(state.native_runtime.get().is_none());
}
#[tokio::test]
async fn driver_storage_failure_closes_shared_question_admission() {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    instance(&state).await.unwrap();
    state.driver.get().unwrap().report_storage_failure();
    assert!(matches!(
        request(&state, request_data()),
        Err(permission_broker::BrokerError::StorageUnavailable)
    ));
    assert!(instance(&state).await.is_err());
    assert!(list(&state, None).is_empty());
    begin_shutdown(&state);
    bounded(drain(&state)).await;
}
struct Manual;
impl Worker for Manual {
    fn start(&self, _: Ticket, _: TurnSnapshot, _: String) -> Task<Result<Started, WorkerError>> {
        Box::pin(async {
            Ok(Started {
                turn_id: "manual-turn".into(),
                done: Box::pin(std::future::pending()),
            })
        })
    }
    fn close(&self, _: Ticket) -> Task<Result<(), WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test]
async fn inbox_shutdown_does_not_implicitly_own_the_shared_driver() {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    instance(&state).await.unwrap();
    begin_shutdown(&state);
    bounded(drain(&state)).await;
    let driver = state.driver.get().unwrap();
    let mut handle = driver
        .start(
            TurnSnapshot {
                key: SessionKey {
                    name: "chat".into(),
                    created_at: "2026-11-12T00:00:00Z".into(),
                },
                provider: Provider::Claude,
                cwd: state.home.clone(),
                settings: TurnSettings {
                    approval: Approval::Ask,
                    ..Default::default()
                },
            },
            "manual".into(),
            Arc::new(Manual),
        )
        .unwrap();
    assert!(bounded(handle.accepted()).await.is_ok());
    driver.cancel(handle.ticket());
    bounded(handle.wait()).await.unwrap();
}

thread_local! {
    static PUBLISH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn before_publish() {
    let hook = PUBLISH.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook();
    }
}
async fn initialization_wait_race(cached: bool) {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    let path = state.home.join("config.json");
    std::fs::write(&path, "{").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let init = state.runtime_init.lock().unwrap();
    let mut waiting = Box::pin(instance(&state));
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(waiting.as_mut().poll(&mut context).is_pending());
    assert_eq!(state.host_jobs.active(), 1);
    if cached {
        ensure_locked(&state, &Default::default()).unwrap();
    }
    crate::runtime_state::begin_shutdown(&state);
    drop(init);
    let result = bounded(waiting).await;
    begin_shutdown(&state);
    bounded(drain(&state)).await;
    assert_eq!(
        result.err().map(|error| error.to_string()).as_deref(),
        Some("permission service is unavailable")
    );
}
#[tokio::test]
async fn initialization_wait_rechecks_stop_before_configuration_io() {
    initialization_wait_race(false).await;
}
#[tokio::test]
async fn initialization_wait_rechecks_stop_before_cached_return() {
    initialization_wait_race(true).await;
}
#[tokio::test]
async fn initialization_cannot_publish_a_broker_after_shutdown_passed_it() {
    let (_home, state, _) = crate::runtime_journal::tests::fixture();
    let entered = Arc::new(tokio::sync::Notify::new());
    let signal = entered.clone();
    let (release, receive) = std::sync::mpsc::channel();
    let creating = state.clone();
    let runtime = tokio::runtime::Handle::current();
    let tracked = state.host_jobs.track();
    let job = tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        let _runtime = runtime.enter();
        let _init = creating.runtime_init.lock().unwrap();
        PUBLISH.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                signal.notify_one();
                receive.recv_timeout(Duration::from_secs(15)).unwrap();
            }))
        });
        ensure_locked(&creating, &Default::default())
    });
    bounded(entered.notified()).await;
    crate::runtime_state::begin_shutdown(&state);
    release.send(()).unwrap();
    let result = bounded(job).await.unwrap();
    let published = state.permissions.get().is_some();
    begin_shutdown(&state);
    bounded(drain(&state)).await;
    assert!(
        result.is_err(),
        "late initializer returned an open Broker after shutdown"
    );
    assert!(
        !published,
        "late initializer published after admission closed"
    );
}
