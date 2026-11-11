//! Node-compatible lightweight history. JSON string values remain UTF-16 units:
//! a completed delta can intentionally contain only half of a surrogate pair.
use crate::journal::{JournalRecord, decode_js_string};
use anyhow::{Context, Result, ensure};
use serde_json::value::RawValue;
use std::collections::{HashMap, HashSet, VecDeque};

pub const HISTORY_PAGE_BYTES: usize = 512 * 1024;
const GET_STRING_CHARS: usize = 100_000;
const TOOL_INPUT_CHARS: usize = 300;
const OTHER_CHARS: usize = 2000;

type Raw = Box<RawValue>;
type Key = Vec<u16>;

fn raw(text: String) -> Result<Raw> {
    Ok(RawValue::from_string(text)?)
}

fn key(text: &str) -> Key {
    text.encode_utf16().collect()
}

fn encode_string(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for character in char::decode_utf16(units.iter().copied()) {
        match character {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(ch) if ch < '\u{20}' => out.push_str(&format!("\\u{:04x}", u32::from(ch))),
            Ok(ch) => out.push(ch),
            Err(error) => out.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn string(value: &RawValue) -> Result<Option<Key>> {
    if value.get().starts_with('"') {
        Ok(Some(decode_js_string(value)?))
    } else {
        Ok(None)
    }
}

fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut at = start + 1;
    while bytes[at] != b'"' {
        at += if bytes[at] == b'\\' { 2 } else { 1 };
    }
    at + 1
}

fn skip_space(bytes: &[u8], at: &mut usize) {
    while bytes.get(*at).is_some_and(u8::is_ascii_whitespace) {
        *at += 1;
    }
}

/// The caller supplies validated RawValue JSON. Nested values are skipped
/// iteratively rather than recursively, including arbitrarily deep containers.
fn value_end(bytes: &[u8], start: usize) -> usize {
    if bytes[start] == b'"' {
        return string_end(bytes, start);
    }
    if bytes[start] != b'{' && bytes[start] != b'[' {
        let mut at = start;
        while bytes.get(at).is_some_and(|b| !b",]} \n\r\t".contains(b)) {
            at += 1;
        }
        return at;
    }
    let mut at = start;
    let mut depth = 0;
    loop {
        match bytes[at] {
            b'"' => at = string_end(bytes, at),
            b'{' | b'[' => {
                depth += 1;
                at += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                at += 1;
                if depth == 0 {
                    return at;
                }
            }
            _ => at += 1,
        }
    }
}

/// Rust Display and ECMAScript choose different decimal ties for the same
/// float. Use the ECMAScript formatter, not a hand-maintained approximation.
fn js_number(text: &str) -> Result<String> {
    let number: f64 = text.parse()?;
    if !number.is_finite() {
        return Ok("null".into());
    }
    Ok(ryu_js::Buffer::new().format_finite(number).to_owned())
}

fn normalize(value: &RawValue) -> Result<Raw> {
    Ok(transform(value, None)?.0)
}

#[derive(Clone, Default)]
struct Fields(Vec<(Key, Raw)>);
impl Fields {
    fn parse(value: &RawValue) -> Result<Self> {
        ensure!(value.get().starts_with('{'), "event must be a JSON object");
        let text = value.get();
        let bytes = text.as_bytes();
        let mut at = 1;
        let mut fields = Self::default();
        let mut positions = HashMap::new();
        loop {
            skip_space(bytes, &mut at);
            if bytes[at] == b'}' {
                return Ok(fields);
            }
            let end = string_end(bytes, at);
            let name = decode_js_string(&raw(text[at..end].to_owned())?)?;
            at = end;
            skip_space(bytes, &mut at);
            ensure!(bytes[at] == b':', "expected object colon");
            at += 1;
            skip_space(bytes, &mut at);
            let end = value_end(bytes, at);
            let value = raw(text[at..end].to_owned())?;
            if let Some(position) = positions.get(&name).copied() {
                fields.0[position] = (name, value);
            } else {
                positions.insert(name.clone(), fields.0.len());
                fields.0.push((name, value));
            }
            at = end;
            skip_space(bytes, &mut at);
            if bytes[at] == b',' {
                at += 1;
            }
        }
    }
    fn set_key(&mut self, name: Key, value: Raw) {
        if let Some((_, old)) = self.0.iter_mut().find(|(k, _)| k == &name) {
            *old = value;
        } else {
            self.0.push((name, value));
        }
    }
    fn set(&mut self, name: &str, value: Raw) {
        self.set_key(key(name), value);
    }
    fn get(&self, name: &str) -> Option<&RawValue> {
        let name = key(name);
        self.0.iter().find(|(k, _)| *k == name).map(|(_, v)| &**v)
    }
    fn remove(&mut self, name: &str) -> Option<Raw> {
        let name = key(name);
        let at = self.0.iter().position(|(k, _)| *k == name)?;
        Some(self.0.remove(at).1)
    }
    fn into_raw(self) -> Result<Raw> {
        let mut out = String::from("{");
        for (at, (name, value)) in self.0.into_iter().enumerate() {
            if at > 0 {
                out.push(',');
            }
            out.push_str(&encode_string(&name));
            out.push(':');
            out.push_str(value.get());
        }
        out.push('}');
        raw(out)
    }
}

/// Retrieve a field using JSON.parse's last-key-wins semantics. Looking up one
/// ordinary key must not reject unrelated UTF-16 keys or duplicate metadata.
pub(crate) fn field(value: &RawValue, name: &str) -> Result<Option<Raw>> {
    Ok(Fields::parse(value)?.get(name).map(RawValue::to_owned))
}

fn array_values(value: &RawValue) -> Result<Vec<Raw>> {
    let text = value.get();
    let bytes = text.as_bytes();
    let mut at = 1;
    let mut out = Vec::new();
    loop {
        skip_space(bytes, &mut at);
        if bytes[at] == b']' {
            return Ok(out);
        }
        let end = value_end(bytes, at);
        out.push(raw(text[at..end].to_owned())?);
        at = end;
        skip_space(bytes, &mut at);
        if bytes[at] == b',' {
            at += 1;
        }
    }
}

/// Object.entries / object spread for the occasional older non-object data.
fn entries(value: &RawValue) -> Result<Fields> {
    match value.get().as_bytes()[0] {
        b'{' => Fields::parse(value),
        b'[' => Ok(Fields(
            array_values(value)?
                .into_iter()
                .enumerate()
                .map(|(at, v)| (key(&at.to_string()), v))
                .collect(),
        )),
        b'"' => Ok(Fields(
            decode_js_string(value)?
                .into_iter()
                .enumerate()
                .map(|(at, unit)| Ok((key(&at.to_string()), raw(encode_string(&[unit]))?)))
                .collect::<Result<Vec<_>>>()?,
        )),
        _ => Ok(Fields::default()),
    }
}

/// Recursive clipping with an explicit work stack, so a deep legacy JSON value
/// cannot overflow the daemon's stack. As in Node's plain-object assignment,
/// a __proto__ key does not become an own output property.
fn clip(value: &RawValue, limit: usize) -> Result<(Raw, bool)> {
    transform(value, Some(limit))
}

fn transform(value: &RawValue, limit: Option<usize>) -> Result<(Raw, bool)> {
    enum Work {
        Value(Raw),
        Literal(String),
    }
    let mut work = vec![Work::Value(value.to_owned())];
    let mut out = String::new();
    let mut cut = false;
    while let Some(task) = work.pop() {
        let Work::Value(value) = task else {
            if let Work::Literal(text) = task {
                out.push_str(&text);
            }
            continue;
        };
        match value.get().as_bytes()[0] {
            b'"' => {
                let mut units = decode_js_string(&value)?;
                if let Some(limit) = limit.filter(|limit| units.len() > *limit) {
                    units.truncate(limit);
                    units.push(0x2026);
                    cut = true;
                }
                out.push_str(&encode_string(&units));
            }
            b'{' => {
                out.push('{');
                work.push(Work::Literal("}".into()));
                let fields: Vec<_> = Fields::parse(&value)?
                    .0
                    .into_iter()
                    .filter(|(name, _)| limit.is_none() || *name != key("__proto__"))
                    .collect();
                for (at, (name, value)) in fields.into_iter().enumerate().rev() {
                    work.push(Work::Value(value));
                    work.push(Work::Literal(format!(
                        "{}{}:",
                        if at > 0 { "," } else { "" },
                        encode_string(&name)
                    )));
                }
            }
            b'[' => {
                out.push('[');
                work.push(Work::Literal("]".into()));
                for (at, value) in array_values(&value)?.into_iter().enumerate().rev() {
                    work.push(Work::Value(value));
                    if at > 0 {
                        work.push(Work::Literal(",".into()));
                    }
                }
            }
            b'-' | b'0'..=b'9' => out.push_str(&js_number(value.get())?),
            _ => out.push_str(value.get()),
        }
    }
    Ok((raw(out)?, cut))
}

struct Event {
    id: u64,
    fields: Fields,
}
impl Event {
    fn from_record(record: JournalRecord) -> Result<Self> {
        Ok(Self {
            id: record.id,
            fields: Fields::parse(&normalize(&record.json)?)?,
        })
    }
    fn kind(&self, kind: &str) -> Result<bool> {
        Ok(self.fields.get("kind").map(string).transpose()?.flatten() == Some(key(kind)))
    }
    fn data(&self) -> Result<Raw> {
        Ok(self
            .fields
            .get("data")
            .filter(|d| d.get() != "null")
            .map(RawValue::to_owned)
            .unwrap_or(raw("{}".into())?))
    }
}

fn data_string(data: &Fields, name: &str) -> Result<Option<Key>> {
    data.get(name).map(string).transpose().map(Option::flatten)
}

fn same_item(a: &Option<Key>, b: &Option<Key>) -> bool {
    a.is_none() || b.is_none() || a == b
}

/// ECMAScript WhiteSpace + LineTerminator; Rust trim additionally removes some
/// characters (for example U+0085) which JavaScript intentionally retains.
fn js_whitespace(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn compact(records: Vec<JournalRecord>) -> Result<Vec<Event>> {
    let mut out: Vec<Event> = Vec::new();
    let mut agents: HashSet<Key> = HashSet::new();
    let mut open: HashMap<Key, (usize, Option<Key>)> = HashMap::new();
    for record in records {
        let mut event = Event::from_record(record)?;
        let parent = event
            .fields
            .get("parentId")
            .map(string)
            .transpose()?
            .flatten();
        let scope = parent
            .filter(|parent| agents.contains(parent))
            .unwrap_or_default();
        let data = event.data()?;
        let fields = entries(&data)?;
        if event.kind("message.delta")? {
            let Some(text) = data_string(&fields, "text")?.filter(|text| !text.is_empty()) else {
                continue;
            };
            let item = data_string(&fields, "itemId")?;
            if let Some((at, _)) = open.get(&scope).filter(|(_, old)| same_item(&item, old)) {
                let mut head = entries(&out[*at].data()?)?;
                let mut whole = data_string(&head, "text")?.unwrap_or_default();
                whole.extend(text);
                head.set("text", raw(encode_string(&whole))?);
                out[*at].fields.set("data", head.into_raw()?);
                // The first item's identity remains the identity of the run.
                continue;
            }
            event.fields.set("data", fields.into_raw()?);
            out.push(event);
            open.insert(scope, (out.len() - 1, item));
            continue;
        }
        if event.kind("message.done")?
            && data_string(&fields, "text")?
                .is_some_and(|text| text.iter().any(|unit| !js_whitespace(*unit)))
            && let Some((at, previous)) = open.get(&scope)
            && same_item(&data_string(&fields, "itemId")?, previous)
        {
            let mut head = entries(&out[*at].data()?)?;
            let text = data_string(&head, "text")?.context("open delta has string text")?;
            head.set("text", raw(encode_string(&text[..text.len().min(1)]))?);
            out[*at].fields.set("data", head.into_raw()?);
        }
        open.clear();
        if event.kind("agent.spawned")?
            && let Some(tool) = data_string(&fields, "toolUseId")?
        {
            agents.insert(tool);
        }
        if [
            "message.user",
            "message.done",
            "permission.requested",
            "permission.resolved",
        ]
        .iter()
        .any(|kind| event.kind(kind).unwrap_or(false))
        {
            out.push(event);
            continue;
        }
        if event.kind("tool.finished")? {
            let mut rest = fields;
            let elided = rest.remove("content").is_some();
            let (data, _) = clip(&rest.into_raw()?, OTHER_CHARS)?;
            let mut rest = Fields::parse(&data)?;
            if elided {
                rest.set("elided", raw("true".into())?);
            }
            event.fields.set("data", rest.into_raw()?);
        } else if event.kind("tool.called")? {
            let mut rest = fields;
            let input = rest.remove("input");
            let (data, _) = clip(&rest.into_raw()?, OTHER_CHARS)?;
            let mut rest = Fields::parse(&data)?;
            if let Some(input) = input {
                let (input, cut) = clip(&input, TOOL_INPUT_CHARS)?;
                rest.set("input", input);
                if cut {
                    rest.set("inputElided", raw("true".into())?);
                }
            }
            event.fields.set("data", rest.into_raw()?);
        } else {
            event.fields.set("data", clip(&data, OTHER_CHARS)?.0);
        }
        out.push(event);
    }
    Ok(out)
}

#[cfg(test)]
fn history(records: Vec<JournalRecord>, before: Option<f64>, budget: usize) -> Result<Raw> {
    page(&compact(records)?, before, budget)
}

fn page(events: &[Event], before: Option<f64>, budget: usize) -> Result<Raw> {
    let upto = before.map_or(events.len(), |before| {
        events
            .iter()
            .take_while(|event| (event.id as f64) < before)
            .count()
    });
    let mut start = upto;
    let mut bytes = 0;
    for at in (0..upto).rev() {
        let size = events[at].fields.clone().into_raw()?.get().len() + 1;
        if bytes + size > budget && start < upto {
            break;
        }
        bytes += size;
        start = at;
    }
    if start > 0 {
        for (at, event) in events.iter().enumerate().take(upto).skip(start) {
            if event.kind("message.user")? {
                if at > start {
                    start = at;
                }
                break;
            }
        }
    }
    let oldest = events
        .get(start)
        .filter(|_| start < upto)
        .map(|event| event.id);
    let selected = events
        .iter()
        .skip(start)
        .take(upto - start)
        .map(|event| event.fields.clone().into_raw())
        .collect::<Result<Vec<_>>>()?;
    let mut fields = Fields::default();
    fields.set("events", raw_array(selected)?);
    fields.set("more", raw((start > 0).to_string())?);
    fields.set(
        "oldest",
        raw(oldest.map_or("null".into(), |id| id.to_string()))?,
    );
    fields.into_raw()
}

/// File identity, byte size, mtime seconds and subsecond nanoseconds.
pub type HistoryStamp = (u64, u64, i64, i64);

struct Cached {
    session: Vec<u16>,
    stamp: HistoryStamp,
    events: Vec<Event>,
}

/// The same four-session LRU as Node. Missing files are loaded but never cached;
/// external replacement, append and mtime changes all invalidate an entry.
#[derive(Default)]
pub struct HistoryCache {
    entries: VecDeque<Cached>,
}
impl HistoryCache {
    pub fn get(
        &mut self,
        session: Vec<u16>,
        stamp: Option<HistoryStamp>,
        load: impl FnOnce() -> Result<Vec<JournalRecord>>,
        before: Option<f64>,
        budget: usize,
    ) -> Result<Raw> {
        if let Some(at) = self
            .entries
            .iter()
            .position(|entry| entry.session == session)
        {
            let entry = self.entries.remove(at).expect("located cache entry");
            if stamp == Some(entry.stamp) {
                self.entries.push_back(entry);
                return page(
                    &self.entries.back().expect("pushed cache entry").events,
                    before,
                    budget,
                );
            }
        }
        let events = compact(load()?)?;
        let result = page(&events, before, budget)?;
        if let Some(stamp) = stamp {
            self.entries.push_back(Cached {
                session,
                stamp,
                events,
            });
            while self.entries.len() > 4 {
                self.entries.pop_front();
            }
        }
        Ok(result)
    }
}

fn raw_array(values: Vec<Raw>) -> Result<Raw> {
    let mut out = String::from("[");
    for (at, value) in values.into_iter().enumerate() {
        if at > 0 {
            out.push(',');
        }
        out.push_str(value.get());
    }
    out.push(']');
    raw(out)
}

pub fn get(records: Vec<JournalRecord>) -> Result<Raw> {
    let mut events = Vec::new();
    let mut bytes = 0;
    let mut truncated = false;
    for record in records {
        let mut event = Event::from_record(record)?;
        let clipped = clip(&event.data()?, GET_STRING_CHARS)?.0;
        event.fields.set("data", clipped);
        let event = event.fields.into_raw()?;
        let size = event.get().len();
        if bytes + size > HISTORY_PAGE_BYTES && !events.is_empty() {
            truncated = true;
            break;
        }
        bytes += size;
        events.push(event);
    }
    let mut fields = Fields::default();
    fields.set("events", raw_array(events)?);
    if truncated {
        fields.set("truncated", raw("true".into())?);
    }
    fields.into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: u64, kind: &str, data: &str, extra: &str) -> JournalRecord {
        JournalRecord {
            id,
            json: raw(format!(
                r#"{{"id":{id},"sessionId":"x","kind":"{kind}","data":{data}{extra}}}"#
            ))
            .unwrap(),
        }
    }
    fn parsed(result: impl AsRef<RawValue>) -> serde_json::Value {
        serde_json::from_str(result.as_ref().get()).unwrap()
    }
    #[test]
    fn delta_runs_use_known_scopes_item_ids_and_all_barriers() {
        let records = vec![
            record(1, "agent.spawned", r#"{"toolUseId":"a"}"#, ""),
            record(2, "message.delta", r#"{"text":"A","itemId":"i"}"#, ""),
            record(
                3,
                "message.delta",
                r#"{"text":"B","itemId":"j"}"#,
                r#", "parentId":"a""#,
            ),
            record(4, "message.delta", r#"{"text":"C"}"#, ""),
            record(
                5,
                "message.delta",
                r#"{"text":"D","itemId":"j"}"#,
                r#", "parentId":"a""#,
            ),
            record(6, "status.changed", r#"{"status":"working"}"#, ""),
            record(7, "message.delta", r#"{"text":"E"}"#, ""),
            record(8, "message.delta", r#"{"text":"F","itemId":"other"}"#, ""),
        ];
        let result = parsed(history(records, None, HISTORY_PAGE_BYTES).unwrap());
        let events = result["events"].as_array().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|e| e["id"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 6, 7]
        );
        assert_eq!(events[1]["data"]["text"], "AC");
        assert_eq!(events[2]["data"]["text"], "BD");
        assert_eq!(events[4]["data"]["text"], "EF");
    }
    #[test]
    fn done_collapses_to_one_utf16_unit_and_matches_js_trim() {
        let result = history(
            vec![
                record(1, "message.delta", r#"{"text":"🌊more"}"#, ""),
                record(2, "message.done", r#"{"text":"done"}"#, ""),
            ],
            None,
            HISTORY_PAGE_BYTES,
        )
        .unwrap();
        assert!(result.get().contains(r#""text":"\ud83c""#));
        let result = parsed(
            history(
                vec![
                    record(1, "message.delta", r#"{"text":"abc"}"#, ""),
                    record(2, "message.done", r#"{"text":"\u0085"}"#, ""),
                ],
                None,
                HISTORY_PAGE_BYTES,
            )
            .unwrap(),
        );
        assert_eq!(result["events"][0]["data"]["text"], "a");
        let result = parsed(
            history(
                vec![
                    record(1, "message.delta", r#"{"text":"abc"}"#, ""),
                    record(2, "message.done", r#"{"text":"\ufeff "}"#, ""),
                ],
                None,
                HISTORY_PAGE_BYTES,
            )
            .unwrap(),
        );
        assert_eq!(result["events"][0]["data"]["text"], "abc");
    }
    #[test]
    fn clips_only_tool_input_and_elides_tool_output() {
        let input = format!(
            r#"{{"input":{{"text":"{}🌊"}},"path":"kept","inputElided":false}}"#,
            "x".repeat(299)
        );
        let result = history(
            vec![
                record(1, "tool.called", &input, r#", "future":"\ud800""#),
                record(2, "tool.finished", r#"{"content":null,"status":"ok"}"#, ""),
            ],
            None,
            HISTORY_PAGE_BYTES,
        )
        .unwrap();
        assert!(result.get().contains(r#"\ud83c…"#));
        assert!(result.get().contains(r#""future":"\ud800""#));
        assert!(result.get().contains(r#""inputElided":true"#));
        assert!(result.get().contains(r#""elided":true"#));
        assert!(!result.get().contains("content"));
    }
    #[test]
    fn pages_at_turn_boundary_and_preserves_one_large_event() {
        let records = vec![
            record(1, "message.user", r#"{"text":"old"}"#, ""),
            record(2, "message.done", r#"{"text":"reply"}"#, ""),
            record(3, "message.user", r#"{"text":"new"}"#, ""),
            record(4, "message.done", r#"{"text":"reply"}"#, ""),
        ];
        let result = parsed(history(records, None, 170).unwrap());
        assert_eq!(result["oldest"], 3);
        assert_eq!(result["more"], true);
        let result = parsed(
            history(
                vec![record(
                    5,
                    "message.user",
                    &format!(r#"{{"text":"{}"}}"#, "x".repeat(3000)),
                    "",
                )],
                None,
                1024,
            )
            .unwrap(),
        );
        assert_eq!(result["events"].as_array().unwrap().len(), 1);
        assert_eq!(result["more"], false);
        assert_eq!(
            parsed(history(vec![record(5, "message.user", "{}", "")], Some(-1.0), 1024).unwrap())["oldest"],
            serde_json::Value::Null
        );
    }
    #[test]
    fn get_has_separate_string_and_total_page_budgets() {
        let data = format!(r#"{{"text":"{}"}}"#, "x".repeat(200_000));
        let records = (1..=7)
            .map(|id| record(id, "message.done", &data, ""))
            .collect();
        let result = parsed(get(records).unwrap());
        assert_eq!(result["events"].as_array().unwrap().len(), 5);
        assert_eq!(result["truncated"], true);
        assert_eq!(
            result["events"][0]["data"]["text"].as_str().unwrap().len(),
            100_003
        );
    }
    #[test]
    fn clip_handles_arrays_keys_and_proto_without_recursive_stack() {
        let value = raw(r#"{"__proto__":{"polluted":true},"long-key":["🌊🌊x","\ud800abc"],"nested":{"text":"abcd"}}"#.into()).unwrap();
        let (result, cut) = clip(&value, 3).unwrap();
        assert!(cut);
        assert_eq!(
            result.get(),
            r#"{"long-key":["🌊\ud83c…","\ud800ab…"],"nested":{"text":"abc…"}}"#
        );
        let deep = raw(format!("{}\"abcd\"{}", "[".repeat(300), "]".repeat(300))).unwrap();
        assert!(clip(&deep, 1).unwrap().0.get().contains("a…"));
    }
    #[test]
    fn cache_refreshes_by_stamp_and_retains_four_recent_sessions() {
        use std::cell::Cell;
        let mut cache = HistoryCache::default();
        let loads = Cell::new(0);
        let read = |cache: &mut HistoryCache, session: &str, stamp: Option<HistoryStamp>| {
            cache
                .get(
                    key(session),
                    stamp,
                    || {
                        loads.set(loads.get() + 1);
                        Ok(vec![record(1, "message.user", "{}", "")])
                    },
                    None,
                    1024,
                )
                .unwrap()
        };
        let a = Some((1, 10, 0, 0));
        read(&mut cache, "a", a);
        read(&mut cache, "a", a);
        assert_eq!(loads.get(), 1);
        read(&mut cache, "a", Some((2, 10, 0, 0)));
        assert_eq!(loads.get(), 2);
        for name in ["b", "c", "d", "e"] {
            read(&mut cache, name, a);
        }
        read(&mut cache, "a", a);
        assert_eq!(loads.get(), 7);
        read(&mut cache, "missing", None);
        read(&mut cache, "missing", None);
        assert_eq!(loads.get(), 9);
    }
    #[test]
    fn decimal_ties_match_ecmascript_instead_of_rust_display() {
        assert_eq!(
            js_number("1976642435050427.2").unwrap(),
            "1976642435050427.2"
        );
        assert_eq!(
            js_number("167772206605557.12").unwrap(),
            "167772206605557.12"
        );
    }

    #[test]
    fn canonicalizes_numbers_duplicates_and_string_escapes_for_byte_budgets() {
        for (number, expected) in [
            ("-0", "0"),
            ("1e0", "1"),
            ("1.2300", "1.23"),
            ("0.000001", "0.000001"),
            ("0.0000001", "1e-7"),
            ("1000000000000000000000", "1e+21"),
            ("9007199254740993", "9007199254740992"),
            ("1e400", "null"),
        ] {
            assert_eq!(js_number(number).unwrap(), expected);
        }
        let normalized = normalize(
            &raw(
                r#"{ "a": { "x": 1e0, "x": 2 }, "n": -0, "s": "\u0061\/", "__proto__": 1 }"#.into(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            normalized.get(),
            r#"{"a":{"x":2},"n":0,"s":"a/","__proto__":1}"#
        );
    }
    #[test]
    fn field_lookup_keeps_last_duplicate_and_ignores_surrogate_keys() {
        let event = raw(r#"{"kind": "first", "\ud800": true, "data": {}, "kind": "last", "data": {"reason":"old","reason":"rm"}}"#.into()).unwrap();
        assert_eq!(field(&event, "kind").unwrap().unwrap().get(), "\"last\"");
        let data = field(&event, "data").unwrap().unwrap();
        assert_eq!(field(&data, "reason").unwrap().unwrap().get(), "\"rm\"");
        assert!(field(&event, "absent").unwrap().is_none());
    }
}
