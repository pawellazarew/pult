use pult_core::claude_launch::{self, Options, Permissions};
use pult_core::turn_snapshot::Approval;
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncWriteExt;

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|xs| xs.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}
fn options(value: &Value) -> Options {
    Options {
        session_id: value["sessionId"]
            .as_str()
            .unwrap_or("fixture-session")
            .into(),
        resume: value["resume"].as_bool().unwrap_or(false),
        fork_on_resume: value["forkOnResume"].as_bool().unwrap_or(false),
        approval: match value["approval"].as_str() {
            Some("read-only") => Approval::ReadOnly,
            Some("workspace") => Approval::Workspace,
            Some("full") => Approval::Full,
            Some("inherit") => Approval::Inherit,
            _ => Approval::Ask,
        },
        model: value["model"].as_str().map(str::to_owned),
        effort: value["effort"].as_str().map(str::to_owned),
        setting_sources: value["settingSources"].as_str().map(str::to_owned),
        mcp_config_path: value["mcpConfigPath"].as_str().map(str::to_owned),
        permissions: value
            .get("permissions")
            .map(|v| serde_json::from_value(v.clone()).unwrap())
            .unwrap_or_default(),
        protect_dirs: strings(&value["protectDirs"]),
        add_dirs: strings(&value["addDirs"]),
        add_dir_roots: strings(&value["addDirRoots"]),
    }
}

async fn oracle(cases: &Value) -> Value {
    let module = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/adapters/claude/argv.js");
    let script = r#"
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
(async () => {
 if (!process.version.startsWith('v24.')) throw new Error('Node24 required');
 const m = await import(pathToFileURL(process.argv[1]).href);
 const cases = JSON.parse(fs.readFileSync(0,'utf8'));
 process.stdout.write(JSON.stringify(cases.map(c => c.op === 'argv' ? m.buildClaudeArgv(c.options)
   : c.op === 'slash' ? m.isSlashCommandTurn(c.text,c.attachments)
   : c.op === 'dirs' ? m.claudeAddDirs(c.dirs,c.protect,c.roots)
   : c.op === 'user' ? JSON.parse(m.userTurnLine(c.text,c.uuid,c.context,c.blocks)) : null)));
})().catch(() => {process.stderr.write('build Node24 Claude argv oracle first');process.exitCode=1;});
"#;
    let mut child = tokio::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(module)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut input = child.stdin.take().unwrap();
        input
            .write_all(&serde_json::to_vec(cases).unwrap())
            .await
            .unwrap();
        input.shutdown().await.unwrap();
        drop(input);
        child.wait_with_output().await.unwrap()
    })
    .await
    .expect("Claude launch oracle watchdog");
    assert!(
        output.status.success(),
        "Node24 Claude launch oracle failed"
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn launch_modes_guards_and_resume_match_actual_node() {
    let mut cases = Vec::new();
    for approval in ["ask", "read-only", "workspace", "full", "inherit"] {
        for resume in [false, true] {
            for broker in [false, true] {
                let mut opt = json!({"sessionId":"fixture-session","resume":resume,"forkOnResume":true,"model":"haiku","effort":"low","settingSources":"user,project","approval":approval,"protectDirs":["/private/pult-fixture/run","/private/m[a]{b}(c)*?\\x"],"addDirs":["/private/pult-fixture","/private/pult-fixture/run/a","/private/pult-fixture/attachments/chat","/","/home/user","/home/user/project","/home/user/project"],"addDirRoots":["/home/user","/private/pult-fixture"],"permissions":{"allow":["Read","Read"],"ask":["Bash","Bash"],"deny":["Write"]}});
                if broker {
                    opt["mcpConfigPath"] = json!("/private/pult-fixture/run/fixture.json");
                }
                cases.push(json!({"op":"argv","options":opt}));
            }
        }
    }
    let expected = oracle(&json!(cases)).await;
    for (i, case) in cases.iter().enumerate() {
        assert_eq!(
            json!(claude_launch::argv(&options(&case["options"])).unwrap()),
            expected[i],
            "case {i}"
        );
    }
}

#[tokio::test]
async fn slash_commands_preserve_javascript_boundary_semantics() {
    let mut cases = Vec::new();
    for text in [
        "",
        "/",
        "//help",
        "/help",
        "/help arg",
        "/Users/user/code",
        " /help",
        "/help/arg",
        "/help\narg",
        "/\u{feff}help",
        "/\u{85}help",
        "/help\u{85}/arg",
        "/help\u{feff}/arg",
        "/context😀",
    ] {
        for attachments in [0, 1] {
            cases.push(json!({"op":"slash","text":text,"attachments":attachments}));
        }
    }
    let expected = oracle(&json!(cases)).await;
    for (i, case) in cases.iter().enumerate() {
        assert_eq!(
            json!(claude_launch::is_slash_command_turn(
                case["text"].as_str().unwrap(),
                case["attachments"].as_u64().unwrap() as usize
            )),
            expected[i],
            "slash case {i}"
        );
    }
}

#[tokio::test]
async fn user_data_and_attachment_blocks_match_node_without_rewriting_text() {
    let cases = json!([
        {"op":"user","text":"привет 😀","uuid":"input-1","context":"<context>fixture</context>","blocks":[]},
        {"op":"user","text":"","uuid":"input-2","context":"","blocks":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"fixture"}}]},
        {"op":"user","text":"/context","uuid":"input-3","blocks":[]}
    ]);
    let expected = oracle(&cases).await;
    for (i, case) in cases.as_array().unwrap().iter().enumerate() {
        assert_eq!(
            claude_launch::user_turn(
                case["text"].as_str().unwrap(),
                case["uuid"].as_str().unwrap(),
                case["context"].as_str(),
                case["blocks"].as_array().unwrap()
            )
            .unwrap(),
            expected[i]
        );
    }
}

