//! Pure session registry normalization and restart recovery. Raw field values keep
//! JavaScript UTF-16 code units, including legacy lone surrogates.
use crate::history::{Fields, array_values, encode_string};
use crate::journal::{JournalRecord, decode_js_string};
use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use regex::Regex;
use serde::Serialize;
use serde_json::value::{RawValue, to_raw_value};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

type Raw = Box<RawValue>;
const EPOCH: &str = "1970-01-01T00:00:00.000Z";
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const APPROVALS: &[&str] = &["read-only", "ask", "workspace", "full", "inherit"];
const STATUSES: &[&str] = &[
    "cold",
    "idle",
    "working",
    "blocked_permission",
    "blocked_question",
    "limited",
    "interrupted",
    "failed",
    "done",
];

#[derive(Clone, Default, Serialize)]
#[serde(transparent)]
pub struct Record(pub BTreeMap<String, Raw>);
impl std::fmt::Debug for Record {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Record")
            .field("fields", &self.0.len())
            .finish_non_exhaustive()
    }
}
impl Record {
    pub fn name(&self) -> &str {
        // Stored records have canonical ASCII names. A raw public Record may
        // be malformed; never panic or present an escaped name as canonical.
        self.get("name")
            .and_then(|raw| raw.get().strip_prefix('"')?.strip_suffix('"'))
            .filter(|name| is_name(name))
            .unwrap_or("")
    }
    pub fn get(&self, key: &str) -> Option<&RawValue> {
        self.0.get(key).map(|raw| &**raw)
    }
    pub fn string(&self, key: &str) -> Option<Vec<u16>> {
        self.get(key).and_then(units)
    }
    pub fn scalar(&self, key: &str) -> Option<String> {
        self.string(key).and_then(|s| String::from_utf16(&s).ok())
    }
    pub fn set_raw(&mut self, key: &str, value: Raw) {
        self.0.insert(key.to_owned(), value);
    }
    pub fn set_string(&mut self, key: &str, value: &str) {
        self.set_raw(key, string_raw(value));
    }
    pub fn set_units(&mut self, key: &str, value: &[u16]) {
        self.set_raw(
            key,
            RawValue::from_string(encode_string(value)).expect("encoded UTF-16 JSON"),
        );
    }
    pub fn set_bool(&mut self, key: &str, value: bool) {
        self.set_raw(key, to_raw_value(&value).expect("boolean JSON"));
    }
    pub fn set_number(&mut self, key: &str, value: f64) {
        self.set_raw(key, number_raw(value));
    }
    pub fn remove(&mut self, key: &str) {
        self.0.remove(key);
    }
    pub fn raw(&self) -> Result<Raw> {
        Ok(to_raw_value(self)?)
    }
}
fn string_raw(value: &str) -> Raw {
    to_raw_value(value).expect("string JSON")
}
fn number_raw(value: f64) -> Raw {
    RawValue::from_string(if value.is_finite() {
        ryu_js::Buffer::new().format_finite(value).to_owned()
    } else {
        "null".into()
    })
    .expect("number JSON")
}
fn units(raw: &RawValue) -> Option<Vec<u16>> {
    raw.get()
        .starts_with('"')
        .then(|| decode_js_string(raw).ok())
        .flatten()
}
fn scalar(raw: &RawValue) -> Option<String> {
    units(raw).and_then(|u| String::from_utf16(&u).ok())
}
fn object(raw: &RawValue) -> Result<Option<Fields>> {
    if raw.get().starts_with('{') {
        Ok(Some(Fields::parse(raw)?))
    } else {
        Ok(None)
    }
}
fn eq(raw: Option<&RawValue>, value: &str) -> bool {
    raw.and_then(scalar).as_deref() == Some(value)
}
fn num(raw: &RawValue) -> Option<f64> {
    serde_json::from_str::<f64>(raw.get())
        .ok()
        .filter(|v| v.is_finite())
}
fn safe(raw: &RawValue) -> Option<f64> {
    num(raw).filter(|v| v.fract() == 0.0 && v.abs() <= MAX_SAFE)
}
fn yes(raw: Option<&RawValue>) -> bool {
    raw.is_some_and(|v| v.get() == "true")
}
fn js_space(unit: u16) -> bool {
    matches!(unit, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn nonblank(units: &[u16]) -> bool {
    units.iter().any(|u| !js_space(*u))
}
fn string_field(out: &mut Record, fields: &Fields, key: &str) {
    if let Some(raw) = fields.get(key).filter(|v| v.get().starts_with('"')) {
        out.set_raw(key, raw.to_owned());
    }
}

pub fn is_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(b))
}

/// Control runs become spaces, invisible format/filler units disappear; Unicode
/// code points determine title length, while invalid UTF-16 units remain intact.
pub fn normalize_title(input: &[u16]) -> Option<Vec<u16>> {
    static VISIBLE: OnceLock<Regex> = OnceLock::new();
    let visible = VISIBLE
        .get_or_init(|| Regex::new(r"[\p{L}\p{N}\p{S}\p{P}]").expect("fixed Unicode pattern"));
    let mut out = Vec::new();
    let mut pending_space = false;
    for unit in input.iter().copied() {
        if matches!(unit, 0x00ad | 0x061c | 0x115f | 0x1160 | 0x200b | 0x200e | 0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x2069 | 0x2800 | 0x3164 | 0xfeff | 0xffa0)
        {
            continue;
        }
        if matches!(unit, 0..=0x1f | 0x7f..=0x9f | 0x2028 | 0x2029) || js_space(unit) {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(0x20);
            pending_space = false;
        }
        out.push(unit);
    }
    let has_visible = char::decode_utf16(out.iter().copied())
        .filter_map(std::result::Result::ok)
        .any(|ch| visible.is_match(ch.encode_utf8(&mut [0; 4])));
    has_visible.then_some(out)
}

