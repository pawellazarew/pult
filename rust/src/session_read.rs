//! The read side of a session manager. Callers supply journal records after the
//! requested cursor; this module preserves Node's JSON pages and text coercion.
use crate::history::{Fields, encode_string, normalize};
use crate::journal::{JournalRecord, decode_js_string};
use anyhow::{Result, bail, ensure};
use serde_json::value::{RawValue, to_raw_value};

type Raw = Box<RawValue>;
const READ_BYTES: usize = crate::MAX_LINE - 4096;
const TRUNCATION_NOTICE: &str =
    "\n… [ответ обрезан: длиннее строки NDJSON; целиком — --format json порциями по --since]";

fn raw(text: String) -> Result<Raw> {
    Ok(RawValue::from_string(text)?)
}

fn string_end(bytes: &[u8], start: usize) -> usize {
    let mut at = start + 1;
    while bytes[at] != b'"' {
        at += if bytes[at] == b'\\' { 2 } else { 1 };
    }
    at + 1
}

fn object_end(bytes: &[u8], start: usize) -> usize {
    let mut depth = 0;
    let mut at = start;
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

/// JSON arrays stringify by joining their elements. Ignoring array brackets and
/// retaining every array comma gives the same recursive join without consuming
/// the Rust stack or repeatedly copying nested arrays. Plain objects ignore
/// their children and use Object.prototype.toString.
fn javascript_string(value: &RawValue) -> Result<Vec<u16>> {
    let text = value.get();
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    let mut arrays = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'[' => {
                arrays += 1;
                at += 1;
            }
            b']' => {
                arrays -= 1;
                at += 1;
            }
            b',' => {
                out.push(u16::from(b','));
                at += 1;
            }
            b'"' => {
                let end = string_end(bytes, at);
                out.extend(decode_js_string(&raw(text[at..end].to_owned())?)?);
                at = end;
            }
            b'{' => {
                let end = object_end(bytes, at);
                let object = raw(text[at..end].to_owned())?;
                // A JSON own property cannot contain a callable toString.
                // It shadows the inherited method and makes JS String throw.
                ensure!(
                    Fields::parse(&object)?.get("toString").is_none(),
                    "message text object cannot be converted to a string"
                );
                out.extend("[object Object]".encode_utf16());
                at = end;
            }
            byte if byte.is_ascii_whitespace() => at += 1,
            _ => {
                let start = at;
                while at < bytes.len() && !b",] \n\r\t".contains(&bytes[at]) {
                    at += 1;
                }
                let primitive = &text[start..at];
                if primitive == "null" {
                    if arrays == 0 {
                        out.extend("null".encode_utf16());
                    }
                } else if primitive == "true" || primitive == "false" {
                    out.extend(primitive.encode_utf16());
                } else {
                    let number: f64 = primitive.parse()?;
                    out.extend(ryu_js::Buffer::new().format(number).encode_utf16());
                }
            }
        }
    }
    Ok(out)
}

fn message_text(event: &RawValue) -> Result<Option<Vec<u16>>> {
    let fields = Fields::parse(event)?;
    let kind = fields
        .get("kind")
        .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok());
    if kind.as_deref() != Some("message.done") {
        return Ok(None);
    }
    let Some(data) = fields.get("data") else {
        bail!("message.done is missing data");
    };
    ensure!(data.get() != "null", "message.done data is null");
    // JS boxes other primitive values and arrays; their .text is undefined.
    if !data.get().starts_with('{') {
        return Ok(None);
    }
    let data = Fields::parse(data)?;
    let Some(text) = data.get("text").filter(|raw| raw.get() != "null") else {
        return Ok(None);
    };
    let text = javascript_string(text)?;
    Ok((!text.is_empty()).then_some(text))
}

