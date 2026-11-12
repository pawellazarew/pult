//! Current core/log.ts string/value filtering, without a logger or IO.
//!
//! Email addresses remain visible. Patterns deliberately
//! retain JavaScript's ASCII word boundaries and non-Unicode /i behavior; Rust's
//! default Unicode boundary/case folding would change which strings are hidden.
//! The URL rule uses ECMAScript whitespace (BOM included, NEL excluded).
//!
//! Value accepts JSON data only. A JSON object resembling Error is still an
//! ordinary object; actual Error instances are not representable by this API.
//! Unpaired UTF-16 surrogates likewise belong to the decoder's fail-closed policy.
//! These are known secret patterns, not a claim to recognize every secret.
use regex::Regex;
use serde_json::Value;
use std::borrow::Cow;
use std::sync::OnceLock;

const MEMORY_TURN_PATTERN: &str = r"(?i-u:mt_[0-9a-f]{64})";

struct Rule {
    pattern: Regex,
    replacement: &'static str,
}
fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let non_space = r"[^\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}/@]";
        let url = format!("([A-Za-z][A-Za-z0-9+.-]*://){non_space}+:{non_space}+@");
        [
            (MEMORY_TURN_PATTERN, "<token>"),
            (r"sk-ant-[A-Za-z0-9_-]{8,}", "<token>"),
            (r"(?-u:\b)sk-[A-Za-z0-9]{16,}", "<token>"),
            (r"(?-u:\b)sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}", "<token>"),
            (r"(?-u:\b)(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{16,}", "<token>"),
            (r"(?-u:\b)github_pat_[A-Za-z0-9_]{16,}", "<token>"),
            (r"(?-u:\b)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}", "<token>"),
            (r"(?-u:\b)(?:Bearer|Basic)[ \t]+[A-Za-z0-9._~+/-]{16,}=*", "<token>"),
            (url.as_str(), "${1}<redacted>@"),
            (r"(?-u:\b)[0-9A-Fa-f]{32,}(?-u:\b)", "<token>"),
        ]
        .into_iter()
        .map(|(pattern, replacement)| Rule {
            pattern: Regex::new(pattern).expect("fixed Node redaction pattern"),
            replacement,
        })
        .collect()
    })
}
fn secret_name(name: &str) -> bool {
    static SECRET: OnceLock<Regex> = OnceLock::new();
    SECRET
        .get_or_init(|| {
            Regex::new(r"(?i-u:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)")
                .expect("fixed Node secret field pattern")
        })
        .is_match(name)
}

pub fn redact_string(text: &str) -> String {
    let mut out = text.to_owned();
    for rule in rules() {
        if let Cow::Owned(replaced) = rule.pattern.replace_all(&out, rule.replacement) {
            out = replaced;
        }
    }
    out
}

pub fn redact(value: &Value) -> Value {
    redact_at(value, 0)
}
fn redact_at(value: &Value, depth: u8) -> Value {
    if depth > 8 {
        return Value::String("<deep>".into());
    }
    match value {
        Value::String(text) => Value::String(redact_string(text)),
        Value::Array(values) => {
            Value::Array(values.iter().map(|v| redact_at(v, depth + 1)).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                // Node builds a plain `{}` and assigns out[k]. __proto__ invokes
                // its setter and never becomes an enumerable own JSON field.
                .filter(|(key, _)| key.as_str() != "__proto__")
                .map(|(key, value)| {
                    (
                        memory_pattern().replace_all(key, "<token>").into_owned(),
                        if memory_pattern().is_match(key) || secret_name(key) {
                            Value::String("<redacted>".into())
                        } else {
                            redact_at(value, depth + 1)
                        },
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn memory_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| Regex::new(MEMORY_TURN_PATTERN).expect("fixed memory capability pattern"))
}
/// Purpose keys are secret even in command identifiers or object property names.
pub(crate) fn contains_memory_capability(value: &Value) -> bool {
    match value {
        Value::String(text) => memory_pattern().is_match(text),
        Value::Object(values) => values.iter().any(|(key, value)| {
            memory_pattern().is_match(key) || contains_memory_capability(value)
        }),
        Value::Array(values) => values.iter().any(contains_memory_capability),
        _ => false,
    }
}
/// The final journal boundary preserves typed counters/opaque IDs while removing
/// the explicit credential format, including hostile structural IDs/property names.
/// This is the same purpose-key policy used by redact_string/redact above.
pub(crate) fn redact_memory_capabilities(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            Value::String(memory_pattern().replace_all(text, "<token>").into_owned())
        }
        Value::Array(values) => {
            Value::Array(values.iter().map(redact_memory_capabilities).collect())
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| {
                    let public_key = memory_pattern().replace_all(key, "<token>").into_owned();
                    let value = if public_key != *key {
                        Value::String("<redacted>".into())
                    } else {
                        redact_memory_capabilities(value)
                    };
                    (public_key, value)
                })
                .collect(),
        ),
        value => value.clone(),
    }
}
