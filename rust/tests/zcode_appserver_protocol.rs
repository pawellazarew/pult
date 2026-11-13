//! Constructed fixtures from pinned public schema, NOT recorded/live CLI samples.
use pult_core::zcode_appserver_protocol::*;
use serde_json::{Value, json};

fn id() -> RequestId { RequestId::string("rpc-1").unwrap() }
fn wire(v: Value) -> Vec<u8> { let mut b=serde_json::to_vec(&v).unwrap();b.push(b'\n');b }
fn response(v: Value) -> Response {match decode_frame(&wire(v)).unwrap(){Incoming::Response(r)=>r,_=>panic!("expected response")}}
fn helper() -> StdioMcpServer {StdioMcpServer::new("pult-memory","/pult-memory-mcp","/project",&["--stdio".into()],&[("PULT_MEMORY_KEY".into(),"private-fixture-key".into())]).unwrap()}
fn workspace() -> Workspace {Workspace::new("/project","workspace-1").unwrap()}
fn snapshot() -> Value {json!({
 "protocol":{"name":"ZCode Protocol","version":1},
 "session":{"sessionId":"s1","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"},"sessionKind":"interactive","title":"","mode":"guarded","status":"idle","createdAt":1,"updatedAt":2},
 "settings":{"model":{"available":[]},"thoughtLevel":{"enabled":false,"available":[]},"mode":{"current":"guarded"}},
 "projection":{"sessionId":"s1","status":"idle","mode":"guarded","turnCount":0,"totalTokenCount":0,"contextUsed":0,"contextWindow":128000,"pendingPermissions":[],"activeToolCalls":[],"backgroundJobs":[]},
 "runtime":{"eventSeq":4,"stateRevision":7,"pendingRequestIds":[]},"messages":[]
})}
fn started() -> Value {json!({"method":"session/event","params":{"eventId":"e1","sessionId":"s1","turnId":"t1","seq":5,"timestamp":100,"type":"turn.started","payload":{"turnNumber":1,"input":"private prompt","inputId":"host-input-1","queryId":"host-query-1"}}})}
fn permission() -> Value {json!({"id":"reverse-1","method":"interaction/requestPermission","params":{"requestId":"permission-1","sessionId":"s1","turnId":"t1","toolCallId":"tool-1","toolName":"Bash","reason":"private reason","riskLevel":"high","input":{"command":"private command"},"options":[{"optionId":"allow","kind":"allow","name":"Allow","response":{"decision":"allow","permissionUpdates":[{"type":"addRules","behavior":"allow","rules":[{"toolName":"Bash","ruleContent":"*"}]}]}}]}})}

