//! Source fixtures and pure permission bridge tests; no provider or RPC process.
use pult_core::codex_permissions::*;
use pult_core::permission_broker::{Decision, Scope};
use pult_core::turn_coordinator::{Coordinator, Limits as CoordinatorLimits};
use pult_core::turn_snapshot::{Provider, SessionKey, TurnSettings, TurnSnapshot};
use serde_json::{Value, json};
const COMMAND: &str = "item/commandExecution/requestApproval";
const FILE: &str = "item/fileChange/requestApproval";
const QUESTION: &str = "item/tool/requestUserInput";
fn owner() -> TrustedOwner {
    static OWNER: std::sync::OnceLock<TrustedOwner> = std::sync::OnceLock::new();
    OWNER
        .get_or_init(|| {
            let session = SessionKey {
                name: "trusted".into(),
                created_at: "2026-11-12T00:00:00Z".into(),
            };
            let mut core = Coordinator::new(CoordinatorLimits::default()).unwrap();
            let ticket = core
                .reserve(TurnSnapshot {
                    key: session.clone(),
                    provider: Provider::Codex,
                    cwd: "/project".into(),
                    settings: TurnSettings::default(),
                })
                .unwrap();
            TrustedOwner {
                session,
                ticket,
                thread_id: "thread".into(),
                provider_turn_id: "turn".into(),
            }
        })
        .clone()
}
fn params() -> Value {
    json!({"threadId":"thread","turnId":"turn","itemId":"item","startedAtMs":100,"command":"echo hello","availableDecisions":["accept","cancel"]})
}
fn prepare_default(method: &str, params: &Value) -> Result<Prepared, Reject> {
    prepare(method, params, owner(), Capabilities::default())
}
fn answer(method: &str, params: &Value, decision: Decision) -> Result<Value, Reject> {
    prepare_default(method, params)?.resolve(&owner(), decision)
}
fn rule_params() -> Value {
    let mut p = params();
    p["proposedExecpolicyAmendment"] = json!(["curl", "https://example.com"]);
    p["availableDecisions"] = json!([{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["curl","https://example.com"]}},"cancel"]);
    p
}
fn rule_enabled(params: &Value) -> Prepared {
    prepare(
        COMMAND,
        params,
        owner(),
        Capabilities {
            persistent_rules: true,
        },
    )
    .unwrap()
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../test/fixtures/codex/11-approval-params-0.163.json"
    ))
    .unwrap()
}
#[test]
fn recorded_command_declines_even_without_offered_decline_and_accepts_once() {
    let fixture = fixture();
    let p = &fixture["command"]["params"];
    let mut owner = owner();
    owner.thread_id = p["threadId"].as_str().unwrap().into();
    owner.provider_turn_id = p["turnId"].as_str().unwrap().into();
    for (decision, expected) in [
        (Decision::deny(), "decline"),
        (Decision::allow(Scope::Once), "accept"),
    ] {
        let prepared = prepare(COMMAND, p, owner.clone(), Capabilities::default()).unwrap();
        assert!(prepared.request().offers.rule.is_none());
        assert_eq!(prepared.request().tool_name, "commandExecution");
        assert_eq!(
            prepared.resolve(&owner, decision).unwrap(),
            json!({"decision":expected})
        );
    }
}
#[test]
fn file_change_and_legacy_vocab_do_not_take_available_decisions_from_params() {
    let fixture = fixture();
    let mut file = fixture["fileChange"]["params"].clone();
    file["threadId"] = json!("thread");
    file["turnId"] = json!("turn");
    file["availableDecisions"] = json!(["cancel"]);
    let request = prepare_default(FILE, &file).unwrap().request();
    assert_eq!(request.tool_name, "fileChange");
    assert_eq!(
        request.input["availableDecisions"],
        json!(["accept", "acceptForSession", "decline", "cancel"])
    );
    assert!(request.offers.session);
    assert_eq!(
        answer(FILE, &file, Decision::allow(Scope::Once)).unwrap(),
        json!({"decision":"accept"})
    );
    assert_eq!(
        answer(FILE, &file, Decision::allow(Scope::Session)).unwrap(),
        json!({"decision":"acceptForSession"})
    );
    for method in ["execCommandApproval", "applyPatchApproval"] {
        let p = json!({"conversationId":"thread","callId":"legacy-call","command":["echo","ok"],"availableDecisions":["abort"]});
        let request = prepare_default(method, &p).unwrap().request();
        assert_eq!(request.tool_use_id.as_deref(), Some("legacy-call"));
        assert_eq!(
            request.input["availableDecisions"],
            json!(["approved", "approved_for_session", "denied", "abort"])
        );
        for (decision, expected) in [
            (Decision::allow(Scope::Once), "approved"),
            (Decision::allow(Scope::Session), "approved_for_session"),
            (Decision::deny(), "denied"),
        ] {
            assert_eq!(
                answer(method, &p, decision).unwrap(),
                json!({"decision":expected})
            );
        }
    }
}
#[test]
fn command_missing_corrupt_or_object_only_available_decisions_never_guess_allow() {
    for available in [
        None,
        Some(Value::Null),
        Some(json!({"accept":true})),
        Some(json!(["cancel"])),
        Some(json!([true,5,"approved",{"accept":true}])),
    ] {
        let mut p = params();
        if let Some(value) = available {
            p["availableDecisions"] = value;
        } else {
            p.as_object_mut().unwrap().remove("availableDecisions");
        }
        assert_eq!(
            answer(COMMAND, &p, Decision::allow(Scope::Once)).unwrap(),
            json!({"decision":"decline"})
        );
        assert_eq!(
            answer(COMMAND, &p, Decision::deny()).unwrap(),
            json!({"decision":"decline"})
        );
        assert_eq!(
            answer(COMMAND, &p, Decision::allow(Scope::Session)),
            Err(Reject::UnofferedScope)
        );
    }
    let p = rule_params();
    assert_eq!(
        rule_enabled(&p)
            .resolve(&owner(), Decision::allow(Scope::Once))
            .unwrap(),
        json!({"decision":"decline"})
    );
}
#[test]
fn session_width_requires_the_exact_native_offered_string() {
    let mut p = params();
    assert_eq!(
        answer(COMMAND, &p, Decision::allow(Scope::Session)),
        Err(Reject::UnofferedScope)
    );
    p["availableDecisions"] = json!(["acceptForSession", "cancel"]);
    assert_eq!(
        answer(COMMAND, &p, Decision::allow(Scope::Session)).unwrap(),
        json!({"decision":"acceptForSession"})
    );
    assert_eq!(
        answer(COMMAND, &p, Decision::allow(Scope::Once)).unwrap(),
        json!({"decision":"decline"})
    );
}
#[test]
fn persistent_capability_is_off_by_default_and_native_object_is_exact() {
    let p = rule_params();
    let prepared = prepare_default(COMMAND, &p).unwrap();
    assert!(prepared.request().offers.rule.is_none());
    assert_eq!(
        prepared.resolve(&owner(), Decision::allow(Scope::Rule)),
        Err(Reject::UnofferedScope)
    );
    let prepared = rule_enabled(&p);
    let request = prepared.request();
    let rule = request.offers.rule.unwrap();
    assert_eq!(rule.label, "curl https://example.com");
    assert_eq!(rule.note, CODEX_EXEC_RULE_NOTE);
    assert_eq!(
        prepared
            .resolve(&owner(), Decision::allow(Scope::Rule))
            .unwrap(),
        json!({"decision":p["availableDecisions"][0]})
    );
}
#[test]
fn exec_rule_requires_exact_matching_nonempty_argv_and_known_union_fields() {
    for candidate in [
        json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["curl"]}}),
        json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["curl","other"]}}),
        json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["curl","https://example.com"],"wider":true}}),
        json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["curl","https://example.com"]},"acceptForSession":true}),
    ] {
        let mut p = rule_params();
        p["availableDecisions"] = json!([candidate]);
        let prepared = rule_enabled(&p);
        assert!(prepared.request().offers.rule.is_none());
        assert_eq!(
            prepared.resolve(&owner(), Decision::allow(Scope::Rule)),
            Err(Reject::UnofferedScope)
        );
    }
    for proposal in [
        Value::Null,
        json!([]),
        json!(["curl", ""]),
        json!(["curl", 5]),
    ] {
        let mut p = rule_params();
        p["proposedExecpolicyAmendment"] = proposal;
        assert!(rule_enabled(&p).request().offers.rule.is_none());
    }
}
#[test]
fn exec_prefix_label_quotes_arguments_like_node_shell_join() {
    let argv = json!(["curl", "hello world", "x'y", "/tmp/файл"]);
    let mut p = params();
    p["proposedExecpolicyAmendment"] = argv.clone();
    p["availableDecisions"] =
        json!([{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":argv}}]);
    assert_eq!(
        rule_enabled(&p).request().offers.rule.unwrap().label,
        "curl 'hello world' 'x'\\''y' '/tmp/файл'"
    );
}
fn network_params() -> Value {
    let mut p = params();
    p["availableDecisions"] = json!([{"applyNetworkPolicyAmendment":{"network_policy_amendment":{"host":"example.com","action":"allow"}}}]);
    p["proposedNetworkPolicyAmendments"] = json!([{"host":"example.com","action":"allow"}]);
    p
}
#[test]
fn network_rule_matches_proposed_allowed_host_and_rejects_broader_unknown_shapes() {
    let p = network_params();
    let prepared = rule_enabled(&p);
    let rule = prepared.request().offers.rule.unwrap();
    assert_eq!(rule.label, "example.com");
    assert_eq!(rule.note, CODEX_NET_RULE_NOTE);
    assert_eq!(
        prepared
            .resolve(&owner(), Decision::allow(Scope::Rule))
            .unwrap(),
        json!({"decision":p["availableDecisions"][0]})
    );
    for (key, value) in [
        ("host", json!("evil.example")),
        ("action", json!("deny")),
        ("unknownAuthority", json!(true)),
    ] {
        let mut p = network_params();
        p["availableDecisions"][0]["applyNetworkPolicyAmendment"]["network_policy_amendment"]
            [key] = value;
        assert!(rule_enabled(&p).request().offers.rule.is_none());
    }
    for proposal in [
        json!([{"host":"example.com","action":"deny"}]),
        json!([]),
        Value::Null,
    ] {
        let mut p = network_params();
        p["proposedNetworkPolicyAmendments"] = proposal;
        assert!(rule_enabled(&p).request().offers.rule.is_none());
    }
}
#[test]
fn exec_rule_precedes_network_regardless_of_candidate_order() {
    let mut p = network_params();
    let exec = rule_params();
    p["proposedExecpolicyAmendment"] = exec["proposedExecpolicyAmendment"].clone();
    p["availableDecisions"]
        .as_array_mut()
        .unwrap()
        .push(exec["availableDecisions"][0].clone());
    assert_eq!(
        rule_enabled(&p).request().offers.rule.unwrap().label,
        "curl https://example.com"
    );
}
#[test]
fn route_and_fresh_owner_are_never_taken_from_untrusted_claims() {
    for (key, value) in [
        ("threadId", json!("foreign")),
        ("turnId", json!("stale")),
        ("threadId", Value::Null),
        ("turnId", Value::Null),
    ] {
        let mut p = params();
        p[key] = value;
        assert!(matches!(
            prepare_default(COMMAND, &p),
            Err(Reject::WrongOwner)
        ));
    }
    for key in ["threadId", "turnId"] {
        let mut p = params();
        p.as_object_mut().unwrap().remove(key);
        assert!(matches!(
            prepare_default(COMMAND, &p),
            Err(Reject::WrongOwner)
        ));
    }
    let mut forged = owner();
    forged.session.name = "other".into();
    assert!(matches!(
        prepare(COMMAND, &params(), forged, Capabilities::default()),
        Err(Reject::WrongOwner)
    ));
    let mut p = params();
    p["sessionId"] = json!("forged");
    p["ticket"] = json!("forged");
    let prepared = prepare_default(COMMAND, &p).unwrap();
    assert_eq!(prepared.request().session_id, "trusted");
    let mut changed = owner();
    changed.provider_turn_id = "later".into();
    assert_eq!(
        prepared.resolve(&changed, Decision::allow(Scope::Once)),
        Err(Reject::WrongOwner)
    );
    let mut core = Coordinator::new(CoordinatorLimits::default()).unwrap();
    let session = owner().session;
    let snapshot = TurnSnapshot {
        key: session.clone(),
        provider: Provider::Codex,
        cwd: "/project".into(),
        settings: TurnSettings::default(),
    };
    let old = core.reserve(snapshot.clone()).unwrap();
    core.request_cancel(&old);
    core.stopped(&old).unwrap();
    let fresh = core.reserve(snapshot).unwrap();
    let mut changed = owner();
    changed.ticket = fresh;
    assert_eq!(
        prepare_default(COMMAND, &params())
            .unwrap()
            .resolve(&changed, Decision::deny()),
        Err(Reject::WrongOwner)
    );
}
#[test]
fn legacy_route_accepts_schema_fields_but_rejects_conflicting_aliases_or_supplied_turn() {
    let mut p = json!({"conversationId":"thread","callId":"call"});
    assert!(prepare_default("execCommandApproval", &p).is_ok());
    p["threadId"] = json!("other");
    assert!(matches!(
        prepare_default("execCommandApproval", &p),
        Err(Reject::WrongOwner)
    ));
    p["threadId"] = json!("thread");
    p["turnId"] = json!("old");
    assert!(matches!(
        prepare_default("execCommandApproval", &p),
        Err(Reject::WrongOwner)
    ));
    p["turnId"] = json!("turn");
    p["itemId"] = json!("different-call");
    assert!(matches!(
        prepare_default("execCommandApproval", &p),
        Err(Reject::Invalid)
    ));
}
#[test]
fn display_preserves_unknown_fields_skips_route_and_caps_text_and_arrays() {
    let mut p = params();
    p["approvalId"] = json!("approval");
    p["unknown"] = json!({"nested":"🌊".repeat(1001)});
    p["array"] = json!((0..43).collect::<Vec<_>>());
    let request = prepare_default(COMMAND, &p).unwrap().request();
    assert!(request.concealed);
    assert_eq!(request.tool_use_id.as_deref(), Some("item:approval"));
    assert!(request.input.get("threadId").is_none());
    assert!(request.input.get("turnId").is_none());
    assert!(request.input.get("startedAtMs").is_none());
    assert_eq!(
        request.input["unknown"]["nested"],
        format!("{}…(обрезано)", "🌊".repeat(1000))
    );
    assert_eq!(request.input["array"].as_array().unwrap().len(), 41);
    assert_eq!(request.input["array"][40], "…(ещё 3)");
    assert_eq!(
        request.input["availableDecisions"],
        json!(["accept", "cancel"])
    );
    let mut p = params();
    p["command"] = json!(format!("{}🌊", "a".repeat(1999)));
    let request = prepare_default(COMMAND, &p).unwrap().request();
    assert!(request.concealed);
    assert_eq!(
        request.input["command"],
        format!("{}�…(обрезано)", "a".repeat(1999))
    );
    assert!(
        !prepare_default(COMMAND, &params())
            .unwrap()
            .request()
            .concealed
    );
}
fn question_params() -> Value {
    json!({"threadId":"thread","turnId":"turn","itemId":"question-item","isBlocking":true,"questions":[{"id":"q","question":"Choose","options":[{"label":"A","description":"A option"}],"isOther":false}],"unknown":"not copied"})
}
fn answer_questions(p: &Value, answers: Option<Value>) -> Result<Value, Reject> {
    answer(
        QUESTION,
        p,
        Decision::Allow {
            scope: Scope::Once,
            updated_input: Some(json!({"not":"an answer"})),
            answers,
        },
    )
}
#[test]
fn question_request_shape_and_answers_match_broker_contract() {
    let p = question_params();
    let request = prepare_default(QUESTION, &p).unwrap().request();
    assert_eq!(request.tool_name, "requestUserInput");
    assert_eq!(request.tool_use_id.as_deref(), Some("question-item"));
    assert_eq!(
        request.input,
        json!({"questions":p["questions"],"isBlocking":true})
    );
    assert!(!request.offers.session);
    assert!(request.offers.rule.is_none());
    assert_eq!(
        answer(QUESTION, &p, Decision::deny()).unwrap(),
        json!({"answers":{}})
    );
    let given = json!({"q":{"answers":["A"]}});
    assert_eq!(
        answer_questions(&p, Some(given.clone())).unwrap(),
        json!({"answers":given})
    );
    for invalid in [
        None,
        Some(json!([])),
        Some(json!({})),
        Some(json!({"q":{"answers":[]}})),
        Some(json!({"q":{"answers":[5]}})),
        Some(json!({"q":{"answers":["\u{feff}"]}})),
        Some(json!({"q":{"answers":["B"]}})),
        Some(json!({"q":{"answers":["A"]},"foreign":{"answers":["A"]}})),
    ] {
        assert_eq!(answer_questions(&p, invalid), Err(Reject::InvalidAnswers));
    }
    let mut p = p;
    p["questions"][0]["isOther"] = json!(true);
    assert!(answer_questions(&p, Some(json!({"q":{"answers":["custom"]}}))).is_ok());
    assert!(answer_questions(&p, Some(json!({"q":{"answers":["\u{0085}"]}}))).is_ok());
}
#[test]
fn malformed_unknown_and_oversized_requests_use_static_fail_closed_errors() {
    for method in [
        "item/permissions/requestApproval",
        "mcpServer/elicitation/request",
        "PRIVATE/unknown",
    ] {
        let error = prepare_default(method, &params()).err().unwrap();
        assert_eq!(error, Reject::Unsupported);
        let wire = error.response_error();
        assert_eq!(wire.code, -32601);
        assert!(!wire.message.contains("PRIVATE"));
    }
    assert!(matches!(
        prepare_default(COMMAND, &json!([])),
        Err(Reject::Invalid)
    ));
    let mut p = params();
    p["large"] = json!("x".repeat(MAX_INPUT_BYTES));
    assert!(matches!(
        prepare_default(COMMAND, &p),
        Err(Reject::Capacity)
    ));
    let mut p = params();
    p.as_object_mut().unwrap().remove("itemId");
    assert!(matches!(prepare_default(COMMAND, &p), Err(Reject::Invalid)));
    let mut p = params();
    p["approvalId"] = json!([]);
    assert!(matches!(prepare_default(COMMAND, &p), Err(Reject::Invalid)));
    let mut p = question_params();
    p["questions"] = json!([{"id":5}]);
    assert!(matches!(
        prepare_default(QUESTION, &p),
        Err(Reject::InvalidAnswers)
    ));
}
#[tokio::test]
async fn prepared_request_crosses_real_broker_redaction_before_publication() {
    use pult_core::permission_broker::{Broker, Options, Redactors};
    use pult_core::turn_driver::{EventSink, Receipt, SinkError, Task};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    };
    struct Sink {
        drafts: Arc<Mutex<Vec<Value>>>,
        seq: AtomicU64,
    }
    impl EventSink for Sink {
        fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
            self.drafts.lock().unwrap().push(draft);
            let id = self.seq.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                Ok(Receipt {
                    id,
                    ts: "2026-11-12T00:00:00Z".into(),
                })
            })
        }
    }
    let drafts = Arc::new(Mutex::new(Vec::new()));
    let broker = Broker::new(
        Arc::new(Sink {
            drafts: drafts.clone(),
            seq: AtomicU64::new(1),
        }),
        Redactors {
            value: Arc::new(|v| {
                serde_json::from_str(&v.to_string().replace("PRIVATE", "[redacted]")).unwrap()
            }),
            string: Arc::new(|s| s.replace("PRIVATE", "[redacted]")),
        },
        Options::default(),
    )
    .unwrap();
    let mut p = params();
    p["command"] = json!("echo PRIVATE");
    let prepared = prepare_default(COMMAND, &p).unwrap();
    let mut handle = broker.request(prepared.request()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while broker.pending_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(broker.list(None)[0]["concealed"], true);
    assert!(!broker.list(None)[0].to_string().contains("PRIVATE"));
    assert!(
        broker
            .resolve(handle.id(), Decision::allow(Scope::Once), "human")
            .unwrap()
            .wait()
            .await
            .unwrap()
    );
    let decision = handle.decision().await;
    assert_eq!(
        prepared.resolve(&owner(), decision).unwrap(),
        json!({"decision":"accept"})
    );
    broker.drain().await;
    assert!(
        drafts
            .lock()
            .unwrap()
            .iter()
            .all(|v| !v.to_string().contains("PRIVATE"))
    );
}

