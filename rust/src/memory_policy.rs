//! Explicit session policy. Filesystem Full never approves persistent memory writes.
use crate::registry::Record;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub read: bool,
    pub write: Write,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Write {
    #[default]
    Off,
    Ask,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Invalid;
impl Policy {
    pub fn parse(value: Option<&Value>) -> Result<Self, Invalid> {
        let Some(value) = value else {
            return Ok(Self::default());
        };
        let object = value.as_object().ok_or(Invalid)?;
        if object
            .keys()
            .any(|key| !matches!(key.as_str(), "read" | "write"))
        {
            return Err(Invalid);
        }
        let read = object
            .get("read")
            .map(|v| v.as_bool().ok_or(Invalid))
            .transpose()?
            .unwrap_or(false);
        let write = match object.get("write").and_then(Value::as_str) {
            None if !object.contains_key("write") => Write::Off,
            Some("off") => Write::Off,
            Some("ask") => Write::Ask,
            _ => return Err(Invalid),
        };
        if !read && write != Write::Off {
            return Err(Invalid);
        }
        Ok(Self { read, write })
    }
    pub(crate) fn private(record: &Record) -> bool {
        ["private", "temporary"].iter().any(|key| {
            record.get(key).is_some_and(|raw| {
                serde_json::from_str::<Value>(raw.get()).map_or(true, |value| value != false)
            })
        })
    }
    pub fn record(record: &Record) -> Result<Self, Invalid> {
        // Temporary/private execution is not ported. A recovered marker must
        // never accidentally opt such a conversation into shared knowledge.
        if Self::private(record) {
            return Ok(Self::default());
        }
        let value = record
            .get("memory")
            .map(|raw| serde_json::from_str(raw.get()).map_err(|_| Invalid))
            .transpose()?;
        Self::parse(value.as_ref())
    }
    pub fn value(self) -> Value {
        json!({"read":self.read,"write": match self.write { Write::Off => "off", Write::Ask => "ask" }})
    }
}

pub(crate) async fn configure(
    state: std::sync::Arc<crate::State>,
    params: Value,
) -> Result<Value, crate::memory::MemoryError> {
    let invalid = || crate::memory::MemoryError {
        code: "invalid_params",
        message: "invalid memory configuration".into(),
    };
    let object = params.as_object().ok_or_else(invalid)?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "session" | "memory"))
    {
        return Err(invalid());
    }
    let name = object
        .get("session")
        .and_then(Value::as_str)
        .filter(|name| crate::session_model::is_name(name))
        .ok_or_else(invalid)?
        .to_owned();
    let next = object
        .get("memory")
        .map(|memory| Policy::parse(Some(memory)))
        .transpose()
        .map_err(|_| invalid())?;
    let tracked = state.host_jobs.track();
    let failed = state.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        let unavailable = || crate::memory::MemoryError {
            code: "storage_unavailable",
            message: "memory policy storage is unavailable".into(),
        };
        let mut registry = state.registry.lock().map_err(|_| unavailable())?;
        if registry.write_poisoned() {
            drop(registry);
            state.execution_storage_failed();
            return Err(unavailable());
        }
        let record = registry
            .find(&name)
            .ok_or_else(|| crate::memory::MemoryError {
                code: "not_found",
                message: "session not found".into(),
            })?;
        if next.is_some_and(|policy| policy.read) && Policy::private(record) {
            return Err(crate::memory::MemoryError {
                code: "forbidden",
                message: "private memory is disabled".into(),
            });
        }
        let key = crate::turn_snapshot::SessionKey {
            name: name.clone(),
            created_at: record.scalar("createdAt").ok_or_else(unavailable)?,
        };
        let policy = match next {
            Some(next) => next,
            None => Policy::record(record).map_err(|_| unavailable())?,
        };
        if next.is_some() {
            let updated = registry.update_checked(&key, |record| {
                record.set_raw("memory", serde_json::value::to_raw_value(&policy.value())?);
                Ok(())
            });
            let poisoned = registry.write_poisoned();
            drop(registry);
            if poisoned {
                state.execution_storage_failed();
            }
            updated.map_err(|_| unavailable())?;
            match state.session_memory.lock() {
                Ok(mut contexts) => {
                    contexts.revoke(&name);
                }
                Err(poison) => {
                    drop(poison);
                    state.execution_storage_failed();
                    return Err(unavailable());
                }
            }
            if let Some(memory) = state.memory_turns.get() {
                memory.revoke_session(&name);
            }
        }
        Ok(json!({"session":name,"memory":policy.value()}))
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            failed.execution_storage_failed();
            Err(crate::memory::MemoryError {
                code: "storage_unavailable",
                message: "memory policy storage is unavailable".into(),
            })
        }
    }
}