#[test]
fn argv_has_only_pinned_entrypoint() {assert_eq!(APP_SERVER_ARGV,["app-server","--stdio"]);}
#[test]
fn exact_create_and_resume_requests_use_private_mcp_array() {
    for (request,method) in [(OutboundRequest::create(id(),"s1",workspace(),vec![helper()]).unwrap(),"session/create"),(OutboundRequest::resume(id(),"s1",workspace(),vec![helper()]).unwrap(),"session/resume")] {
        let bytes=request.encode().unwrap();
        let value:Value=serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value,json!({"id":"rpc-1","method":method,"params":{"sessionId":"s1","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"},"mcpServers":[{"name":"pult-memory","command":"/pult-memory-mcp","cwd":"/project","args":["--stdio"],"env":[{"name":"PULT_MEMORY_KEY","value":"private-fixture-key"}],"isolation":"session"}]}}));
        assert!(bytes.ends_with(b"\n"));assert!(value["params"].get("content").is_none());assert!(value.get("jsonrpc").is_none());
    }
}
#[test]
fn exact_send_and_close_requests_do_not_imply_started_or_cleanup() {
    let send=OutboundRequest::send(id(),"s1","input-1","query-1","hello\nworld").unwrap().encode().unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&send).unwrap(),json!({"id":"rpc-1","method":"session/send","params":{"sessionId":"s1","inputId":"input-1","queryId":"query-1","content":"hello\nworld"}}));
    assert_eq!(serde_json::from_slice::<Value>(&OutboundRequest::close(id(),"s1").unwrap().encode().unwrap()).unwrap(),json!({"id":"rpc-1","method":"session/close","params":{"sessionId":"s1"}}));
}
#[test]
fn send_ack_is_distinct_and_correlated() {
    let ack=response(json!({"id":"rpc-1","result":{"accepted":true,"sessionId":"s1","stateRevision":9}})).send_ack(&id(),"s1").unwrap();
    assert_eq!(ack.session_id,"s1");assert_eq!(ack.state_revision,9);
    for result in [json!({"accepted":false,"sessionId":"s1","stateRevision":9}),json!({"accepted":true,"sessionId":"s1","stateRevision":9,"started":true}),json!({"accepted":true,"sessionId":"s1","stateRevision":-1})] {assert!(response(json!({"id":"rpc-1","result":result})).send_ack(&id(),"s1").is_err());}
    assert!(response(json!({"id":"rpc-2","result":{"accepted":true,"sessionId":"s1","stateRevision":9}})).send_ack(&id(),"s1").is_err());
    assert!(response(json!({"id":"rpc-1","result":{"accepted":true,"sessionId":"other","stateRevision":9}})).send_ack(&id(),"s1").is_err());
}
#[test]
fn snapshot_ack_extracts_identity_and_runtime_without_input_acceptance() {
    for method in [SnapshotMethod::Create,SnapshotMethod::Resume] {
        let ack=response(json!({"id":"rpc-1","result":snapshot()})).snapshot_ack(&id(),"s1",method).unwrap();
        assert_eq!(ack.method,method);assert_eq!(ack.session_id,"s1");assert_eq!(ack.workspace_path,"/project");assert_eq!(ack.workspace_key,"workspace-1");assert_eq!(ack.state_revision,7);assert_eq!(ack.event_seq,4);assert_eq!(ack.active_turn_id,None);assert_eq!(ack.untrusted_snapshot(),&snapshot());
    }
    assert!(response(json!({"id":"rpc-1","result":snapshot()})).send_ack(&id(),"s1").is_err());
}
#[test]
fn snapshot_critical_headers_fail_closed() {
    for (path,value) in [(vec!["protocol","version"],json!(2)),(vec!["protocol","name"],json!("Codex")),(vec!["session","sessionId"],json!("other")),(vec!["projection","sessionId"],json!("other")),(vec!["runtime","stateRevision"],json!(-1)),(vec!["runtime","pendingRequestIds"],json!([null])),(vec!["session","workspace","workspacePath"],json!(""))] {
        let mut s=snapshot();let mut cursor=&mut s;for k in &path[..path.len()-1]{cursor=&mut cursor[*k];}cursor[path[path.len()-1]]=value;
        assert!(response(json!({"id":"rpc-1","result":s})).snapshot_ack(&id(),"s1",SnapshotMethod::Resume).is_err());
    }
    let mut s=snapshot();s["authority"]=json!("owner");assert!(response(json!({"id":"rpc-1","result":s})).snapshot_ack(&id(),"s1",SnapshotMethod::Create).is_err());
}
#[test]
fn snapshot_retains_bounded_opaque_projection_not_full_schema_claim() {
    let mut s=snapshot();s["projection"]["opaque-future-data"]=json!({"private":"untrusted"});
    let ack=response(json!({"id":"rpc-1","result":s.clone()})).snapshot_ack(&id(),"s1",SnapshotMethod::Resume).unwrap();assert_eq!(ack.untrusted_snapshot(),&s);
}
#[test]
fn close_ack_is_not_process_cleanup() {
    assert_eq!(response(json!({"id":"rpc-1","result":{"closed":true}})).close_ack(&id()).unwrap().closed,Some(true));
    assert_eq!(response(json!({"id":"rpc-1","result":{}})).close_ack(&id()).unwrap().closed,None);
    assert!(response(json!({"id":"rpc-1","result":{"closed":true,"pid":42}})).close_ack(&id()).is_err());
}
#[test]
fn native_turn_started_keeps_host_correlation_as_candidate_only() {
    match decode_frame(&wire(started())).unwrap(){Incoming::TurnStarted(e)=>{assert_eq!(e.session_id,"s1");assert_eq!(e.turn_id.as_deref(),Some("t1"));assert_eq!(e.input_id.as_deref(),Some("host-input-1"));assert_eq!(e.query_id.as_deref(),Some("host-query-1"));assert_eq!(e.seq,5);},_=>panic!("expected candidate")}
    let mut missing=started();missing["params"].as_object_mut().unwrap().remove("turnId");missing["params"]["payload"].as_object_mut().unwrap().remove("inputId");
    match decode_frame(&wire(missing)).unwrap(){Incoming::TurnStarted(e)=>{assert!(e.turn_id.is_none());assert!(e.input_id.is_none());},_=>panic!("expected uncorrelated candidate")}
}
#[test]
fn turn_started_unknown_and_malformed_fields_fail_closed() {
    for (key,v) in [("inputId",json!("")),("turnNumber",json!(-1)),("input",json!({"text":"wrong"})),("authority",json!("owner")),("workflowLaunch",json!({}))] {let mut s=started();s["params"]["payload"][key]=v;assert!(decode_frame(&wire(s)).is_err());}
    let mut s=started();s["params"]["type"]=json!("turn.completed");assert!(decode_frame(&wire(s)).is_err());
}
#[test]
fn runtime_preferences_reverse_defaults_disable_host_capabilities() {
    let request=json!({"id":17,"method":"session/requestRuntimePreferences","params":{"sessionId":"s1","scope":"runtime-materialization","workspace":{"workspacePath":"/project","workspaceKey":"workspace-1"}}});
    match decode_frame(&wire(request)).unwrap(){Incoming::Reverse(r)=>{assert_eq!(serde_json::from_slice::<Value>(&r.default_deny().unwrap()).unwrap(),json!({"id":17,"result":{"nativeSearchEnhancementsEnabled":false,"toolSearchMode":"off","subagentRuntimeConfigEnabled":false,"appControlEnabled":false,"memoryEnabled":false,"askUserQuestionAutoResolutionEnabled":false,"modelContextBudgetStrategy":"preflight-v1"}}));},_=>panic!("expected reverse")}
}
#[test]
fn permission_reverse_never_uses_offered_allow_or_persistent_rules() {
    match decode_frame(&wire(permission())).unwrap(){Incoming::Reverse(r)=>assert_eq!(serde_json::from_slice::<Value>(&r.default_deny().unwrap()).unwrap(),json!({"id":"reverse-1","result":{"decision":"deny","reason":"Host approval is unavailable"}})),_=>panic!("expected permission")}
    let mut p=permission();p["params"]["options"][0]["response"]["owner"]=json!(true);assert!(decode_frame(&wire(p)).is_err());
    let mut p=permission();p["params"]["options"]=json!([]);assert!(decode_frame(&wire(p)).is_err());
}
#[test]
fn user_question_reverse_cancels_without_echoing_private_data() {
    let p=json!({"id":"question-rpc","method":"interaction/requestUserInput","params":{"requestId":"q1","sessionId":"s1","prompt":"private prompt","questions":[{"question":"private question","header":"Choose","options":[{"value":"yes","label":"Yes"}],"multiSelect":false}]}});
    match decode_frame(&wire(p)).unwrap(){Incoming::Reverse(r)=>assert_eq!(serde_json::from_slice::<Value>(&r.default_deny().unwrap()).unwrap(),json!({"id":"question-rpc","result":{"action":"cancel","reason":"Host input is unavailable"}})),_=>panic!("expected question")}
}
#[test]
fn protocol_errors_keep_only_bounded_code_without_reflecting_private_message() {
    let r=response(json!({"id":"rpc-1","error":{"code":-32601,"message":"private failure","data":{"private-key":"secret"}}}));assert_eq!(r.error_code(),Some(-32601));assert!(r.send_ack(&id(),"s1").is_err());
}
#[test]
fn framing_and_ambiguous_envelopes_fail_closed() {
    for bytes in [b"{}".as_slice(),b"{}\n{}\n",b"Content-Length: 2\r\n\r\n{}",b"\n",b"{\"id\":1,\"id\":2,\"result\":{}}\n",b"{\"id\":1,\"result\":{},\"error\":{}}\n",b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n",b"{\"id\":null,\"result\":{}}\n",b"{\"id\":1,\"method\":\"initialize\",\"params\":{}}\n",b"{\"id\":1,\"result\":{\"nested\":{\"dup\":1,\"dup\":2}}}\n",b"{\"id\":1,\"result\":null} trailing\n"] {assert!(decode_frame(bytes).is_err());}
    assert!(decode_frame(b"{\"id\":1,\"result\":null}\r\n").is_ok());
}
#[test]
fn error_strings_never_expose_input_bytes() {
    let e=decode_frame(b"SECRET_BAD_FRAME\n").err().unwrap();assert!(!format!("{e:?} {e}").contains("SECRET_BAD_FRAME"));
}
#[test]
fn frame_depth_nodes_strings_and_integer_budgets_are_bounded() {
    assert!(decode_frame(&vec![b' ';MAX_FRAME_BYTES+1]).is_err());
    let nested=format!("{{\"id\":1,\"result\":{}null{}}}\n","[".repeat(MAX_DEPTH+1),"]".repeat(MAX_DEPTH+1));assert!(decode_frame(nested.as_bytes()).is_err());
    assert!(decode_frame(&wire(json!({"id":1,"result":vec![0;MAX_NODES]}))).is_err());
    assert!(decode_frame(&wire(json!({"id":1,"result":"x".repeat(MAX_STRING_BYTES+1)}))).is_err());
    assert!(decode_frame(b"{\"id\":9007199254740992,\"result\":{}}\n").is_err());
    assert!(RequestId::integer(i64::MIN).is_err());
}
#[test]
fn configurable_history_budget_accepts_large_snapshot_without_truncation() {
    let mut s=snapshot();s["messages"]=json!((0..200).map(|_|json!({"opaque":"x".repeat(2048)})).collect::<Vec<_>>());
    let bytes=wire(json!({"id":"rpc-1","result":s.clone()}));assert!(bytes.len()>MAX_FRAME_BYTES);assert!(decode_frame(&bytes).is_err());
    let limits=DecodeLimits{frame_bytes:1024*1024,..DecodeLimits::default()};
    match decode_frame_with_limits(&bytes,limits).unwrap(){Incoming::Response(r)=>assert_eq!(r.snapshot_ack(&id(),"s1",SnapshotMethod::Resume).unwrap().untrusted_snapshot(),&s),_=>panic!("expected snapshot")}
    assert!(decode_frame_with_limits(&bytes,DecodeLimits{frame_bytes:usize::MAX,..limits}).is_err());
}
#[test]
fn mcp_empty_duplicate_environment_and_config_budgets_fail_closed() {
    assert!(OutboundRequest::create(id(),"s1",workspace(),vec![]).is_err());
    assert!(OutboundRequest::resume(id(),"s1",workspace(),vec![helper(),helper()]).is_err());
    for env in [vec![("KEY".into(),"x".into());2],vec![("BAD=KEY".into(),"x".into())],vec![("KEY".into(),"x".repeat(16*1024+1))],vec![("KEY".into(),"x".into());MAX_ENV_ENTRIES+1]] {assert!(StdioMcpServer::new("name","helper","/project",&[],&env).is_err());}
    let env=(0..8).map(|i|(format!("KEY_{i}"),"x".repeat(16*1024))).collect::<Vec<_>>();assert!(StdioMcpServer::new("name","helper","/project",&[],&env).is_err());
    assert!(helper().protocol_version("invented").is_err());assert!(helper().timeout_ms(0).is_err());
}
#[test]
fn builder_checks_ids_even_when_enum_variant_bypasses_constructor() {
    let request=OutboundRequest::close(RequestId::Integer(i64::MAX),"s1").unwrap();assert!(request.encode().is_err());
    assert!(OutboundRequest::send(id(),"s1","","q1","prompt").is_err());
    assert!(OutboundRequest::send(id(),"s1","i1","q1",&"x".repeat(MAX_STRING_BYTES+1)).is_err());
}
