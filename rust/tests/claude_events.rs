//! Ordinary Claude mapper fixtures and actual built Node 24 mapper oracle.
//! No Claude process, account, provider request or network connection is used.
use pult_core::claude_events::*;
use pult_core::turn_coordinator::{Coordinator, Limits as CoordinatorLimits};
use pult_core::turn_snapshot::{Provider, SessionKey, TurnSettings, TurnSnapshot};
use serde_json::{Value, json};
use std::process::Stdio;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
fn binding(sid: &str, input: &str) -> Binding {
    let session = SessionKey {
        name: "trusted".into(),
        created_at: "2026-11-12T00:00:00Z".into(),
    };
    let mut core = Coordinator::new(CoordinatorLimits::default()).unwrap();
    let ticket = core
        .reserve(TurnSnapshot {
            key: session.clone(),
            provider: Provider::Claude,
            cwd: "/project".into(),
            settings: TurnSettings::default(),
        })
        .unwrap();
    Binding {
        session,
        ticket,
        generation: 7,
        provider_session_id: sid.into(),
        public_turn_id: "local-turn".into(),
        user_message_uuid: input.into(),
        session_started: false,
    }
}
fn setup(limits: Limits) -> (Normalizer, TrustedCallback) {
    let b = binding("native-session", "input-uuid");
    let c = TrustedCallback {
        generation: b.generation,
        ticket: b.ticket.clone(),
    };
    (
        Normalizer::new(b, limits, Box::new(LogRedactor)).unwrap(),
        c,
    )
}
fn frame(mut value: Value) -> Value {
    value["session_id"] = json!("native-session");
    value
}
fn push(n: &mut Normalizer, c: &TrustedCallback, value: Value) -> Batch {
    n.push(c, &frame(value))
}
fn drafts(batch: &Batch) -> Value {
    serde_json::to_value(&batch.drafts).unwrap()
}
fn assistant(text: &str) -> Value {
    json!({"type":"assistant","message":{"model":"model-A","content":[{"type":"text","text":text}]}})
}
fn result(text: &str) -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":text,"user_message_uuids":["input-uuid"]})
}
fn fixture(name: &str) -> Vec<Value> {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/claude")
            .join(name),
    )
    .unwrap()
    .lines()
    .filter_map(|line| serde_json::from_str(line).ok())
    .collect()
}
fn node_oracle(frames: &[Value]) -> Value {
    const SCRIPT: &str = r#"
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
(async () => {
 if (!process.version.startsWith('v24.')) throw new Error('Claude oracle requires Node 24');
 const {createClaudeMapper} = await import(pathToFileURL(process.argv[1]).href);
 const frames = JSON.parse(fs.readFileSync(0, 'utf8'));
 const mapper = createClaudeMapper({sessionId: 'trusted'});
 const output = JSON.stringify(frames.map(frame => mapper.push(frame).drafts));
 if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error('oracle output budget');
 process.stdout.write(output);
})().catch(() => {process.stderr.write('build the actual Node Claude mapper with Node24 tsc -p tsconfig.json');process.exitCode=1;});
"#;
    let corpus = serde_json::to_vec(frames).unwrap();
    assert!(corpus.len() <= 2 * 1024 * 1024);
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/adapters/claude/mapper.js");
    let output = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut child = Command::new("node")
                .arg("-e")
                .arg(SCRIPT)
                .arg(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .expect("Node24 mapper oracle");
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut input = child.stdin.take().unwrap();
                input.write_all(&corpus).await.unwrap();
                input.shutdown().await.unwrap();
                drop(input);
                child.wait_with_output().await.unwrap()
            })
            .await
            .expect("Claude Node oracle 10s watchdog")
        });
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn recorded_ordinary_streams_match_actual_node_mapper_drafts() {
    for name in [
        "01-simple-turn.jsonl",
        "04-permission-deny-allow.jsonl",
        "05-permission-bash-deny.jsonl",
        "08-not-logged-in.jsonl",
        "09-account-region-block.jsonl",
        "10-resume-no-conversation.jsonl",
    ] {
        // Historical captures may contain several user turns; this owned
        // normalizer ends at the first result, like a single Driver worker.
        let mut frames = fixture(name);
        if let Some(last) = frames.iter().position(|v| v["type"] == "result") {
            frames.truncate(last + 1);
        }
        let sid = frames
            .iter()
            .find_map(|v| v["session_id"].as_str())
            .unwrap();
        let b = binding(sid, "input-uuid");
        let c = TrustedCallback {
            generation: 7,
            ticket: b.ticket.clone(),
        };
        let mut n = Normalizer::new(b, Limits::default(), Box::new(LogRedactor)).unwrap();
        let oracle = node_oracle(&frames);
        for (i, event) in frames.iter().enumerate() {
            let batch = n.push(&c, event);
            assert!(batch.fault.is_none(), "{name} frame{i}");
            assert_eq!(drafts(&batch), oracle[i], "{name} frame{i}");
            assert!(
                batch
                    .drafts
                    .iter()
                    .all(|d| serde_json::to_value(d).unwrap()["kind"] != "status.changed")
            );
        }
    }
}
#[test]
fn synthetic_ordinary_tool_context_and_limit_shapes_match_node() {
    let frames = vec![
        frame(
            json!({"type":"system","subtype":"init","model":"model-A","cwd":"/project","mcp_servers":null}),
        ),
        frame(
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"mail@test.invalid"}}}),
        ),
        frame(
            json!({"type":"assistant","message":{"model":"model-A","usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":4},"content":[{"type":"text","text":"sk-proj-ZZZZZZZZZZZZZZZZ"},{"type":"tool_use","id":"tool-one","name":"Bash","input":{"command":"echo mail@test.invalid","API_TOKEN":"fake"}}]}}),
        ),
        frame(
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-one","is_error":true,"content":[{"type":"image","data":"Z".repeat(32)}]}]}}),
        ),
        frame(
            json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","unifiedWindows":{"five_hour":{"utilization":0.75,"resetsAt":123}}}}),
        ),
        frame(
            json!({"type":"result","is_error":false,"terminal_reason":"completed","result":"done","usage":{"input_tokens":10,"output_tokens":2},"modelUsage":{"model-A":{"contextWindow":200000}},"permission_denials":[null,{"tool_name":"Bash","tool_use_id":"tool-one","tool_input":{"secret":"fake"}},{"tool_name":"Read"}] }),
        ),
    ];
    let expected = node_oracle(&frames);
    let (mut n, c) = setup(Limits::default());
    for (index, event) in frames.iter().enumerate() {
        let batch = n.push(&c, event);
        assert!(batch.fault.is_none());
        assert_eq!(drafts(&batch), expected[index], "frame{index}");
    }
}
#[test]
fn trusted_ticket_generation_session_guards_precede_all_callbacks() {
    struct Counter(Arc<AtomicUsize>);
    impl Redactor for Counter {
        fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(value.clone())
        }
    }
    let b = binding("native-session", "input-uuid");
    let calls = Arc::new(AtomicUsize::new(0));
    let correct = TrustedCallback {
        generation: 7,
        ticket: b.ticket.clone(),
    };
    let wrong = binding("native-session", "input-uuid");
    let mut n = Normalizer::new(b, Limits::default(), Box::new(Counter(calls.clone()))).unwrap();
    for callback in [
        TrustedCallback {
            generation: 8,
            ticket: correct.ticket.clone(),
        },
        TrustedCallback {
            generation: 7,
            ticket: wrong.ticket,
        },
    ] {
        assert!(n.push(&callback, &frame(assistant("private"))).ignored);
    }
    assert!(n.push(&correct,&json!({"session_id":"other","type":"assistant","message":{"content":[{"type":"text","text":"private"}]}})).ignored);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!n.push(&correct, &frame(assistant("visible"))).ignored);
    assert!(calls.load(Ordering::SeqCst) > 0);
}
#[test]
fn result_ok_ignores_subtype_and_error_fallback_is_not_blank() {
    let (mut n, c) = setup(Limits::default());
    let batch = push(
        &mut n,
        &c,
        json!({"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","result":"login failed"}),
    );
    let terminal = batch.terminal.unwrap();
    assert!(!terminal.ok);
    assert_eq!(terminal.error_code, Some(OutcomeCode::ProviderUnavailable));
    assert_eq!(terminal.message.as_deref(), Some("login failed"));
    let (mut n, c) = setup(Limits::default());
    let batch = push(
        &mut n,
        &c,
        json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["No conversation found with session ID: synthetic",5,"retry later"]}),
    );
    assert_eq!(
        batch.terminal.unwrap().message.as_deref(),
        Some("No conversation found with session ID: synthetic; retry later")
    );
    let (mut n, c) = setup(Limits::default());
    let batch = push(
        &mut n,
        &c,
        json!({"type":"result","subtype":"failure-looking","is_error":false,"result":"ok"}),
    );
    assert!(batch.terminal.unwrap().ok);
}
#[test]
fn foreign_results_after_uuid_ack_never_close_the_owned_turn() {
    let (mut n, c) = setup(Limits::default());
    push(
        &mut n,
        &c,
        json!({"type":"command_lifecycle","command_uuid":"input-uuid","state":"queued"}),
    );
    for event in [
        json!({"type":"result","is_error":false,"num_turns":0,"result":""}),
        json!({"type":"result","result":"foreign","user_message_uuids":["other"]}),
    ] {
        let batch = push(&mut n, &c, event);
        assert!(batch.terminal.is_none());
        assert!(batch.drafts.is_empty());
        assert!(matches!(
            batch.signals[0],
            Signal::Deferred(Deferred::ForeignResult)
        ));
    }
    assert!(
        push(&mut n, &c, result("actual answer"))
            .terminal
            .unwrap()
            .ok
    );
    assert!(push(&mut n, &c, result("late duplicate")).ignored);
}
#[test]
fn untagged_background_notice_drain_is_deferred_but_tagged_zero_turn_command_finishes() {
    let (mut n, c) = setup(Limits::default());
    push(
        &mut n,
        &c,
        json!({"type":"system","subtype":"task_notification","status":"completed"}),
    );
    let batch = push(
        &mut n,
        &c,
        json!({"type":"result","num_turns":0,"is_error":false,"result":""}),
    );
    assert!(batch.terminal.is_none());
    assert!(matches!(
        batch.signals[0],
        Signal::Deferred(Deferred::ForeignResult)
    ));
    let mut local = result("cost summary");
    local["num_turns"] = json!(0);
    assert_eq!(
        push(&mut n, &c, local).terminal.unwrap().text.as_deref(),
        Some("cost summary")
    );
}
#[test]
fn subagents_and_background_are_explicitly_deferred_without_fake_tree_or_root_text() {
    let (mut n, c) = setup(Limits::default());
    let mut child = assistant("child secret text");
    child["parent_tool_use_id"] = json!("parent-tool");
    let batch = push(&mut n, &c, child);
    assert!(batch.drafts.is_empty());
    assert!(matches!(
        batch.signals[0],
        Signal::Deferred(Deferred::Subagent)
    ));
    let batch = push(
        &mut n,
        &c,
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-id","name":"Agent","input":{"prompt":"private"}}]}}),
    );
    assert!(batch.drafts.is_empty());
    assert!(matches!(
        batch.signals[0],
        Signal::Deferred(Deferred::Subagent)
    ));
    let batch = push(
        &mut n,
        &c,
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-id","content":"Async agent launched"}]}}),
    );
    assert!(batch.drafts.is_empty());
    let batch = push(
        &mut n,
        &c,
        json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"description":"private"}]}),
    );
    assert!(batch.drafts.is_empty());
    assert!(matches!(
        batch.signals[0],
        Signal::Deferred(Deferred::Background)
    ));
}
#[test]
fn rate_limit_allowed_warning_is_not_terminal_and_rejected_is_a_signal() {
    let (mut n, c) = setup(Limits::default());
    for (status, limited) in [
        ("allowed", false),
        ("allowed_warning", false),
        ("rejected", true),
        ("new-status", true),
    ] {
        let batch = push(
            &mut n,
            &c,
            json!({"type":"rate_limit_event","rate_limit_info":{"status":status}}),
        );
        assert!(batch.terminal.is_none());
        assert_eq!(batch.drafts.len(), if limited { 2 } else { 1 });
        assert_eq!(batch.signals.len(), usize::from(limited));
    }
    assert!(push(&mut n, &c, result("done")).terminal.unwrap().ok);
}
#[test]
fn retries_reset_on_content_and_storm_signal_is_bounded_and_redacted() {
    let (mut n, c) = setup(Limits::default());
    let retry = json!({"type":"system","subtype":"api_retry","error":{"API_TOKEN":"fake","message":"a@host.test"}});
    assert!(push(&mut n, &c, retry.clone()).signals.is_empty());
    assert!(push(&mut n, &c, retry.clone()).signals.is_empty());
    push(&mut n, &c, assistant("transport alive"));
    assert!(push(&mut n, &c, retry.clone()).signals.is_empty());
    push(&mut n, &c, retry.clone());
    let batch = push(&mut n, &c, retry);
    let Signal::RetryStorm {
        retries,
        last_error,
    } = &batch.signals[0]
    else {
        panic!("retry signal")
    };
    assert_eq!(*retries, 3);
    assert_eq!(last_error["API_TOKEN"], "<redacted>");
    assert_eq!(last_error["message"], "a@host.test");
    assert!(batch.terminal.is_none());
}
#[test]
fn account_block_phrase_only_matters_inside_error_envelopes() {
    let (mut n, c) = setup(Limits::default());
    let phrase = "disabled Claude subscription access a@host.test";
    let normal = push(&mut n, &c, assistant(phrase));
    assert!(normal.signals.is_empty());
    let mut error = assistant(phrase);
    error["is_api_error_message"] = json!(true);
    let blocked = push(&mut n, &c, error);
    assert!(
        matches!(&blocked.signals[0],Signal::ProviderBlocked {text} if text.ends_with("a@host.test"))
    );
    let (mut n, c) = setup(Limits::default());
    let mut successful = result(phrase);
    successful["is_error"] = json!(false);
    assert!(push(&mut n, &c, successful).signals.is_empty());
}
#[test]
fn context_uses_last_prompt_and_model_window_not_result_token_totals() {
    let (mut n, c) = setup(Limits::default());
    let event = json!({"type":"assistant","message":{"model":"model-A","usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":4},"content":[]}});
    let first = push(&mut n, &c, event.clone());
    assert_eq!(
        first.drafts[0].data,
        json!({"used":17,"window":null,"model":"model-A"})
    );
    assert!(push(&mut n, &c, event).drafts.is_empty());
    let mut done = result("ok");
    done["usage"] = json!({"input_tokens":999,"output_tokens":30});
    done["modelUsage"] =
        json!({"other":{"contextWindow":50000},"model-A":{"contextWindow":200000}});
    let batch = push(&mut n, &c, done);
    assert_eq!(batch.drafts[0].data["usage"]["input_tokens"], 999);
    assert_eq!(
        batch.drafts[1].data,
        json!({"used":17,"window":200000,"model":"model-A"})
    );
}
#[test]
fn init_dedup_and_unknown_noise_do_not_reset_or_finish_the_turn() {
    let (mut n, c) = setup(Limits::default());
    let init = json!({"type":"system","subtype":"init","tools":["A","B"],"model":"model-A"});
    assert_eq!(push(&mut n, &c, init.clone()).drafts.len(), 1);
    assert!(push(&mut n, &c, init).drafts.is_empty());
    for event in [
        json!({"type":"future_message","secret":"hidden"}),
        json!({"type":"system","subtype":"status"}),
        json!({"type":"stream_event","event":{"type":"message_stop"}}),
    ] {
        assert!(push(&mut n, &c, event).ignored);
    }
    assert!(push(&mut n, &c, result("ok")).terminal.is_some());
}
#[test]
fn live_reasoning_is_redacted_and_no_error_or_thinking_text_leaks() {
    let (mut n, c) = setup(Limits::default());
    let batch = push(
        &mut n,
        &c,
        json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Bearer ZZZZZZZZZZZZZZZZ"}}}),
    );
    assert!(batch.drafts.is_empty());
    assert!(matches!(&batch.live[0],Live::Reasoning(text) if text=="<token>"));
}
#[test]
fn callback_failure_or_panic_discards_the_entire_batch_and_returns_one_static_terminal() {
    struct Refuse {
        calls: usize,
        panic: bool,
    }
    impl Redactor for Refuse {
        fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
            self.calls += 1;
            if self.calls > 1 {
                if self.panic {
                    panic!("PRIVATE callback panic");
                }
                return Err(RedactionError);
            }
            Ok(value.clone())
        }
    }
    pult_core::panic_guard::install();
    for panic in [false, true] {
        let b = binding("native-session", "input-uuid");
        let c = TrustedCallback {
            generation: 7,
            ticket: b.ticket.clone(),
        };
        let mut n =
            Normalizer::new(b, Limits::default(), Box::new(Refuse { calls: 0, panic })).unwrap();
        let batch = push(
            &mut n,
            &c,
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"first"},{"type":"text","text":"PRIVATE second"}]}}),
        );
        assert_eq!(batch.fault, Some(Error::Redaction));
        assert!(batch.drafts.is_empty());
        assert!(batch.live.is_empty());
        assert!(batch.signals.is_empty());
        let terminal = serde_json::to_value(batch.terminal.unwrap()).unwrap();
        assert!(!terminal.to_string().contains("PRIVATE"));
        assert!(push(&mut n, &c, result("late")).ignored);
    }
}
#[test]
fn text_uses_utf16_units_and_batch_and_tool_state_are_bounded() {
    let (mut n, c) = setup(Limits {
        text_units: 2,
        ..Limits::default()
    });
    let mut one = assistant("🌊");
    one["message"].as_object_mut().unwrap().remove("model");
    assert!(push(&mut n, &c, one).fault.is_none());
    let mut two = assistant("🌊a");
    two["message"].as_object_mut().unwrap().remove("model");
    assert_eq!(push(&mut n, &c, two).fault, Some(Error::Capacity));
    let (mut n, c) = setup(Limits {
        events: 1,
        ..Limits::default()
    });
    let batch = push(
        &mut n,
        &c,
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"one"},{"type":"text","text":"two"}]}}),
    );
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.drafts.is_empty());
    let (mut n, c) = setup(Limits {
        batch_bytes: 170,
        ..Limits::default()
    });
    let batch = push(
        &mut n,
        &c,
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"x".repeat(20)},{"type":"text","text":"x".repeat(20)}]}}),
    );
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.drafts.is_empty());
    let (mut n, c) = setup(Limits {
        tool_ids: 1,
        ..Limits::default()
    });
    for id in ["one", "two"] {
        let batch = push(
            &mut n,
            &c,
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":id,"name":"Bash","input":{}}]}}),
        );
        if id == "two" {
            assert_eq!(batch.fault, Some(Error::Capacity));
            assert!(batch.drafts.is_empty());
        }
    }
    let (mut n, c) = setup(Limits {
        events: 1,
        ..Limits::default()
    });
    assert!(push(&mut n, &c, json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent","name":"Agent","input":{}}]}})).fault.is_none());
    let repeated = json!({"type":"tool_result","tool_use_id":"agent"});
    let batch = push(
        &mut n,
        &c,
        json!({"type":"user","message":{"content":[repeated.clone(),repeated]}}),
    );
    assert_eq!(batch.fault, Some(Error::Capacity));
    assert!(batch.signals.is_empty());
    let (mut n, c) = setup(Limits {
        input_bytes: 32,
        ..Limits::default()
    });
    assert_eq!(
        push(&mut n, &c, assistant("oversized")).fault,
        Some(Error::Capacity)
    );
}

#[test]
fn opaque_tool_ids_remain_distinct_under_production_redaction_and_match_node() {
    let ids = [
        "0123456789abcdef0123456789abcdef",
        "fedcba9876543210fedcba9876543210",
    ];
    let frames = vec![
        frame(
            json!({"type":"assistant","message":{"content":ids.map(|id|json!({"type":"tool_use","id":id,"name":"Bash","input":{"token":"fake"}}))}}),
        ),
        frame(
            json!({"type":"user","message":{"content":ids.map(|id|json!({"type":"tool_result","tool_use_id":id,"content":"ok"}))}}),
        ),
        frame(
            json!({"type":"result","is_error":false,"permission_denials":ids.map(|id|json!({"tool_name":"Bash","tool_use_id":id,"tool_input":{"token":"fake"}}))}),
        ),
    ];
    let expected = node_oracle(&frames);
    let (mut n, c) = setup(Limits::default());
    for (index, event) in frames.iter().enumerate() {
        let batch = n.push(&c, event);
        assert!(batch.fault.is_none());
        assert_eq!(drafts(&batch), expected[index], "frame{index}");
    }
}

#[test]
fn denial_count_and_expanding_redactor_are_bounded_before_accumulation() {
    struct Expand(Arc<AtomicUsize>);
    impl Redactor for Expand {
        fn redact(&mut self, _: &Value) -> Result<Value, RedactionError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"payload":"x".repeat(4096)}))
        }
    }
    for count_limit in [true, false] {
        let b = binding("native-session", "input-uuid");
        let c = TrustedCallback {
            generation: 7,
            ticket: b.ticket.clone(),
        };
        let count = Arc::new(AtomicUsize::new(0));
        let limits = Limits {
            tool_ids: if count_limit { 2 } else { 256 },
            event_bytes: 8192,
            batch_bytes: 8192,
            ..Limits::default()
        };
        let mut n = Normalizer::new(b, limits, Box::new(Expand(count.clone()))).unwrap();
        let denials = vec![json!({"tool_input":{}}); 32];
        let batch = push(
            &mut n,
            &c,
            json!({"type":"result","is_error":false,"permission_denials":denials}),
        );
        assert_eq!(batch.fault, Some(Error::Capacity));
        assert!(batch.drafts.is_empty());
        assert!(batch.signals.is_empty());
        assert!(batch.terminal.is_some());
        if count_limit {
            assert_eq!(count.load(Ordering::SeqCst), 0);
        } else {
            assert!(count.load(Ordering::SeqCst) <= 2);
        }
    }
}

