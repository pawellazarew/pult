//! Constructed fixtures from pinned public schema, NOT recorded/live CLI samples.
use pult_core::zcode_appserver_protocol::*;
use serde_json::{Value, json};

fn id() -> RequestId {
    RequestId::string("rpc-1").unwrap()
}
fn wire(v: Value) -> Vec<u8> {
    let mut b = serde_json::to_vec(&v).unwrap();
    b.push(b'\n');
    b
}
fn response(v: Value) -> Response {
    match decode_frame(&wire(v)).unwrap() {
        Incoming::Response(r) => r,
        _ => panic!("expected response"),
    }
}
fn helper() -> StdioMcpServer {
    StdioMcpServer::new(
        "pult-memory",
        "/pult-memory-mcp",
        "/project",
        &["--stdio".into()],
        &[("PULT_MEMORY_KEY".into(), "private-fixture-key".into())],
    )
    .unwrap()
}
fn workspace() -> Workspace {
    Workspace::new("/project", "workspace-1").unwrap()
}
fn snapshot() -> Value {
    json!({
     "protocol":{"name":"ZCode Protocol","version":1},
     "session":{"sessionId":"s1","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"},"sessionKind":"interactive","title":"","mode":"guarded","status":"idle","createdAt":1,"updatedAt":2},
     "settings":{"model":{"available":[]},"thoughtLevel":{"enabled":false,"available":[]},"mode":{"current":"guarded"}},
     "projection":{"sessionId":"s1","status":"idle","mode":"guarded","turnCount":0,"totalTokenCount":0,"contextUsed":0,"contextWindow":128000,"pendingPermissions":[],"activeToolCalls":[],"backgroundJobs":[]},
     "runtime":{"eventSeq":4,"stateRevision":7,"pendingRequestIds":[]},"messages":[]
    })
}
fn started() -> Value {
    json!({"method":"session/event","params":{"eventId":"e1","sessionId":"s1","turnId":"t1","seq":5,"timestamp":100,"type":"turn.started","payload":{"turnNumber":1,"input":"private prompt","inputId":"host-input-1","queryId":"host-query-1"}}})
}
fn permission() -> Value {
    json!({"id":"reverse-1","method":"interaction/requestPermission","params":{"requestId":"permission-1","sessionId":"s1","turnId":"t1","toolCallId":"tool-1","toolName":"Bash","reason":"private reason","riskLevel":"high","input":{"command":"private command"},"options":[{"optionId":"allow","kind":"allow","name":"Allow","response":{"decision":"allow","permissionUpdates":[{"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"*"}]}]}}]}})
}

#[test]
fn argv_has_only_pinned_entrypoint() {
    assert_eq!(APP_SERVER_ARGV, ["app-server", "--stdio"]);
}
#[test]
fn exact_create_and_resume_requests_use_private_mcp_array() {
    for (request, method) in [
        (
            OutboundRequest::create(id(), "s1", workspace(), vec![helper()]).unwrap(),
            "session/create",
        ),
        (
            OutboundRequest::resume(id(), "s1", workspace(), vec![helper()]).unwrap(),
            "session/resume",
        ),
    ] {
        let bytes = request.encode().unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let mut expected = json!({"id":"rpc-1","method":method,"params":{"sessionId":"s1","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"},"mcpServers":[{"name":"pult-memory","command":"/pult-memory-mcp","cwd":"/project","args":["--stdio"],"env":[{"name":"PULT_MEMORY_KEY","value":"private-fixture-key"}],"isolation":"session"}]}});
        if method == "session/create" {
            expected["params"]["titleGenerationEnabled"] = json!(false);
        }
        assert_eq!(value, expected);
        assert!(bytes.ends_with(b"\n"));
        assert!(value["params"].get("content").is_none());
        assert!(value.get("jsonrpc").is_none());
    }
}
#[test]
fn exact_send_and_close_requests_do_not_imply_started_or_cleanup() {
    let send = OutboundRequest::send(id(), "s1", "input-1", "query-1", "hello\nworld")
        .unwrap()
        .encode()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&send).unwrap(),
        json!({"id":"rpc-1","method":"session/send","params":{"sessionId":"s1","inputId":"input-1","queryId":"query-1","content":"hello\nworld"}})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(
            &OutboundRequest::close(id(), "s1")
                .unwrap()
                .encode()
                .unwrap()
        )
        .unwrap(),
        json!({"id":"rpc-1","method":"session/close","params":{"sessionId":"s1"}})
    );
}
#[test]
fn send_ack_is_distinct_and_correlated() {
    let ack = response(
        json!({"id":"rpc-1","result":{"accepted":true,"sessionId":"s1","stateRevision":9}}),
    )
    .send_ack(&id(), "s1")
    .unwrap();
    assert_eq!(ack.session_id, "s1");
    assert_eq!(ack.state_revision, 9);
    for result in [
        json!({"accepted":false,"sessionId":"s1","stateRevision":9}),
        json!({"accepted":true,"sessionId":"s1","stateRevision":9,"started":true}),
        json!({"accepted":true,"sessionId":"s1","stateRevision":-1}),
    ] {
        assert!(
            response(json!({"id":"rpc-1","result":result}))
                .send_ack(&id(), "s1")
                .is_err()
        );
    }
    assert!(
        response(
            json!({"id":"rpc-2","result":{"accepted":true,"sessionId":"s1","stateRevision":9}})
        )
        .send_ack(&id(), "s1")
        .is_err()
    );
    assert!(
        response(
            json!({"id":"rpc-1","result":{"accepted":true,"sessionId":"other","stateRevision":9}})
        )
        .send_ack(&id(), "s1")
        .is_err()
    );
}
#[test]
fn snapshot_ack_extracts_identity_and_runtime_without_input_acceptance() {
    for method in [
        SnapshotMethod::Create,
        SnapshotMethod::Resume,
        SnapshotMethod::SetMode,
    ] {
        let ack = response(json!({"id":"rpc-1","result":snapshot()}))
            .snapshot_ack(&id(), "s1", method)
            .unwrap();
        assert_eq!(ack.method, method);
        assert_eq!(ack.session_mode, SessionMode::Guarded);
        assert_eq!(ack.session_id, "s1");
        assert_eq!(ack.workspace_path, "/project");
        assert_eq!(ack.workspace_key, "workspace-1");
        assert_eq!(ack.state_revision, 7);
        assert_eq!(ack.event_seq, 4);
        assert_eq!(ack.active_turn_id, None);
        assert_eq!(ack.untrusted_snapshot(), &snapshot());
    }
    assert!(
        response(json!({"id":"rpc-1","result":snapshot()}))
            .send_ack(&id(), "s1")
            .is_err()
    );
}
#[test]
fn snapshot_critical_headers_fail_closed() {
    for (path, value) in [
        (vec!["protocol", "version"], json!(2)),
        (vec!["protocol", "name"], json!("Codex")),
        (vec!["session", "sessionId"], json!("other")),
        (vec!["projection", "sessionId"], json!("other")),
        (vec!["runtime", "stateRevision"], json!(-1)),
        (vec!["runtime", "pendingRequestIds"], json!([null])),
        (vec!["session", "workspace", "workspacePath"], json!("")),
    ] {
        let mut s = snapshot();
        let mut cursor = &mut s;
        for k in &path[..path.len() - 1] {
            cursor = &mut cursor[*k];
        }
        cursor[path[path.len() - 1]] = value;
        assert!(
            response(json!({"id":"rpc-1","result":s}))
                .snapshot_ack(&id(), "s1", SnapshotMethod::Resume)
                .is_err()
        );
    }
    let mut s = snapshot();
    s["authority"] = json!("owner");
    assert!(
        response(json!({"id":"rpc-1","result":s}))
            .snapshot_ack(&id(), "s1", SnapshotMethod::Create)
            .is_err()
    );
}
#[test]
fn snapshot_retains_bounded_opaque_projection_not_full_schema_claim() {
    let mut s = snapshot();
    s["projection"]["opaque-future-data"] = json!({"private":"untrusted"});
    let ack = response(json!({"id":"rpc-1","result":s.clone()}))
        .snapshot_ack(&id(), "s1", SnapshotMethod::Resume)
        .unwrap();
    assert_eq!(ack.untrusted_snapshot(), &s);
}
#[test]
fn close_ack_is_not_process_cleanup() {
    assert_eq!(
        response(json!({"id":"rpc-1","result":{"closed":true}}))
            .close_ack(&id())
            .unwrap()
            .closed,
        Some(true)
    );
    assert_eq!(
        response(json!({"id":"rpc-1","result":{}}))
            .close_ack(&id())
            .unwrap()
            .closed,
        None
    );
    assert!(
        response(json!({"id":"rpc-1","result":{"closed":true,"pid":42}}))
            .close_ack(&id())
            .is_err()
    );
}
#[test]
fn native_turn_started_keeps_host_correlation_as_candidate_only() {
    match decode_frame(&wire(started())).unwrap() {
        Incoming::TurnStarted(e) => {
            assert_eq!(e.session_id, "s1");
            assert_eq!(e.turn_id.as_deref(), Some("t1"));
            assert_eq!(e.input_id.as_deref(), Some("host-input-1"));
            assert_eq!(e.query_id.as_deref(), Some("host-query-1"));
            assert_eq!(e.seq, 5);
        }
        _ => panic!("expected candidate"),
    }
    let mut missing = started();
    missing["params"].as_object_mut().unwrap().remove("turnId");
    missing["params"]["payload"]
        .as_object_mut()
        .unwrap()
        .remove("inputId");
    match decode_frame(&wire(missing)).unwrap() {
        Incoming::TurnStarted(e) => {
            assert!(e.turn_id.is_none());
            assert!(e.input_id.is_none());
        }
        _ => panic!("expected uncorrelated candidate"),
    }
}
#[test]
fn turn_started_unknown_and_malformed_fields_fail_closed() {
    for (key, v) in [
        ("inputId", json!("")),
        ("turnNumber", json!(-1)),
        ("input", json!({"text":"wrong"})),
        ("authority", json!("owner")),
        ("workflowLaunch", json!({})),
    ] {
        let mut s = started();
        s["params"]["payload"][key] = v;
        assert!(decode_frame(&wire(s)).is_err());
    }
    let mut s = started();
    s["params"]["type"] = json!("invented.event");
    assert!(decode_frame(&wire(s)).is_err());
}
#[test]
fn runtime_preferences_reverse_defaults_disable_host_capabilities() {
    let request = json!({"id":17,"method":"session/requestRuntimePreferences","params":{"sessionId":"s1","scope":"runtime-materialization","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"}}});
    match decode_frame(&wire(request)).unwrap() {
        Incoming::Reverse(r) => {
            assert_eq!(
                serde_json::from_slice::<Value>(&r.default_deny().unwrap()).unwrap(),
                json!({"id":17,"result":{"nativeSearchEnhancementsEnabled":false,"toolSearchMode":"off","subagentRuntimeConfigEnabled":false,"appControlEnabled":false,"memoryEnabled":false,"askUserQuestionAutoResolutionEnabled":false,"modelContextBudgetStrategy":"preflight-v1"}})
            );
        }
        _ => panic!("expected reverse"),
    }
}
#[test]
fn permission_reverse_never_uses_offered_allow_or_persistent_rules() {
    match decode_frame(&wire(permission())).unwrap() {
        Incoming::Reverse(r) => assert_eq!(
            serde_json::from_slice::<Value>(&r.default_deny().unwrap()).unwrap(),
            json!({"id":"reverse-1","result":{"decision":"deny","reason":"Host approval is unavailable"}})
        ),
        _ => panic!("expected permission"),
    }
    let mut p = permission();
    p["params"]["options"][0]["response"]["owner"] = json!(true);
    assert!(decode_frame(&wire(p)).is_err());
    let mut p = permission();
    p["params"]["options"] = json!([]);
    assert!(decode_frame(&wire(p)).is_err());
}
#[test]
fn user_question_reverse_cancels_without_echoing_private_data() {
    let p = json!({"id":"question-rpc","method":"interaction/requestUserInput","params":{"requestId":"q1","sessionId":"s1","prompt":"private prompt","questions":[{"question":"private question","header":"Choose","options":[{"value":"yes","label":"Yes"}],"multiSelect":false}]}});
    match decode_frame(&wire(p)).unwrap() {
        Incoming::Reverse(r) => assert_eq!(
            serde_json::from_slice::<Value>(&r.default_deny().unwrap()).unwrap(),
            json!({"id":"question-rpc","result":{"action":"cancel","reason":"Host input is unavailable"}})
        ),
        _ => panic!("expected question"),
    }
}
#[test]
fn protocol_errors_keep_only_bounded_code_without_reflecting_private_message() {
    let r = response(
        json!({"id":"rpc-1","error":{"code":-32601,"message":"private failure","data":{"private-key":"secret"}}}),
    );
    assert_eq!(r.error_code(&id()).unwrap(), Some(-32601));
    assert!(r.send_ack(&id(), "s1").is_err());
}
#[test]
fn framing_and_ambiguous_envelopes_fail_closed() {
    for bytes in [
        b"{}".as_slice(),
        b"{}\n{}\n",
        b"Content-Length: 2\r\n\r\n{}",
        b"\n",
        b"{\"id\":1,\"id\":2,\"result\":{}}\n",
        b"{\"id\":1,\"result\":{},\"error\":{}}\n",
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",
        b"{\"id\":null,\"result\":{}}\n",
        b"{\"id\":1,\"method\":\"initialize\",\"params\":{}}\n",
        b"{\"id\":1,\"result\":{\"nested\":{\"dup\":1,\"dup\":2}}}\n",
        b"{\"id\":1,\"result\":null} trailing\n",
    ] {
        assert!(decode_frame(bytes).is_err());
    }
    assert!(decode_frame(b"{\"id\":1,\"result\":null}\r\n").is_ok());
}
#[test]
fn error_strings_never_expose_input_bytes() {
    let e = decode_frame(b"SECRET_BAD_FRAME\n").err().unwrap();
    assert!(!format!("{e:?} {e}").contains("SECRET_BAD_FRAME"));
}
#[test]
fn frame_depth_nodes_strings_and_integer_budgets_are_bounded() {
    assert!(decode_frame(&vec![b' '; MAX_FRAME_BYTES + 1]).is_err());
    let nested = format!(
        "{{\"id\":1,\"result\":{}null{}}}\n",
        "[".repeat(MAX_DEPTH + 1),
        "]".repeat(MAX_DEPTH + 1)
    );
    assert!(decode_frame(nested.as_bytes()).is_err());
    assert!(decode_frame(&wire(json!({"id":1,"result":vec![0;MAX_NODES]}))).is_err());
    assert!(
        decode_frame(&wire(
            json!({"id":1,"result":"x".repeat(MAX_STRING_BYTES+1)})
        ))
        .is_err()
    );
    assert!(decode_frame(b"{\"id\":9007199254740992,\"result\":{}}\n").is_err());
    assert!(RequestId::integer(i64::MIN).is_err());
}
#[test]
fn default_history_budget_accepts_large_snapshot_without_truncation() {
    let mut s = snapshot();
    s["messages"] = json!(
        (0..200)
            .map(|_| json!({"opaque":"x".repeat(2048)}))
            .collect::<Vec<_>>()
    );
    let bytes = wire(json!({"id":"rpc-1","result":s.clone()}));
    assert!(bytes.len() > 256 * 1024);
    let small = DecodeLimits {
        frame_bytes: 256 * 1024,
        ..DecodeLimits::default()
    };
    assert!(decode_frame_with_limits(&bytes, small).is_err());
    let limits = DecodeLimits::default();
    match decode_frame_with_limits(&bytes, limits).unwrap() {
        Incoming::Response(r) => assert_eq!(
            r.snapshot_ack(&id(), "s1", SnapshotMethod::Resume)
                .unwrap()
                .untrusted_snapshot(),
            &s
        ),
        _ => panic!("expected snapshot"),
    }
    assert!(
        decode_frame_with_limits(
            &bytes,
            DecodeLimits {
                frame_bytes: usize::MAX,
                ..limits
            }
        )
        .is_err()
    );
}
#[test]
fn mcp_empty_duplicate_environment_and_config_budgets_fail_closed() {
    assert!(OutboundRequest::create(id(), "s1", workspace(), vec![]).is_err());
    assert!(OutboundRequest::resume(id(), "s1", workspace(), vec![helper(), helper()]).is_err());
    for env in [
        vec![("KEY".into(), "x".into()); 2],
        vec![("BAD=KEY".into(), "x".into())],
        vec![("KEY".into(), "x".repeat(16 * 1024 + 1))],
        vec![("KEY".into(), "x".into()); MAX_ENV_ENTRIES + 1],
    ] {
        assert!(StdioMcpServer::new("name", "helper", "/project", &[], &env).is_err());
    }
    let env = (0..8)
        .map(|i| (format!("KEY_{i}"), "x".repeat(16 * 1024)))
        .collect::<Vec<_>>();
    assert!(StdioMcpServer::new("name", "helper", "/project", &[], &env).is_err());
    assert!(helper().protocol_version("invented").is_err());
    assert!(helper().timeout_ms(0).is_err());
}
#[test]
fn builder_checks_ids_even_when_enum_variant_bypasses_constructor() {
    let request = OutboundRequest::close(RequestId::Integer(i64::MAX), "s1").unwrap();
    assert!(request.encode().is_err());
    assert!(OutboundRequest::send(id(), "s1", "", "q1", "prompt").is_err());
    assert!(
        OutboundRequest::send(id(), "s1", "i1", "q1", &"x".repeat(MAX_CONTENT_BYTES + 1)).is_err()
    );
}

#[test]
fn explicit_small_capacity_errors_are_distinct_from_malformed_json() {
    let small = DecodeLimits {
        frame_bytes: 4096,
        depth: 4,
        nodes: 16,
        string_bytes: 16,
    };
    for bytes in [
        wire(json!({"id":1,"result":"x".repeat(17)})),
        wire(json!({"id":1,"result":vec![0;32]})),
        b"{\"id\":1,\"result\":[[[[[]]]]]}\n".to_vec(),
    ] {
        assert!(matches!(
            decode_frame_with_limits(&bytes, small),
            Err(ProtocolError::BudgetExceeded)
        ));
    }
    assert!(matches!(
        decode_frame_with_limits(b"invalid\n", small),
        Err(ProtocolError::InvalidJson)
    ));
}
#[test]
fn default_accepts_a_large_opaque_history_string_within_frame() {
    let mut s = snapshot();
    s["messages"] = json!([{"opaque":"x".repeat(3*1024*1024)}]);
    let bytes = wire(json!({"id":"rpc-1","result":s.clone()}));
    match decode_frame(&bytes).unwrap() {
        Incoming::Response(r) => assert_eq!(
            r.snapshot_ack(&id(), "s1", SnapshotMethod::Resume)
                .unwrap()
                .untrusted_snapshot(),
            &s
        ),
        _ => panic!("expected snapshot"),
    }
}

#[test]
fn native_send_started_intent_and_other_pinned_metadata_are_bounded_untrusted() {
    let mut frame = started();
    frame["params"]["payload"]["intent"] = json!({
        "commandId":"host-input-1", "clientId":"legacy-session-send",
        "sessionId":"s1", "type":"sendText", "text":"private prompt",
        "modelSelection":{"providerId":"fixture-provider","modelId":"fixture-model"}
    });
    frame["params"]["payload"]["originMeta"] = json!({"private":"opaque"});
    frame["params"]["payload"]["attachments"] = json!([{"name":"private.png"}]);
    frame["params"]["payload"]["inputSource"] = json!("shared_context");
    match decode_frame(&wire(frame.clone())).unwrap() {
        Incoming::TurnStarted(candidate) => {
            assert_eq!(candidate.input_id.as_deref(), Some("host-input-1"));
            assert_eq!(candidate.turn_id.as_deref(), Some("t1"));
        }
        _ => panic!("expected transport candidate"),
    }
    for (field, value) in [
        ("intent", json!([])),
        ("originMeta", json!(true)),
        ("attachments", json!([null])),
        ("inputSource", json!("invented")),
        ("authority", json!("owner")),
    ] {
        let mut bad = frame.clone();
        bad["params"]["payload"][field] = value;
        assert!(decode_frame(&wire(bad)).is_err());
    }
}

#[test]
fn exact_trace_schema_is_accepted_without_granting_reverse_authority() {
    for trace in [
        json!({}),
        json!({"traceId":"trace-1","parentId":"parent-1","spanId":"span-1","traceparent":"00-fixture"}),
    ] {
        let mut frame = permission();
        frame["trace"] = trace;
        match decode_frame(&wire(frame)).unwrap() {
            Incoming::Reverse(request) => {
                let result: Value =
                    serde_json::from_slice(&request.default_deny().unwrap()).unwrap();
                assert_eq!(result["result"]["decision"], "deny");
            }
            _ => panic!("expected reverse"),
        }
    }
    for trace in [
        json!(null),
        json!({"traceId":""}),
        json!({"traceId":1}),
        json!({"owner":true}),
        json!({"traceId":"x".repeat(257)}),
    ] {
        let mut frame = permission();
        frame["trace"] = trace;
        assert!(decode_frame(&wire(frame)).is_err());
    }
}

#[test]
fn error_codes_require_exact_pending_rpc_id_before_exposure() {
    let error = response(
        json!({"id":"rpc-unrelated","error":{"code":-32004,"message":"private unavailable"}}),
    );
    assert!(matches!(
        error.error_code(&id()),
        Err(ProtocolError::CorrelationMismatch)
    ));
    assert_eq!(
        error
            .error_code(&RequestId::string("rpc-unrelated").unwrap())
            .unwrap(),
        Some(-32004)
    );
    let ok = response(json!({"id":"rpc-1","result":{}}));
    assert_eq!(ok.error_code(&id()).unwrap(), None);
}

#[test]
fn host_ids_reject_native_trim_ambiguity_and_mcp_magic_names() {
    assert!(OutboundRequest::create(id(), " s1 ", workspace(), vec![helper()]).is_err());
    assert!(Workspace::new("/project", " workspace-1 ").is_err());
    assert!(Workspace::new("/project ", "workspace-1").is_err());
    assert!(StdioMcpServer::new("helper", " helper ", "/project", &[], &[]).is_err());
    assert!(StdioMcpServer::new("helper", "helper", "/project ", &[], &[]).is_err());
    for name in [" helper ", "__proto__"] {
        assert!(StdioMcpServer::new(name, "helper", "/project", &[], &[]).is_err());
    }
    // Native explicitly supports custom IDs; sess_ is a factory convention, not a wire rule.
    assert!(
        OutboundRequest::create(id(), "custom-native-sid", workspace(), vec![helper()]).is_ok()
    );
    for version in ["legacy", "auto", "2026-07-28"] {
        assert!(helper().protocol_version(version).is_ok());
    }
    assert!(helper().protocol_version("2025-03-26").is_err());
}

#[test]
fn encoded_content_capacity_is_checked_after_json_escaping() {
    let request =
        OutboundRequest::send(id(), "s1", "i1", "q1", &"\u{0001}".repeat(65_536)).unwrap();
    assert!(matches!(
        request.encode(),
        Err(ProtocolError::FrameTooLarge)
    ));
}

#[test]
fn subscribe_request_and_ack_use_native_delivery_kind_and_exact_header() {
    let request = OutboundRequest::subscribe(id(), "s1", DeliveryKind::DesktopContinuous, None)
        .unwrap()
        .encode()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&request).unwrap(),
        json!({"id":"rpc-1","method":"session/subscribe","params":{"sessionId":"s1","deliveryKind":"desktop-continuous","includeSnapshot":false}})
    );
    let replay = OutboundRequest::subscribe(id(), "s1", DeliveryKind::WebRemoteReplayable, Some(8))
        .unwrap()
        .encode()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&replay).unwrap()["params"]["afterSeq"],
        8
    );
    let ack = response(json!({"id":"rpc-1","result":{"sessionId":"s1","eventSeq":9,"events":[]}}))
        .subscribe_ack(&id(), "s1")
        .unwrap();
    assert_eq!(ack.session_id, "s1");
    assert_eq!(ack.event_seq, 9);
    assert!(ack.untrusted_events().is_empty());
    assert!(ack.untrusted_snapshot().is_none());
    for result in [
        json!({"sessionId":"other","eventSeq":9,"events":[]}),
        json!({"sessionId":"s1","eventSeq":-1,"events":[]}),
        json!({"sessionId":"s1","eventSeq":9,"events":[{}]}),
        json!({"sessionId":"s1","eventSeq":9,"events":[{"eventId":"e1","sessionId":"other","seq":1,"timestamp":1,"type":"session.updated","payload":{}}]}),
        json!({"sessionId":"s1","eventSeq":9,"events":[],"authority":true}),
    ] {
        assert!(
            response(json!({"id":"rpc-1","result":result}))
                .subscribe_ack(&id(), "s1")
                .is_err()
        );
    }
    assert!(
        response(json!({"id":"unrelated","result":{"sessionId":"s1","eventSeq":9,"events":[]}}))
            .subscribe_ack(&id(), "s1")
            .is_err()
    );
}