pub fn render(
    records: Vec<JournalRecord>,
    since: f64,
    json: bool,
    worktree: Option<Raw>,
) -> Result<Raw> {
    ensure!(since.is_finite(), "read cursor must be finite");
    let mut result = Fields::default();
    let empty_cursor = || raw(ryu_js::Buffer::new().format_finite(since).to_owned());
    if json {
        let count = records.len();
        let mut events = Vec::new();
        let mut used = 0;
        let mut cursor = None;
        for record in records {
            let event = normalize(&record.json)?;
            let size = event.get().len() + 1;
            if !events.is_empty() && used + size > READ_BYTES {
                break;
            }
            used += size;
            cursor = Some(record.id);
            events.push(event);
        }
        result.set(
            "cursor",
            match cursor {
                Some(id) => to_raw_value(&id)?,
                None => empty_cursor()?,
            },
        );
        if events.len() < count {
            result.set("truncated", raw("true".into())?);
        }
        result.set("events", to_raw_value(&events)?);
    } else {
        let cursor = records.last().map(|record| record.id);
        let mut text = Vec::new();
        for record in records {
            if let Some(message) = message_text(&record.json)? {
                if !text.is_empty() {
                    text.push(u16::from(b'\n'));
                }
                text.extend(message);
            }
        }
        let mut truncated = false;
        while !text.is_empty() && encode_string(&text).len() > READ_BYTES {
            let end = ((text.len() as f64) * 0.9).floor() as usize;
            text.truncate(end);
            truncated = true;
        }
        if truncated {
            text.extend(TRUNCATION_NOTICE.encode_utf16());
        }
        result.set(
            "cursor",
            match cursor {
                Some(id) => to_raw_value(&id)?,
                None => empty_cursor()?,
            },
        );
        result.set("text", raw(encode_string(&text))?);
    }
    if let Some(worktree) = worktree {
        result.set("worktree", worktree);
    }
    result.into_raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(id: u64, kind: &str, data: serde_json::Value) -> JournalRecord {
        JournalRecord {
            id,
            json: to_raw_value(&json!({
                "id":id,"sessionId":"chat","kind":kind,"data":data
            }))
            .unwrap(),
        }
    }
    fn decoded(value: &RawValue) -> serde_json::Value {
        serde_json::from_str(value.get()).unwrap()
    }

    #[test]
    fn empty_cursors_and_worktree_keep_node_shapes() {
        for since in [-1.5, 0.0, 10.25] {
            let worktree =
                raw(r#"{"path":"/scratch","repo":"/repo","branch":"task"}"#.into()).unwrap();
            let cursor: serde_json::Value =
                serde_json::from_str(ryu_js::Buffer::new().format(since)).unwrap();
            assert_eq!(
                decoded(&render(Vec::new(), since, true, Some(worktree)).unwrap()),
                json!({"cursor":cursor,"events":[],"worktree":{"path":"/scratch","repo":"/repo","branch":"task"}})
            );
            assert_eq!(
                decoded(&render(Vec::new(), since, false, None).unwrap()),
                json!({"cursor":cursor,"text":""})
            );
        }
    }

    #[test]
    fn json_pages_preserve_one_large_event_and_report_the_last_returned_id() {
        let large = "x".repeat(READ_BYTES);
        let events = vec![
            record(3, "tool.finished", json!({"content":large})),
            record(7, "message.done", json!({"text":"later"})),
        ];
        let result = decoded(&render(events, 1.5, true, None).unwrap());
        assert_eq!(result["cursor"], 3);
        assert_eq!(result["events"].as_array().unwrap().len(), 1);
        assert_eq!(result["truncated"], true);
        assert_eq!(
            result["events"][0]["data"]["content"]
                .as_str()
                .unwrap()
                .len(),
            READ_BYTES
        );
    }

    #[test]
    fn json_budget_uses_canonical_json_bytes_including_escapes_and_newlines() {
        let almost = record(
            1,
            "message.done",
            json!({"text":"x".repeat(READ_BYTES-180)}),
        );
        let other = record(2, "message.done", json!({"text":"\n\"\\".repeat(40)}));
        let size = normalize(&almost.json).unwrap().get().len() + 1;
        assert!(size < READ_BYTES);
        assert!(size + normalize(&other.json).unwrap().get().len() + 1 > READ_BYTES);
        let result = decoded(&render(vec![almost, other], -0.5, true, None).unwrap());
        assert_eq!(result["cursor"], 1);
        assert_eq!(result["truncated"], true);
        let lexical=JournalRecord{id:4,json:raw(r#"{ "id":4, "sessionId":"chat", "kind":"future", "data":{"a":1e0,"a":2.0,"minus":-0} }"#.into()).unwrap()};
        let result = render(vec![lexical], 0.0, true, None).unwrap();
        assert!(result.get().contains(r#""a":2,"minus":0"#));
    }

    #[test]
    fn text_reads_coerce_legacy_values_and_keep_cursor_after_non_message_events() {
        let events = vec![
            record(1, "message.delta", json!({"text":"ignored"})),
            record(
                2,
                "message.done",
                json!({"text":[1,[true,null,"🌊"],{},[]]}),
            ),
            record(3, "message.done", json!({"text":false})),
            record(4, "message.done", json!({"text":null})),
            record(5, "message.done", json!({"text":""})),
            record(9, "tool.finished", json!({"content":"ignored"})),
        ];
        assert_eq!(
            decoded(&render(events, 0.0, false, None).unwrap()),
            json!({"cursor":9,"text":"1,true,,🌊,[object Object],\nfalse"})
        );
        let legacy = JournalRecord {
            id: 10,
            json: raw(r#"{"id":10,"kind":"message.done","data":{"text":"a\ud800b"}}"#.into())
                .unwrap(),
        };
        let result = render(vec![legacy], 0.0, false, None).unwrap();
        let text = Fields::parse(&result)
            .unwrap()
            .get("text")
            .unwrap()
            .to_owned();
        assert_eq!(decode_js_string(&text).unwrap(), vec![97, 0xd800, 98]);
    }

    #[test]
    fn text_clipping_uses_utf16_slices_and_node_suffix_without_rewinding_cursor() {
        let text = "🌊\n".repeat(READ_BYTES);
        let mut expected = text.encode_utf16().collect::<Vec<_>>();
        while encode_string(&expected).len() > READ_BYTES {
            expected.truncate(((expected.len() as f64) * 0.9).floor() as usize);
        }
        expected.extend(TRUNCATION_NOTICE.encode_utf16());
        let events = vec![
            record(1, "message.done", json!({"text":text})),
            record(8, "status.changed", json!({"status":"idle"})),
        ];
        let result = render(events, 0.0, false, None).unwrap();
        let fields = Fields::parse(&result).unwrap();
        assert_eq!(fields.get("cursor").unwrap().get(), "8");
        assert_eq!(
            decode_js_string(fields.get("text").unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn deep_legacy_arrays_do_not_recurse_and_bad_data_returns_an_error() {
        let nested = format!("{}\"end\"{}", "[".repeat(2048), "]".repeat(2048));
        assert_eq!(
            javascript_string(&raw(nested).unwrap()).unwrap(),
            "end".encode_utf16().collect::<Vec<_>>()
        );
        for data in ["null", r#"{"text":{"toString":null}}"#] {
            let event = JournalRecord {
                id: 1,
                json: raw(format!(r#"{{"id":1,"kind":"message.done","data":{data}}}"#)).unwrap(),
            };
            assert!(render(vec![event], 0.0, false, None).is_err());
        }
    }
}