pub fn title_length(units: &[u16]) -> usize {
    let mut at = 0;
    let mut count = 0;
    while at < units.len() {
        at += if (0xd800..=0xdbff).contains(&units[at])
            && units
                .get(at + 1)
                .is_some_and(|u| (0xdc00..=0xdfff).contains(u))
        {
            2
        } else {
            1
        };
        count += 1;
    }
    count
}
fn first_points(units: &[u16], limit: usize) -> Vec<u16> {
    let mut at = 0;
    for _ in 0..limit {
        if at == units.len() {
            break;
        }
        at += if (0xd800..=0xdbff).contains(&units[at])
            && units
                .get(at + 1)
                .is_some_and(|u| (0xdc00..=0xdfff).contains(u))
        {
            2
        } else {
            1
        };
    }
    units[..at].to_vec()
}

fn date_timestamp<T: TimeZone>(date: DateTime<T>) -> Option<i64> {
    // Chrono encodes leap seconds as a normal second plus >=1e9 nanoseconds.
    // They are outside the supported timestamp grammar, including RFC inputs.
    (date.nanosecond() < 1_000_000_000).then(|| date.timestamp_millis())
}

/// Standard ISO forms, RFC2822 and common legacy local date forms. This function
/// intentionally returns None for unsupported legacy Date.parse dialects; an
/// existing migration marker must never be treated as absent on that basis.
pub fn date_millis(text: &str) -> Option<i64> {
    let text = text.trim_matches(|c: char| c.len_utf16() == 1 && js_space(c as u16));
    if text.is_empty() {
        return None;
    }
    // Chrono accepts leap seconds, while ECMAScript Date.parse rejects them.
    // Validate the complete ISO clock before any calendar normalization.
    if let Some(at) = text.find(['T', 't'])
        && at == 10
        && text.as_bytes().get(4) == Some(&b'-')
    {
        static ISO_CLOCK: OnceLock<Regex> = OnceLock::new();
        let clock = ISO_CLOCK.get_or_init(|| Regex::new(r"^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(?:[Zz]|[+-][0-9]{2}:?[0-9]{2})?$").expect("fixed ISO clock pattern"));
        let parts = clock.captures(&text[at + 1..])?;
        let hour: u32 = parts.get(1)?.as_str().parse().ok()?;
        let minute: u32 = parts.get(2)?.as_str().parse().ok()?;
        let second = parts
            .get(3)
            .map_or(Some(0), |part| part.as_str().parse::<u32>().ok())?;
        if hour > 24 || minute > 59 || second > 59 {
            return None;
        }
        if hour == 24
            && (minute != 0
                || second != 0
                || parts
                    .get(4)
                    .is_some_and(|p| p.as_str().bytes().any(|b| b != b'0')))
        {
            return None;
        }
    }
    if let Ok(date) = DateTime::parse_from_rfc3339(text) {
        return date_timestamp(date);
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(text) {
        return date_timestamp(date);
    }
    // ISO date-only uses UTC, including valid day overflow such as Feb 30.
    let iso_date = |date: &str| -> Option<NaiveDate> {
        let parts: Vec<_> = date.split('-').collect();
        if parts.is_empty()
            || parts.len() > 3
            || parts[0].len() != 4
            || !parts[0].bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        let year: i32 = parts[0].parse().ok()?;
        let month: u32 = parts.get(1).map_or(Some(1), |m| m.parse().ok())?;
        let day: u32 = parts.get(2).map_or(Some(1), |d| d.parse().ok())?;
        if !(1..=31).contains(&day) {
            return None;
        }
        NaiveDate::from_ymd_opt(year, month, 1)?
            .checked_add_signed(chrono::Duration::days((day - 1) as i64))
    };
    if text.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        && (text.len() == 4 || text.len() == 7 || text.len() == 10)
    {
        return iso_date(text)?
            .and_hms_opt(0, 0, 0)
            .and_then(|d| date_timestamp(d.and_utc()));
    }
    // Normalize ISO calendar overflow before parsing a timezone-aware timestamp.
    if let Some((day, time)) = text.split_once('T')
        && let Some(date) = iso_date(day)
    {
        let day = date.format("%Y-%m-%d").to_string();
        let mut combined = format!("{day}T{time}");
        if let Some(rest) = time.strip_prefix("24:00") {
            let clock = time.split(['Z', '+', '-']).next()?;
            if !clock[5..].bytes().all(|b| matches!(b, b'0' | b':' | b'.')) {
                return None;
            }
            if rest.starts_with(":00")
                || rest.starts_with('Z')
                || rest.starts_with('+')
                || rest.starts_with('-')
                || rest.is_empty()
            {
                let next = date.checked_add_signed(chrono::Duration::days(1))?;
                combined = format!("{}T00:00{rest}", next.format("%Y-%m-%d"));
            }
        }
        if let Ok(date) = DateTime::parse_from_rfc3339(&combined) {
            return date_timestamp(date);
        }
        let zoned = if let Some(prefix) = combined.strip_suffix('Z') {
            format!("{prefix}+00:00")
        } else {
            combined.clone()
        };
        for fmt in ["%Y-%m-%dT%H:%M%:z", "%Y-%m-%dT%H:%M:%S%.f%:z"] {
            if let Ok(date) = DateTime::parse_from_str(&zoned, fmt) {
                return date_timestamp(date);
            }
        }
        for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
            if let Ok(date) = NaiveDateTime::parse_from_str(&combined, fmt) {
                return Local
                    .from_local_datetime(&date)
                    .earliest()
                    .and_then(date_timestamp);
            }
        }
    }
    // Chrono's %Y accepts a short year literally, while V8 maps it into
    // 19xx/20xx in legacy forms. Leave those ambiguous inputs unsupported so
    // they cannot move a record into an older access-migration cohort.
    for fmt in [
        "%a %b %d %Y %H:%M:%S GMT%z",
        "%a, %d %b %Y %H:%M:%S GMT",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M:%S",
        "%m/%d/%Y %H:%M:%S",
    ] {
        if let Ok(date) = DateTime::parse_from_str(text, fmt)
            && date.year() >= 100
        {
            return date_timestamp(date);
        }
        if let Ok(date) = NaiveDateTime::parse_from_str(text, fmt)
            && date.year() >= 100
        {
            return Local
                .from_local_datetime(&date)
                .earliest()
                .and_then(date_timestamp);
        }
    }
    for fmt in [
        "%m/%d/%Y",
        "%Y/%m/%d",
        "%b %d %Y",
        "%B %d %Y",
        "%b %d, %Y",
        "%B %d, %Y",
    ] {
        if let Ok(date) = NaiveDate::parse_from_str(text, fmt)
            && date.year() >= 100
        {
            return Local
                .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
                .earliest()
                .and_then(date_timestamp);
        }
    }
    None
}

