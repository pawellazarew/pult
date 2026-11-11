use pult_core::codex_events::{
    Batch, Binding, Error, Kind, Limits, Live, Normalizer, OutcomeCode, RedactionError, Redactor,
    Signal, TrustedCallback,
};
use pult_core::turn_coordinator::{Coordinator, Limits as CoordinatorLimits};
use pult_core::turn_snapshot::{Provider, SessionKey, TurnSettings, TurnSnapshot};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
struct Identity;
impl Redactor for Identity {
    fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
        Ok(value.clone())
    }
}
fn binding(thread: &str, turn: &str) -> Binding {
    let session = SessionKey {
        name: "trusted-session".into(),
        created_at: "2026-11-11T00:00:00Z".into(),
    };
    let mut coordinator = Coordinator::new(CoordinatorLimits::default()).unwrap();
    let ticket = coordinator
        .reserve(TurnSnapshot {
            key: session.clone(),
            provider: Provider::Codex,
            cwd: "/trusted/project".into(),
            settings: TurnSettings::default(),
        })
        .unwrap();
    Binding {
        session,
        ticket,
        generation: 7,
        thread_id: thread.into(),
        provider_turn_id: turn.into(),
        public_turn_id: "turn-local".into(),
        model: Some("model-trusted".into()),
        started_ms: 100,
    }
}
fn setup(limits: Limits, redactor: Box<dyn Redactor>) -> (Normalizer, TrustedCallback) {
    let binding = binding("thread", "turn-provider");
    let callback = TrustedCallback {
        generation: binding.generation,
        ticket: binding.ticket.clone(),
    };
    (
        Normalizer::new(binding, limits, redactor).unwrap(),
        callback,
    )
}
fn p(value: Value) -> Value {
    let mut value = value;
    value["threadId"] = json!("thread");
    value["turnId"] = json!("turn-provider");
    value
}
fn push(
    normalizer: &mut Normalizer,
    callback: &TrustedCallback,
    method: &str,
    value: Value,
) -> Batch {
    normalizer.push(callback, method, &p(value), 200)
}
fn fixture(name: &str) -> Vec<Value> {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/codex")
            .join(name),
    )
    .unwrap()
    .lines()
    .map(|s| serde_json::from_str(s).unwrap())
    .collect()
}
fn play(name: &str) -> Vec<Batch> {
    let frames = fixture(name);
    let start = frames
        .iter()
        .find(|v| v["method"] == "turn/started")
        .unwrap();
    let params = &start["params"];
    let binding = binding(
        params["threadId"].as_str().unwrap(),
        params["turn"]["id"].as_str().unwrap(),
    );
    let callback = TrustedCallback {
        generation: binding.generation,
        ticket: binding.ticket.clone(),
    };
    let mut normalizer = Normalizer::new(binding, Limits::default(), Box::new(Identity)).unwrap();
    frames
        .iter()
        .map(|frame| {
            normalizer.push(
                &callback,
                frame["method"].as_str().unwrap_or(""),
                &frame["params"],
                250,
            )
        })
        .collect()
}
#[test]
fn recorded_simple_turn_matches_independent_journal_shapes() {
    let batches = play("01-simple-turn.jsonl");
    let drafts: Vec<_> = batches
        .iter()
        .flat_map(|b| &b.drafts)
        .map(|d| serde_json::to_value(d).unwrap())
        .collect();
    let message_id = "msg_0371cc045d9a3fc0016ab03e3e5f2c87d28b3ef343092776ca";
    assert_eq!(drafts,json!([
        {"sessionId":"trusted-session","provider":"codex","kind":"message.delta","data":{"text":"OK","itemId":message_id}},
        {"sessionId":"trusted-session","provider":"codex","kind":"message.done","data":{"text":"OK","phase":"final_answer","itemId":message_id}},
        {"sessionId":"trusted-session","provider":"codex","kind":"context.updated","data":{"used":18637,"window":258400,"model":"model-trusted"}},
        {"sessionId":"trusted-session","provider":"codex","kind":"usage.updated","data":{"source":"result","totalCostUsd":null,"durationMs":150,"usage":{"input_tokens":18632,"output_tokens":5,"cache_read_input_tokens":0}}}
    ]).as_array().unwrap().to_vec());
    let outcomes: Vec<_> = batches.iter().filter_map(|b| b.terminal.as_ref()).collect();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        serde_json::to_value(outcomes[0]).unwrap(),
        json!({"turnId":"turn-local","ok":true,"text":"OK"})
    );
}
#[test]
fn recorded_permission_decline_maps_tool_outcome_without_deciding_permissions() {
    let batches = play("02-permission-decline.jsonl");
    let calls: Vec<_> = batches
        .iter()
        .flat_map(|b| &b.drafts)
        .filter(|d| matches!(d.kind, Kind::ToolCalled | Kind::ToolFinished))
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].data["name"], "commandExecution");
    assert!(
        calls[0].data["input"]["command"]
            .as_str()
            .unwrap()
            .contains("echo hi > x.txt")
    );
    assert_eq!(calls[1].data["isError"], true);
    assert_eq!(calls[1].data["status"], "declined");
    assert_eq!(calls[1].data["exitCode"], Value::Null);
    assert!(batches.iter().find_map(|b| b.terminal.as_ref()).unwrap().ok);
}
#[test]
fn unicode_partial_stream_and_completed_items_are_not_double_counted() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    for text in ["При", "вет ", "👩🏽‍💻"] {
        let batch = push(
            &mut normalizer,
            &callback,
            "item/agentMessage/delta",
            json!({"itemId":"message","delta":text}),
        );
        assert_eq!(batch.drafts[0].data["text"], text);
    }
    let item = json!({"item":{"type":"agentMessage","id":"message","text":"Привет 👩🏽‍💻","phase":"commentary"}});
    assert_eq!(
        push(&mut normalizer, &callback, "item/completed", item.clone()).drafts[0].data["phase"],
        "commentary"
    );
    assert!(push(&mut normalizer, &callback, "item/completed", item).ignored);
    assert!(
        push(
            &mut normalizer,
            &callback,
            "item/agentMessage/delta",
            json!({"itemId":"message","delta":"late"})
        )
        .ignored
    );
    push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"agentMessage","id":"second","text":"вторая"}}),
    );
    let terminal = push(
        &mut normalizer,
        &callback,
        "turn/completed",
        json!({"turn":{"id":"turn-provider","status":"completed","items":[{"text":"WRONG"}]}}),
    )
    .terminal
    .unwrap();
    assert_eq!(terminal.text.as_deref(), Some("Привет 👩🏽‍💻\nвторая"));
    assert!(
        push(
            &mut normalizer,
            &callback,
            "turn/completed",
            json!({"turn":{"id":"turn-provider","status":"completed"}})
        )
        .ignored
    );
}
#[test]
fn trusted_ticket_generation_thread_and_turn_all_gate_callbacks() {
    let calls = Arc::new(AtomicUsize::new(0));
    struct Count(Arc<AtomicUsize>);
    impl Redactor for Count {
        fn redact(&mut self, v: &Value) -> Result<Value, RedactionError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(v.clone())
        }
    }
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Count(calls.clone())));
    let stale = TrustedCallback {
        generation: callback.generation + 1,
        ticket: callback.ticket.clone(),
    };
    assert!(
        normalizer
            .push(
                &stale,
                "item/agentMessage/delta",
                &p(json!({"delta":"wrong"})),
                200
            )
            .ignored
    );
    let other = binding("thread", "turn-provider");
    let stale = TrustedCallback {
        generation: 7,
        ticket: other.ticket,
    };
    assert!(
        normalizer
            .push(
                &stale,
                "item/agentMessage/delta",
                &p(json!({"delta":"wrong"})),
                200
            )
            .ignored
    );
    for (thread, turn) in [("foreign", "turn-provider"), ("thread", "old-turn")] {
        assert!(normalizer.push(&callback,"item/agentMessage/delta",&json!({"threadId":thread,"turnId":turn,"delta":"wrong","sessionId":"trusted-session","generation":7}),200).ignored);
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
    let batch = push(
        &mut normalizer,
        &callback,
        "item/agentMessage/delta",
        json!({"delta":"right","sessionId":"attacker","ticket":"spoof"}),
    );
    assert_eq!(batch.drafts[0].session_id, "trusted-session");
}
#[test]
fn unknown_notifications_and_private_reasoning_are_not_journaled() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    for method in [
        "brand/new",
        "account/updated",
        "item/reasoning/textDelta",
        "item/fileChange/outputDelta",
    ] {
        let b = push(
            &mut normalizer,
            &callback,
            method,
            json!({"delta":"PRIVATE"}),
        );
        assert!(b.ignored);
        assert!(b.drafts.is_empty());
    }
    let b = push(
        &mut normalizer,
        &callback,
        "item/reasoning/summaryTextDelta",
        json!({"delta":"summary"}),
    );
    assert!(b.drafts.is_empty());
    assert!(matches!(&b.live[0],Live::Reasoning(s) if s=="summary"));
    let b = push(
        &mut normalizer,
        &callback,
        "item/commandExecution/outputDelta",
        json!({"delta":"PRIVATE"}),
    );
    assert!(b.drafts.is_empty());
    assert!(matches!(b.live[0], Live::Output));
}
#[test]
fn tool_mappings_preserve_node_public_fields_and_hide_terminal_output() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    let call = push(
        &mut normalizer,
        &callback,
        "item/started",
        json!({"item":{"type":"commandExecution","id":"cmd","command":"echo safe","cwd":"/project","aggregatedOutput":"HIDDEN"}}),
    );
    assert_eq!(
        call.drafts[0].data,
        json!({"toolUseId":"cmd","name":"commandExecution","input":{"command":"echo safe","cwd":"/project"}})
    );
    assert!(
        push(
            &mut normalizer,
            &callback,
            "item/started",
            json!({"item":{"type":"commandExecution","id":"cmd"}})
        )
        .ignored
    );
    let done = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"commandExecution","id":"cmd","status":"completed","exitCode":0,"aggregatedOutput":"HIDDEN"}}),
    );
    assert_eq!(
        done.drafts[0].data,
        json!({"toolUseId":"cmd","name":"commandExecution","isError":false,"status":"completed","exitCode":0})
    );
    assert!(
        push(
            &mut normalizer,
            &callback,
            "item/completed",
            json!({"item":{"type":"commandExecution","id":"cmd"}})
        )
        .ignored
    );
    let call = push(
        &mut normalizer,
        &callback,
        "item/started",
        json!({"item":{"type":"collabAgentToolCall","id":"wait","tool":"wait","senderThreadId":"sender","receiverThreadIds":["child"],"prompt":null}}),
    );
    assert_eq!(
        call.drafts[0].data,
        json!({"toolUseId":"wait","name":"wait","input":{"senderThreadId":"sender","receiverThreadIds":["child"],"prompt":null}})
    );
    let generic = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"fileChange","id":"file","status":"failed","changes":"PRIVATE"}}),
    );
    assert_eq!(
        generic.drafts[0].data,
        json!({"toolUseId":"file","name":"fileChange","isError":true,"status":"failed"})
    );
}
#[test]
fn mcp_content_strips_blobs_and_error_overrides_result() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    let done = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"mcpToolCall","id":"mcp","server":"browser","tool":"shot","status":"completed","result":{"content":[{"type":"image","data":"A".repeat(1024)},{"type":"text","text":"ok"}]}}}),
    );
    assert_eq!(
        done.drafts[0].data,
        json!({"toolUseId":"mcp","name":"mcp__browser__shot","isError":false,"status":"completed","content":[{"type":"text","text":"[изображение, 1 КБ]"},{"type":"text","text":"ok"}]})
    );
    let done = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"mcpToolCall","id":"error","status":"completed","result":{"content":"must disappear"},"error":{"message":"failed explicitly"}}}),
    );
    assert_eq!(
        done.drafts[0].data,
        json!({"toolUseId":"error","name":"mcp__mcp__tool","isError":true,"status":"completed","content":"failed explicitly"})
    );
}
#[test]
fn context_dedupes_but_result_usage_sums_each_last_observation_like_node() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    let usage = json!({"tokenUsage":{"last":{"inputTokens":10,"outputTokens":3,"cachedInputTokens":2,"totalTokens":13,"reasoningOutputTokens":1},"modelContextWindow":100}});
    assert_eq!(
        push(
            &mut normalizer,
            &callback,
            "thread/tokenUsage/updated",
            usage.clone()
        )
        .drafts[0]
            .data,
        json!({"used":12,"window":100,"model":"model-trusted"})
    );
    assert!(
        push(
            &mut normalizer,
            &callback,
            "thread/tokenUsage/updated",
            usage
        )
        .drafts
        .is_empty()
    );
    push(
        &mut normalizer,
        &callback,
        "model/rerouted",
        json!({"toModel":"new-model"}),
    );
    let updated = push(
        &mut normalizer,
        &callback,
        "thread/tokenUsage/updated",
        json!({"tokenUsage":{"last":{"totalTokens":14}}}),
    );
    assert_eq!(
        updated.drafts[0].data,
        json!({"used":14,"window":null,"model":"new-model"})
    );
    let done = push(
        &mut normalizer,
        &callback,
        "turn/completed",
        json!({"turn":{"id":"turn-provider","status":"completed"}}),
    );
    assert_eq!(
        done.drafts[0].data["usage"],
        json!({"input_tokens":20,"output_tokens":6,"cache_read_input_tokens":4})
    );
}
#[test]
fn interrupted_and_unauthorized_outcomes_have_exact_status_contract() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    let done = push(
        &mut normalizer,
        &callback,
        "turn/completed",
        json!({"turn":{"id":"turn-provider","status":"interrupted","error":{"message":"сервер остановил"}}}),
    );
    assert_eq!(done.drafts.len(), 1);
    assert_eq!(done.drafts[0].kind, Kind::UsageUpdated);
    assert_eq!(
        serde_json::to_value(done.terminal.unwrap()).unwrap(),
        json!({"turnId":"turn-local","ok":false,"errorCode":"interrupted","message":"ход turn-local прерван: сервер остановил"})
    );
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    let done = push(
        &mut normalizer,
        &callback,
        "error",
        json!({"willRetry":false,"error":{"message":"login required","codexErrorInfo":"unauthorized"}}),
    );
    assert_eq!(
        done.terminal.unwrap().error_code,
        Some(OutcomeCode::ProviderUnavailable)
    );
    assert_eq!(done.drafts.len(), 1); // Driver writes final status after cleanup.
}
#[test]
fn recorded_limit_is_terminal_once_and_retry_storm_is_only_a_policy_signal() {
    let batches = play("08-usage-limit-error.jsonl");
    let done: Vec<_> = batches.iter().filter_map(|b| b.terminal.as_ref()).collect();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].error_code, Some(OutcomeCode::Limited));
    let kinds: Vec<_> = batches
        .iter()
        .flat_map(|b| &b.drafts)
        .map(|d| d.kind)
        .collect();
    assert_eq!(kinds, vec![Kind::LimitHit, Kind::UsageUpdated]);
    let batches = play("05-error-retry-storm.jsonl");
    assert!(batches.iter().all(|b| b.terminal.is_none()));
    assert!(
        batches
            .iter()
            .flat_map(|b| &b.signals)
            .any(|s| matches!(s,Signal::Retry{message,..} if message.contains("Reconnecting")))
    );
}
struct Mask;
impl Redactor for Mask {
    fn redact(&mut self, v: &Value) -> Result<Value, RedactionError> {
        fn mask(v: &Value) -> Value {
            match v {
                Value::String(s) => json!(s.replace("SECRET", "<redacted>")),
                Value::Array(a) => Value::Array(a.iter().map(mask).collect()),
                Value::Object(o) => Value::Object(
                    o.iter()
                        .map(|(k, v)| {
                            (
                                k.clone(),
                                if k == "token" {
                                    json!("<redacted>")
                                } else {
                                    mask(v)
                                },
                            )
                        })
                        .collect(),
                ),
                _ => v.clone(),
            }
        }
        Ok(mask(v))
    }
}
#[test]
fn redaction_is_mandatory_for_text_tools_live_and_terminal_content() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Mask));
    let b = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"agentMessage","id":"msg","text":"SECRET","questions":[{"title":"SECRET?","options":["SECRET"]}]}}),
    );
    assert!(!serde_json::to_string(&b.drafts).unwrap().contains("SECRET"));
    let b = push(
        &mut normalizer,
        &callback,
        "item/started",
        json!({"item":{"type":"mcpToolCall","id":"mcp","arguments":{"token":"SECRET"}}}),
    );
    assert!(!serde_json::to_string(&b.drafts).unwrap().contains("SECRET"));
    let b = push(
        &mut normalizer,
        &callback,
        "item/reasoning/summaryTextDelta",
        json!({"delta":"SECRET"}),
    );
    assert!(matches!(&b.live[0],Live::Reasoning(s) if s=="<redacted>"));
    let b = push(
        &mut normalizer,
        &callback,
        "turn/completed",
        json!({"turn":{"id":"turn-provider","status":"failed","error":{"message":"SECRET failure"}}}),
    );
    assert!(
        !serde_json::to_string(&b.terminal.unwrap())
            .unwrap()
            .contains("SECRET")
    );
}
#[test]
fn redaction_failure_never_falls_back_to_raw_and_returns_single_static_failure() {
    struct Refuse;
    impl Redactor for Refuse {
        fn redact(&mut self, _: &Value) -> Result<Value, RedactionError> {
            Err(RedactionError)
        }
    }
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Refuse));
    let b = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"agentMessage","id":"msg","text":"SECRET"}}),
    );
    assert_eq!(b.fault, Some(Error::Redaction));
    assert!(b.drafts.is_empty());
    assert!(
        !serde_json::to_string(&b.terminal.unwrap())
            .unwrap()
            .contains("SECRET")
    );
    assert!(
        push(
            &mut normalizer,
            &callback,
            "turn/completed",
            json!({"turn":{"id":"turn-provider","status":"completed"}})
        )
        .terminal
        .is_none()
    );
}
#[test]
fn bounded_state_and_oversized_payloads_fail_closed_without_losing_terminal() {
    for limits in [
        Limits {
            completed: 1,
            ..Limits::default()
        },
        Limits {
            text_bytes: 1,
            ..Limits::default()
        },
        Limits {
            tools: 1,
            ..Limits::default()
        },
        Limits {
            input_bytes: 1,
            ..Limits::default()
        },
    ] {
        let (mut normalizer, callback) = setup(limits, Box::new(Identity));
        let first = if limits.tools == 1 {
            "item/started"
        } else {
            "item/completed"
        };
        let kind = if limits.tools == 1 {
            "commandExecution"
        } else {
            "agentMessage"
        };
        let one = push(
            &mut normalizer,
            &callback,
            first,
            json!({"item":{"type":kind,"id":"one","text":"long"}}),
        );
        let fault = if one.fault.is_some() {
            one
        } else {
            push(
                &mut normalizer,
                &callback,
                first,
                json!({"item":{"type":kind,"id":"two","text":"long"}}),
            )
        };
        assert_eq!(fault.fault, Some(Error::Capacity));
        assert!(fault.terminal.is_some());
        assert!(fault.drafts.is_empty());
        assert!(
            push(
                &mut normalizer,
                &callback,
                "turn/completed",
                json!({"turn":{"id":"turn-provider","status":"completed"}})
            )
            .terminal
            .is_none()
        );
    }
    let limits = Limits {
        completed: usize::MAX,
        ..Limits::default()
    };
    assert!(matches!(
        Normalizer::new(
            binding("thread", "turn-provider"),
            limits,
            Box::new(Identity)
        ),
        Err(Error::Invalid)
    ));
}
#[test]
fn capacity_error_is_deferred_only_before_visible_work_and_final_message_is_not_silently_lost() {
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
    let capacity = push(
        &mut normalizer,
        &callback,
        "error",
        json!({"willRetry":false,"error":{"message":"Selected model is at capacity"}}),
    );
    assert!(capacity.terminal.is_none());
    assert!(matches!(&capacity.signals[0], Signal::Capacity(_)));
    let done = push(
        &mut normalizer,
        &callback,
        "turn/completed",
        json!({"turn":{"id":"turn-provider","status":"failed","error":null}}),
    );
    assert_eq!(
        done.terminal.unwrap().message.as_deref(),
        Some("Selected model is at capacity")
    );
}