const MCP: &str = "mcpServer/elicitation/request";
fn mcp_params() -> Value {
    json!({"threadId":"thread","serverName":"pult_browser","mode":"form",
        "message":"Allow to run tool \"browser_navigate\"?",
        "_meta":{"codex_approval_kind":"mcp_tool_call","tool_description":"Navigate",
            "tool_params":{"url":"http://x/"},"tool_params_display":"untrusted display"},
        "requestedSchema":{"type":"object","properties":{}}})
}
fn pending(server: &str, tool: &str, arguments: Value) -> McpApprovalContext {
    McpApprovalContext {
        request_id: None,
        pending: Some(PendingMcpCall {
            owner: owner(),
            server: server.into(),
            tool: tool.into(),
            arguments,
        }),
    }
}
#[test]
fn live_mcp_fixture_has_exact_once_only_native_answers() {
    let p = mcp_params();
    let prepared = prepare(
        MCP,
        &p,
        owner(),
        Capabilities {
            persistent_rules: true,
        },
    )
    .unwrap();
    let request = prepared.request();
    assert_eq!(request.tool_name, "mcp__pult_browser__browser_navigate");
    assert_eq!(request.tool_use_id, None);
    assert_eq!(
        request.input,
        json!({"arguments":{"url":"http://x/"},
        "message":"Allow to run tool \"browser_navigate\"?", "availableDecisions":["accept","decline"]})
    );
    assert!(!request.offers.session);
    assert!(request.offers.rule.is_none());
    assert_eq!(
        prepared
            .resolve(&owner(), Decision::allow(Scope::Once))
            .unwrap(),
        json!({"action":"accept","content":{}})
    );
    assert_eq!(
        answer(MCP, &p, Decision::deny()).unwrap(),
        json!({"action":"decline"})
    );
    for scope in [Scope::Session, Scope::Rule] {
        assert_eq!(
            answer(MCP, &p, Decision::allow(scope)),
            Err(Reject::UnofferedScope)
        );
    }
}
#[test]
fn mcp_pending_metadata_and_nullish_argument_precedence_match_node() {
    let bare = json!({"threadId":"thread","serverName":"pult_browser","_meta":{"codex_approval_kind":"mcp_tool_call"}});
    let request = prepare_mcp_tool_approval(
        &bare,
        owner(),
        pending("pult_browser", "browser_click", json!({"target":"e3"})),
    )
    .unwrap()
    .request();
    assert_eq!(request.tool_name, "mcp__pult_browser__browser_click");
    assert_eq!(request.input["arguments"], json!({"target":"e3"}));
    let request = prepare_default(MCP, &bare).unwrap().request();
    assert_eq!(request.tool_name, "mcp__pult_browser__tool");
    assert_eq!(
        request.input["arguments"],
        "аргументы не пришли — Codex не прислал их ни в вопросе, ни в начале вызова"
    );
    assert!(request.input.get("message").is_none());
    let mut p = bare;
    p["_meta"]["tool_title"] = json!("title");
    assert_eq!(
        prepare_default(MCP, &p).unwrap().request().tool_name,
        "mcp__pult_browser__title"
    );
    p["_meta"]["tool"] = json!("lowest");
    p["_meta"]["toolName"] = json!("middle");
    p["_meta"]["tool_name"] = json!("first");
    p["_meta"]["tool_params"] = Value::Null;
    p["_meta"]["arguments"] = json!(false);
    p["_meta"]["tool_arguments"] = json!({"ignored":true});
    let request = prepare_default(MCP, &p).unwrap().request();
    assert_eq!(request.tool_name, "mcp__pult_browser__first");
    assert_eq!(request.input["arguments"], false);
}
#[test]
fn mcp_missing_turn_uses_captured_ticket_and_stale_context_is_rejected() {
    let p = mcp_params();
    let mut changed = owner();
    changed.provider_turn_id = "new-turn".into();
    assert_eq!(
        prepare_default(MCP, &p)
            .unwrap()
            .resolve(&changed, Decision::allow(Scope::Once)),
        Err(Reject::WrongOwner)
    );
    for (key, value) in [
        ("threadId", json!("foreign")),
        ("turnId", json!("foreign")),
        ("turnId", Value::Null),
    ] {
        let mut p = p.clone();
        p[key] = value;
        assert!(matches!(prepare_default(MCP, &p), Err(Reject::WrongOwner)));
    }
    for mismatch in 0..4 {
        let mut ctx = pending(
            "pult_browser",
            "browser_navigate",
            json!({"PRIVATE":"secret"}),
        );
        let call = ctx.pending.as_mut().unwrap();
        match mismatch {
            0 => call.owner.provider_turn_id = "old".into(),
            1 => call.owner = changed.clone(),
            2 => call.server = "other".into(),
            _ => call.tool = "other".into(),
        }
        assert!(matches!(
            prepare_mcp_tool_approval(&p, owner(), ctx),
            Err(Reject::WrongOwner)
        ));
    }
    let mut fresh = owner();
    fresh.ticket = Coordinator::new(CoordinatorLimits::default())
        .unwrap()
        .reserve(TurnSnapshot {
            key: fresh.session.clone(),
            provider: Provider::Codex,
            cwd: "/project".into(),
            settings: TurnSettings::default(),
        })
        .unwrap();
    assert_eq!(
        prepare_default(MCP, &p)
            .unwrap()
            .resolve(&fresh, Decision::allow(Scope::Once)),
        Err(Reject::WrongOwner)
    );
}
#[test]
fn mcp_generic_or_malformed_forms_never_gain_authority() {
    for (key, value, expected) in [
        ("mode", json!("url"), Reject::Unsupported),
        (
            "requestedSchema",
            json!({"required":["token"]}),
            Reject::Unsupported,
        ),
        (
            "requestedSchema",
            json!({"required":"token"}),
            Reject::Invalid,
        ),
        ("requestedSchema", Value::Null, Reject::Invalid),
        ("message", json!([]), Reject::Invalid),
        ("_meta", json!({}), Reject::Unsupported),
        (
            "_meta",
            json!({"codex_approval_kind":"mcp_tool_call","tool":17}),
            Reject::Invalid,
        ),
    ] {
        let mut p = mcp_params();
        p[key] = value;
        assert_eq!(prepare_default(MCP, &p).err(), Some(expected));
    }
    let mut p = mcp_params();
    p["_meta"]["tool_params"] = json!("x".repeat(MAX_INPUT_BYTES));
    assert!(matches!(prepare_default(MCP, &p), Err(Reject::Capacity)));
    let mut p = mcp_params();
    p["message"] = json!("x".repeat(FIELD_LIMIT + 1));
    let request = prepare_default(MCP, &p).unwrap().request();
    assert!(request.concealed);
    assert!(
        request.input["message"]
            .as_str()
            .unwrap()
            .ends_with("…(обрезано)")
    );
}
#[test]
fn browser_code_is_declined_without_a_broker_request() {
    for tool in [
        "browser_run_code_unsafe",
        "browser_run_code",
        "browser_evaluate",
    ] {
        let mut p = mcp_params();
        p["_meta"]["tool_name"] = json!(tool);
        let error = prepare_default(MCP, &p).err().unwrap();
        assert_eq!(error, Reject::Forbidden);
        assert_eq!(error.static_response(), Some(json!({"action":"decline"})));
        p["serverName"] = json!("other");
        assert!(prepare_default(MCP, &p).is_ok());
        p["serverName"] = json!("pult_browser");
        p["_meta"].as_object_mut().unwrap().remove("tool_name");
        p["message"] = json!(format!("run tool \"\"; run tool \"{tool}\""));
        assert!(matches!(prepare_default(MCP, &p), Err(Reject::Forbidden)));
    }
    let p = json!({"threadId":"thread","serverName":"pult_browser","_meta":{"codex_approval_kind":"mcp_tool_call"}});
    assert!(matches!(
        prepare_mcp_tool_approval(
            &p,
            owner(),
            pending("pult_browser", "browser_evaluate", json!({}))
        ),
        Err(Reject::Forbidden)
    ));
    assert_eq!(Reject::Unsupported.static_response(), None);
}
#[test]
fn native_request_identity_is_private_and_only_display_correlation() {
    let mut p = mcp_params();
    p["turnId"] = json!("turn");
    p["id"] = json!("FORGED");
    p["itemId"] = json!("FORGED");
    let prepared = prepare_mcp_tool_approval(
        &p,
        owner(),
        McpApprovalContext {
            request_id: Some("raw-native-id".into()),
            pending: None,
        },
    )
    .unwrap();
    assert_eq!(
        prepared.request().tool_use_id,
        Some("turn:raw-native-id".into())
    );
    assert!(!prepared.request().input.to_string().contains("FORGED"));
    assert_eq!(
        prepared
            .resolve(&owner(), Decision::allow(Scope::Once))
            .unwrap(),
        json!({"action":"accept","content":{}})
    );
    assert_eq!(
        prepare_default(MCP, &p).unwrap().request().tool_use_id,
        None
    );
    p.as_object_mut().unwrap().remove("turnId");
    let request = prepare_mcp_tool_approval(
        &p,
        owner(),
        McpApprovalContext {
            request_id: Some("raw-native-id".into()),
            pending: None,
        },
    )
    .unwrap()
    .request();
    assert_eq!(request.tool_use_id, None);
}