#[test]
fn recognized_bounded_notifications_are_not_privileged_reverse_requests() {
    let state = json!({"method":"state.updated","params":{"type":"state.updated","scope":"session","revision":8,"sessionId":"s1","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"},"reason":"prompt_started","patch":{"status":"running"}}});
    match decode_frame(&wire(state.clone())).unwrap() {
        Incoming::Notification(notification) => {
            assert_eq!(notification.method(), "state.updated");
            assert_eq!(notification.untrusted_params(), &state["params"]);
        }
        _ => panic!("expected bounded notification"),
    }
    let mut event = started();
    event["params"]["type"] = json!("turn.completed");
    event["params"]["payload"] = json!({"opaque":"untrusted"});
    assert!(matches!(
        decode_frame(&wire(event)),
        Ok(Incoming::Notification(_))
    ));
    assert!(matches!(
        decode_frame(&wire(
            json!({"method":"startup/pluginsDegraded","params":{"reason":"timeout"}})
        )),
        Ok(Incoming::Notification(_))
    ));
    for notification in [
        json!({"method":"invented/notification","params":{}}),
        json!({"method":"state.updated","params":{"type":"state.updated","scope":"session","revision":-1,"patch":{}}}),
        json!({"method":"state.updated","params":{"type":"state.updated","scope":"session","revision":1,"patch":{},"authority":"owner"}}),
        json!({"method":"interaction/requestPermission","params":{}}),
    ] {
        assert!(decode_frame(&wire(notification)).is_err());
    }
    // A request ID changes dispatch: no privileged request may be ignored as a notification.
    let mut request = state;
    request["id"] = json!("server-1");
    assert!(decode_frame(&wire(request)).is_err());
}