#[test]
fn ambiguous_model_prefix_windows_are_not_chosen_by_sorted_value_order() {
    for (models, expected) in [
        (
            json!({"model-A[z]":{"contextWindow":200000},"model-A[a]":{"contextWindow":100000}}),
            None,
        ),
        (
            json!({"model-A[z]":{"contextWindow":100000},"model-A[a]":{"contextWindow":100000}}),
            Some(json!(100000)),
        ),
        (
            json!({"model-A":{"contextWindow":50000},"model-A[z]":{"contextWindow":200000},"model-A[a]":{"contextWindow":100000}}),
            Some(json!(50000)),
        ),
        (
            json!({"model-A[z]":{"contextWindow":200000}}),
            Some(json!(200000)),
        ),
    ] {
        let (mut n, c) = setup(Limits::default());
        let initial = push(
            &mut n,
            &c,
            json!({"type":"assistant","message":{"model":"model-A","content":[],"usage":{"input_tokens":9}}}),
        );
        assert!(initial.fault.is_none());
        let mut end = result("done");
        end["modelUsage"] = models;
        let batch = push(&mut n, &c, end);
        assert!(batch.fault.is_none());
        let window = batch
            .drafts
            .iter()
            .find(|d| d.kind == Kind::ContextUpdated)
            .map(|d| d.data["window"].clone());
        assert_eq!(window, expected);
    }
}
