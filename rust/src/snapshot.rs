//! Lightweight journal projection for the window; no conversation bodies retained.
use anyhow::{Context, Result};
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet};

pub(crate) type QueueReceipts = HashSet<(Vec<u16>, Vec<u16>)>;

#[derive(Default, Debug)]
pub(crate) struct SnapshotIndex {
    latest: HashMap<Vec<u16>, HashMap<String, u64>>,
    activity: HashMap<Vec<u16>, Box<RawValue>>,
    receipts: HashMap<Vec<u16>, QueueReceipts>,
}

impl SnapshotIndex {
    pub fn note(&mut self, id: u64, event: &RawValue) -> Result<()> {
        // Borrow each value from the validated record. Copying/decoding the
        // entire tool output for four field lookups made large-journal startup
        // several times slower. Map insertion also provides last-key-wins.
        let fields: HashMap<String, &RawValue> = serde_json::from_str(event.get())?;
        let session = crate::journal::decode_js_string(
            fields.get("sessionId").context("event has sessionId")?,
        )?;
        let kind = fields
            .get("kind")
            .and_then(|v| serde_json::from_str::<String>(v.get()).ok());
        let removed = if kind.as_deref() == Some("session.ended") {
            fields
                .get("data")
                .filter(|v| v.get().starts_with('{'))
                .map(|v| crate::history::field(v, "reason"))
                .transpose()?
                .flatten()
                .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                .as_deref()
                == Some("rm")
        } else {
            false
        };
        if removed {
            self.receipts.remove(&session);
            self.latest.remove(&session);
            self.activity.remove(&session);
            return Ok(());
        }
        if kind.as_deref() == Some("message.user")
            && let Some(data) = fields.get("data").filter(|v| v.get().starts_with('{'))
        {
            let data = crate::history::Fields::parse(data)?;
            if let (Some(id), Some(at)) = (data.get("queueItemId"), data.get("queueItemAt"))
                && let (Ok(id), Ok(at)) = (
                    crate::journal::decode_js_string(id),
                    crate::journal::decode_js_string(at),
                )
            {
                self.receipts
                    .entry(session.clone())
                    .or_default()
                    .insert((id, at));
            }
        }
        if let Some(kind) = kind.as_deref().filter(|kind| {
            matches!(
                *kind,
                "daemon.started"
                    | "background.changed"
                    | "context.updated"
                    | "usage.updated"
                    | "limit.hit"
                    | "net.blocked"
            )
        }) {
            self.latest
                .entry(session.clone())
                .or_default()
                .insert(kind.to_owned(), id);
        }
        if !matches!(kind.as_deref(), Some("message.delta" | "context.updated")) {
            if let Some(ts) = fields.get("ts") {
                self.activity.insert(session, (*ts).to_owned());
            } else {
                self.activity.remove(&session);
            }
        }
        Ok(())
    }

    pub fn receipts(&self, session: &str) -> QueueReceipts {
        self.receipts
            .get(&session.encode_utf16().collect::<Vec<_>>())
            .cloned()
            .unwrap_or_default()
    }

    pub fn ids(&self) -> Vec<u64> {
        let mut ids: Vec<_> = self
            .latest
            .values()
            .flat_map(|by_kind| by_kind.values().copied())
            .collect();
        ids.sort_unstable();
        ids
    }

    pub fn activity(&self) -> Result<Box<RawValue>> {
        let fields = self
            .activity
            .iter()
            .map(|(key, value)| format!("{}:{}", crate::stream::encode_units(key), value.get()))
            .collect::<Vec<_>>()
            .join(",");
        Ok(RawValue::from_string(format!("{{{fields}}}"))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn duplicate_metadata_and_reason_use_last_value_like_node() {
        let mut state = SnapshotIndex::default();
        state.note(1, &RawValue::from_string(r#"{"sessionId":"x","kind":"message.done","kind":"background.changed","ts":"a","ts":"b","data":{},"data":{"active":true}}"#.into()).unwrap()).unwrap();
        assert_eq!(state.ids(), vec![1]);
        assert_eq!(state.activity().unwrap().get(), r#"{"x":"b"}"#);
        state.note(2, &RawValue::from_string(r#"{"sessionId":"x","kind":"session.ended","data":{"reason":"stop","reason":"rm"}}"#.into()).unwrap()).unwrap();
        assert!(state.ids().is_empty());
        assert_eq!(state.activity().unwrap().get(), "{}");
    }
    #[test]
    fn removal_resets_state_and_activity_follows_order_not_timestamp() {
        let mut state = SnapshotIndex::default();
        let mut note = |id, kind, ts, data| {
            state
                .note(
                    id,
                    &serde_json::value::to_raw_value(
                        &json!({"sessionId":"chat","kind":kind,"ts":ts,"data":data}),
                    )
                    .unwrap(),
                )
                .unwrap()
        };
        note(1, "background.changed", "z", json!({}));
        note(2, "context.updated", "later", json!({}));
        note(3, "message.delta", "later", json!({}));
        note(4, "message.done", "a", json!({}));
        assert_eq!(state.ids(), vec![1, 2]);
        assert_eq!(state.activity().unwrap().get(), r#"{"chat":"a"}"#);
        state
            .note(
                5,
                &serde_json::value::to_raw_value(
                    &json!({"sessionId":"chat","kind":"session.ended","data":{"reason":"rm"}}),
                )
                .unwrap(),
            )
            .unwrap();
        assert!(state.ids().is_empty());
        assert_eq!(state.activity().unwrap().get(), "{}");
        state
            .note(
                6,
                &serde_json::value::to_raw_value(
                    &json!({"sessionId":"chat","kind":"usage.updated","ts":null}),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(state.ids(), vec![6]);
        assert_eq!(state.activity().unwrap().get(), r#"{"chat":null}"#);
    }
}
