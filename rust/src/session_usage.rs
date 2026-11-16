//! Daemon-epoch usage from manager-owned execution commits, never history replay.
//! This optional projection can fail independently of journal/execution storage.
use crate::{history::Fields, session_model::Record};
use serde_json::value::RawValue;
use std::collections::HashMap;

type Raw = Box<RawValue>;
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub entries: usize,
    pub retained_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 65_536,
            retained_bytes: 16 * 1024 * 1024,
        }
    }
}
#[derive(Clone)]
pub(crate) struct Row {
    provider: String,
    cost: f64,
    input: f64,
    output: f64,
    cache: f64,
    turns: f64,
    rate_limit: Raw,
}
pub(crate) struct Cache {
    rows: HashMap<Vec<u16>, Row>,
    bytes: usize,
    limits: Limits,
    unavailable: bool,
}
// A failed preparation is applied only after known successful append. It never
// rejects journal data or turns off execution. No Debug for private payloads.
pub(crate) enum Prepared {
    Update {
        name: Vec<u16>,
        row: Row,
        bytes: usize,
    },
    Unavailable,
}
#[derive(Debug, PartialEq)]
pub(crate) enum Error {
    Unavailable,
    Capacity,
}

impl Default for Cache {
    fn default() -> Self {
        Self::new(Limits::default())
    }
}
impl Cache {
    pub(crate) fn new(limits: Limits) -> Self {
        Self {
            rows: HashMap::new(),
            bytes: 0,
            limits,
            unavailable: false,
        }
    }
    pub(crate) fn prepare(
        &mut self,
        name: &[u16],
        provider: Option<&str>,
        data: &RawValue,
    ) -> Prepared {
        self.prepare_checked(name, provider, data)
            .unwrap_or(Prepared::Unavailable)
    }
    fn prepare_checked(
        &mut self,
        name: &[u16],
        provider: Option<&str>,
        data: &RawValue,
    ) -> anyhow::Result<Prepared> {
        anyhow::ensure!(!self.unavailable, "usage unavailable");
        let old = self.rows.get(name);
        anyhow::ensure!(
            old.is_some() || self.rows.len() < self.limits.entries,
            "usage names full"
        );
        let mut row = old
            .cloned()
            .unwrap_or_else(|| Row::zero(provider.unwrap_or("claude")));
        let data = Fields::parse(data)?;
        let source = data
            .get("source")
            .and_then(|v| crate::journal::decode_js_string(v).ok());
        if source.as_deref() == Some(&"result".encode_utf16().collect::<Vec<_>>()) {
            if let Some(cost) = data.get("totalCostUsd").and_then(numeric) {
                row.cost = cost;
            }
            row.turns += 1.0;
            if let Some(usage) = data.get("usage").filter(|v| v.get() != "null") {
                let usage = Fields::parse(usage)?;
                let token = |key| -> anyhow::Result<f64> {
                    match usage.get(key) {
                        None => Ok(0.0),
                        Some(v) if v.get() == "null" => Ok(0.0),
                        Some(v) => numeric(v)
                            .ok_or_else(|| anyhow::anyhow!("usage token must be numeric or null")),
                    }
                };
                row.input += token("input_tokens")?;
                row.output += token("output_tokens")?;
                row.cache += token("cache_read_input_tokens")?;
            }
        } else if source.as_deref() == Some(&"rate_limit_event".encode_utf16().collect::<Vec<_>>())
        {
            let mut limit = Fields::default();
            for key in ["status", "windows", "resetsAt"] {
                if let Some(value) = data.get(key) {
                    limit.set(key, crate::history::normalize(value)?);
                }
            }
            row.rate_limit = limit.into_raw()?;
        }
        let size = |row: &Row| name.len() * 2 + row.provider.len() + row.rate_limit.get().len();
        let bytes = self.bytes - old.map_or(0, size) + size(&row);
        anyhow::ensure!(bytes <= self.limits.retained_bytes, "usage bytes full");
        self.rows.try_reserve(usize::from(old.is_none()))?;
        Ok(Prepared::Update {
            name: name.to_vec(),
            row,
            bytes,
        })
    }
    pub(crate) fn apply_committed(&mut self, prepared: Prepared) {
        match prepared {
            Prepared::Update { name, row, bytes } if !self.unavailable => {
                self.rows.insert(name, row);
                self.bytes = bytes;
            }
            _ => {
                self.unavailable = true;
                self.rows.clear();
                self.bytes = 0;
            }
        }
    }
    pub(crate) fn render(&self, records: &[Record], budget: usize) -> Result<Raw, Error> {
        if self.unavailable {
            return Err(Error::Unavailable);
        }
        let mut out = String::new();
        push(&mut out, "{\"usage\":[", budget)?;
        for (i, record) in records.iter().enumerate() {
            if i > 0 {
                push(&mut out, ",", budget)?;
            }
            let name = record.string("name").unwrap_or_default();
            let zero;
            let row = match self.rows.get(&name) {
                Some(row) => row,
                None => {
                    zero = Row::zero(record.scalar("provider").as_deref().unwrap_or("claude"));
                    &zero
                }
            };
            push(&mut out, "{\"session\":", budget)?;
            push(&mut out, &crate::history::encode_string(&name), budget)?;
            push(&mut out, ",\"provider\":", budget)?;
            push(
                &mut out,
                &crate::history::encode_string(&row.provider.encode_utf16().collect::<Vec<_>>()),
                budget,
            )?;
            for (key, value) in [
                ("totalCostUsd", row.cost),
                ("inputTokens", row.input),
                ("outputTokens", row.output),
                ("cacheReadTokens", row.cache),
                ("turns", row.turns),
            ] {
                push(&mut out, &format!(",\"{key}\":"), budget)?;
                push(
                    &mut out,
                    if value.is_finite() {
                        ryu_js::Buffer::new().format_finite(value).to_owned()
                    } else {
                        "null".into()
                    }
                    .as_str(),
                    budget,
                )?;
            }
            push(&mut out, ",\"rateLimit\":", budget)?;
            push(&mut out, row.rate_limit.get(), budget)?;
            push(&mut out, "}", budget)?;
        }
        push(&mut out, "]}", budget)?;
        RawValue::from_string(out).map_err(|_| Error::Unavailable)
    }
}
impl Row {
    fn zero(provider: &str) -> Self {
        Self {
            provider: provider.into(),
            cost: 0.0,
            input: 0.0,
            output: 0.0,
            cache: 0.0,
            turns: 0.0,
            rate_limit: RawValue::from_string("null".into()).expect("null JSON"),
        }
    }
}
fn numeric(raw: &RawValue) -> Option<f64> {
    matches!(raw.get().as_bytes().first(), Some(b'-' | b'0'..=b'9'))
        .then(|| raw.get().parse().ok())
        .flatten()
}
fn push(out: &mut String, text: &str, budget: usize) -> Result<(), Error> {
    if out.len().saturating_add(text.len()) > budget {
        return Err(Error::Capacity);
    }
    out.push_str(text);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn raw(v: &Value) -> Raw {
        serde_json::value::to_raw_value(v).unwrap()
    }
    fn record(name: &str, provider: &str) -> Record {
        let mut rec = Record::default();
        rec.set_string("name", name);
        rec.set_string("provider", provider);
        rec
    }
    #[test]
    fn actual_node_manager_oracle() {
        let source =
            RawValue::from_string(include_str!("../../test/fixtures/usage/manager.json").into())
                .unwrap();
        let root = Fields::parse(&source).unwrap();
        let actions = crate::history::array_values(root.get("actions").unwrap()).unwrap();
        let mut cache = Cache::default();
        let mut records = Vec::new();
        for action in actions {
            let fields = Fields::parse(&action).unwrap();
            let text = |key| {
                fields
                    .get(key)
                    .and_then(|v| serde_json::from_str::<String>(v.get()).ok())
                    .unwrap_or_default()
            };
            let name = text("name");
            match text("op").as_str() {
                "create" => records.push(record(&name, &text("provider"))),
                "emit" => {
                    let provider = records
                        .iter()
                        .find(|r| r.name() == name)
                        .and_then(|r| r.scalar("provider"));
                    let prepared = cache.prepare(
                        &name.encode_utf16().collect::<Vec<_>>(),
                        provider.as_deref(),
                        fields.get("data").unwrap(),
                    );
                    cache.apply_committed(prepared);
                }
                // Public rm is not in Rust yet; validate cache semantics without adding a host API.
                "remove" => {
                    records.retain(|r| r.name() != name);
                    cache.rows.remove(&name.encode_utf16().collect::<Vec<_>>());
                    cache.bytes = cache
                        .rows
                        .iter()
                        .map(|(key, row)| {
                            key.len() * 2 + row.provider.len() + row.rate_limit.get().len()
                        })
                        .sum();
                }
                "restart" => cache = Cache::default(),
                _ => {}
            }
            let actual = cache.render(&records, crate::MAX_LINE).unwrap();
            assert_eq!(
                crate::history::normalize(&actual).unwrap().get(),
                crate::history::normalize(fields.get("expected").unwrap())
                    .unwrap()
                    .get()
            );
        }
    }
    #[test]
    fn byte_limit_frame_limit_and_rate_replacement_are_explicit() {
        let mut cache = Cache::new(Limits {
            entries: 10,
            retained_bytes: 80,
        });
        let small = cache.prepare(
            &[97],
            None,
            &raw(&json!({"source":"rate_limit_event","status":"one"})),
        );
        cache.apply_committed(small);
        let before = cache.bytes;
        let replace = cache.prepare(&[97], None, &raw(&json!({"source":"rate_limit_event"})));
        cache.apply_committed(replace);
        assert!(cache.bytes < before);
        assert_eq!(
            cache.render(&[record("a", "claude")], 10).unwrap_err(),
            Error::Capacity
        );
        let large = cache.prepare(
            &[97],
            None,
            &raw(&json!({"source":"rate_limit_event","windows":{"opaque":"x".repeat(100)}})),
        );
        cache.apply_committed(large);
        assert_eq!(cache.render(&[], 1000).unwrap_err(), Error::Unavailable);
        // Resource failure is epoch-wide, even if the overfull name is invisible.
    }
    #[test]
    fn only_committed_failures_latch_and_resource_limits_never_evict() {
        let mut cache = Cache::new(Limits {
            entries: 1,
            retained_bytes: 1000,
        });
        let first = cache.prepare(
            &[97],
            Some("codex"),
            &raw(&json!({"source":"result","usage":{"input_tokens":1}})),
        );
        cache.apply_committed(first);
        let failed = cache.prepare(&[98], None, &raw(&json!({})));
        assert!(cache.render(&[record("a", "codex")], 1000).is_ok());
        cache.apply_committed(failed);
        assert_eq!(cache.render(&[], 1000).unwrap_err(), Error::Unavailable);
        let mut cache = Cache::default();
        let malformed = cache.prepare(
            &[97],
            None,
            &raw(&json!({"source":"result","usage":{"input_tokens":"3"}})),
        );
        cache.apply_committed(malformed);
        assert_eq!(cache.render(&[], 1000).unwrap_err(), Error::Unavailable);
    }
}
