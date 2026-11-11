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
fn active_record(state: &crate::State, name: &str) -> Result<Record, MemoryError> {
    let registry = state.registry.lock().map_err(|e| err("internal", e))?;
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
    tokio::task::spawn_blocking(move || {
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
    let registry = state.registry.lock().map_err(|e| err("internal", e))?;
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
    let result = tokio::task::spawn_blocking(move || {
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
        if method == "memory.catalog" {
            let page = memory.execute("memory.list", &json!({"limit":50}), &context)?;
            crate::memory_catalog::build(page, bound.public_context())
        } else {
            memory.execute(&method, &params, &context)
        }
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
