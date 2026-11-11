//! Independent corpus against the actual built Node config validators. Typed
//! Rust warning codes deliberately differ from translated Node warning strings.
use pult_core::runtime_config;
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

fn corpus() -> Vec<(&'static str, Value)> {
    let mcp_many: Vec<_> = (0..36).map(|n| json!(format!("Server_{n}"))).collect();
    let mut mcp_mixed = mcp_many.clone();
    mcp_mixed.push(Value::Null);
    vec![
        ("defaults", json!({})),
        ("null-root", Value::Null),
        (
            "array-root",
            json!([{"network":{"codex":{"mode":"required"}}}]),
        ),
        ("scalar-root", json!(true)),
        (
            "four-network-profiles",
            json!({"network":{"claude":{"proxy":" http://claude.test:80 ","mode":"required"},"codex":{"proxy":"socks5h://codex.test:90","mode":"auto"},"opencode":{"proxy":"http://opencode.test:80","mode":"off"},"zcode":{"proxy":"http://zcode.test:80"}},"attachments":{"retentionDays":7}}),
        ),
        (
            "required-empty-four-providers",
            json!({"network":{"claude":{"mode":"required"},"codex":{"mode":"required","proxy":""},"opencode":{"mode":"required","proxy":" \u{feff}"},"zcode":{"mode":"required","proxy":false}}}),
        ),
        (
            "profile-invalid-types",
            json!({"network":{"claude":[],"codex":null,"opencode":42,"zcode":true}}),
        ),
        (
            "network-array-and-legacy-guard",
            json!({"network":[],"guardCountries":[" ru ","BY"]}),
        ),
        (
            "no-proxy-filtering",
            json!({"network":{"codex":{"mode":"off","noProxy":[" *.corp.test ",".corp.test","127.0.0.1","10.0.0.0/8","",false,"bad host","bad,host","\u{85}"," x\u{feff}y "]}}}),
        ),
        (
            "no-proxy-invalid-types",
            json!({"network":{"claude":{"noProxy":"host.test"},"codex":{"noProxy":null},"opencode":{"noProxy":{}},"zcode":{"noProxy":[]}}}),
        ),
        (
            "invalid-and-inferred-network-modes",
            json!({"network":{"claude":{"mode":"auto"},"codex":{"mode":" REQUIRED ","proxy":"http://proxy.test"},"opencode":{"mode":0},"zcode":{"proxy":"http://proxy.test","mode":false}}}),
        ),
        (
            "legacy-guard-opaque-codes",
            json!({"guardCountries":[" ru ","ZZ","ß","ru","", "\u{85}"]}),
        ),
        (
            "new-guard-wins-and-filters-codes",
            json!({"guardCountries":["RU"],"network":{"guard":{"mode":" ALLOW ","countries":[" de ","DE","xk","ZZ",42,"ß"]}}}),
        ),
        (
            "malformed-new-guard-closes",
            json!({"guardCountries":["DE"],"network":{"guard":{"mode":"maybe","countries":["DE"]}}}),
        ),
        (
            "array-new-guard-closes",
            json!({"guardCountries":[],"network":{"guard":[]}}),
        ),
        (
            "empty-allow-remains-closed",
            json!({"network":{"guard":{"mode":"allow","countries":[]}}}),
        ),
        (
            "numeric-zero",
            json!({"warmTtlMs":0,"permTimeoutMs":-0.0,"subagentGraceMs":0,"backgroundMaxMs":0,"notify":{"minTurnSeconds":0,"sound":false},"watchdog":{"silenceMinutes":0},"autoTitle":false}),
        ),
        (
            "fractional-and-huge-finite-numbers",
            json!({"warmTtlMs":0.25,"permTimeoutMs":1e308,"subagentGraceMs":9_007_199_254_740_993u64,"backgroundMaxMs":2.5,"notify":{"minTurnSeconds":0.125},"watchdog":{"silenceMinutes":1e100}}),
        ),
        (
            "invalid-numeric-types",
            json!({"warmTtlMs":-1,"permTimeoutMs":"10","subagentGraceMs":null,"backgroundMaxMs":[],"notify":{"minTurnSeconds":-0.5,"sound":"false"},"watchdog":{"silenceMinutes":false},"autoTitle":1}),
        ),
        (
            "command-preserves-text-and-disk-rejects-unknown",
            json!({"notifyCommand":" \u{feff}echo private-notify-command \n","notify":{"minTurnSeconds":1.5},"disk":{"thresholdGb":1,"prompt":"keep","unknown":true},"language":" ru ","unknownRoot":{"keep":"out of normalized output"}}),
        ),
        (
            "https-update-and-retention",
            json!({"updates":{"check":false,"url":" \u{feff}https://updates.test/latest.json\t"},"attachments":{"retentionDays":90},"language":"en"}),
        ),
        (
            "invalid-update-and-retention",
            json!({"updates":{"check":null,"url":"http://updates.test/latest.json"},"notify":[],"notifyCommand":false,"attachments":{"retentionDays":"7"},"watchdog":[]}),
        ),
        ("mcp-valid-limit", json!({"mcp":{"servers":mcp_many}})),
        (
            "mcp-mixed-tail-rejects-entire-list",
            json!({"mcp":{"servers":mcp_mixed}}),
        ),
        (
            "fractional-disk-defaults",
            json!({"disk":{"thresholdGb":1.5,"prompt":"custom"},"attachments":{"retentionDays":null}}),
        ),
        (
            "unsafe-disk-product-defaults",
            json!({"disk":{"thresholdGb":9_007_200,"prompt":null},"attachments":{"retentionDays":30}}),
        ),
        (
            "new-session-valid-and-browser-restrictions",
            json!({"newSession":{"rememberLast":false,"defaults":{"provider":"zcode","claude":{"model":"custom/model:[1]","effort":"custom-effort","approval":"workspace","mode":"warm","browser":true,"worktree":true},"codex":{"model":"gpt-6.1","effort":"ultra","approval":"workspace","browser":true},"zcode":{"model":"account-model","effort":"high","approval":"read-only","browser":true,"worktree":false}}}}),
        ),
        (
            "new-session-full-and-inherit-never-default",
            json!({"newSession":{"defaults":{"claude":{"approval":"inherit","browser":true},"codex":{"approval":"full","browser":true},"zcode":{"approval":"full","browser":true}}}}),
        ),
        (
            "new-session-unknown-fields-and-invalid-defaults",
            json!({"newSession":{"rememberLast":"false","unknown":{"x":1},"defaults":{"provider":"opencode","claude":[],"codex":{"model":" bad ","effort":"INVALID","approval":"bogus","mode":"WARM","browser":1,"worktree":null,"unknown":true},"zcode":null,"opencode":{"approval":"full"}}}}),
        ),
        (
            "exact-javascript-whitespace",
            json!({"network":{"claude":{"proxy":"\u{85}","noProxy":["\u{feff}*.corp.test\u{feff}","\u{85}","bad\u{2028}host"]},"zcode":{"mode":"required","proxy":"\u{feff}"},"guard":{"mode":"\u{feff}ALLOW\u{feff}","countries":["\u{feff}de\u{feff}","\u{85}DE"]}},"notifyCommand":"\u{85}","updates":{"url":"\u{feff}https://updates.test/latest.json\u{feff}"},"mcp":{"servers":["\u{feff}Server.one\u{feff}","\u{85}Server.two","Server.one"," ","bad/server"]},"disk":{"thresholdGb":9_007_199,"prompt":"\u{feff} \u{feff}"},"newSession":{"defaults":{"claude":{"model":"\u{feff}sonnet\u{feff}"}}}}),
        ),
    ]
}

