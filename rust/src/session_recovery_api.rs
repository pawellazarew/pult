//! Authenticated owner-only native recovery. Scoped purposes return before the
//! owner dispatcher, and JSON selectors/acknowledgements alone are not authority.
use crate::State;
use crate::session_runtime_api::{self as api, CommandGuard};
use crate::turn_snapshot::SessionKey;
use serde_json::{Value, json, value::RawValue};
use std::sync::Arc;

pub(crate) fn fields(params: &Value, allowed: &[&str]) -> api::Result<()> {
    let object = params.as_object().ok_or_else(api::invalid)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(api::invalid());
    }
    Ok(())
}

async fn current(
    state: Arc<State>,
    params: &Value,
    diagnostic: bool,
) -> api::Result<(SessionKey, bool)> {
    let name = api::name(params)?;
    let job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _job = job;
        if diagnostic {
            api::diagnostic_available(&state)?;
        } else {
            api::available(&state)?;
        }
        let registry = state.registry.lock().map_err(|_| api::storage())?;
        let record = registry
            .find(&name)
            .ok_or_else(|| api::error("not_found", "session does not exist"))?;
        if record.scalar("provider").as_deref() != Some("zcode") {
            return Err(api::error(
                "unsupported",
                "native recovery is only available for ZCode",
            ));
        }
        Ok((api::key(record)?, record.get("zcodePendingInput").is_some()))
    })
    .await
    .map_err(|_| api::storage())?
}

pub(crate) async fn get(state: Arc<State>, params: Value) -> api::Result<Box<RawValue>> {
    fields(&params, &["name"])?;
    let (key, unknown) = current(state.clone(), &params, true).await?;
    api::diagnostic_available(&state)?;
    // Never initialize a provider, discover its binary or reconstruct a proof
    // from cold metadata. The descriptor is only a read-only in-memory selector.
    let recovery = state
        .zcode_runtime
        .get()
        .and_then(|slot| slot.runtime.pending_recovery(&key))
        .map(|descriptor| descriptor.value());
    api::raw(
        json!({"provider":"zcode", "recovery":recovery, "deliveryUnknown":unknown,
        "executionUnavailable":crate::runtime_state::unavailable(&state)}),
    )
}

