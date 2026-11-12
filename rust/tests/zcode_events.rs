//! Pure native fixtures/oracles only; no ZCode CLI, model or account.
use pult_core::{
    turn_coordinator::{Coordinator, Limits as CoreLimits},
    turn_snapshot::{Provider, SessionKey, TurnSettings, TurnSnapshot},
    zcode_events::*,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
#[path = "support/zcode_oracle.rs"]
mod support;
use support::oracle;
fn binding() -> (HostBinding, TrustedCallback) {
    let session = SessionKey {
        name: "trusted".into(),
        created_at: "2026-11-12T00:00:00Z".into(),
    };
    let mut core = Coordinator::new(CoreLimits::default()).unwrap();
    let ticket = core
        .reserve(TurnSnapshot {
            key: session.clone(),
            provider: Provider::Zcode,
            cwd: "/project".into(),
            settings: TurnSettings::default(),
        })
        .unwrap();
    let callback = TrustedCallback {
        ticket: ticket.clone(),
        generation: 7,
    };
    (
        HostBinding::new(session, ticket, 7, "public-turn".into()).unwrap(),
        callback,
    )
}
fn setup(limits: Limits) -> (Normalizer, TrustedCallback) {
    let (b, c) = binding();
    (
        Normalizer::new(b, limits, Box::new(LogRedactor)).unwrap(),
        c,
    )
}
fn wire(batch: &Batch) -> Value {
    serde_json::to_value(batch).unwrap()
}
#[tokio::test]
async fn actual_node_four_captured_native_fixtures() {
    for name in [
        "01-simple-turn",
        "02-tool-turn",
        "03-resume-turn2",
        "04-cancelled",
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../test/fixtures/zcode/{name}.jsonl"));
        let frames = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .collect::<Vec<_>>();
        let (mut mapper, c) = setup(Default::default());
        let actual: Vec<_> = frames
            .iter()
            .map(|v| {
                let out = mapper.push(&c, v);
                assert!(out.fault.is_none(), "fixture {name}");
                wire(&out)
            })
            .collect();
        assert_eq!(
            Value::Array(actual),
            oracle(json!({"kind":"events","frames":frames})).await,
            "{name}"
        );
    }
}
#[tokio::test]
async fn actual_node_synthetic_shapes_and_numeric_boundaries() {
    let frames = vec![
        Value::Null,
        json!([]),
        json!({"type":"turn.started"}),
        json!({"type":"turn.started","sessionId":"native","payload":{"modelSelection":{"modelId":"model-x"}}}),
        json!({"type":"model.streaming","payload":{"kind":"reasoning_start"}}),
        json!({"type":"model.streaming","payload":{"kind":"reasoning_delta","delta":"thought"}}),
        json!({"type":"model.streaming","payload":{"kind":"text_delta","delta":"mail person@example.test"}}),
        json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":"opaque","toolName":"","input":[]}}),
        json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"opaque","result":null}}),
        json!({"type":"tool.updated","payload":{"kind":"result","toolCallId":"opaque","result":{"content":"","success":0}}}),
        json!({"type":"turn.completed","payload":{"response":"","resultType":"unexpected","usage":{"inputTokens":-0.0,"outputTokens":1.75,"cacheReadTokens":-2,"totalTokens":9007199254740993u64,"modelRequestCount":0}}}),
        json!({"type":"result","usage":{"inputTokens":1e100,"reasoningTokens":"not-number"},"projection":{"contextUsed":0,"contextWindow":null}}),
        json!({"type":"result","resultType":"cancelled","response":"cancelled","usage":[]}),
        json!({"type":"unknown-native-noise","sessionId":"native"}),
    ];
    let (mut mapper, c) = setup(Default::default());
    let actual: Vec<_> = frames.iter().map(|v| wire(&mapper.push(&c, v))).collect();
    assert_eq!(
        Value::Array(actual),
        oracle(json!({"kind":"events","frames":frames})).await
    );
}
#[test]
fn host_pin_is_monotonic_and_stale_callback_never_changes_scope() {
    let (mut mapper, c) = setup(Default::default());
    let early = mapper.push(
        &c,
        &json!({"type":"session.titleUpdated","sessionId":"candidate"}),
    );
    assert!(matches!(&early.signals[0],Signal::SessionId{id} if id=="candidate"));
    assert!(mapper.pin_native(&c, Some("native"), Some("turn")).is_ok());
    assert_eq!(
        mapper.pin_native(&c, Some("foreign"), None),
        Err(Error::Invalid)
    );
    assert!(
        mapper
            .push(&c, &json!({"type":"result","sessionId":"foreign"}))
            .ignored
    );
    assert!(
        mapper
            .push(
                &c,
                &json!({"type":"result","sessionId":"native","turnId":"foreign"})
            )
            .ignored
    );
    let stale = TrustedCallback {
        ticket: c.ticket.clone(),
        generation: 6,
    };
    let (_, foreign_ticket) = binding();
    assert!(
        mapper
            .push(
                &foreign_ticket,
                &json!({"type":"result","sessionId":"native"})
            )
            .ignored
    );
    assert_eq!(
        mapper.pin_native(&foreign_ticket, Some("other"), None),
        Err(Error::Invalid)
    );
    assert!(
        mapper
            .push(&stale, &json!({"type":"result","sessionId":"native"}))
            .ignored
    );
    assert_eq!(mapper.public_turn_id(), "public-turn");
    assert_eq!(
        mapper
            .push(
                &c,
                &json!({"type":"result","sessionId":"native","turnId":"turn"})
            )
            .drafts
            .len(),
        0
    );
}
#[test]
fn missing_native_ids_are_not_invented_from_host_binding() {
    let (mut mapper, c) = setup(Default::default());
    mapper.pin_native(&c, Some("native"), Some("turn")).unwrap();
    let batch = mapper.push(&c, &json!({"type":"turn.started"}));
    assert_eq!(batch.drafts[0].data["providerSessionId"], Value::Null);
    assert_eq!(
        wire(&batch)["signals"],
        json!([{"kind":"turn_started","model":null}])
    );
}
#[test]
fn production_redaction_preserves_distinct_opaque_ids_and_usage() {
    let (mut mapper, c) = setup(Default::default());
    let secret = format!("sk-ant-{}", "x".repeat(24));
    let mut ids = vec![];
    for letter in ["a", "b"] {
        let id = letter.repeat(32);
        let batch=mapper.push(&c,&json!({"type":"tool.updated","payload":{"kind":"scheduled","toolCallId":id,"toolName":"Read","input":{"token":secret,"mail":"person@example.test"}}}));
        assert!(batch.fault.is_none());
        ids.push(batch.drafts[0].data["toolUseId"].clone());
        assert_eq!(batch.drafts[0].data["input"]["mail"], "person@example.test");
        assert!(!wire(&batch).to_string().contains(&secret));
    }
    assert_ne!(ids[0], ids[1]);
    let batch = mapper.push(
        &c,
        &json!({"type":"result","usage":{"inputTokens":7,"outputTokens":1.75}}),
    );
    assert_eq!(batch.drafts[0].data["usage"]["input_tokens"], 7);
    assert_eq!(batch.drafts[0].data["usage"]["output_tokens"], 1.75);
}
#[test]
fn reasoning_content_is_filtered_before_public_live_signal() {
    let (mut mapper, c) = setup(Default::default());
    let secret = format!("pa_{}", "c".repeat(64));
    let batch = mapper.push(
        &c,
        &json!({"type":"model.streaming","payload":{"kind":"reasoning_delta","delta":secret}}),
    );
    assert!(!wire(&batch).to_string().contains(&secret));
}
struct Panic;
impl Redactor for Panic {
    fn redact(&mut self, _: &Value) -> Result<Value, RedactionError> {
        panic!("synthetic private callback payload")
    }
}
#[test]
fn redactor_panic_is_static_whole_batch_failure_once() {
    pult_core::panic_guard::install();
    let (b, c) = binding();
    let mut mapper = Normalizer::new(b, Default::default(), Box::new(Panic)).unwrap();
    let batch=mapper.push(&c,&json!({"type":"turn.completed","sessionId":"native","payload":{"response":"private","usage":{}}}));
    assert_eq!(batch.fault, Some(Error::Redaction));
    assert!(batch.drafts.is_empty() && batch.signals.is_empty() && batch.live.is_empty());
    assert!(mapper.push(&c, &json!({"type":"result"})).ignored);
}
struct Expand(Arc<AtomicUsize>);
impl Redactor for Expand {
    fn redact(&mut self, v: &Value) -> Result<Value, RedactionError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(if v.is_string() {
            json!("x".repeat(2048))
        } else {
            v.clone()
        })
    }
}
#[test]
fn expanding_redactor_and_input_size_fail_without_partial_drafts() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (b, c) = binding();
    let mut mapper = Normalizer::new(
        b,
        Limits {
            text_units: 64,
            ..Default::default()
        },
        Box::new(Expand(calls.clone())),
    )
    .unwrap();
    let batch=mapper.push(&c,&json!({"type":"turn.completed","sessionId":"native","payload":{"response":"x","usage":{}}}));
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.signals.is_empty() && batch.drafts.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let (mut mapper, c) = setup(Limits {
        input_bytes: 32,
        ..Default::default()
    });
    let batch = mapper.push(&c, &json!({"type":"result","response":"x".repeat(100)}));
    assert_eq!(batch.fault, Some(Error::Capacity));
}
#[test]
fn text_bound_uses_utf16_and_no_status_or_terminal_is_emitted() {
    let (mut mapper, c) = setup(Limits {
        text_units: 2,
        ..Default::default()
    });
    assert!(
        mapper
            .push(
                &c,
                &json!({"type":"model.streaming","payload":{"kind":"text_delta","delta":"😀"}})
            )
            .fault
            .is_none()
    );
    let batch = mapper.push(&c, &json!({"type":"result","response":"😀x"}));
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.drafts.is_empty());
}
#[test]
fn batch_budget_discards_earlier_usage_when_later_context_exceeds_budget() {
    let (mut mapper, c) = setup(Limits {
        batch_bytes: 32,
        ..Default::default()
    });
    let batch=mapper.push(&c,&json!({"type":"result","usage":{"inputTokens":7},"projection":{"contextUsed":8,"contextWindow":10}}));
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.drafts.is_empty() && batch.signals.is_empty());
}
#[test]
fn oversized_tool_object_is_rejected_before_clone_or_redactor() {
    let calls = Arc::new(AtomicUsize::new(0));
    let (b, c) = binding();
    let mut mapper = Normalizer::new(
        b,
        Limits {
            event_bytes: 64,
            ..Default::default()
        },
        Box::new(Expand(calls.clone())),
    )
    .unwrap();
    let batch=mapper.push(&c,&json!({"type":"tool.updated","sessionId":"native","payload":{"kind":"scheduled","toolCallId":"id","input":{"large":"x".repeat(1000)}}}));
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(batch.signals.is_empty() && batch.drafts.is_empty());
}
#[test]
fn excessive_semantic_depth_and_width_are_static_failures() {
    let (mut mapper, c) = setup(Default::default());
    let mut deep = Value::Null;
    for _ in 0..140 {
        deep = json!([deep]);
    }
    let batch = mapper.push(&c, &json!({"type":"session.updated","payload":deep}));
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.signals.is_empty() && batch.drafts.is_empty());
    let (mut mapper, c) = setup(Default::default());
    let batch = mapper.push(
        &c,
        &json!({"type":"session.updated","payload":vec![Value::Null;131073]}),
    );
    assert_eq!(batch.fault, Some(Error::Capacity));
}
struct WrongRoot;
impl Redactor for WrongRoot {
    fn redact(&mut self, _: &Value) -> Result<Value, RedactionError> {
        Ok(json!({"injected":"object"}))
    }
}
#[test]
fn wrong_root_redactor_cannot_inject_a_replacement_event() {
    let (b, c) = binding();
    let mut mapper = Normalizer::new(b, Default::default(), Box::new(WrongRoot)).unwrap();
    let batch = mapper.push(
        &c,
        &json!({"type":"turn.completed","sessionId":"native","payload":{"response":"text"}}),
    );
    assert_eq!(batch.fault, Some(Error::Redaction));
    assert!(batch.signals.is_empty() && batch.drafts.is_empty());
}
#[test]
fn unknown_early_envelope_retains_native_candidate_without_binding_logical_scope() {
    let (mut mapper, c) = setup(Default::default());
    let batch = mapper.push(
        &c,
        &json!({"type":"future.safe.noise","sessionId":"candidate"}),
    );
    assert!(!batch.ignored);
    assert!(batch.drafts.is_empty());
    assert!(matches!(&batch.signals[0],Signal::SessionId{id} if id=="candidate"));
    let next = mapper.push(
        &c,
        &json!({"type":"turn.started","sessionId":"different-candidate"}),
    );
    assert_eq!(next.drafts[0].session_id, "trusted");
    assert_eq!(
        next.drafts[0].data["providerSessionId"],
        "different-candidate"
    );
}
