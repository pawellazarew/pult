use pult_core::{turn_snapshot::Approval, worker_env::Environment, zcode_launch::*};
use serde_json::{Value, json};
#[path = "support/zcode_oracle.rs"]
mod support;
fn options(approval: Approval) -> Options<'static> {
    Options {
        prompt: "raw user text\n😀",
        cwd: "/project folder",
        resume_session_id: Some("sess_confirmed"),
        approval,
        model: Some("metadata-model"),
        effort: Some("high"),
    }
}
#[tokio::test]
async fn actual_node_modes_context_languages_resume_and_metadata() {
    let mut cases = vec![];
    let mut actual = vec![];
    for approval in [
        Approval::ReadOnly,
        Approval::Ask,
        Approval::Workspace,
        Approval::Full,
        Approval::Inherit,
    ] {
        for broker in [false, true] {
            for (language, typed) in [("ru", ContextLanguage::Ru), ("en", ContextLanguage::En)] {
                let opts = options(approval);
                cases.push(json!({"prompt":opts.prompt,"cwd":opts.cwd,"resumeSessionId":opts.resume_session_id,"approval":approval.as_str(),"model":opts.model,"effort":opts.effort,"broker":broker,"language":language}));
                actual.push(json!({"argv":argv(&opts).unwrap(),"context":approval_context_language(approval,broker,typed)}));
            }
        }
    }
    assert_eq!(
        Value::Array(actual),
        support::oracle(json!({"kind":"launch","cases":cases})).await
    );
}
#[test]
fn no_session_model_effort_or_mcp_flags_appear() {
    let mut opts = options(Approval::Ask);
    opts.resume_session_id = None;
    let args = argv(&opts).unwrap();
    assert_eq!(&args[..2], &["-p", opts.prompt]);
    for flag in [
        "--session-id",
        "--resume",
        "--model",
        "--effort",
        "--mcp-config",
        "--permission-prompt-tool",
    ] {
        assert!(!args.iter().any(|v| v == flag));
    }
    assert!(
        approval_context(Approval::Ask, true)
            .contains("Вопросов человеку в Inbox Пульт отсюда не приходит")
    );
}
#[test]
fn empty_resume_is_omitted_like_node() {
    let mut opts = options(Approval::Ask);
    opts.resume_session_id = Some("");
    assert!(!argv(&opts).unwrap().iter().any(|v| v == "--resume"));
}
#[test]
fn extra_environment_extracts_only_explicit_host_config_values() {
    let mut parent = Environment::new();
    for name in ENV_PASS {
        parent.insert(name.into(), format!("host-value-{name}").into());
    }
    for name in [
        "HOME",
        "PATH",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "ZCODE_OFFICIAL_ENDPOINT_TOKEN",
        "ANTHROPIC_API_KEY",
        "NODE_OPTIONS",
        "PULT_ASK_KEY",
        "PULT_MEMORY_TURN_KEY",
    ] {
        parent.insert(name.into(), "must-not-pass".into());
    }
    let selected = extra_env(&parent).unwrap();
    assert_eq!(selected.len(), 7);
    for name in ENV_PASS {
        assert_eq!(
            selected.get(std::ffi::OsStr::new(name)),
            parent.get(std::ffi::OsStr::new(name))
        );
    }
    assert!(extra_env(&Environment::new()).unwrap().is_empty());
    parent.insert(ENV_PASS[0].into(), "".into());
    assert_eq!(extra_env(&parent).unwrap().len(), 6);
}
#[test]
fn explicit_config_values_are_separate_from_filtered_base_and_route() {
    let parent: Environment = [
        ("HOME".into(), "/home".into()),
        ("PATH".into(), "/bin".into()),
        (ENV_PASS[0].into(), "/host/config.json".into()),
        ("HTTPS_PROXY".into(), "ambient".into()),
    ]
    .into_iter()
    .collect();
    let selected = extra_env(&parent).unwrap();
    let filtered = pult_core::worker_env::from_parent(&parent, &Environment::new()).unwrap();
    assert!(!filtered.contains_key(std::ffi::OsStr::new(ENV_PASS[0])));
    assert!(!filtered.contains_key(std::ffi::OsStr::new("HTTPS_PROXY")));
    let output = pult_core::worker_env::from_parent(&filtered, &selected).unwrap();
    assert_eq!(
        output.get(std::ffi::OsStr::new(ENV_PASS[0])).unwrap(),
        "/host/config.json"
    );
    assert_eq!(output.get(std::ffi::OsStr::new("HOME")).unwrap(), "/home");
}
#[test]
fn invalid_or_over_budget_config_environment_has_static_errors() {
    let mut parent = Environment::new();
    parent.insert(ENV_PASS[0].into(), "PRIVATE\0value".into());
    assert_eq!(extra_env(&parent).unwrap_err(), Error::Invalid);
    parent.insert(ENV_PASS[0].into(), "x".repeat(65536).into());
    assert_eq!(extra_env(&parent).unwrap_err(), Error::Capacity);
}
#[test]
fn prompt_and_path_validation_is_bounded_without_truncating() {
    let mut opts = options(Approval::Full);
    opts.prompt = "bad\0prompt";
    assert_eq!(argv(&opts).unwrap_err(), Error::Invalid);
    opts.prompt = "valid";
    opts.cwd = "relative";
    assert_eq!(argv(&opts).unwrap_err(), Error::Invalid);
    opts.cwd = "/project";
    let large = "x".repeat(65537);
    opts.prompt = &large;
    assert_eq!(argv(&opts).unwrap_err(), Error::Capacity);
}
#[tokio::test]
async fn actual_node_explicit_environment_keys_empty_values_and_unicode() {
    let mut all = serde_json::Map::new();
    for name in ENV_PASS {
        all.insert(name.into(), json!(format!("/host/配置/{name} 😀")));
    }
    all.insert(
        "ZCODE_OFFICIAL_ENDPOINT_TOKEN".into(),
        json!("not-forwarded"),
    );
    all.insert("PULT_ASK_KEY".into(), json!("not-forwarded"));
    all.insert("HTTPS_PROXY".into(), json!("not-forwarded"));
    let cases = vec![
        Value::Object(all),
        json!({"ZCODE_BASE_URL":"","ZCODE_TEST_BASE_URL":"   ","zcode_app_version":"not-forwarded"}),
        json!({}),
    ];
    let actual: Vec<Value> = cases
        .iter()
        .map(|case| {
            let env: Environment = case
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.into(), value.as_str().unwrap().into()))
                .collect();
            let selected = extra_env(&env).unwrap();
            Value::Object(
                selected
                    .iter()
                    .map(|(key, value)| {
                        (key.to_str().unwrap().into(), json!(value.to_str().unwrap()))
                    })
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        Value::Array(actual),
        support::oracle(json!({"kind":"env","cases":cases})).await
    );
}
#[tokio::test]
async fn actual_node_first_turn_and_empty_resume_preserve_raw_prompt() {
    let mut actual = vec![];
    let mut cases = vec![];
    for resume in [None, Some("")] {
        let opts = Options {
            prompt: "raw \"quoted\"\n😀",
            cwd: "/project",
            resume_session_id: resume,
            approval: Approval::Ask,
            model: Some("accepted-metadata"),
            effort: Some("high"),
        };
        cases.push(json!({"prompt":opts.prompt,"cwd":opts.cwd,"resumeSessionId":resume,"model":opts.model,"effort":opts.effort,"broker":false}));
        actual.push(
            json!({"argv":argv(&opts).unwrap(),"context":approval_context(Approval::Ask,false)}),
        );
    }
    assert_eq!(
        Value::Array(actual),
        support::oracle(json!({"kind":"launch","cases":cases})).await
    );
}
