//! Daemon-owned Inbox lifetime, independent of any provider executable/runtime.
//! Provider shutdown may cancel its exact questions, never close this broker.
use crate::{
    State,
    permission_broker::{self, Broker, Decision, PermissionRequest, RequestHandle, Resolution},
};
use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use std::sync::Arc;

/// Caller holds State.runtime_init and a Tokio runtime context. No filesystem
/// or provider discovery is performed here; config is a checked host snapshot.
pub(crate) fn ensure_locked(
    state: &Arc<State>,
    config: &crate::runtime_config::RuntimeConfig,
) -> Result<Broker> {
    if *state.stop.borrow() || crate::runtime_state::unavailable(state) {
        bail!("permission service is unavailable");
    }
    if let Some(broker) = state.permissions.get() {
        return Ok(broker.clone());
    }
    let broker = if let Some(runtime) = state.native_runtime.get() {
        // Legacy test/host construction can adopt its existing Inbox instead
        // of splitting already-pending cards across two independent brokers.
        runtime.permission_broker()
    } else {
        Broker::new(
            state.execution_sink(),
            permission_broker::Redactors {
                value: Arc::new(crate::redaction::redact),
                string: Arc::new(crate::redaction::redact_string),
            },
            permission_broker::Options::from_timeout_ms(config.perm_timeout_ms)
                .map_err(|_| anyhow!("permission configuration is invalid"))?,
        )
        .map_err(|_| anyhow!("permission service is unavailable"))?
    };
    #[cfg(test)]
    tests::before_publish();
    // Creation (including random generation) is outside the admission lock.
    // Only bounded in-memory publication shares the stop/fault checkpoint.
    let _admission = state
        .execution_admission
        .lock()
        .map_err(|_| anyhow!("permission publication unavailable"))?;
    if *state.stop.borrow() || crate::runtime_state::unavailable(state) {
        bail!("permission service is unavailable");
    }
    state
        .permissions
        .set(broker.clone())
        .map_err(|_| anyhow!("permission service already initialized"))?;
    Ok(broker)
}
/// Initialization reads only Pult's checked configuration. It never resolves,
/// starts or logs into Codex/Claude, nor runs a network probe.
pub(crate) async fn instance(state: &Arc<State>) -> Result<Broker> {
    if *state.stop.borrow() || crate::runtime_state::unavailable(state) {
        bail!("permission service is unavailable");
    }
    if let Some(broker) = state.permissions.get() {
        return Ok(broker.clone());
    }
    let state = state.clone();
    let handle = tokio::runtime::Handle::current();
    let tracked = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        let _runtime = handle.enter();
        let _init = state
            .runtime_init
            .lock()
            .map_err(|_| anyhow!("runtime initialization unavailable"))?;
        if *state.stop.borrow() || crate::runtime_state::unavailable(&state) {
            bail!("permission service is unavailable");
        }
        if let Some(broker) = state.permissions.get() {
            return Ok(broker.clone());
        }
        let config = crate::runtime_bootstrap::configuration(&state.home)?.config;
        ensure_locked(&state, &config)
    })
    .await
    .map_err(|_| anyhow!("permission initialization failed"))?
}
pub(crate) fn current(state: &State) -> Option<Broker> {
    state.permissions.get().cloned().or_else(|| {
        state
            .native_runtime
            .get()
            .map(|runtime| runtime.permission_broker())
    })
}
pub(crate) fn request(
    state: &State,
    request: PermissionRequest,
) -> Result<RequestHandle, permission_broker::BrokerError> {
    if *state.stop.borrow() || crate::runtime_state::unavailable(state) {
        return Err(permission_broker::BrokerError::StorageUnavailable);
    }
    current(state)
        .ok_or(permission_broker::BrokerError::Closed)?
        .request(request)
}
pub(crate) fn list(state: &State, session: Option<&str>) -> Vec<Value> {
    current(state).map_or_else(Vec::new, |broker| broker.list(session))
}
pub(crate) fn resolve(
    state: &State,
    id: &str,
    decision: Decision,
    by: &str,
) -> Result<Resolution, permission_broker::BrokerError> {
    current(state)
        .ok_or(permission_broker::BrokerError::Closed)?
        .resolve(id, decision, by)
}
pub(crate) fn begin_shutdown(state: &State) {
    if let Some(broker) = current(state) {
        broker.shutdown();
    }
}
pub(crate) async fn drain(state: &State) {
    if let Some(broker) = current(state) {
        broker.drain().await;
    }
}

#[cfg(test)]
#[path = "permission_state_tests.rs"]
mod tests;