#[test]
fn panicking_redactor_after_healthy_output_closes_with_one_static_terminal_failure() {
    pult_core::panic_guard::install();
    struct PanicAfterOne(usize);
    impl Redactor for PanicAfterOne {
        fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
            self.0 += 1;
            if self.0 > 1 {
                panic!("SECRET callback panic payload");
            }
            Ok(value.clone())
        }
    }
    let (mut normalizer, callback) = setup(Limits::default(), Box::new(PanicAfterOne(0)));
    let healthy = push(
        &mut normalizer,
        &callback,
        "item/agentMessage/delta",
        json!({"delta":"healthy","itemId":"message"}),
    );
    assert_eq!(healthy.drafts[0].data["text"], "healthy");
    assert!(healthy.terminal.is_none());
    let failed = push(
        &mut normalizer,
        &callback,
        "item/completed",
        json!({"item":{"type":"agentMessage","id":"message","text":"SECRET final text"}}),
    );
    assert_eq!(failed.fault, Some(Error::Redaction));
    assert!(failed.drafts.is_empty());
    assert!(failed.live.is_empty());
    assert!(failed.signals.is_empty());
    assert_eq!(
        serde_json::to_value(failed.terminal.unwrap()).unwrap(),
        json!({"turnId":"turn-local","ok":false,"errorCode":"internal","message":"Codex event redaction failed"})
    );
    let late = push(
        &mut normalizer,
        &callback,
        "turn/completed",
        json!({"turn":{"id":"turn-provider","status":"completed"}}),
    );
    assert!(late.ignored);
    assert!(late.terminal.is_none());
    assert!(late.drafts.is_empty());
}

#[test]
fn structured_questions_use_javascript_whitespace_for_titles_and_options() {
    for (title, option, retained) in [
        ("\u{feff}", "ok", false),
        ("ok", "\u{feff}", false),
        ("\u{0085}", "ok", true),
        ("ok", "\u{0085}", true),
    ] {
        let (mut normalizer, callback) = setup(Limits::default(), Box::new(Identity));
        let batch = push(
            &mut normalizer,
            &callback,
            "item/completed",
            json!({"item":{"type":"agentMessage","id":"message","text":"body","questions":[{"title":title,"options":[option]}]}}),
        );
        assert_eq!(batch.drafts[0].data.get("questions").is_some(), retained);
    }
}
