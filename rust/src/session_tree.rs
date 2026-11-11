//! Journal-backed agent/tool trees. Indices and explicit stacks keep malformed
//! cycles and deep histories away from the process call stack.
use crate::history::{Fields, encode_string, normalize};
use crate::journal::{JournalRecord, decode_js_string};
use anyhow::{Context, Result, ensure};
use serde_json::value::RawValue;
use std::collections::HashMap;

#[derive(Clone, Hash, PartialEq, Eq)]
enum ParentKey {
    Text(Vec<u16>),
    Primitive(String),
    Object(usize),
}
struct Node {
    fields: Fields,
    children: Vec<usize>,
    agent: bool,
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.to_owned()).expect("fixed JSON")
}
fn units(value: &RawValue) -> Option<Vec<u16>> {
    decode_js_string(value).ok()
}
fn string(fields: &Fields, name: &str) -> Option<Vec<u16>> {
    fields.get(name).and_then(units).filter(|s| !s.is_empty())
}
fn scalar(value: &RawValue) -> Option<String> {
    units(value).and_then(|s| String::from_utf16(&s).ok())
}
fn elapsed(start: Option<&RawValue>, end: Option<&RawValue>) -> Option<i64> {
    let start = crate::session_model::date_millis(&scalar(start?)?)?;
    let end = crate::session_model::date_millis(&scalar(end?)?)?;
    end.checked_sub(start).filter(|v| *v >= 0)
}
fn parent_key(value: &RawValue, sequence: usize) -> Result<ParentKey> {
    if let Some(value) = units(value) {
        return Ok(ParentKey::Text(value));
    }
    Ok(match value.get().as_bytes()[0] {
        b'{' | b'[' => ParentKey::Object(sequence),
        b'n' | b't' | b'f' => ParentKey::Primitive(value.get().to_owned()),
        _ => {
            let number: f64 = value.get().parse()?;
            ParentKey::Primitive(format!("number:{}", ryu_js::Buffer::new().format(number)))
        }
    })
}

pub fn render(records: Vec<JournalRecord>, english: bool) -> Result<Box<RawValue>> {
    let mut nodes: Vec<Node> = Vec::new();
    let mut by_id: HashMap<Vec<u16>, usize> = HashMap::new();
    let mut roots = Vec::new();
    let mut pending: HashMap<ParentKey, Vec<usize>> = HashMap::new();
    let mut pending_order = Vec::new();
    for record in records {
        let event = Fields::parse(&record.json)?;
        let kind = event.get("kind").and_then(scalar).unwrap_or_default();
        let open = kind == "agent.spawned" || kind == "tool.called";
        if !open && kind != "agent.finished" && kind != "tool.finished" {
            continue;
        }
        let data = event.get("data").context("tree event has no data")?;
        ensure!(data.get() != "null", "tree event data is null");
        if !data.get().starts_with('{') {
            continue;
        }
        let data = Fields::parse(data)?;
        let Some(id) = string(&data, "toolUseId") else {
            continue;
        };
        if open {
            if by_id.contains_key(&id) {
                continue;
            }
            let index = nodes.len();
            let agent = kind == "agent.spawned";
            let mut fields = Fields::default();
            fields.set("id", RawValue::from_string(encode_string(&id))?);
            fields.set("kind", raw(if agent { "\"agent\"" } else { "\"tool\"" }));
            let name = string(&data, "name").unwrap_or_else(|| {
                if agent { "Agent" } else { "tool" }
                    .encode_utf16()
                    .collect()
            });
            fields.set("name", RawValue::from_string(encode_string(&name))?);
            for key in ["subagentType", "model"] {
                if let Some(value) = string(&data, key) {
                    fields.set(key, RawValue::from_string(encode_string(&value))?);
                }
            }
            fields.set("status", raw("\"running\""));
            if let Some(ts) = event.get("ts") {
                fields.set("startedAt", ts.to_owned());
            }
            nodes.push(Node {
                fields,
                children: Vec::new(),
                agent,
            });
            by_id.insert(id.clone(), index);
            if let Some(parent) = event.get("parentId") {
                let key = parent_key(parent, index)?;
                if let ParentKey::Text(parent) = &key
                    && let Some(parent) = by_id.get(parent)
                {
                    nodes[*parent].children.push(index);
                } else {
                    if !pending.contains_key(&key) {
                        pending_order.push(key.clone());
                    }
                    pending.entry(key).or_default().push(index);
                }
            } else {
                roots.push(index);
            }
            if let Some(children) = pending.remove(&ParentKey::Text(id)) {
                nodes[index].children.extend(children);
            }
        } else if let Some(&index) = by_id.get(&id) {
            let status = if data.get("isError").is_some_and(|x| x.get() == "true") {
                "\"failed\""
            } else {
                "\"done\""
            };
            nodes[index].fields.set("status", raw(status));
            if let Some(ms) = elapsed(nodes[index].fields.get("startedAt"), event.get("ts")) {
                nodes[index]
                    .fields
                    .set("durationMs", serde_json::value::to_raw_value(&ms)?);
            }
            if let Some(ts) = event.get("ts") {
                nodes[index].fields.set("endedAt", ts.to_owned());
            } else {
                nodes[index].fields.remove("endedAt");
            }
        }
    }
    let mut orphans = 0;
    for key in pending_order {
        if let Some(children) = pending.remove(&key) {
            orphans += children.len();
            roots.extend(children);
        }
    }
    let roots_json = encode_forest(&nodes, &roots)?;
    let text = format_forest(&nodes, &roots, english)?;
    RawValue::from_string(format!(
        "{{\"roots\":{roots_json},\"orphans\":{orphans},\"text\":{}}}",
        encode_string(&text)
    ))
    .map_err(Into::into)
}