#[test]
fn missing_broker_ignores_mcp_rules_and_never_claims_host_prompts() {
    let opt = Options {
        session_id: "fixture-session".into(),
        permissions: Permissions {
            allow: vec!["PRIVATE_TEXT".into()],
            ..Default::default()
        },
        ..Default::default()
    };
    let args = claude_launch::argv(&opt).unwrap();
    assert!(!args.iter().any(|v| v.contains("PRIVATE_TEXT")));
    assert_eq!(
        args[args
            .iter()
            .position(|v| v == "--permission-prompts")
            .unwrap()
            + 1],
        "none"
    );
    assert!(
        !args
            .iter()
            .any(|v| v == "--mcp-config" || v == "--permission-prompt-tool")
    );
}

#[test]
fn invalid_arguments_reject_without_echoing_values() {
    for field in ["session", "model", "effort", "sources", "mcp"] {
        let mut opt = Options {
            session_id: "fixture-session".into(),
            ..Default::default()
        };
        let invalid = "PRIVATE_VALUE\0fixture".to_owned();
        match field {
            "session" => opt.session_id = invalid,
            "model" => opt.model = Some(invalid),
            "effort" => opt.effort = Some(invalid),
            "sources" => opt.setting_sources = Some(invalid),
            _ => opt.mcp_config_path = Some(invalid),
        }
        let error = claude_launch::argv(&opt).unwrap_err();
        assert!(!error.to_string().contains("PRIVATE_VALUE"));
    }
    let opt = Options {
        session_id: "fixture-session".into(),
        setting_sources: Some("--dangerously-skip-permissions".into()),
        ..Default::default()
    };
    assert!(claude_launch::argv(&opt).is_err());
}

#[tokio::test]
async fn add_directory_boundaries_match_node_without_widening_roots() {
    let cases = json!([
      {"op":"dirs","dirs":["/p/run","/p/run/x","/p/run/","/p","/p/","/","rel","-x","/a\u{0000}b","/home/user","/home","/home/user/project","/p/runner","/p/attachments/chat"],"protect":["/p/run"],"roots":["/home/user","/p"]},
      {"op":"dirs","dirs":["/","//","/x","/x","/x/","/x/y"],"protect":[],"roots":[]}
    ]);
    let expected = oracle(&cases).await;
    for (i, case) in cases.as_array().unwrap().iter().enumerate() {
        assert_eq!(
            json!(claude_launch::add_dirs(
                &strings(&case["dirs"]),
                &strings(&case["protect"]),
                &strings(&case["roots"])
            )),
            expected[i]
        );
    }
}

#[test]
fn private_question_config_reserves_pult_without_owner_authority() {
    let mut servers = serde_json::Map::new();
    servers.insert("pult".into(), json!({"command":"foreign"}));
    servers.insert("other".into(), json!({"command":"other-fixture"}));
    let key = "a".repeat(64);
    let body = claude_launch::mcp_ask_config(
        "/opt/pult/pultd-rust",
        "/private/pult-fixture",
        "chat",
        &key,
        servers,
    )
    .unwrap();
    let pult = &body["mcpServers"]["pult"];
    assert_eq!(pult["command"], "/opt/pult/pultd-rust");
    assert_eq!(
        pult["args"],
        json!(["--home", "/private/pult-fixture", "mcp-ask"])
    );
    assert_eq!(pult["env"].as_object().unwrap().len(), 3);
    assert_eq!(pult["env"]["PULT_ASK_KEY"], key);
    assert_eq!(body["mcpServers"]["other"]["command"], "other-fixture");
    assert!(!body.to_string().contains("run/token"));
    let error = claude_launch::mcp_ask_config(
        "/opt/pult/pultd-rust",
        "/private/pult-fixture",
        "chat",
        "PRIVATE_INVALID_CREDENTIAL",
        Default::default(),
    )
    .unwrap_err();
    assert!(!error.to_string().contains("PRIVATE_"));
}

#[test]
fn question_config_accepts_scoped_purpose_key_without_an_owner_token() {
    let key = format!("pa_{}", "a".repeat(64));
    let config = claude_launch::mcp_ask_config(
        "/opt/pult/pultd-rust",
        "/private/pult-fixture",
        "chat",
        &key,
        Default::default(),
    )
    .unwrap();
    assert_eq!(config["mcpServers"]["pult"]["env"]["PULT_ASK_KEY"], key);
    assert!(!config.to_string().contains("run/token"));
}