#[test]
fn explicit_native_modes_and_set_mode_snapshot_ack_are_not_host_approval() {
    for (mode, wire_mode) in [
        (SessionMode::Plan, "plan"),
        (SessionMode::Build, "build"),
        (SessionMode::Edit, "edit"),
        (SessionMode::Yolo, "yolo"),
        (SessionMode::Guarded, "guarded"),
        (SessionMode::Auto, "auto"),
    ] {
        let create = OutboundRequest::create(id(), "s1", workspace(), vec![helper()])
            .unwrap()
            .with_mode(mode)
            .unwrap()
            .encode()
            .unwrap();
        let create: Value = serde_json::from_slice(&create).unwrap();
        assert_eq!(create["params"]["mode"], wire_mode);
        assert_eq!(create["params"]["titleGenerationEnabled"], false);
        let set = OutboundRequest::set_mode(id(), "s1", mode, Some(7))
            .unwrap()
            .encode()
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&set).unwrap(),
            json!({"id":"rpc-1","method":"session/setMode","params":{"sessionId":"s1","mode":wire_mode,"expectedRevision":7}})
        );
    }
    let ack = response(json!({"id":"rpc-1","result":snapshot()}))
        .snapshot_ack(&id(), "s1", SnapshotMethod::SetMode)
        .unwrap();
    assert_eq!(ack.method, SnapshotMethod::SetMode);
    assert!(
        OutboundRequest::close(id(), "s1")
            .unwrap()
            .with_mode(SessionMode::Guarded)
            .is_err()
    );
    assert!(OutboundRequest::set_mode(id(), "s1", SessionMode::Guarded, Some(u64::MAX)).is_err());
}

