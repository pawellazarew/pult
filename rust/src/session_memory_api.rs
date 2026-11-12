//! Owner registration and narrow memory credentials. No provider execution yet.
use crate::{
    memory::{Context, MemoryError},
    session_memory::{self, MemoryLease},
    session_model::Record,
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

pub(crate) const METHODS: [&str; 4] = [
    "memory.context.bind",
    "memory.context.issue",
    "memory.context.revoke",
    "memory.context.status",
];
pub(crate) const READ_METHODS: [&str; 4] = [
    "memory.catalog",
    "memory.get",
    "memory.list",
    "memory.search",
];
fn err(code: &'static str, message: impl ToString) -> MemoryError {
    MemoryError {
        code,
        message: message.to_string(),
    }
}
fn selector(params: &Value, required: bool) -> Result<Option<&str>, MemoryError> {
    match params.get("session") {
        None if !required => Ok(None),
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 128 => Ok(Some(s)),
        _ => Err(err(
            "invalid_params",
            "session must be a nonempty string of at most 128 bytes",
        )),
    }
}
fn fields(params: &Value, allowed: &[&str]) -> Result<(), MemoryError> {
    let fields = params
        .as_object()
        .ok_or_else(|| err("invalid_params", "params must be an object"))?;
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(err("invalid_params", "unknown context parameter"));
    }
    Ok(())
}
fn execution_available(state: &crate::State) -> Result<(), MemoryError> {
    if crate::runtime_state::unavailable(state) {
        return Err(err("forbidden", "memory execution context is unavailable"));
    }
    Ok(())
}
fn registry_available(registry: &crate::registry::Registry) -> Result<(), MemoryError> {
    if registry.write_poisoned() {
        return Err(err("forbidden", "session registry requires recovery"));
    }
    Ok(())
}
fn active_record(state: &crate::State, name: &str) -> Result<Record, MemoryError> {
    execution_available(state)?;
    let registry = state.registry.lock().map_err(|e| err("internal", e))?;
    registry_available(&registry)?;
    let record = registry
        .find(name)
        .ok_or_else(|| err("not_found", "session not found"))?;
    if record.get("archived").is_some_and(|v| v.get() == "true") {
        return Err(err("forbidden", "session is archived"));
    }
    Ok(record.clone())
}
fn project(record: &Record) -> Result<Option<String>, MemoryError> {
    if record.scalar("scope").as_deref() == Some("general") {
        return Ok(None);
    }
    let cwd = match record.get("worktree") {
        Some(raw) => crate::history::Fields::parse(raw).ok().and_then(|fields| {
            fields
                .get("repo")
                .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
        }),
        None => record.scalar("cwd"),
    }
    .ok_or_else(|| err("invalid_params", "session has no valid project directory"))?;
    crate::memory_project::resolve(Path::new(&cwd))
        .map(Some)
        .map_err(|e| err("invalid_params", format!("memory project: {e}")))
}

pub(crate) async fn execute(
    state: Arc<crate::State>,
    method: String,
    params: Value,
) -> Result<Value, MemoryError> {
    let host_job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _host_job = host_job;
        fields(
            &params,
            if method == "memory.context.bind" {
                &["session", "enabled"]
            } else {
                &["session"]
            },
        )?;
        let name = selector(&params, method != "memory.context.status")?;
        if method == "memory.context.status" {
            return Ok(state
                .session_memory
                .lock()
                .map_err(|e| err("internal", e))?
                .status(name));
        }
        let name = name.expect("validated required selector");
        if method == "memory.context.revoke" {
            return Ok(state
                .session_memory
                .lock()
                .map_err(|e| err("internal", e))?
                .revoke(name));
        }
        let record = active_record(&state, name)?;
        let fingerprint = session_memory::fingerprint(&record)?;
        if method == "memory.context.bind" {
            let enabled = match params.get("enabled") {
                None => true,
                Some(Value::Bool(v)) => *v,
                _ => return Err(err("invalid_params", "enabled must be boolean")),
            };
            let project = project(&record)?;
            // Filesystem discovery may be slow. Recheck the exact session before publishing.
            let registry = state.registry.lock().map_err(|e| err("internal", e))?;
            registry_available(&registry)?;
            let current = registry
                .find(name)
                .ok_or_else(|| err("not_found", "session not found"))?;
            if current.get("archived").is_some_and(|v| v.get() == "true")
                || session_memory::fingerprint(current)? != fingerprint
            {
                return Err(err(
                    "conflict",
                    "session changed during registration; retry bind",
                ));
            }
            state
                .session_memory
                .lock()
                .map_err(|e| err("internal", e))?
                .bind(name, fingerprint, project, enabled)
        } else {
            let registry = state.registry.lock().map_err(|e| err("internal", e))?;
            registry_available(&registry)?;
            let current = registry
                .find(name)
                .ok_or_else(|| err("not_found", "session not found"))?;
            if current.get("archived").is_some_and(|v| v.get() == "true")
                || session_memory::fingerprint(current)? != fingerprint
            {
                return Err(err(
                    "conflict",
                    "session changed during credential issuance",
                ));
            }
            state
                .session_memory
                .lock()
                .map_err(|e| err("internal", e))?
                .issue(name, &fingerprint)
        }
    })
    .await
    .map_err(|e| err("internal", e))?
}

fn registered(state: &crate::State, name: &str) -> Result<Arc<MemoryLease>, MemoryError> {
    execution_available(state)?;
    let registry = state.registry.lock().map_err(|e| err("internal", e))?;
    registry_available(&registry)?;
    let record = registry
        .find(name)
        .ok_or_else(|| err("not_found", "session not found"))?;
    if record.get("archived").is_some_and(|v| v.get() == "true") {
        return Err(err("forbidden", "session is archived"));
    }
    state
        .session_memory
        .lock()
        .map_err(|e| err("internal", e))?
        .registration(name, &session_memory::fingerprint(record)?)
}

