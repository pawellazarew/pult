//! Owner memory administration. Scoped read/turn roles are routed separately.
use crate::memory::{Context, MemoryError};
use anyhow::anyhow;
use serde_json::Value;
use serde_json::value::RawValue;
use std::{path::Path, sync::Arc};

pub(crate) const METHODS: [&str; 14] = [
    "memory.add",
    "memory.catalog",
    "memory.configure",
    "memory.context.bind",
    "memory.context.issue",
    "memory.context.revoke",
    "memory.context.status",
    "memory.forget",
    "memory.get",
    "memory.history",
    "memory.list",
    "memory.projects",
    "memory.search",
    "memory.update",
];

/// Inspect the raw envelope first so invalid Unicode in the new memory API
/// becomes an invalid_params response, without dropping existing subscriptions.
type ParsedCommand = Result<(String, Value), MemoryError>;

pub(crate) fn parse(bytes: &[u8]) -> Option<(Value, ParsedCommand)> {
    let raw: Box<RawValue> = serde_json::from_slice(bytes).ok()?;
    let fields = crate::history::Fields::parse(&raw).ok()?;
    let method: String = serde_json::from_str(fields.get("method")?.get()).ok()?;
    if !METHODS.contains(&method.as_str()) {
        return None;
    }
    let id = fields
        .get("id")
        .and_then(|v| serde_json::from_str::<Value>(v.get()).ok())
        .unwrap_or(Value::Null);
    let command = (|| {
        if !id.is_string() && !id.is_number() {
            return Err(error(
                "invalid_params",
                "request needs a string or number id",
            ));
        }
        let params = fields
            .get("params")
            .map(|raw| serde_json::from_str::<Value>(raw.get()))
            .transpose()
            .map_err(|_| {
                error(
                    "invalid_params",
                    "memory params require valid Unicode strings",
                )
            })?
            .unwrap_or_else(|| serde_json::json!({}));
        if !params.is_object() {
            return Err(error("invalid_params", "memory params must be an object"));
        }
        Ok((method, params))
    })();
    Some((id, command))
}

fn error(code: &'static str, message: impl ToString) -> MemoryError {
    MemoryError {
        code,
        message: message.to_string(),
    }
}

pub(crate) async fn execute(
    state: Arc<crate::State>,
    method: String,
    mut params: Value,
) -> Result<Value, MemoryError> {
    if method == "memory.configure" {
        return crate::memory_policy::configure(state, params).await;
    }
    if crate::session_memory_api::METHODS.contains(&method.as_str()) {
        return crate::session_memory_api::execute(state, method, params).await;
    }
    if method == "memory.catalog" {
        return crate::session_memory_api::read(state, method, params, None).await;
    }
    let host_job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _host_job = host_job;
        // Project IDs select existing durable data only on the owner boundary.
        // Shared scoped/turn APIs retain their strict parameter allowlists.
        let selected_project = match params.get("projectId") {
            None => None,
            Some(Value::String(id)) if !id.is_empty() => {
                if params.get("session").is_some()
                    || params.get("scope").and_then(Value::as_str) != Some("project")
                {
                    return Err(error(
                        "invalid_params",
                        "projectId requires explicit project scope and cannot accompany session",
                    ));
                }
                Some(id.clone())
            }
            _ => {
                return Err(error(
                    "invalid_params",
                    "projectId must be a nonempty string",
                ));
            }
        };
        if selected_project.is_some() {
            params.as_object_mut().unwrap().remove("projectId");
        }
        if method == "memory.projects"
            && params.as_object().is_none_or(|p| {
                p.keys()
                    .any(|key| !matches!(key.as_str(), "limit" | "offset"))
            })
        {
            return Err(error(
                "invalid_params",
                "memory.projects accepts only limit and offset",
            ));
        }
        // Copy the trusted session context before filesystem IO and the memory lock.
        // Release registry before acquiring memory; scoped reads use memory -> registry.
        // Never add a registry -> memory nesting here.
        let (session, cwd) = {
            let session = match params.get("session") {
                None => None,
                Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
                _ => return Err(error("invalid_params", "session must be a nonempty string")),
            };
            if let Some(name) = &session {
                let registry = state.registry.lock().map_err(|e| error("internal", e))?;
                let record = registry
                    .find(name)
                    .ok_or_else(|| error("not_found", format!("session {name} not found")))?;
                let cwd = if params.get("scope").and_then(Value::as_str) == Some("global") {
                    None
                } else {
                    Some(
                        match record.get("worktree") {
                            Some(raw) => {
                                crate::history::Fields::parse(raw).ok().and_then(|fields| {
                                    fields
                                        .get("repo")
                                        .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                                })
                            }
                            None => record.scalar("cwd"),
                        }
                        .ok_or_else(|| {
                            error("invalid_params", "session has no valid project directory")
                        })?,
                    )
                };
                (session, cwd)
            } else {
                (session, None)
            }
        };
        let project_id = cwd
            .map(|cwd| crate::memory_project::resolve(Path::new(&cwd)))
            .transpose()
            .map_err(|e| error("invalid_params", format!("memory project: {e}")))?;
        let context = Context {
            project_id: selected_project.clone().or(project_id),
            session,
        };
        let mut memory = state.memory.lock().map_err(|e| error("internal", e))?;
        let memory = memory.as_mut().map_err(|e| {
            error(
                "internal",
                format!("memory unavailable: {e}; repair the memory database and restart"),
            )
        })?;
        if method == "memory.projects" {
            return memory.projects(&params);
        }
        if let Some(project_id) = selected_project
            && !memory.has_project(&project_id)?
        {
            return Err(error("not_found", "memory project not found"));
        }
        memory.execute(&method, &params, &context)
    })
    .await
    .map_err(|e| error("internal", anyhow!(e)))?
}