pub(crate) async fn confirm(
    state: Arc<State>,
    params: Value,
    command: Option<CommandGuard>,
) -> api::Result<Box<RawValue>> {
    fields(
        &params,
        &["name", "recoveryId", "acknowledgePossibleExecution"],
    )?;
    if params["acknowledgePossibleExecution"] != true {
        return Err(api::error(
            "invalid_params",
            "owner acknowledgement of possible prior execution is required",
        ));
    }
    let id = params["recoveryId"]
        .as_str()
        .ok_or_else(api::invalid)?
        .to_owned();
    let command =
        command.ok_or_else(|| api::error("internal", "owner recovery admission is unavailable"))?;
    command.check()?;
    let (key, _) = current(state.clone(), &params, false).await?;
    api::available(&state)?;
    let slot = state.zcode_runtime.get().ok_or_else(|| {
        api::error(
            "not_found",
            "no in-memory recovery proof; inspect provider history",
        )
    })?;
    // This synchronous handoff is serialized with stop by the command gate.
    // The Runtime then owns warning/storage IO even if this caller disappears.
    let result = command
        .submit_recovery(&slot.runtime, key, id)?
        .await
        .map_err(|error| {
            api::error(
                error.code(),
                "recovery was not confirmed; inspect its current state",
            )
        })?;
    api::raw(json!({
        "provider":"zcode", "reset":true, "mayHaveExecuted":true,
        "requestedEventId":result.requested_event_id,
        "committedEventId":result.committed_event_id,
        "queuePaused":true, "startsNewConversation":true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_policy::ClientKind;
    use crate::registry::Record;
    use std::sync::atomic::Ordering;

    fn seed(state: &State, provider: &str, marker: Option<&str>) {
        let cwd = state.home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        let mut record = Record::default();
        for (key, value) in [
            ("name", "chat"),
            ("createdAt", "2026-11-12T00:00:00Z"),
            ("provider", provider),
            ("cwd", cwd.to_str().unwrap()),
            ("approval", "ask"),
        ] {
            record.set_string(key, value);
        }
        if let Some(marker) = marker {
            record.set_raw(
                "zcodePendingInput",
                serde_json::value::RawValue::from_string(marker.into()).unwrap(),
            );
            record.set_string("providerSessionId", "sess_original");
        }
        state.registry.lock().unwrap().insert(record).unwrap();
    }
    async fn call(state: &Arc<State>, method: &str, params: Value) -> api::Result<Value> {
        let raw = api::execute(
            state.clone(),
            method,
            params,
            ClientKind::Other,
            "owner-fixture",
        )
        .await?;
        Ok(serde_json::from_str(raw.get()).unwrap())
    }
    fn no_provider(state: &State) {
        assert!(state.zcode_runtime.get().is_none());
        assert!(state.claude_runtime.get().is_none());
        assert!(state.native_runtime.get().is_none());
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 0);
    }
    #[tokio::test]
    async fn cold_recovery_query_and_confirmation_never_reconstruct_or_initialize() {
        for marker in [None, Some("null"), Some(r#"{"future":[1,true]}"#)] {
            let (_home, state) = api::tests::fixture();
            seed(&state, "zcode", marker);
            let before = state
                .registry
                .lock()
                .unwrap()
                .find("chat")
                .unwrap()
                .raw()
                .unwrap();
            let result = call(&state, "agent.recovery.get", json!({"name":"chat"}))
                .await
                .unwrap();
            assert_eq!(
                result,
                json!({"provider":"zcode", "recovery":null, "deliveryUnknown":marker.is_some(), "executionUnavailable":false})
            );
            assert_eq!(call(&state, "agent.recovery.confirm", json!({"name":"chat", "recoveryId":"zr-fixture", "acknowledgePossibleExecution":true})).await.unwrap_err().code, "not_found");
            assert_eq!(
                state
                    .registry
                    .lock()
                    .unwrap()
                    .find("chat")
                    .unwrap()
                    .raw()
                    .unwrap()
                    .get(),
                before.get()
            );
            no_provider(&state);
        }
    }
    #[tokio::test]
    async fn acknowledgement_and_strict_fields_are_validated_before_metadata_io() {
        let (_home, state) = api::tests::fixture();
        for params in [
            json!({"name":"chat", "recoveryId":"zr-fixture"}),
            json!({"name":"chat", "recoveryId":"zr-fixture", "acknowledgePossibleExecution":false}),
            json!({"name":"chat", "recoveryId":"zr-fixture", "acknowledgePossibleExecution":true, "providerSessionId":"forged"}),
        ] {
            assert_eq!(
                call(&state, "agent.recovery.confirm", params)
                    .await
                    .unwrap_err()
                    .code,
                "invalid_params"
            );
        }
        assert_eq!(
            call(
                &state,
                "agent.recovery.get",
                json!({"name":"chat", "nativeSid":"forged"})
            )
            .await
            .unwrap_err()
            .code,
            "invalid_params"
        );
        no_provider(&state);
    }
    #[tokio::test]
    async fn other_provider_is_rejected_without_discovery() {
        let (_home, state) = api::tests::fixture();
        seed(&state, "codex", None);
        assert_eq!(
            call(&state, "agent.recovery.get", json!({"name":"chat"}))
                .await
                .unwrap_err()
                .code,
            "unsupported"
        );
        no_provider(&state);
    }
    #[tokio::test]
    async fn read_only_recovery_remains_diagnostic_after_execution_storage_fault() {
        let (_home, state) = api::tests::fixture();
        seed(&state, "zcode", Some("null"));
        state
            .execution_storage_failed
            .store(true, Ordering::Release);
        let result = call(&state, "agent.recovery.get", json!({"name":"chat"}))
            .await
            .unwrap();
        assert_eq!(
            result,
            json!({"provider":"zcode", "recovery":null, "deliveryUnknown":true, "executionUnavailable":true})
        );
        assert_eq!(call(&state, "agent.recovery.confirm", json!({"name":"chat", "recoveryId":"zr-fixture", "acknowledgePossibleExecution":true})).await.unwrap_err().code, "storage_unavailable");
        no_provider(&state);
        state.stop.send_replace(true);
        assert_eq!(
            call(&state, "agent.recovery.get", json!({"name":"chat"}))
                .await
                .unwrap_err()
                .code,
            "closed"
        );
    }
}