fn permission_request(bytes: &[u8]) -> ReverseRequest {
    match decode_frame(bytes).unwrap() {
        Incoming::Reverse(r @ ReverseRequest::Permission { .. }) => r,
        _ => panic!("expected permission"),
    }
}
fn retained_permission(r: &ReverseRequest) -> &NativePermissionData {
    match r {
        ReverseRequest::Permission {
            payload: NativePermissionPayload::Retained(data),
            ..
        } => data,
        _ => panic!("expected retained untrusted data"),
    }
}
const PERMISSION_DENY: &[u8] = b"{\"id\":\"reverse-1\",\"result\":{\"decision\":\"deny\",\"reason\":\"Host approval is unavailable\"}}\n";

#[test]
fn permission_retains_all_untrusted_fields_without_changing_conservative_reply() {
    let mut p = permission();
    p["params"]["origin"] = json!({"kind":"subagent","agentId":"agent1","agentType":"worker","childSessionId":"child","parentSessionId":"s1","childTurnId":"child-turn","parentTurnId":"t1","parentToolCallId":"parent-call","description":"private origin"});
    let request = permission_request(&wire(p.clone()));
    let data = retained_permission(&request);
    assert_eq!(data.untrusted_tool_call_id(), "tool-1");
    assert_eq!(data.untrusted_tool_name(), "Bash");
    assert_eq!(data.untrusted_reason(), "private reason");
    assert_eq!(data.untrusted_risk_level(), "high");
    assert_eq!(data.untrusted_turn_id().as_deref(), Some("t1"));
    for (raw, expected) in [
        (data.untrusted_params(), &p["params"]),
        (data.untrusted_input(), &p["params"]["input"]),
        (data.untrusted_options(), &p["params"]["options"]),
        (data.untrusted_origin().unwrap(), &p["params"]["origin"]),
    ] {
        assert_eq!(&serde_json::from_str::<Value>(raw.get()).unwrap(), expected);
    }
    assert_eq!(request.default_deny().unwrap(), PERMISSION_DENY);
}

