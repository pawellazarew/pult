//! Trusted Claude launch policy. User text goes only to stdin, never argv.
//! This module does not spawn, grant authority or validate filesystem identity.
use crate::turn_snapshot::Approval;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const PERMISSION_TOOL: &str = "mcp__pult__ask";
const MAX_ARGUMENT_BYTES: usize = 1024 * 1024;
// 25 MiB of native images expand in base64, plus bounded text/metadata.
pub const MAX_INPUT_BYTES: usize = 36 * 1024 * 1024;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Permissions {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ask: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
}
impl Permissions {
    fn merge(&mut self, other: &Self) {
        for (target, source) in [
            (&mut self.allow, &other.allow),
            (&mut self.ask, &other.ask),
            (&mut self.deny, &other.deny),
        ] {
            for value in source {
                if !target.contains(value) {
                    target.push(value.clone());
                }
            }
        }
    }
    fn empty(&self) -> bool {
        self.allow.is_empty() && self.ask.is_empty() && self.deny.is_empty()
    }
}

/// Host-supplied values. Commands/RPC cannot add arbitrary switches.
#[derive(Default)]
pub struct Options {
    pub session_id: String,
    pub resume: bool,
    pub fork_on_resume: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub setting_sources: Option<String>,
    pub approval: Approval,
    pub mcp_config_path: Option<String>,
    pub permissions: Permissions,
    pub protect_dirs: Vec<String>,
    pub add_dirs: Vec<String>,
    pub add_dir_roots: Vec<String>,
}

pub fn escape_rule_path(path: &str) -> String {
    let mut result = String::new();
    for ch in path.chars() {
        if "[]{}()*?\\".contains(ch) {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}
fn within(child: &str, parent: &str) -> bool {
    let child = child.trim_end_matches('/');
    let parent = parent.trim_end_matches('/');
    child == parent
        || child
            .strip_prefix(parent)
            .is_some_and(|rest| rest.starts_with('/'))
}
pub fn add_dirs(dirs: &[String], protect: &[String], roots: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    dirs.iter()
        .filter(|dir| {
            seen.insert((*dir).clone())
                && dir.starts_with('/')
                && !dir.contains('\0')
                && !protect.iter().any(|p| within(dir, p) || within(p, dir))
                && !std::iter::once("/")
                    .chain(roots.iter().map(String::as_str))
                    .any(|r| within(r, dir))
        })
        .cloned()
        .collect()
}
pub fn guard_permissions(protect: &[String], approval: Approval) -> Permissions {
    Permissions {
        ask: if approval == Approval::ReadOnly {
            vec!["Bash".into()]
        } else {
            vec![]
        },
        deny: protect
            .iter()
            .flat_map(|path| {
                let escaped = escape_rule_path(path);
                [
                    format!("Read(/{escaped}/**)"),
                    format!("Edit(/{escaped}/**)"),
                ]
            })
            .collect(),
        ..Default::default()
    }
}

pub fn argv(options: &Options) -> Result<Vec<String>> {
    crate::turn_snapshot::TurnSettings {
        model: options.model.clone(),
        effort: options.effort.clone(),
        approval: options.approval,
        ..Default::default()
    }
    .validate(crate::turn_snapshot::Provider::Claude)?;
    ensure!(
        !options.session_id.is_empty(),
        "Claude session identity is missing"
    );
    ensure!(
        options.session_id.len() <= 512
            && !options.session_id.starts_with('-')
            && !options.session_id.chars().any(char::is_control),
        "invalid Claude session identity"
    );
    if let Some(path) = &options.mcp_config_path {
        ensure!(
            path.starts_with('/') && !path.contains('\0'),
            "invalid Claude MCP configuration path"
        );
    }
    if let Some(sources) = &options.setting_sources {
        ensure!(!sources.starts_with('-'), "invalid Claude setting sources");
    }
    let mut args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--forward-subagent-text",
    ]
    .map(str::to_owned)
    .to_vec();
    args.extend([
        if options.resume {
            "--resume"
        } else {
            "--session-id"
        }
        .into(),
        options.session_id.clone(),
    ]);
    if options.resume && options.fork_on_resume {
        args.push("--fork-session".into());
    }
    for (flag, value) in [
        ("--model", &options.model),
        ("--effort", &options.effort),
        ("--setting-sources", &options.setting_sources),
    ] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            args.extend([flag.into(), value.clone()]);
        }
    }
    let mode = match options.approval {
        Approval::ReadOnly | Approval::Ask => Some("manual"),
        Approval::Workspace => Some("acceptEdits"),
        Approval::Full => Some("bypassPermissions"),
        Approval::Inherit => None,
    };
    if let Some(mode) = mode {
        args.extend(["--permission-mode".into(), mode.into()]);
    }
    if options.approval == Approval::ReadOnly {
        args.extend(
            [
                "--disallowedTools",
                "Write",
                "Edit",
                "MultiEdit",
                "NotebookEdit",
                "ExitPlanMode",
            ]
            .map(str::to_owned),
        );
    }
    let dirs = add_dirs(
        &options.add_dirs,
        &options.protect_dirs,
        &options.add_dir_roots,
    );
    if !dirs.is_empty() {
        args.push("--add-dir".into());
        args.extend(dirs);
    }
    if let Some(path) = &options.mcp_config_path {
        args.extend([
            "--permission-prompts".into(),
            "host".into(),
            "--mcp-config".into(),
            path.clone(),
            "--strict-mcp-config".into(),
            "--permission-prompt-tool".into(),
            PERMISSION_TOOL.into(),
        ]);
    } else {
        args.extend(["--permission-prompts".into(), "none".into()]);
    }
    let mut permissions = Permissions::default();
    permissions.merge(&guard_permissions(&options.protect_dirs, options.approval));
    if options.mcp_config_path.is_some() {
        permissions.merge(&options.permissions);
    }
    if !permissions.empty() {
        args.extend([
            "--settings".into(),
            serde_json::to_string(&json!({"permissions":permissions}))?,
        ]);
    }
    let mut bytes = 0usize;
    for arg in &args {
        ensure!(!arg.contains('\0'), "Claude argument contains NUL");
        bytes = bytes
            .checked_add(arg.len() + 1)
            .ok_or_else(|| anyhow::anyhow!("Claude arguments exceed budget"))?;
        ensure!(
            bytes <= MAX_ARGUMENT_BYTES,
            "Claude arguments exceed budget"
        );
    }
    Ok(args)
}

