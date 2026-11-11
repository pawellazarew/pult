//! Owner-only session metadata commands, without provider execution.
use crate::history::{Fields, array_values};
use crate::journal::decode_js_string;
use anyhow::{Result, ensure};
use serde_json::{Value, value::RawValue};

pub(crate) enum Command {
    Rename {
        name: String,
        title: Vec<u16>,
    },
    Archive {
        name: String,
        archived: bool,
    },
    Seen {
        name: String,
        unread: bool,
        up_to: Option<u64>,
    },
}

pub(crate) struct ApiError {
    pub code: &'static str,
    pub message: String,
}
impl ApiError {
    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            code: "internal",
            message: error.to_string(),
        }
    }
}

fn js_string(raw: &RawValue, array_item: bool, depth: usize) -> Result<Vec<u16>> {
    ensure!(depth <= 64, "name coercion nesting exceeds 64 levels");
    let text = raw.get();
    Ok(match text.as_bytes()[0] {
        b'"' => decode_js_string(raw)?,
        b'{' => "[object Object]".encode_utf16().collect(),
        b'[' => {
            let mut out = Vec::new();
            for (index, item) in array_values(raw)?.iter().enumerate() {
                if index > 0 {
                    out.push(u16::from(b','));
                }
                out.extend(js_string(item, true, depth + 1)?);
            }
            out
        }
        b'n' if array_item => Vec::new(),
        b'n' | b't' | b'f' => text.encode_utf16().collect(),
        _ => {
            let number: f64 = text.parse()?;
            ryu_js::Buffer::new()
                .format(number)
                .encode_utf16()
                .collect()
        }
    })
}

fn integer(raw: &RawValue) -> Option<u64> {
    serde_json::from_str::<f64>(raw.get())
        .ok()
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && *n >= 0.0
                && *n <= crate::journal::MAX_EVENT_ID as f64
        })
        .map(|n| n as u64)
}

pub(crate) fn parse(bytes: &[u8]) -> Option<(Value, Result<Command>)> {
    let raw: Box<RawValue> = serde_json::from_slice(bytes).ok()?;
    let fields = Fields::parse(&raw).ok()?;
    let method: String = serde_json::from_str(fields.get("method")?.get()).ok()?;
    if !matches!(
        method.as_str(),
        "agent.rename" | "agent.archive" | "agent.seen"
    ) {
        return None;
    }
    let id = fields
        .get("id")
        .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
        .unwrap_or(Value::Null);
    let result = (|| {
        ensure!(
            id.is_string() || id.is_number(),
            "request needs id, method and object params"
        );
        let params = match fields.get("params") {
            Some(raw) => Fields::parse(raw)?,
            None => Fields::default(),
        };
        // Validate action fields before resolving the name, matching Node RPC.
        let title = if method == "agent.rename" {
            Some(decode_js_string(
                params
                    .get("title")
                    .ok_or_else(|| anyhow::anyhow!("title must be a string"))?,
            )?)
        } else {
            None
        };
        let archived = if method == "agent.archive" {
            Some(serde_json::from_str::<bool>(
                params
                    .get("archived")
                    .ok_or_else(|| anyhow::anyhow!("archived must be a boolean"))?
                    .get(),
            )?)
        } else {
            None
        };
        let unread = params.get("unread");
        let up_to = params.get("upTo");
        if method == "agent.seen" {
            ensure!(
                unread.is_none_or(|raw| matches!(raw.get(), "true" | "false")),
                "unread must be a boolean"
            );
            ensure!(
                up_to.is_none_or(|raw| integer(raw).is_some()),
                "upTo must be a nonnegative safe integer"
            );
        }
        let name = params
            .get("name")
            .filter(|v| v.get() != "null")
            .map(|raw| js_string(raw, false, 0))
            .transpose()?
            .unwrap_or_default();
        let name = String::from_utf16_lossy(&name);
        Ok(match method.as_str() {
            "agent.rename" => Command::Rename {
                name,
                title: title.expect("validated title"),
            },
            "agent.archive" => Command::Archive {
                name,
                archived: archived.expect("validated archive"),
            },
            _ => Command::Seen {
                name,
                unread: unread.is_some_and(|v| v.get() == "true"),
                up_to: up_to.and_then(integer),
            },
        })
    })();
    Some((id, result))
}

pub(crate) async fn execute(
    state: std::sync::Arc<crate::State>,
    command: Command,
) -> std::result::Result<Box<RawValue>, ApiError> {
    tokio::task::spawn_blocking(move || {
        // Use the same lock order as startup and all registry/journal commands.
        let store = state.store.lock().map_err(ApiError::internal)?;
        let mut registry = state.registry.lock().map_err(ApiError::internal)?;
        let name = match &command {
            Command::Rename { name, .. }
            | Command::Archive { name, .. }
            | Command::Seen { name, .. } => name,
        };
        if registry.find(name).is_none() {
            return Err(ApiError {
                code: "not_found",
                message: format!("session {name} not found"),
            });
        }
        if let Command::Rename { title, .. } = &command
            && crate::session_model::normalize_title(title)
                .is_some_and(|title| crate::session_model::title_length(&title) > 60)
        {
            return Err(ApiError {
                code: "invalid_params",
                message: "title exceeds 60 characters".into(),
            });
        }
        let record = match command {
            Command::Rename { name, title } => registry.rename(&name, &title),
            Command::Archive { name, archived } => registry.archive(&name, archived),
            Command::Seen {
                name,
                unread,
                up_to,
            } => registry.seen(&name, unread, up_to, store.last_id()),
        }
        .map_err(ApiError::internal)?;
        crate::session_model::public_record(&record).map_err(ApiError::internal)
    })
    .await
    .map_err(ApiError::internal)?
}
