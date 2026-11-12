//! Compare against actual Node core/log.ts, extracted without changing regexes.
//! Fixtures are synthetic strings, never live credentials or network requests.
use pult_core::redaction::{redact, redact_string};
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

fn oracle(strings: &[String], values: &[Value]) -> Value {
    const SCRIPT: &str = r#"
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const start = source.indexOf('const SECRET_NAME_RE =');
const end = source.indexOf('export interface Logger {');
if (start < 0 || end <= start) throw new Error('Node redactor extraction boundary changed');
const body = source.slice(start, end)
  .replace('const VALUE_RULES: Array<{ re: RegExp; to: string }>', 'const VALUE_RULES')
  .replace('export function redactString(s: string): string', 'function redactString(s)')
  .replace('export function redact(value: unknown, depth = 0): unknown', 'function redact(value, depth = 0)')
  .replace('const out: Record<string, unknown> = {}', 'const out = {}')
  .replace('Object.entries(value as Record<string, unknown>)', 'Object.entries(value)');
const api = vm.runInNewContext(body + '; ({ redactString, redact })');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const output = JSON.stringify({strings: input.strings.map(s => api.redactString(s)), values: input.values.map(v => api.redact(v))});
if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error('Node redaction oracle output budget exceeded');
process.stdout.write(output);
"#;
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/core/log.ts");
    let corpus = serde_json::to_vec(&json!({"strings":strings,"values":values})).unwrap();
    assert!(
        corpus.len() <= 2 * 1024 * 1024,
        "fixed oracle corpus budget"
    );
    let output = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("oracle runtime")
        .block_on(async {
            let mut child = Command::new("node")
                .arg("-e")
                .arg(SCRIPT)
                .arg(source)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .expect("Node is required for redaction parity oracle");
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut input = child.stdin.take().expect("oracle stdin");
                input.write_all(&corpus).await.expect("send oracle corpus");
                input.shutdown().await.expect("close oracle stdin");
                drop(input);
                child.wait_with_output().await.expect("collect Node oracle")
            })
            .await
            .expect("Node redaction oracle exceeded its 10s watchdog")
        });
    assert!(
        output.status.success(),
        "Node oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn check_strings(strings: Vec<String>) {
    let expected = oracle(&strings, &[]);
    for (index, text) in strings.iter().enumerate() {
        assert_eq!(
            json!(redact_string(text)),
            expected["strings"][index],
            "oracle string case {index}: {text:?}"
        );
    }
}
fn check_values(values: Vec<Value>) {
    let expected = oracle(&[], &values);
    for (index, value) in values.iter().enumerate() {
        assert_eq!(
            redact(value),
            expected["values"][index],
            "oracle value case {index}"
        );
    }
}
#[test]
fn known_secret_families_and_minimum_lengths_match_real_node() {
    let mut cases = vec![];
    for (prefix, minimum) in [
        ("sk-ant-", 8),
        ("sk-", 16),
        ("sk-proj-", 16),
        ("sk-svcacct-", 16),
        ("sk-admin-", 16),
        ("ghp_", 16),
        ("gho_", 16),
        ("ghs_", 16),
        ("ghr_", 16),
        ("github_pat_", 16),
    ] {
        for len in [minimum - 1, minimum, minimum + 1, 64] {
            cases.push(format!("{prefix}{}", "Z".repeat(len)));
        }
    }
    for first in [7, 8, 9] {
        for middle in [7, 8, 9] {
            for last in [7, 8, 9] {
                cases.push(format!(
                    "eyJ{}.{}.{}",
                    "Z".repeat(first),
                    "Z".repeat(middle),
                    "Z".repeat(last)
                ));
            }
        }
    }
    for length in [15, 16, 17, 48] {
        for scheme in ["Bearer", "Basic", "bearer", "BASIC"] {
            cases.push(format!("{scheme} {}==", "Z".repeat(length)));
        }
    }
    cases.extend([
        "not a secret".into(),
        "fake sk-unknown-prefix".into(),
        "SK-PROJ-ZZZZZZZZZZZZZZZZ".into(),
        "GitHub_pat_ZZZZZZZZZZZZZZZZ".into(),
    ]);
    check_strings(cases);
}
#[test]
fn ascii_word_boundaries_match_node_next_to_unicode_words_and_punctuation() {
    let mut cases = vec![];
    for prefix in [
        "", "x", "_", "9", "-", "é", "Ж", "K", "ſ", "🌊", "\u{200b}", "\0",
    ] {
        for suffix in ["", "x", "_", "-", "é", "🌊"] {
            for secret in [
                "sk-ZZZZZZZZZZZZZZZZ",
                "sk-proj-ZZZZZZZZZZZZZZZZ",
                "ghp_ZZZZZZZZZZZZZZZZ",
                "github_pat_ZZZZZZZZZZZZZZZZ",
                "Bearer ZZZZZZZZZZZZZZZZ",
                "abcdef0123456789ABCDEF0123456789",
            ] {
                cases.push(format!("{prefix}{secret}{suffix}"));
            }
        }
    }
    check_strings(cases);
}
#[test]
fn email_addresses_remain_visible_including_unicode_and_partial_forms() {
    let cases = [
        concat!("a@", "b.co"),
        "first.last+tag%route@sub-domain.example.test",
        "a@b.c",
        "a@host",
        "a@localhost",
        "a@b.123",
        concat!("a@", "b.coé"),
        "Жa@b.testЖ",
        "é@domain.test",
        "name@домен.рф",
        concat!("x@", "y.co/second@y.test"),
        "a@b..test",
        "a@b-.test",
        "<a@b.test>",
        "A_B@EXAMPLE.TEST",
        "a@b.test\nsecond@x.test",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    for email in &cases {
        assert_eq!(redact_string(email), *email);
    }
    check_strings(cases);
}
#[test]
fn replacement_order_keeps_key_before_bearer_and_masks_url_credentials() {
    let cases = vec![
        "http://user:password@proxy.example:80/path".into(),
        "http://user:password@127.0.0.1:80/path".into(),
        concat!("Bearer ", "sk-proj-ZZZZZZZZZZZZZZZZ").into(),
        concat!("Authorization: Basic ", "ZZZZZZZZZZZZZZZZ==").into(),
        concat!("HTTP://a@", "x.co:pw@127.0.0.1").into(),
        "a@x.test sk-ant-ZZZZZZZZ http://u:pw@127.0.0.1".into(),
    ];
    check_strings(cases);
    assert_eq!(
        redact_string("http://user:password@proxy.example:80/path"),
        "http://<redacted>@proxy.example:80/path"
    );
    assert_eq!(
        redact_string("http://user:password@127.0.0.1:80/path"),
        "http://<redacted>@127.0.0.1:80/path"
    );
    assert_eq!(
        redact_string(concat!("Bearer ", "sk-proj-ZZZZZZZZZZZZZZZZ")),
        "Bearer <token>"
    );
}
#[test]
fn url_userinfo_uses_js_whitespace_and_ascii_case_folding() {
    let mut cases = vec![];
    for space in [
        '\t', '\n', '\u{000b}', '\u{000c}', '\r', ' ', '\u{00a0}', '\u{1680}', '\u{2000}',
        '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        '\u{0085}', '\u{200b}', '\0',
    ] {
        cases.push(format!("http://u{space}ser:pw@127.0.0.1"));
        cases.push(format!("http://user:p{space}w@127.0.0.1"));
        cases.push(format!("Bearer{space}ZZZZZZZZZZZZZZZZ"));
    }
    for scheme in ["http", "HTTP", "hTtPs", "socks5", "ABC+1.-", "K", "ſ", "hK"] {
        cases.push(format!("{scheme}://user:pw@127.0.0.1"));
    }
    cases.extend([
        "http://u:pw:more@127.0.0.1".into(),
        "http://u:@127.0.0.1".into(),
        "http://:pw@127.0.0.1".into(),
        "http://u:p/w@127.0.0.1".into(),
        "http://u:p@ss@127.0.0.1".into(),
        "http://🌊:пароль@127.0.0.1".into(),
    ]);
    check_strings(cases);
}
#[test]
fn hex_minimum_length_and_ascii_end_boundary_match_node() {
    let mut cases = vec![];
    for length in [31, 32, 33, 64, 65] {
        for prefix in ["", "x", "_", "é", "🌊", "-"] {
            for suffix in ["", "x", "_", "é", "🌊", "-"] {
                cases.push(format!("{prefix}{}{suffix}", "a".repeat(length)));
            }
        }
    }
    cases.extend([
        "ABCD0123456789EFABCD0123456789EFAB".into(),
        "0xabcdef0123456789abcdef0123456789".into(),
    ]);
    check_strings(cases);
}
#[test]
fn secret_object_keys_are_ascii_substrings_and_values_are_wholly_hidden() {
    check_values(vec![
        json!({"API_KEY":"visible","token":null,"SeCrEt":[1,2,3],"Password":{"safe":"visible"},"passwd":true,"credentials":5,"authorName":"visible","cookieJar":false,"monKEY":"visible"}),
        json!({"Key":"visible","paſsword":"visible","ſecret":"visible","authKey":"visible","ordinary":"a@b.test"}),
        json!({"nested":[{"input":{"command":"Bearer ZZZZZZZZZZZZZZZZ"},"ACCESS_TOKEN":{"nested":"must not leak"}},"sk-ant-ZZZZZZZZ"]}),
        json!({"name":"Error","message":"email@host.test","stack":"sk-proj-ZZZZZZZZZZZZZZZZ","other":42}),
    ]);
}
fn wrap(mut value: Value, count: usize, array: bool) -> Value {
    for _ in 0..count {
        value = if array {
            json!([value])
        } else {
            json!({"nested":value})
        };
    }
    value
}
#[test]
fn depth_eight_boundary_applies_before_primitives_and_secret_child_filtering() {
    let mut cases = vec![];
    for depth in [7, 8, 9, 10, 30] {
        for array in [false, true] {
            for value in [
                Value::Null,
                json!(5),
                json!(false),
                json!("a@host.test"),
                json!({"TOKEN":"raw","safe":"raw"}),
                json!(["raw", null]),
            ] {
                cases.push(wrap(value, depth, array));
            }
        }
    }
    check_values(cases);
    assert_eq!(
        redact(&wrap(json!({"TOKEN":"raw","safe":"raw"}), 8, false)),
        wrap(json!({"TOKEN":"<redacted>","safe":"<deep>"}), 8, false)
    );
}
#[test]
fn proto_named_json_properties_follow_node_plain_object_assignment() {
    check_values(vec![
        json!({"__proto__":{"safe":"prototype","token":"hidden"},"ordinary":"kept"}),
        json!({"__proto__":"ignored","constructor":{"safe":"kept"},"prototype":{"safe":"kept"}}),
        json!({"nested":{"__proto__":null,"__proto__TOKEN":"hidden","toJSON":"ordinary text","safe":1}}),
        json!([{ "__proto__":["ignored"],"safe":false}]),
    ]);
    assert_eq!(
        redact(&json!({"__proto__":{"secret":"raw"},"safe":"ok"})),
        json!({"safe":"ok"})
    );
}
#[test]
fn json_scalars_and_structure_are_preserved_without_debug_or_input_mutation() {
    let value = json!({"array":[null,true,0,42,0.25,"harmless"],"safe":{"value":"visible"},"secret":{"raw":"hidden"}});
    let original = value.clone();
    let output = redact(&value);
    assert_eq!(value, original);
    assert_eq!(output["array"], original["array"]);
    assert_eq!(output["safe"], original["safe"]);
    assert_eq!(output["secret"], "<redacted>");
    check_values(vec![
        value,
        Value::Null,
        json!(true),
        json!(42),
        json!(0.25),
        json!("a@b.test"),
    ]);
}

#[test]
fn visible_email_does_not_disable_token_password_or_url_credential_filters() {
    let text = format!("mail@host.test sk-ant-{}", "Z".repeat(8));
    assert_eq!(redact_string(&text), "mail@host.test <token>");
    let input = json!({
        "email":"mail@host.test",
        "nested":[{"message":text,"API_TOKEN":"synthetic-value","password":"mail@host.test"}],
        "url":"https://user:password@proxy.example.test/path"
    });
    assert_eq!(
        redact(&input),
        json!({
            "email":"mail@host.test",
            "nested":[{"message":"mail@host.test <token>","API_TOKEN":"<redacted>","password":"<redacted>"}],
            "url":"https://<redacted>@proxy.example.test/path"
        })
    );
    check_strings(vec![text]);
    check_values(vec![input]);
}

#[test]
fn turn_memory_capabilities_match_real_node_in_embedded_text_and_nested_property_names() {
    let mut cases = Vec::new();
    for prefix in ["mt_", "MT_", "mT_"] {
        for length in [63, 64, 65] {
            for hex in ["a", "F"] {
                let key = format!("{prefix}{}", hex.repeat(length));
                for (before, after) in [("", ""), ("word_", "_tail"), ("é", "𐀀"), ("[", "]")] {
                    cases.push(format!("{before}{key}{after}"));
                }
            }
        }
    }
    check_strings(cases);
    let key = format!("mt_{}", "a".repeat(64));
    let upper = key.to_ascii_uppercase();
    assert_eq!(
        redact_string(&format!("owner@example.com word_{upper}_tail")),
        "owner@example.com word_<token>_tail"
    );
    let values = vec![
        json!({"nested":[{"commandId":key,"message":upper,"email":"owner@example.com"}]}),
        json!({key.clone():"must hide entire value",upper.clone():{"value":"also hidden"},"ordinary":"visible"}),
        json!({"metadata":{"prefix-mt_":true},format!("embedded-{key}-suffix"):"concealed"}),
    ];
    assert_eq!(
        redact(&values[1]),
        json!({"<token>":"<redacted>","ordinary":"visible"})
    );
    check_values(values);
}