pub fn is_slash_command_turn(text: &str, attachments: usize) -> bool {
    if attachments != 0 {
        return false;
    }
    let Some(tail) = text.strip_prefix('/') else {
        return false;
    };
    let mut token = false;
    for ch in tail.chars() {
        if js_whitespace(ch) {
            return token;
        }
        if ch == '/' {
            return false;
        }
        token = true;
    }
    token
}
pub(crate) fn js_whitespace(ch: char) -> bool {
    matches!(ch,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}

/// Already validated native attachment blocks; text and context stay separate.
pub fn user_turn(
    text: &str,
    uuid: &str,
    runtime_context: Option<&str>,
    attachments: &[Value],
) -> Result<Value> {
    ensure!(
        !uuid.is_empty() && uuid.len() <= 512 && !uuid.chars().any(char::is_control),
        "invalid Claude message identity"
    );
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(json!({"type":"text","text":text}));
    }
    content.extend_from_slice(attachments);
    if let Some(context) = runtime_context.filter(|v| !v.is_empty()) {
        content.push(json!({"type":"text","text":context}));
    }
    let frame = json!({"type":"user","message":{"role":"user","content":content},"uuid":uuid});
    ensure!(
        serde_json::to_vec(&frame)?.len() <= MAX_INPUT_BYTES,
        "Claude input exceeds frame budget"
    );
    Ok(frame)
}

/// Secret-bearing private-file payload, never journal or diagnostic data.
/// The helper is the Rust executable; no Node runtime or owner token is passed.
pub fn mcp_ask_config(
    helper: &str,
    home: &str,
    session: &str,
    ask_key: &str,
    mut servers: serde_json::Map<String, Value>,
) -> Result<Value> {
    ensure!(
        helper.starts_with('/')
            && home.starts_with('/')
            && !helper.contains('\0')
            && !home.contains('\0'),
        "invalid Claude MCP helper location"
    );
    ensure!(
        !session.is_empty() && session.len() <= 128 && !session.chars().any(char::is_control),
        "invalid Claude MCP session"
    );
    let raw_key = ask_key.strip_prefix("pa_").unwrap_or(ask_key);
    ensure!(
        raw_key.len() == 64
            && raw_key
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid Claude question credential"
    );
    servers.insert(
        "pult".into(),
        json!({
            "command":helper,"args":["--home",home,"mcp-ask"],
            "env":{"PULT_HOME":home,"PULT_ASK_SESSION":session,"PULT_ASK_KEY":ask_key}
        }),
    );
    let body = json!({"mcpServers":servers});
    ensure!(
        serde_json::to_vec(&body)?.len() <= MAX_ARGUMENT_BYTES,
        "Claude MCP configuration exceeds budget"
    );
    Ok(body)
}