fn parse_browser(raw: &RawValue) -> Result<Option<Raw>> {
    if raw.get() == "true" {
        return Ok(Some(RawValue::from_string("{}".into())?));
    }
    let Some(fields) = object(raw)? else {
        return Ok(None);
    };
    Ok(Some(if yes(fields.get("headed")) {
        RawValue::from_string("{\"headed\":true}".into())?
    } else {
        RawValue::from_string("{}".into())?
    }))
}
fn parse_worktree(raw: &RawValue) -> Result<Option<Raw>> {
    let Some(fields) = object(raw)? else {
        return Ok(None);
    };
    let mut out = Record::default();
    for key in ["path", "branch", "repo"] {
        let Some(value) = fields
            .get(key)
            .filter(|v| units(v).is_some_and(|v| !v.is_empty()))
        else {
            return Ok(None);
        };
        out.set_raw(key, value.to_owned());
    }
    Ok(Some(out.raw()?))
}
fn parse_context(raw: &RawValue) -> Result<Option<Raw>> {
    let Some(fields) = object(raw)? else {
        return Ok(None);
    };
    let Some(used) = fields.get("used").and_then(num).filter(|v| *v >= 0.0) else {
        return Ok(None);
    };
    let Some(at) = fields
        .get("at")
        .filter(|v| units(v).is_some_and(|u| !u.is_empty()))
    else {
        return Ok(None);
    };
    let window = fields
        .get("window")
        .and_then(num)
        .filter(|v| *v >= 0.0)
        .map(f64::round)
        .filter(|v| *v > 0.0);
    let mut out = Record::default();
    out.set_number("used", used.round());
    out.set_raw(
        "window",
        window
            .map(number_raw)
            .unwrap_or(RawValue::from_string("null".into())?),
    );
    out.set_raw(
        "model",
        fields
            .get("model")
            .filter(|v| units(v).is_some_and(|u| !u.is_empty()))
            .map(RawValue::to_owned)
            .unwrap_or(RawValue::from_string("null".into())?),
    );
    out.set_raw("at", at.to_owned());
    Ok(Some(out.raw()?))
}
fn parse_applied(raw: &RawValue) -> Result<Option<Raw>> {
    let Some(fields) = object(raw)? else {
        return Ok(None);
    };
    let Some(approval) = fields
        .get("approval")
        .and_then(scalar)
        .filter(|s| APPROVALS.contains(&s.as_str()))
    else {
        return Ok(None);
    };
    let mut out = Record::default();
    out.set_string("approval", &approval);
    out.set_raw(
        "reported",
        fields
            .get("reported")
            .filter(|v| units(v).is_some())
            .map(RawValue::to_owned)
            .unwrap_or(RawValue::from_string("null".into())?),
    );
    for key in ["confirmed", "full"] {
        out.set_bool(key, yes(fields.get(key)));
    }
    out.set_raw(
        "at",
        fields
            .get("at")
            .filter(|v| units(v).is_some())
            .map(RawValue::to_owned)
            .unwrap_or(string_raw(EPOCH)),
    );
    Ok(Some(out.raw()?))
}
fn attachments(raw: Option<&RawValue>) -> Result<Option<Vec<Raw>>> {
    let Some(raw) = raw else {
        return Ok(Some(Vec::new()));
    };
    if !raw.get().starts_with('[') {
        return Ok(None);
    }
    let all = array_values(raw)?;
    if all.len() > 20 {
        return Ok(None);
    }
    let mut out = Vec::new();
    for raw in all {
        let Some(fields) = object(&raw)? else {
            return Ok(None);
        };
        let path = fields.get("path").and_then(units);
        let name = fields.get("name").and_then(units);
        let mime = fields.get("mime").and_then(units);
        let bytes = fields.get("bytes").and_then(safe);
        if !path
            .as_ref()
            .is_some_and(|s| s.first() == Some(&47) && s.len() <= 16384)
            || !name
                .as_ref()
                .is_some_and(|s| !s.is_empty() && s.len() <= 512)
            || !mime
                .as_ref()
                .is_some_and(|s| !s.is_empty() && s.len() <= 128)
            || !bytes.is_some_and(|n| (0.0..=26_214_400.0).contains(&n))
            || !(eq(fields.get("kind"), "file") || eq(fields.get("kind"), "directory"))
        {
            return Ok(None);
        }
        let mut item = Record::default();
        for key in ["path", "name", "mime", "kind"] {
            item.set_raw(
                key,
                fields
                    .get(key)
                    .context("validated attachment field")?
                    .to_owned(),
            );
        }
        item.set_number("bytes", bytes.unwrap());
        out.push(item.raw()?);
    }
    Ok(Some(out))
}
fn parse_queue(raw: &RawValue) -> Result<Vec<Raw>> {
    if !raw.get().starts_with('[') {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut ids = HashSet::new();
    for raw in array_values(raw)? {
        let Some(fields) = object(&raw)? else {
            continue;
        };
        let Some(id) = fields
            .get("id")
            .and_then(units)
            .filter(|id| !id.is_empty() && !ids.contains(id))
        else {
            continue;
        };
        let Some(attachments) = attachments(fields.get("attachments"))? else {
            continue;
        };
        let Some(text) = fields
            .get("text")
            .and_then(units)
            .filter(|text| nonblank(text) || !attachments.is_empty())
        else {
            continue;
        };
        ids.insert(id.clone());
        let mut item = Record::default();
        item.set_units("id", &id);
        item.set_units("text", &text);
        if !attachments.is_empty() {
            item.set_raw("attachments", to_raw_value(&attachments)?);
        }
        item.set_raw(
            "at",
            fields
                .get("at")
                .filter(|v| units(v).is_some())
                .map(RawValue::to_owned)
                .unwrap_or(string_raw(EPOCH)),
        );
        out.push(item.raw()?);
        if out.len() == 20 {
            break;
        }
    }
    Ok(out)
}

pub fn parse(raw: &RawValue) -> Result<Vec<Record>> {
    let Some(root) = object(raw)? else {
        return Ok(Vec::new());
    };
    let Some(list) = root.get("sessions").filter(|v| v.get().starts_with('[')) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for raw in array_values(list)? {
        let Some(fields) = object(&raw)? else {
            continue;
        };
        let Some(name) = fields
            .get("name")
            .and_then(scalar)
            .filter(|name| is_name(name))
        else {
            continue;
        };
        let Some(provider) = fields
            .get("provider")
            .and_then(scalar)
            .filter(|p| ["claude", "codex", "zcode"].contains(&p.as_str()))
        else {
            continue;
        };
        let Some(cwd) = fields.get("cwd").and_then(units).filter(|s| !s.is_empty()) else {
            continue;
        };
        let mut rec = Record::default();
        rec.set_string("name", &name);
        rec.set_string("provider", &provider);
        rec.set_units("cwd", &cwd);
        if let Some(title) = fields
            .get("title")
            .and_then(units)
            .and_then(|s| normalize_title(&s))
        {
            rec.set_units("title", &first_points(&title, 60));
        }
        if eq(fields.get("scope"), "general") {
            rec.set_string("scope", "general");
        }
        for key in ["model", "effort", "settingSources", "providerSessionId"] {
            string_field(&mut rec, &fields, key);
        }
        // Preserve opaque future policy semantics and UTF-16, without treating
        // malformed values as permission. Compact only outside-string whitespace
        // so pretty registry values cannot split a public NDJSON frame.
        for key in ["memory", "private", "temporary"] {
            if let Some(value) = fields.get(key) {
                rec.set_raw(key, crate::history::compact_raw(value)?);
            }
        }
        if provider == "codex"
            && let Some(tier) = fields
                .get("serviceTier")
                .and_then(scalar)
                .filter(|s| ["default", "fast"].contains(&s.as_str()))
        {
            rec.set_string("serviceTier", &tier);
        }
        rec.set_string(
            "mode",
            if eq(fields.get("mode"), "warm") {
                "warm"
            } else {
                "turn"
            },
        );
        for key in [
            "forkOnResume",
            "archived",
            "autoTitled",
            "markedUnread",
            "queuePaused",
        ] {
            if yes(fields.get(key)) {
                rec.set_bool(key, true);
            }
        }
        for (key, parser) in [
            (
                "worktree",
                parse_worktree as fn(&RawValue) -> Result<Option<Raw>>,
            ),
            ("context", parse_context),
            ("applied", parse_applied),
            ("browser", parse_browser),
            ("browserSuspended", parse_browser),
        ] {
            if let Some(raw) = fields.get(key)
                && let Some(value) = parser(raw)?
            {
                rec.set_raw(key, value);
            }
        }
        rec.set_raw(
            "createdAt",
            fields
                .get("createdAt")
                .filter(|v| units(v).is_some())
                .map(RawValue::to_owned)
                .unwrap_or(string_raw(EPOCH)),
        );
        if let Some(request) = fields.get("startRequest").and_then(scalar).filter(|s| {
            s.len() == 36
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        }) {
            rec.set_string("startRequest", &request);
        }
        if let Some(at) = fields
            .get("lastTurnAt")
            .and_then(scalar)
            .filter(|s| date_millis(s).is_some())
        {
            rec.set_string("lastTurnAt", &at);
        }
        rec.set_string(
            "lastStatus",
            fields
                .get("lastStatus")
                .and_then(scalar)
                .filter(|s| STATUSES.contains(&s.as_str()))
                .as_deref()
                .unwrap_or("cold"),
        );
        rec.set_number(
            "lastEventId",
            fields.get("lastEventId").and_then(safe).unwrap_or(0.0),
        );
        if let Some(n) = fields
            .get("lastSeenEventId")
            .and_then(safe)
            .filter(|n| *n >= 0.0)
        {
            rec.set_number("lastSeenEventId", n);
        }
        if let Some(queue) = fields.get("queue") {
            let queue = parse_queue(queue)?;
            if !queue.is_empty() {
                rec.set_raw("queue", to_raw_value(&queue)?);
            }
        }
        if let Some(marker) = fields.get("queueDispatch")
            && let Some(marker_fields) = object(marker)?
            && marker_fields
                .get("id")
                .and_then(units)
                .is_some_and(|v| !v.is_empty() && v.len() <= 1024)
            && marker_fields
                .get("at")
                .and_then(units)
                .is_some_and(|v| v.len() <= 1024)
        {
            let mut clean = Record::default();
            for field in ["id", "at"] {
                clean.set_raw(
                    field,
                    marker_fields
                        .get(field)
                        .expect("validated marker field")
                        .to_owned(),
                );
            }
            rec.set_raw("queueDispatch", clean.raw()?);
            rec.set_bool("queuePaused", true);
        }
        if let Some(approval) = fields.get("approval")
            && !eq(Some(approval), "ask")
        {
            rec.set_string(
                "approval",
                scalar(approval)
                    .filter(|s| APPROVALS.contains(&s.as_str()))
                    .as_deref()
                    .unwrap_or("read-only"),
            );
        }
        if eq(fields.get("grant"), "cli-once") {
            rec.set_string("grant", "cli-once");
        }
        if let Some(seen) = fields
            .get("inheritSeen")
            .filter(|v| units(v).is_some_and(|s| !s.is_empty()))
        {
            rec.set_raw("inheritSeen", seen.to_owned());
        }
        out.push(rec);
    }
    Ok(out)
}

pub fn version(raw: &RawValue) -> Result<Option<f64>> {
    Ok(object(raw)?.and_then(|o| o.get("version").and_then(|v| v.get().parse::<f64>().ok())))
}

pub fn migrate(
    raw_version: Option<f64>,
    records: &mut [Record],
    marker_at: Option<&str>,
) -> Result<usize> {
    if raw_version.is_some_and(|v| v >= 2.0) {
        return Ok(0);
    }
    let cut = marker_at
        .map(|at| date_millis(at).context("unsupported access migration marker date"))
        .transpose()?;
    let mut changed = 0;
    for rec in records {
        if rec.scalar("provider").as_deref() != Some("claude") || rec.get("approval").is_some() {
            continue;
        }
        if let Some(cut) = cut
            && !rec
                .scalar("createdAt")
                .and_then(|s| date_millis(&s))
                .is_some_and(|at| at < cut)
        {
            continue;
        }
        rec.set_string("approval", "inherit");
        changed += 1;
    }
    Ok(changed)
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStats {
    pub cooled: usize,
    pub seeded_seen: usize,
    pub seeded_last_turn: usize,
    pub removed_receipts: usize,
    pub paused_queues: usize,
}
impl RecoveryStats {
    pub fn changed(&self) -> bool {
        self.cooled
            + self.seeded_seen
            + self.seeded_last_turn
            + self.removed_receipts
            + self.paused_queues
            > 0
    }
}

pub type AcceptedReceipts = HashSet<(Vec<u16>, Vec<u16>)>;

#[cfg(test)]
pub fn recover(
    records: &mut [Record],
    last_id: u64,
    lookup: impl FnMut(&str) -> Result<Vec<JournalRecord>>,
) -> Result<RecoveryStats> {
    recover_with_receipts(records, last_id, lookup, |_| Ok(HashSet::new()))
}

/// No process is resumed here. Both the durable journal and the session
/// projection contribute receipts. The former protects acknowledged writes
/// whose best-effort projection was lost; the latter preserves imported data.
/// Every remaining queue pauses for a human, and no changes apply on error.
pub fn recover_with_receipts(
    records: &mut [Record],
    last_id: u64,
    lookup: impl FnMut(&str) -> Result<Vec<JournalRecord>>,
    lookup_accepted: impl FnMut(&str) -> Result<AcceptedReceipts>,
) -> Result<RecoveryStats> {
    let mut next = records.to_vec();
    let stats = recover_in_place(&mut next, last_id, lookup, lookup_accepted)?;
    records.clone_from_slice(&next);
    Ok(stats)
}
fn recover_in_place(
    records: &mut [Record],
    last_id: u64,
    mut lookup: impl FnMut(&str) -> Result<Vec<JournalRecord>>,
    mut lookup_accepted: impl FnMut(&str) -> Result<AcceptedReceipts>,
) -> Result<RecoveryStats> {
    let mut stats = RecoveryStats::default();
    for rec in records {
        if !matches!(
            rec.scalar("lastStatus").as_deref(),
            Some("cold" | "done" | "failed")
        ) {
            rec.set_string("lastStatus", "cold");
            stats.cooled += 1;
        }
        if !rec
            .get("lastSeenEventId")
            .and_then(safe)
            .is_some_and(|n| n <= last_id as f64)
        {
            rec.set_number("lastSeenEventId", last_id as f64);
            stats.seeded_seen += 1;
        }
        let has_queue = rec.get("queue").is_some();
        if !has_queue {
            rec.remove("queueDispatch");
        }
        let needs_turn = rec.get("lastTurnAt").is_none();
        let events = if needs_turn || has_queue {
            match lookup(rec.name()) {
                Ok(events) => events,
                Err(error) if has_queue => return Err(error),
                Err(_) => Vec::new(),
            }
        } else {
            Vec::new()
        };
        if needs_turn {
            let chosen = events
                .iter()
                .rev()
                .find(|event| {
                    crate::history::field(&event.json, "kind")
                        .ok()
                        .flatten()
                        .as_ref()
                        .is_some_and(|kind| eq(Some(kind), "message.user"))
                })
                .or_else(|| events.last());
            let at = chosen
                .map(|event| crate::history::field(&event.json, "ts"))
                .transpose()?
                .flatten();
            let at = at
                .filter(|v| scalar(v).is_some_and(|s| date_millis(&s).is_some()))
                .unwrap_or(
                    rec.get("createdAt")
                        .context("normalized createdAt")?
                        .to_owned(),
                );
            rec.set_raw("lastTurnAt", at);
            stats.seeded_last_turn += 1;
        }
        if let Some(raw_queue) = rec.get("queue") {
            let mut accepted = lookup_accepted(rec.name())?;
            for event in &events {
                if !crate::history::field(&event.json, "kind")?
                    .as_ref()
                    .is_some_and(|v| eq(Some(v), "message.user"))
                {
                    continue;
                }
                if let Some(data) = crate::history::field(&event.json, "data")?
                    && let Some(data) = object(&data)?
                    && let (Some(id), Some(at)) = (
                        data.get("queueItemId").and_then(units),
                        data.get("queueItemAt").and_then(units),
                    )
                {
                    accepted.insert((id, at));
                }
            }
            let mut remaining = Vec::new();
            for item in array_values(raw_queue)? {
                let fields = Fields::parse(&item)?;
                let id = fields
                    .get("id")
                    .and_then(units)
                    .context("normalized queue id")?;
                let at = fields
                    .get("at")
                    .and_then(units)
                    .context("normalized queue at")?;
                if accepted.contains(&(id, at)) {
                    stats.removed_receipts += 1;
                } else {
                    remaining.push(item);
                }
            }
            if remaining.is_empty() {
                rec.remove("queue");
                rec.remove("queuePaused");
                rec.remove("queueDispatch");
            } else {
                if let Some(marker) = rec.get("queueDispatch") {
                    let marker = Fields::parse(marker)?;
                    let survives = remaining.iter().any(|v| {
                        Fields::parse(v).is_ok_and(|f| {
                            f.get("id").and_then(units) == marker.get("id").and_then(units)
                                && f.get("at").and_then(units) == marker.get("at").and_then(units)
                        })
                    });
                    if !survives {
                        rec.remove("queueDispatch");
                    }
                }
                rec.set_raw("queue", to_raw_value(&remaining)?);
                if !yes(rec.get("queuePaused")) {
                    rec.set_bool("queuePaused", true);
                    stats.paused_queues += 1;
                }
            }
        }
    }
    Ok(stats)
}

pub fn public_record(record: &Record) -> Result<Raw> {
    let mut record = record.clone();
    if let Some(queue) = record.get("queue") {
        let marker = record.get("queueDispatch").map(Fields::parse).transpose()?;
        let mut previews = Vec::new();
        for item in array_values(queue)? {
            let mut fields = Fields::parse(&item)?;
            let mut text = fields
                .get("text")
                .and_then(units)
                .context("normalized queue text")?;
            if marker.as_ref().is_some_and(|marker| {
                marker.get("id").and_then(units) == fields.get("id").and_then(units)
                    && marker.get("at").and_then(units) == fields.get("at").and_then(units)
            }) {
                let mut warning = "[Delivery unknown; Send now may duplicate] "
                    .encode_utf16()
                    .collect::<Vec<_>>();
                warning.extend(text);
                text = warning;
                fields.set("text", RawValue::from_string(encode_string(&text))?);
            }
            if title_length(&text) > 200 {
                let mut preview = first_points(&text, 199);
                preview.push(0x2026);
                fields.set("text", RawValue::from_string(encode_string(&preview))?);
            }
            previews.push(fields.into_raw()?);
        }
        record.set_raw("queue", to_raw_value(&previews)?);
    }
    record.raw()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn raw(text: &str) -> Raw {
        RawValue::from_string(text.to_owned()).unwrap()
    }
    fn records(text: &str) -> Vec<Record> {
        parse(&raw(text)).unwrap()
    }
    fn base() -> Vec<Record> {
        records(
            r#"{"version":2,"sessions":[{"name":"chat","provider":"claude","cwd":"/project","createdAt":"2026-01-01T00:00:00Z","lastStatus":"working","lastEventId":1}]}"#,
        )
    }
    fn event(id: u64, text: &str) -> JournalRecord {
        JournalRecord {
            id,
            json: raw(text),
        }
    }

    #[test]
    fn pretty_opaque_metadata_remains_one_ndjson_frame_without_interpreting_values() {
        let memory = r#"{
  "read":true,
  "write":"ask",
  "future":{"raw":"\ud800","text":"inside space \"quote\" \\ tail","number":1.0000e+20}
}"#;
        let got = records(&format!(
            r#"{{"sessions":[{{"name":"chat","provider":"codex","cwd":"/project","memory":{memory},"private":{{
  "future":"\ud800"
}},"temporary":false}}]}}"#
        ));
        let frame = public_record(&got[0]).unwrap();
        assert!(
            !frame.get().contains('\n'),
            "opaque pretty JSON split an NDJSON response"
        );
        assert!(!frame.get().contains('\r'));
        assert!(frame.get().contains(r#""raw":"\ud800""#));
        assert!(
            frame.get().contains("1.0000e+20"),
            "opaque numbers were interpreted"
        );
        assert!(frame.get().contains("inside space"));
        let reparsed = records(&format!(r#"{{"sessions":[{}]}}"#, frame.get()));
        assert_eq!(
            got[0].get("memory").unwrap().get(),
            reparsed[0].get("memory").unwrap().get()
        );
    }
    #[test]
    fn memory_policy_and_privacy_survive_recovery_as_opaque_raw_utf16() {
        for memory in [
            r#"{"read":true,"write":"ask"}"#,
            r#"{"read":true,"write":"future","extra":"\ud800"}"#,
            "null",
            "17",
            r#""invalid""#,
        ] {
            let input = format!(
                r#"{{"sessions":[{{"name":"chat","provider":"codex","cwd":"/project","memory":{memory},"private":{{"future":"\ud800"}},"temporary":null}}]}}"#
            );
            let got = records(&input);
            assert_eq!(got[0].get("memory").map(RawValue::get), Some(memory));
            assert_eq!(
                got[0].get("private").map(RawValue::get),
                Some(r#"{"future":"\ud800"}"#)
            );
            assert_eq!(got[0].get("temporary").map(RawValue::get), Some("null"));
            assert_eq!(
                crate::memory_policy::Policy::record(&got[0]).unwrap(),
                crate::memory_policy::Policy::default()
            );
            let canonical = got[0].raw().unwrap();
            let reparsed = records(&format!(r#"{{"sessions":[{}]}}"#, canonical.get()));
            for key in ["memory", "private", "temporary"] {
                assert_eq!(
                    reparsed[0].get(key).map(RawValue::get),
                    got[0].get(key).map(RawValue::get)
                );
            }
        }
        let got = records(r#"{"sessions":[{"name":"chat","provider":"codex","cwd":"/project"}]}"#);
        for key in ["memory", "private", "temporary"] {
            assert!(got[0].get(key).is_none());
        }
    }
    #[test]
    fn parses_access_boundaries_and_keeps_raw_utf16() {
        let got = records(
            r#"{"sessions":[{"name":"chat","provider":"codex","cwd":"/p\ud800","approval":"future","serviceTier":"fast","model":"\ud800","lastEventId":-4,"lastSeenEventId":-1,"context":{"used":0.5,"window":0,"model":"","at":"x"},"applied":{"approval":"full","reported":9,"confirmed":1,"full":true},"browser":true},{"name":"BAD","provider":"claude","cwd":"/p"}]}"#,
        );
        assert_eq!(got.len(), 1);
        let rec = &got[0];
        assert_eq!(rec.name(), "chat");
        assert_eq!(rec.scalar("approval").as_deref(), Some("read-only"));
        assert_eq!(rec.scalar("serviceTier").as_deref(), Some("fast"));
        assert_eq!(rec.string("model"), Some(vec![0xd800]));
        assert_eq!(rec.string("cwd").unwrap().last(), Some(&0xd800));
        assert!(rec.get("lastSeenEventId").is_none());
        let ctx: serde_json::Value =
            serde_json::from_str(rec.get("context").unwrap().get()).unwrap();
        assert_eq!(
            ctx,
            serde_json::json!({"used":1,"window":null,"model":null,"at":"x"})
        );
        assert!(rec.raw().unwrap().get().contains(r#"\ud800"#));
    }
    #[test]
    fn title_controls_visibility_codepoints_and_queue_preview() {
        let input = " \u{202e}a\n\u{00ad}\u{2800}\t🦀\u{200d}b ";
        let normalized = normalize_title(&input.encode_utf16().collect::<Vec<_>>()).unwrap();
        assert_eq!(String::from_utf16(&normalized).unwrap(), "a 🦀\u{200d}b");
        assert!(normalize_title(&[0x200b, 0x2800, 0x20, 0x301]).is_none());
        assert_eq!(title_length(&[0xd83c, 0xdf0a, 0xd800]), 2);
        let mut rec = base().remove(0);
        let text = "🦀".repeat(201);
        rec.set_raw(
            "queue",
            to_raw_value(&serde_json::json!([{"id":"q","text":text,"at":"x"}])).unwrap(),
        );
        let public = public_record(&rec).unwrap();
        let queue = crate::history::field(&public, "queue").unwrap().unwrap();
        let item = array_values(&queue).unwrap().remove(0);
        let text = crate::history::field(&item, "text").unwrap().unwrap();
        let units = decode_js_string(&text).unwrap();
        assert_eq!(title_length(&units), 200);
        assert_eq!(units.last(), Some(&0x2026));
    }
    #[test]
    fn queue_validation_deduplicates_after_validating_and_preserves_attachments() {
        let rec=records(r#"{"sessions":[{"name":"chat","provider":"claude","cwd":"/p","queue":[{"id":"a","text":" "},{"id":"a","text":"ok"},{"id":"a","text":"duplicate"},{"id":"b","text":"","attachments":[{"path":"/a","name":"a","bytes":0,"mime":"x","kind":"file"}]},{"id":"c","text":"ok","attachments":[{"path":"relative","name":"a","bytes":0,"mime":"x","kind":"file"}]}]}]}"#).remove(0);
        let queue = array_values(rec.get("queue").unwrap()).unwrap();
        assert_eq!(queue.len(), 2);
        assert_eq!(
            crate::history::field(&queue[0], "at")
                .unwrap()
                .unwrap()
                .get(),
            format!("\"{EPOCH}\"")
        );
    }
    #[test]
    fn migration_cutoff_never_expands_newer_ask_or_invalid_marker() {
        let mut got = base();
        assert_eq!(
            migrate(Some(1.0), &mut got, Some("2026-01-02T00:00:00Z")).unwrap(),
            1
        );
        assert_eq!(got[0].scalar("approval").as_deref(), Some("inherit"));
        let mut got = base();
        assert_eq!(
            migrate(Some(1.0), &mut got, Some("2025-01-01T00:00:00Z")).unwrap(),
            0
        );
        assert!(got[0].get("approval").is_none());
        assert!(migrate(Some(1.0), &mut got, Some("unrecognized date")).is_err());
        assert!(got[0].get("approval").is_none());
        assert_eq!(
            version(&raw(r#"{"version":1e400}"#)).unwrap(),
            Some(f64::INFINITY)
        );
    }
    #[test]
    fn ambiguous_legacy_year_cannot_expand_access_during_migration() {
        for created in ["01/02/26", "Jan 02 26", "26/01/01"] {
            assert_eq!(date_millis(created), None);
            let mut records = base();
            records[0].set_string("createdAt", created);
            assert_eq!(
                migrate(Some(1.0), &mut records, Some("2026-01-01T00:00:00Z")).unwrap(),
                0
            );
            assert!(records[0].get("approval").is_none());
            assert!(migrate(Some(1.0), &mut records, Some(created)).is_err());
        }
    }

    #[test]
    fn dates_match_iso_overflow_fraction_and_midnight_rules() {
        assert_eq!(date_millis("2026-01-02T03:04Z"), Some(1767323040000));
        assert_eq!(date_millis("2026-02-30T01:00:00Z"), Some(1772413200000));
        assert_eq!(date_millis("2026-02-30"), Some(1772409600000));
        assert_eq!(date_millis("2026-01-02T24:00Z"), Some(1767398400000));
        assert_eq!(
            date_millis("2026-01-02T03:04:05.1239Z"),
            Some(1767323045123)
        );
        assert_eq!(date_millis("2026-01-02T24:00:00.001Z"), None);
        assert_eq!(date_millis("2026-01-02T24:00:01Z"), None);
        assert_eq!(date_millis("2026-01-02T03:04:60Z"), None);
        assert_eq!(date_millis("2026-01-02T03:04:05.Z"), None);
        // RFC leap seconds are deliberately unsupported, not reinterpreted as
        // a minute boundary by Chrono (V8's legacy parser handles them oddly).
        assert_eq!(date_millis("Fri, 02 Jan 2026 03:04:60 +0000"), None);
        assert_eq!(date_millis("2026-01-02 03:04:60"), None);
    }
    #[test]
    fn recovery_pauses_pending_queue_uses_exact_receipts_and_is_idempotent() {
        let mut got = base();
        got[0].set_number("lastSeenEventId", 999.0);
        got[0].set_raw(
            "queue",
            raw(r#"[{"id":"a:b","text":"keep","at":"c"},{"id":"a","text":"remove","at":"b:c"}]"#),
        );
        let lookup = |_: &str| {
            Ok(vec![event(
                1,
                r#"{"id":1,"sessionId":"chat","kind":"message.user","ts":"2026-01-02T00:00:00Z","data":{"queueItemId":"a","queueItemAt":"b:c"}}"#,
            )])
        };
        let stats = recover(&mut got, 4, lookup).unwrap();
        assert_eq!(stats.cooled, 1);
        assert_eq!(stats.seeded_seen, 1);
        assert_eq!(stats.seeded_last_turn, 1);
        assert_eq!(stats.removed_receipts, 1);
        assert_eq!(stats.paused_queues, 1);
        assert_eq!(got[0].scalar("lastStatus").as_deref(), Some("cold"));
        assert_eq!(got[0].get("lastSeenEventId").unwrap().get(), "4");
        assert_eq!(array_values(got[0].get("queue").unwrap()).unwrap().len(), 1);
        assert!(!recover(&mut got, 4, lookup).unwrap().changed());
    }
    #[test]
    fn global_receipt_survives_a_missing_session_projection() {
        let mut got = base();
        got[0].set_raw("queue",raw(r#"[{"id":"accepted","text":"never resend","at":"old"},{"id":"pending","text":"keep","at":"later"}]"#));
        let stats = recover_with_receipts(
            &mut got,
            9,
            |_| Ok(Vec::new()),
            |name| {
                assert_eq!(name, "chat");
                Ok(HashSet::from([(
                    "accepted".encode_utf16().collect(),
                    "old".encode_utf16().collect(),
                )]))
            },
        )
        .unwrap();
        assert_eq!(stats.removed_receipts, 1);
        assert_eq!(stats.paused_queues, 1);
        let remaining = array_values(got[0].get("queue").unwrap()).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            crate::history::field(&remaining[0], "id")
                .unwrap()
                .unwrap()
                .get(),
            r#""pending""#
        );
        let before = got[0].raw().unwrap().get().to_owned();
        assert!(
            recover_with_receipts(
                &mut got,
                10,
                |_| Ok(Vec::new()),
                |_| anyhow::bail!("receipt read failed")
            )
            .is_err()
        );
        assert_eq!(got[0].raw().unwrap().get(), before);
    }

    #[test]
    fn recovery_failure_does_not_partially_mutate_registry() {
        let mut got = base();
        got[0].set_raw("queue", raw(r#"[{"id":"a","text":"x","at":"a"}]"#));
        let before = got[0].raw().unwrap().get().to_owned();
        assert!(recover(&mut got, 4, |_| anyhow::bail!("unreadable projection")).is_err());
        assert_eq!(got[0].raw().unwrap().get(), before);
    }
}