#[tokio::test]
async fn mcp_real_broker_redacts_public_metadata_without_changing_native_plan() {
    use pult_core::permission_broker::{Broker, Options, Redactors};
    use pult_core::turn_driver::{EventSink, Receipt, SinkError, Task};
    use std::sync::{Arc, Mutex};
    struct Sink(Arc<Mutex<Vec<Value>>>);
    impl EventSink for Sink {
        fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
            let mut drafts = self.0.lock().unwrap();
            drafts.push(draft);
            let id = drafts.len() as u64;
            Box::pin(async move {
                Ok(Receipt {
                    id,
                    ts: "2026-11-12T00:00:00Z".into(),
                })
            })
        }
    }
    let drafts = Arc::new(Mutex::new(Vec::new()));
    let broker = Broker::new(
        Arc::new(Sink(drafts.clone())),
        Redactors {
            value: Arc::new(pult_core::redaction::redact),
            string: Arc::new(pult_core::redaction::redact_string),
        },
        Options::default(),
    )
    .unwrap();
    let mut p = mcp_params();
    p["turnId"] = json!("turn");
    p["_meta"]["tool_params"] = json!({"token":"PRIVATE_ARGUMENT","url":"http://x/"});
    p["message"] = json!("run tool \"browser_navigate\" for private@example.com");
    let native_id = "0123456789abcdef0123456789abcdef";
    let prepared = prepare_mcp_tool_approval(
        &p,
        owner(),
        McpApprovalContext {
            request_id: Some(native_id.into()),
            pending: None,
        },
    )
    .unwrap();
    assert_eq!(
        prepared.request().input["arguments"]["token"],
        "PRIVATE_ARGUMENT"
    );
    assert_eq!(
        prepared.request().tool_use_id,
        Some(format!("turn:{native_id}"))
    );
    let mut handle = broker.request(prepared.request()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while broker.pending_count() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let cards = broker.list(None);
    assert_eq!(cards.len(), 1);
    let public = cards[0].to_string();
    for private in ["PRIVATE_ARGUMENT", "private@example.com", native_id] {
        assert!(!public.contains(private));
    }
    assert_eq!(cards[0]["concealed"], true);
    assert_eq!(cards[0]["input"]["arguments"]["token"], "<redacted>");
    assert_eq!(cards[0]["toolUseId"], "turn:<token>");
    assert!(
        broker
            .resolve(handle.id(), Decision::allow(Scope::Once), "human")
            .unwrap()
            .wait()
            .await
            .unwrap()
    );
    assert_eq!(
        prepared.resolve(&owner(), handle.decision().await).unwrap(),
        json!({"action":"accept","content":{}})
    );
    broker.drain().await;
    let serialized = serde_json::to_string(&*drafts.lock().unwrap()).unwrap();
    for private in ["PRIVATE_ARGUMENT", "private@example.com", native_id] {
        assert!(!serialized.contains(private));
    }
}
#[tokio::test]
async fn mcp_broker_redactor_panic_maps_to_static_decline_without_publication() {
    use pult_core::permission_broker::{Broker, Options, Redactors};
    use pult_core::turn_driver::{EventSink, Receipt, SinkError, Task};
    use std::sync::Arc;
    struct NoWrite;
    impl EventSink for NoWrite {
        fn append(&self, _: Value) -> Task<Result<Receipt, SinkError>> {
            panic!("must not publish");
        }
    }
    pult_core::panic_guard::install();
    for panic_value in [true, false] {
        let broker = Broker::new(
            Arc::new(NoWrite),
            Redactors {
                value: Arc::new(move |v| {
                    if panic_value {
                        panic!("PRIVATE_REDATOR_PAYLOAD")
                    }
                    v.clone()
                }),
                string: Arc::new(move |s| {
                    if !panic_value {
                        panic!("PRIVATE_REDATOR_PAYLOAD")
                    }
                    s.into()
                }),
            },
            Options::default(),
        )
        .unwrap();
        let prepared = prepare_default(MCP, &mcp_params()).unwrap();
        assert!(broker.request(prepared.request()).is_err());
        assert_eq!(broker.pending_count(), 0);
        // Host maps broker failure to a deny; no raw panic text is part of plan.
        assert_eq!(
            prepared.resolve(&owner(), Decision::deny()).unwrap(),
            json!({"action":"decline"})
        );
        broker.drain().await;
    }
}