pub(crate) async fn read(
    state: Arc<crate::State>,
    method: String,
    params: Value,
    lease: Option<Arc<MemoryLease>>,
) -> Result<Value, MemoryError> {
    let scoped = lease.is_some();
    let host_job = state.host_jobs.track();
    let result = tokio::task::spawn_blocking(move || {
        let _host_job = host_job;
        let bound = if let Some(lease) = lease {
            if !READ_METHODS.contains(&method.as_str()) {
                return Err(err("forbidden", "memory credential is read-only"));
            }
            if params.get("session").is_some() || params.get("projectId").is_some() {
                return Err(err(
                    "invalid_params",
                    "a memory credential cannot select a session or project",
                ));
            }
            lease
        } else {
            fields(&params, &["session"])?;
            registered(&state, selector(&params, true)?.expect("required selector"))?
        };
        if method == "memory.catalog" {
            fields(
                &params,
                if params.get("session").is_some() {
                    &["session"]
                } else {
                    &[]
                },
            )?;
        }
        // Owner memory APIs release registry before memory IO. This lock order is
        // memory -> short registry read; context mutations never acquire memory.
        let mut memory = state.memory.lock().map_err(|e| err("internal", e))?;
        let record = active_record(&state, &bound.session)
            .map_err(|_| err("forbidden", "memory session is unavailable"))?;
        session_memory::validate_record(&record, &bound)?;
        if !bound.is_valid() {
            return Err(err("forbidden", "memory credential was revoked"));
        }
        let context = Context {
            project_id: bound.project_id.clone(),
            session: Some(bound.session.clone()),
        };
        let memory = memory
            .as_mut()
            .map_err(|e| err("internal", format!("memory unavailable: {e}")))?;
        let result = if method == "memory.catalog" {
            let page = memory.execute("memory.list", &json!({"limit":50}), &context)?;
            crate::memory_catalog::build(page, bound.public_context())?
        } else {
            memory.execute(&method, &params, &context)?
        };
        // A credential/source revoked while database IO ran cannot publish its
        // result. Owner repair reads use the separate unscoped memory API.
        let current = active_record(&state, &bound.session)?;
        session_memory::validate_record(&current, &bound)?;
        if !bound.is_valid() {
            return Err(err("forbidden", "memory credential was revoked"));
        }
        Ok(result)
    })
    .await
    .map_err(|e| err("internal", e))
    .and_then(|result| result);
    result.map_err(|failure| {
        if scoped && failure.code == "internal" {
            err("internal", "memory read is unavailable")
        } else {
            failure
        }
    })
}

#[cfg(test)]
mod fault_tests {
    use super::*;

    async fn fixture() -> (tempfile::TempDir, Arc<crate::State>, Arc<MemoryLease>) {
        let (home, state, _sink) = crate::runtime_journal::tests::fixture();
        let mut record = Record::default();
        for (field, value) in [
            ("name", "chat"),
            ("createdAt", "2026-11-12T00:00:00Z"),
            ("provider", "codex"),
            ("scope", "general"),
            ("cwd", state.home.to_str().unwrap()),
        ] {
            record.set_string(field, value);
        }
        state.registry.lock().unwrap().insert(record).unwrap();
        *state.memory.lock().unwrap() = Ok(crate::memory::MemoryStore::open(&state.home).unwrap());
        execute(
            state.clone(),
            "memory.context.bind".into(),
            json!({"session":"chat","enabled":true}),
        )
        .await
        .unwrap();
        let issued = execute(
            state.clone(),
            "memory.context.issue".into(),
            json!({"session":"chat"}),
        )
        .await
        .unwrap();
        let lease = state
            .session_memory
            .lock()
            .unwrap()
            .lookup(issued["key"].as_str().unwrap())
            .unwrap();
        read(
            state.clone(),
            "memory.list".into(),
            json!({}),
            Some(lease.clone()),
        )
        .await
        .unwrap();
        (home, state, lease)
    }

    #[tokio::test]
    async fn uncertain_archive_cannot_authorize_memory_with_stale_registration() {
        let (_home, state, lease) = fixture().await;
        state
            .registry
            .lock()
            .unwrap()
            .fail_next_commit_for_test(true);
        assert!(
            crate::session_api::execute(
                state.clone(),
                crate::session_api::Command::Archive {
                    name: "chat".into(),
                    archived: true,
                }
            )
            .await
            .is_err()
        );
        assert!(state.registry.lock().unwrap().write_poisoned());
        assert!(
            read(state.clone(), "memory.list".into(), json!({}), Some(lease))
                .await
                .is_err(),
            "uncertain archived metadata still authorized an agent memory credential"
        );
        assert!(
            execute(
                state,
                "memory.context.issue".into(),
                json!({"session":"chat"})
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn global_execution_fault_blocks_agent_memory_but_preserves_owner_repair_access() {
        let (_home, state, lease) = fixture().await;
        state.execution_storage_failed();
        assert!(!state.registry.lock().unwrap().write_poisoned());
        assert!(
            read(state.clone(), "memory.list".into(), json!({}), Some(lease))
                .await
                .is_err(),
            "agent memory read survived global execution fault"
        );
        assert!(
            execute(
                state.clone(),
                "memory.context.issue".into(),
                json!({"session":"chat"})
            )
            .await
            .is_err()
        );
        assert!(
            execute(
                state.clone(),
                "memory.context.revoke".into(),
                json!({"session":"chat"})
            )
            .await
            .is_ok()
        );
        assert!(
            crate::memory_api::execute(state, "memory.list".into(), json!({}))
                .await
                .is_ok()
        );
    }
}