#[test]
fn permission_primitive_array_and_null_input_remain_original_json() {
    for input in [
        json!(null),
        json!(true),
        json!(7),
        json!(1.5),
        json!("private string"),
        json!([1, null, {"secret":true}]),
    ] {
        let mut p = permission();
        p["params"]["input"] = input.clone();
        p["params"].as_object_mut().unwrap().remove("turnId");
        let request = permission_request(&wire(p));
        let data = retained_permission(&request);
        assert_eq!(data.untrusted_turn_id(), None);
        assert!(data.untrusted_origin().is_none());
        assert_eq!(
            serde_json::from_str::<Value>(data.untrusted_input().get()).unwrap(),
            input
        );
        assert_eq!(request.default_deny().unwrap(), PERMISSION_DENY);
    }
}

#[test]
fn permission_raw_params_and_fields_preserve_lexical_identity() {
    let params = r#"{ "requestId":"permission-1", "sessionId":"s1", "toolCallId":"tool-1", "toolName":"B\u0061sh", "reason":"private\u0020reason", "riskLevel":"low", "input" : [ -0, 1.2300e+02, {"s":"\u0061", "n":  0.50 } ], "options" : [ { "optionId":"a", "kind":"allow", "name":"Allow", "response": { "decision":"allow", "modifiedInput": [ 1.00 ] } } ] }"#;
    let bytes = format!(
        "{{ \"id\":\"reverse-1\", \"method\":\"interaction/requestPermission\", \"params\":{params} }}\r\n"
    );
    let request = permission_request(bytes.as_bytes());
    let data = retained_permission(&request);
    assert_eq!(data.untrusted_params().get(), params);
    assert_eq!(data.untrusted_tool_name(), "Bash");
    assert_eq!(data.untrusted_reason(), "private reason");
    assert_eq!(
        data.untrusted_input().get(),
        r#"[ -0, 1.2300e+02, {"s":"\u0061", "n":  0.50 } ]"#
    );
    assert_eq!(
        data.untrusted_options().get(),
        r#"[ { "optionId":"a", "kind":"allow", "name":"Allow", "response": { "decision":"allow", "modifiedInput": [ 1.00 ] } } ]"#
    );
    assert_eq!(request.default_deny().unwrap(), PERMISSION_DENY);
}

