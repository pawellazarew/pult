//! Lossless parameters for read APIs: old Node session names may contain UTF-16
//! code units which cannot be represented by a Rust String.
use anyhow::{Result, bail, ensure};
use serde_json::{Value, value::RawValue};
use std::collections::HashMap;

pub(crate) enum Query {
    Snapshot,
    History {
        session: Vec<u16>,
        before: Option<f64>,
        budget: usize,
    },
    Get {
        ids: Vec<u64>,
    },
}

fn safe_integer(raw: &RawValue) -> Option<f64> {
    serde_json::from_str::<f64>(raw.get()).ok().filter(|n| {
        n.is_finite() && n.fract() == 0.0 && n.abs() <= crate::journal::MAX_EVENT_ID as f64
    })
}

pub(crate) fn parse(bytes: &[u8]) -> Option<(Value, Result<Query>)> {
    let mut fields: HashMap<String, Box<RawValue>> = serde_json::from_slice(bytes).ok()?;
    let method: String = serde_json::from_str(fields.get("method")?.get()).ok()?;
    if !matches!(
        method.as_str(),
        "events.snapshot" | "events.history" | "events.get"
    ) {
        return None;
    }
    let id = fields
        .remove("id")
        .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
        .unwrap_or(Value::Null);
    let query = (|| {
        ensure!(
            id.is_string() || id.is_number(),
            "request needs id, method and object params"
        );
        let params: HashMap<String, Box<RawValue>> = if let Some(raw) = fields.remove("params") {
            serde_json::from_str(raw.get())
                .map_err(|_| anyhow::anyhow!("params must be an object"))?
        } else {
            HashMap::new()
        };
        match method.as_str() {
            "events.snapshot" => Ok(Query::Snapshot),
            "events.history" => {
                let session = params
                    .get("sessionId")
                    .and_then(|raw| crate::journal::decode_js_string(raw).ok());
                let Some(session) = session.filter(|s| !s.is_empty()) else {
                    bail!("events.history: sessionId must be a nonempty string");
                };
                let before = params.get("before").and_then(|v| safe_integer(v));
                let budget = params
                    .get("budget")
                    .and_then(|v| safe_integer(v))
                    .unwrap_or(524_288.0)
                    .clamp(1024.0, 524_288.0) as usize;
                Ok(Query::History {
                    session,
                    before,
                    budget,
                })
            }
            _ => {
                let ids = params
                    .get("ids")
                    .and_then(|raw| serde_json::from_str::<Vec<Box<RawValue>>>(raw.get()).ok())
                    .unwrap_or_default();
                let ids: Vec<_> = ids.iter().filter_map(|raw| safe_integer(raw)).collect();
                ensure!(
                    !ids.is_empty(),
                    "events.get: ids must contain a safe integer"
                );
                ensure!(ids.len() <= 200, "events.get: at most 200 IDs per request");
                Ok(Query::Get {
                    ids: ids
                        .into_iter()
                        .filter(|n| *n > 0.0)
                        .map(|n| n as u64)
                        .collect(),
                })
            }
        }
    })();
    Some((id, query))
}

pub(crate) async fn execute(
    state: std::sync::Arc<crate::State>,
    query: Query,
) -> Result<Box<RawValue>> {
    tokio::task::spawn_blocking(move || {
        let mut store = state
            .store
            .lock()
            .map_err(|_| anyhow::anyhow!("journal lock poisoned"))?;
        match query {
            Query::Snapshot => store.snapshot(),
            Query::Get { ids } => crate::history::get(store.read_ids(&ids)?),
            Query::History {
                session,
                before,
                budget,
            } => {
                let stamp = store.session_stamp(&session)?;
                let mut cache = state
                    .history
                    .lock()
                    .map_err(|_| anyhow::anyhow!("history cache lock poisoned"))?;
                let page = cache.get(
                    session.clone(),
                    stamp,
                    || store.read_session(&session),
                    before,
                    budget,
                )?;
                let mut fields: HashMap<String, Box<RawValue>> = serde_json::from_str(page.get())?;
                fields.insert(
                    "cursor".into(),
                    serde_json::value::to_raw_value(&store.last_id())?,
                );
                Ok(serde_json::value::to_raw_value(&fields)?)
            }
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_names_and_javascript_safe_integer_filter() {
        let (_, query) = parse(br#"{"id":1,"method":"events.history","params":{"sessionId":"old-\ud800","before":1.5,"budget":-1}}"#).unwrap();
        match query.unwrap() {
            Query::History {
                session,
                before,
                budget,
            } => {
                assert_eq!(session.last(), Some(&0xd800));
                assert_eq!(before, None);
                assert_eq!(budget, 1024);
            }
            _ => panic!("expected history"),
        }
        let (_, query) = parse(br#"{"id":1,"method":"events.get","params":{"ids":[true,"2",2.0,2,-1,0,1.5,9007199254740992]}}"#).unwrap();
        match query.unwrap() {
            Query::Get { ids } => assert_eq!(ids, vec![2, 2]),
            _ => panic!("expected get"),
        }
    }
}