fn encode_forest(nodes: &[Node], roots: &[usize]) -> Result<String> {
    enum Task {
        Node(usize),
        Literal(&'static str),
    }
    let mut output = String::from("[");
    let mut stack = vec![Task::Literal("]")];
    for (position, &index) in roots.iter().enumerate().rev() {
        stack.push(Task::Node(index));
        if position > 0 {
            stack.push(Task::Literal(","));
        }
    }
    let mut visits = 0;
    while let Some(task) = stack.pop() {
        match task {
            Task::Literal(text) => output.push_str(text),
            Task::Node(index) => {
                visits += 1;
                ensure!(visits <= nodes.len(), "tree contains a reachable cycle");
                let node = &nodes[index];
                let fields = normalize(&node.fields.clone().into_raw()?)?;
                output.push_str(&fields.get()[..fields.get().len() - 1]);
                output.push_str(",\"children\":[");
                stack.push(Task::Literal("]}"));
                for (position, &child) in node.children.iter().enumerate().rev() {
                    stack.push(Task::Node(child));
                    if position > 0 {
                        stack.push(Task::Literal(","));
                    }
                }
            }
        }
        ensure!(
            output.len() < crate::MAX_LINE - 256,
            "tree exceeds frame budget"
        );
    }
    Ok(output)
}

fn format_forest(nodes: &[Node], roots: &[usize], english: bool) -> Result<Vec<u16>> {
    let mut output = Vec::new();
    let mut stack: Vec<_> = roots.iter().rev().map(|&index| (index, 0)).collect();
    let mut visits = 0;
    while let Some((index, depth)) = stack.pop() {
        visits += 1;
        ensure!(visits <= nodes.len(), "tree contains a reachable cycle");
        let node = &nodes[index];
        if !output.is_empty() {
            output.push(u16::from(b'\n'));
        }
        output.extend(std::iter::repeat_n(u16::from(b' '), depth * 2));
        output.extend(
            match node.fields.get("status").and_then(scalar).as_deref() {
                Some("done") => "✓ ",
                Some("failed") => "✗ ",
                _ => "… ",
            }
            .encode_utf16(),
        );
        if node.agent {
            output.extend("Agent(".encode_utf16());
            output.extend(
                string(&node.fields, "subagentType").unwrap_or_else(|| vec![u16::from(b'?')]),
            );
            output.push(u16::from(b')'));
        } else {
            output.extend(string(&node.fields, "name").expect("tree node name"));
        }
        if let Some(model) = string(&node.fields, "model") {
            output.extend(" · ".encode_utf16());
            output.extend(model);
        }
        if let Some(duration) = node.fields.get("durationMs") {
            let milliseconds: f64 = duration.get().parse()?;
            let mut buffer = ryu_js::Buffer::new();
            output.extend(
                format!(
                    " · {} {}",
                    buffer.format(milliseconds),
                    if english { "ms" } else { "мс" }
                )
                .encode_utf16(),
            );
        }
        ensure!(
            output.len() < crate::MAX_LINE - 256,
            "tree text exceeds frame budget"
        );
        for &child in node.children.iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    Ok(output)
}