fn first_difference(left: &Value, right: &Value, at: &str) -> Option<String> {
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            if a.keys().ne(b.keys()) {
                return Some(format!("{at}/<keys>"));
            }
            a.iter()
                .find_map(|(key, value)| first_difference(value, &b[key], &format!("{at}/{key}")))
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                return Some(format!("{at}/<length>"));
            }
            a.iter()
                .zip(b)
                .enumerate()
                .find_map(|(n, (a, b))| first_difference(a, b, &format!("{at}/{n}")))
        }
        _ if left == right => None,
        _ => Some(at.into()),
    }
}

#[tokio::test]
async fn normalized_runtime_config_matches_actual_node_validator_corpus() {
    let cases = corpus();
    assert_eq!(cases.len(), 30);
    let inputs = Value::Array(cases.iter().map(|(_, value)| value.clone()).collect());
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/runtime-config-interop.mjs");
    let mut child = tokio::process::Command::new("node")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("could not start Node runtime config oracle");
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut input = child.stdin.take().expect("oracle stdin");
        input
            .write_all(&serde_json::to_vec(&inputs).unwrap())
            .await
            .expect("could not send config corpus");
        input
            .shutdown()
            .await
            .expect("could not close oracle stdin");
        drop(input);
        child
            .wait_with_output()
            .await
            .expect("could not collect Node config oracle")
    })
    .await
    .expect("runtime config oracle exceeded its 10s watchdog");
    assert!(
        output.status.success(),
        "Node config oracle failed; run npm ci && npm run build before this test"
    );
    let expected: Vec<Value> =
        serde_json::from_slice(&output.stdout).expect("invalid Node config oracle output");
    assert_eq!(expected.len(), cases.len());
    let differences: Vec<_> = cases
        .iter()
        .zip(expected)
        .filter_map(|((name, raw), expected)| {
            let actual = runtime_config::parse(raw).config.to_file();
            first_difference(&actual, &expected, "").map(|path| format!("{name}: {path}"))
        })
        .collect();
    assert!(
        differences.is_empty(),
        "Node/Rust normalized config parity differences: {}",
        differences.join(", ")
    );
}

#[test]
fn public_debug_and_warning_fields_do_not_reveal_configuration_secrets() {
    let raw = json!({"network":{"codex":{"proxy":"http://PRIVATE_PROXY_SECRET@proxy.test","noProxy":["PRIVATE_HOST_SECRET"]}},"notifyCommand":"PRIVATE_COMMAND_SECRET","mcp":{"servers":["PRIVATE_MCP_SECRET"]},"updates":{"url":"https://PRIVATE_UPDATE_SECRET/latest.json"},"disk":{"thresholdGb":1,"prompt":"PRIVATE_PROMPT_SECRET"},"guardCountries":["PRIVATE_COUNTRY_SECRET"],"newSession":{"defaults":{"claude":{"model":"PRIVATE_MODEL_SECRET","effort":"PRIVATE_EFFORT_SECRET"},"codex":{"approval":"PRIVATE_INVALID_SECRET"}}}});
    let parsed = runtime_config::parse(&raw);
    let debug = format!("{parsed:?}");
    assert!(!debug.contains("PRIVATE_"));
    assert!(
        parsed
            .warnings
            .iter()
            .all(|w| !w.field.contains("PRIVATE_"))
    );
}
