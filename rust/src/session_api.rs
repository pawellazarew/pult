//! Owner-only session metadata commands, without provider execution.
use crate::history::{Fields, array_values};
use crate::journal::decode_js_string;
use anyhow::{Result, ensure};
use serde_json::{Value, value::RawValue};

pub(crate) enum Command {
    Read {
        name: String,
        since: f64,
        json: bool,
    },
    Tree {
        name: String,
        locale: Option<crate::locale::Setting>,
    },
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

impl Command {
    pub(crate) fn is_mutation(&self) -> bool {
        !matches!(self, Self::Read { .. } | Self::Tree { .. })
    }
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

pub(crate) fn js_string(raw: &RawValue, array_item: bool, depth: usize) -> Result<Vec<u16>> {
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
        "agent.read" | "agent.tree" | "agent.rename" | "agent.archive" | "agent.seen"
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
            "agent.read" => Command::Read {
                name,
                since: params
                    .get("since")
                    .and_then(|v| serde_json::from_str::<f64>(v.get()).ok())
                    .filter(|n| n.is_finite())
                    .unwrap_or(0.0),
                json: params.get("format").is_some_and(|v| {
                    decode_js_string(v)
                        .is_ok_and(|v| v == "json".encode_utf16().collect::<Vec<_>>())
                }),
            },
            "agent.tree" => Command::Tree {
                name,
                locale: crate::locale::explicit(fields.get("locale")),
            },
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
        let mut store = state.store.lock().map_err(ApiError::internal)?;
        let mut registry = state.registry.lock().map_err(ApiError::internal)?;
        let name = match &command {
            Command::Read { name, .. }
            | Command::Tree { name, .. }
            | Command::Rename { name, .. }
            | Command::Archive { name, .. }
            | Command::Seen { name, .. } => name,
        };
        if registry.find(name).is_none() {
            return Err(ApiError {
                code: "not_found",
                message: format!("session {name} not found"),
            });
        }
        match &command {
            Command::Read { name, since, json } => {
                let worktree = registry
                    .find(name)
                    .and_then(|r| r.get("worktree"))
                    .map(RawValue::to_owned);
                let records = store
                    .read_from(
                        since.floor().max(0.0) as u64,
                        Some(name),
                        usize::MAX,
                        usize::MAX,
                    )
                    .map_err(ApiError::internal)?;
                return crate::session_read::render(records, *since, *json, worktree)
                    .map_err(ApiError::internal);
            }
            Command::Tree { name, locale } => {
                let english = crate::locale::english(locale.unwrap_or(registry.language()), None);
                let records = store
                    .read_from(0, Some(name), usize::MAX, usize::MAX)
                    .map_err(ApiError::internal)?;
                return crate::session_tree::render(records, english).map_err(ApiError::internal);
            }
            _ => {}
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
            Command::Read { .. } | Command::Tree { .. } => {
                unreachable!("read queries returned above")
            }
            Command::Rename { name, title } => registry.rename(&name, &title),
            Command::Archive { name, archived } => {
                let result = registry.archive(&name, archived);
                if archived
                    && result.is_ok()
                    && let Ok(mut contexts) = state.session_memory.lock()
                {
                    contexts.revoke(&name);
                }
                result
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_decode_escaped_format_and_accept_fractional_cursor() {
        let (_, command) = parse(br#"{"id":1,"method":"agent.read","params":{"name":"session","format":"j\u0073on","since":-0.5}}"#).unwrap();
        assert!(matches!(
            command.unwrap(),
            Command::Read {
                json: true,
                since: -0.5,
                ..
            }
        ));
        let (_, command) = parse(br#"{"id":1,"method":"agent.read","params":{"name":"session","format":null,"since":"4"}}"#).unwrap();
        assert!(matches!(
            command.unwrap(),
            Command::Read {
                json: false,
                since: 0.0,
                ..
            }
        ));
    }
}