fn permission_with_retention_bytes(bytes: usize) -> Value {
    let mut p = permission();
    p["params"]["input"] = json!("");
    let overhead = serde_json::to_vec(&p["params"]).unwrap().len()
        + std::mem::size_of::<ReverseRequest>()
        + "reverse-1".len()
        + "s1".len()
        + "permission-1".len();
    p["params"]["input"] = json!("x".repeat(bytes - overhead));
    p
}
#[test]
fn permission_retention_boundary_counts_backing_metadata_and_correlation_copies() {
    let at_limit = permission_with_retention_bytes(MAX_PERMISSION_RETENTION_BYTES);
    let request = permission_request(&wire(at_limit));
    assert!(
        !retained_permission(&request)
            .untrusted_input()
            .get()
            .is_empty()
    );
    assert_eq!(request.default_deny().unwrap(), PERMISSION_DENY);
    let over_limit = permission_with_retention_bytes(MAX_PERMISSION_RETENTION_BYTES + 1);
    let request = permission_request(&wire(over_limit));
    assert!(matches!(
        request,
        ReverseRequest::Permission {
            payload: NativePermissionPayload::ConservativeOnly(
                PermissionPayloadLimit::RetentionBudget
            ),
            ..
        }
    ));
    assert_eq!(request.default_deny().unwrap(), PERMISSION_DENY);
}
#[test]
fn larger_valid_permission_is_explicitly_conservative_without_lowering_wire_limit() {
    let mut p = permission();
    p["params"]["input"] = json!({"secret":"x".repeat(1024 * 1024)});
    let request = permission_request(&wire(p));
    assert!(matches!(
        request,
        ReverseRequest::Permission {
            payload: NativePermissionPayload::ConservativeOnly(
                PermissionPayloadLimit::RetentionBudget
            ),
            ..
        }
    ));
    assert_eq!(request.default_deny().unwrap(), PERMISSION_DENY);
}
#[test]
fn permission_strict_validation_precedes_any_conservative_only_state() {
    let mut p = permission_with_retention_bytes(MAX_PERMISSION_RETENTION_BYTES + 1);
    p["params"]["origin"] = json!({"kind":"invented"});
    assert!(decode_frame(&wire(p)).is_err());
    let p = permission_with_retention_bytes(MAX_PERMISSION_RETENTION_BYTES + 1);
    let input = serde_json::to_string(&p["params"]["input"]).unwrap();
    let body = String::from_utf8(wire(p)).unwrap();
    for malformed in [
        body.replace(
            "\"toolName\":\"Bash\"",
            "\"toolName\":\"Bash\",\"toolName\":\"Other\"",
        ),
        body.replace("\"input\":", "\"input\":null,\"input\":"),
        body.replace(
            "\"decision\":\"allow\"",
            "\"decision\":\"allow\",\"decision\":\"deny\"",
        ),
    ] {
        assert!(decode_frame(malformed.as_bytes()).is_err());
    }
    let nested = format!(
        "{}null{}",
        "[".repeat(MAX_DEPTH + 1),
        "]".repeat(MAX_DEPTH + 1)
    );
    let deep = body.replace(
        &format!("\"input\":{input}"),
        &format!("\"input\":{{\"nested\":{nested},\"padding\":{input}}}"),
    );
    assert!(decode_frame(deep.as_bytes()).is_err());
    let duplicate = body.replace(
        &format!("\"input\":{input}"),
        &format!("\"input\":{{\"nested\":{{\"same\":1,\"same\":2}},\"padding\":{input}}}"),
    );
    assert!(decode_frame(duplicate.as_bytes()).is_err());
    assert!(
        decode_frame_with_limits(
            body.as_bytes(),
            DecodeLimits {
                nodes: 12,
                ..DecodeLimits::default()
            }
        )
        .is_err()
    );
    assert!(
        decode_frame_with_limits(
            body.as_bytes(),
            DecodeLimits {
                string_bytes: 1024,
                ..DecodeLimits::default()
            }
        )
        .is_err()
    );
}
