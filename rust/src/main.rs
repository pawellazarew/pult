#![forbid(unsafe_code)]
use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
struct Args {
    #[arg(long, required_unless_present = "skill")]
    home: Option<PathBuf>,
    #[arg(long)]
    skill: bool,
    #[command(subcommand)]
    command: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    Daemon {
        #[command(subcommand)]
        action: DaemonAction,
    },
    Catalog,
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    Events {
        #[command(subcommand)]
        action: EventsAction,
    },
    Perm {
        #[command(subcommand)]
        action: PermAction,
    },
}

/// Memory administration and read-only session access.
#[derive(Subcommand)]
enum MemoryAction {
    Catalog {
        #[arg(long, default_value = "{}")]
        params: String,
    },
    Context {
        #[command(subcommand)]
        action: MemoryContextAction,
    },
    Add {
        #[arg(long)]
        params: String,
    },
    Update {
        #[arg(long)]
        params: String,
    },
    Forget {
        #[arg(long)]
        params: String,
    },
    Get {
        #[arg(long)]
        params: String,
    },
    List {
        #[arg(long, default_value = "{}")]
        params: String,
    },
    Search {
        #[arg(long)]
        params: String,
    },
    History {
        #[arg(long)]
        params: String,
    },
}

#[derive(Subcommand)]
enum MemoryContextAction {
    Bind {
        #[arg(long)]
        params: String,
    },
    Issue {
        #[arg(long)]
        params: String,
    },
    Revoke {
        #[arg(long)]
        params: String,
    },
    Status {
        #[arg(long, default_value = "{}")]
        params: String,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// Partial metadata creation with explicit JSON settings.
    Start {
        #[arg(long)]
        params: String,
    },
    List,
    /// Partial ordinary Codex execution.
    Prompt {
        name: String,
        text: String,
        #[arg(long)]
        attachments: Option<String>,
        #[arg(long, conflicts_with_all=["interrupt","steer"], help="Queue behind existing work; send immediately when idle")]
        queue: bool,
        #[arg(long, conflicts_with_all=["queue","steer"], help="Interrupt, wait for cleanup, then send a new task")]
        interrupt: bool,
        #[arg(long, conflicts_with_all=["queue","interrupt"], help="Clarify the active Codex turn without interrupting it")]
        steer: bool,
    },
    Stop {
        name: String,
        #[arg(long)]
        turn_id: Option<String>,
    },
    Read {
        name: String,
        #[arg(long, default_value = "0", allow_hyphen_values = true, num_args = 0..=1, default_missing_value = "")]
        since: String,
        #[arg(long, default_value = "text")]
        format: String,
    },
    Tree {
        name: String,
        #[arg(long)]
        json: bool,
    },
    Rename {
        name: String,
        words: Vec<String>,
        #[arg(long, conflicts_with = "words")]
        title: Option<String>,
    },
    Archive {
        name: String,
    },
    Unarchive {
        name: String,
    },
    Seen {
        name: String,
        #[arg(long)]
        unread: bool,
    },
}

#[derive(Subcommand)]
enum PermAction {
    List {
        #[arg(long)]
        name: Option<String>,
    },
    Resolve {
        id: String,
        #[arg(value_parser = ["allow", "deny"])]
        decision: String,
        #[arg(long, value_parser = ["once", "session", "rule"])]
        scope: Option<String>,
        #[arg(long)]
        answers: Option<String>,
        #[arg(long)]
        message: Option<String>,
    },
}

#[derive(Subcommand)]
enum EventsAction {
    Snapshot,
    History {
        #[arg(long)]
        session: String,
        #[arg(long)]
        before: Option<i64>,
        #[arg(long)]
        budget: Option<usize>,
    },
    Get {
        #[arg(required = true)]
        ids: Vec<u64>,
    },
    Tail {
        #[arg(long, default_value_t = 0)]
        since: u64,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        limit: Option<usize>,
    },
}

#[derive(Subcommand)]
enum DaemonAction {
    Serve,
    Status {
        /// Prepare the native runtime without starting a provider or a turn.
        #[arg(long)]
        initialize_runtime: bool,
    },
    Stop,
}

#[tokio::main]
async fn main() -> Result<()> {
    pult_core::panic_guard::install();
    let args = Args::parse();
    if args.skill {
        println!(
            "Rust core protocol 1. Use an explicit private scratch --home.\nCommands: agent start --params JSON, agent list, agent prompt NAME TEXT [--attachments JSON] [--queue|--interrupt|--steer], agent stop NAME [--turn-id ID], perm list [--name NAME], perm resolve ID allow|deny [--scope once|session|rule] [--answers JSON] [--message TEXT] (partial ordinary Codex staging), memory add|update|forget|get|list|search|history|catalog --params JSON, memory context bind|issue|revoke|status --params JSON (owner administration; no turn injection yet), daemon serve, daemon status, daemon stop, catalog, events tail, events snapshot, events history --session NAME [--before ID] [--budget BYTES], events get ID..., agent read NAME [--since N] [--format text|json], agent tree NAME [--json], agent rename NAME [TITLE] [--title TEXT], agent archive|unarchive NAME, agent seen NAME [--unread]\nPULT_MEMORY_KEY selects memory-only authentication for every RPC without reading the owner token or display config. Memory credentials allow only get/list/search/catalog; they never grant owner authority.\nOwner-token connections support memory.context.bind, memory.context.issue, memory.context.revoke, memory.context.status, memory.catalog, memory.add, memory.update, memory.forget, memory.get, memory.list, memory.search, memory.history, agent.read, agent.tree, agent.rename, agent.archive, agent.seen, daemon.status, daemon.stop, events.tail, events.subscribe, events.unsubscribe, events.snapshot, events.history, events.get and protocol.catalog.\nPartial owner methods: agent.start, agent.list, agent.prompt, agent.stop, agent.queue.send/resume/remove/move, perm.list, perm.resolve. Queue and Codex steering are available; background and remaining provider parity continue.\nHistory reads per-session files, snapshots and get use the global journal.\nSubscriptions replay committed events with bounded output. live=true sends an empty-session reset.\nevents.emit requires PULT_TEST=1 and is for deterministic verification.\nJournal append is acknowledged after sync. A failed append has an unknown outcome until replay.\nOther catalogued methods return not_implemented. Legacy ask/runtime credentials remain rejected.\nPrivate sessions/config are allowed only in a marked Rust scratch home. Startup recovers sessions cold and pauses queues; no provider is started. Production cutover and remaining provider parity follow later compatibility steps."
        );
        return Ok(());
    }
    let home = args.home.expect("clap requires home");
    let result = match args.command.unwrap_or(Action::Daemon {
        action: DaemonAction::Status {
            initialize_runtime: false,
        },
    }) {
        Action::Daemon {
            action: DaemonAction::Serve,
        } => {
            anyhow::ensure!(
                std::env::var_os("PULT_MEMORY_KEY").is_none(),
                "memory credentials cannot start an owner daemon"
            );
            return pult_core::serve(home).await;
        }
        Action::Daemon {
            action: DaemonAction::Status { initialize_runtime },
        } => {
            cli_request(
                &home,
                "daemon.status",
                if initialize_runtime {
                    serde_json::json!({"initializeRuntime":true})
                } else {
                    serde_json::json!({})
                },
            )
            .await?
        }
        Action::Daemon {
            action: DaemonAction::Stop,
        } => cli_request(&home, "daemon.stop", serde_json::json!({})).await?,
        Action::Catalog => cli_request(&home, "protocol.catalog", serde_json::json!({})).await?,
        Action::Memory { action } => {
            let (method, params) = match action {
                MemoryAction::Catalog { params } => ("memory.catalog", params),
                MemoryAction::Context { action } => match action {
                    MemoryContextAction::Bind { params } => ("memory.context.bind", params),
                    MemoryContextAction::Issue { params } => ("memory.context.issue", params),
                    MemoryContextAction::Revoke { params } => ("memory.context.revoke", params),
                    MemoryContextAction::Status { params } => ("memory.context.status", params),
                },
                MemoryAction::Add { params } => ("memory.add", params),
                MemoryAction::Update { params } => ("memory.update", params),
                MemoryAction::Forget { params } => ("memory.forget", params),
                MemoryAction::Get { params } => ("memory.get", params),
                MemoryAction::List { params } => ("memory.list", params),
                MemoryAction::Search { params } => ("memory.search", params),
                MemoryAction::History { params } => ("memory.history", params),
            };
            let params: serde_json::Value = serde_json::from_str(&params)?;
            anyhow::ensure!(params.is_object(), "memory --params must be a JSON object");
            cli_request(&home, method, params).await?
        }
        Action::Agent { action } => {
            let (method, params) = match action {
                AgentAction::Start { params } => (
                    "agent.start",
                    parse_cli_object(&params, "agent start --params")?,
                ),
                AgentAction::List => ("agent.list", serde_json::json!({})),
                AgentAction::Prompt {
                    name,
                    text,
                    attachments,
                    queue,
                    interrupt,
                    steer,
                } => {
                    let mut params = serde_json::json!({"name":name,"text":text});
                    if let Some(attachments) = attachments {
                        let attachments: serde_json::Value = serde_json::from_str(&attachments)
                            .map_err(|_| anyhow::anyhow!("--attachments must be a JSON array"))?;
                        anyhow::ensure!(
                            attachments.is_array(),
                            "--attachments must be a JSON array"
                        );
                        params["attachments"] = attachments;
                    }
                    for (name, enabled) in
                        [("queue", queue), ("interrupt", interrupt), ("steer", steer)]
                    {
                        if enabled {
                            params[name] = serde_json::json!(true);
                        }
                    }
                    ("agent.prompt", params)
                }
                AgentAction::Stop { name, turn_id } => {
                    let mut params = serde_json::json!({"name":name});
                    if let Some(turn_id) = turn_id {
                        params["turnId"] = serde_json::json!(turn_id);
                    }
                    ("agent.stop", params)
                }
                AgentAction::Read {
                    name,
                    since,
                    format,
                } => {
                    let json = format == "json";
                    let since = parse_cli_cursor(&since);
                    let result = cli_request(&home, "agent.read", serde_json::json!({"name": name, "since": if since.is_finite() { since } else { 0.0 }, "format": if json { "json" } else { "text" }})).await?;
                    let fields: std::collections::HashMap<
                        String,
                        Box<serde_json::value::RawValue>,
                    > = serde_json::from_str(result.get())?;
                    if let Some(wt) = fields.get("worktree") {
                        let wt: std::collections::HashMap<
                            String,
                            Box<serde_json::value::RawValue>,
                        > = serde_json::from_str(wt.get())?;
                        let label = if cli_language(&home)? == "ru" {
                            "ветка"
                        } else {
                            "branch"
                        };
                        eprintln!(
                            "worktree {} · {} {}",
                            pult_core::display_string(&wt["path"])?,
                            label,
                            pult_core::display_string(&wt["branch"])?
                        );
                    }
                    if json {
                        let events: Vec<Box<serde_json::value::RawValue>> =
                            serde_json::from_str(fields["events"].get())?;
                        for event in events {
                            println!("{}", event.get());
                        }
                    } else {
                        let text = pult_core::display_string(&fields["text"])?;
                        if !text.is_empty() {
                            println!("{text}");
                        }
                    }
                    return Ok(());
                }
                AgentAction::Tree { name, json } => {
                    let result =
                        cli_request(&home, "agent.tree", serde_json::json!({"name": name})).await?;
                    if json {
                        println!("{}", result.get());
                    } else {
                        let fields: std::collections::HashMap<
                            String,
                            Box<serde_json::value::RawValue>,
                        > = serde_json::from_str(result.get())?;
                        let text = pult_core::display_string(&fields["text"])?;
                        println!(
                            "{}",
                            if text.is_empty() {
                                if cli_language(&home)? == "ru" {
                                    "дерево пустое: ни одного инструмента и субагента"
                                } else {
                                    "Tree is empty: no tools or subagents"
                                }
                            } else {
                                &text
                            }
                        );
                    }
                    return Ok(());
                }
                AgentAction::Rename { name, words, title } => (
                    "agent.rename",
                    serde_json::json!({"name":name,"title":title.unwrap_or_else(||words.join(" "))}),
                ),
                AgentAction::Archive { name } => (
                    "agent.archive",
                    serde_json::json!({"name":name,"archived":true}),
                ),
                AgentAction::Unarchive { name } => (
                    "agent.archive",
                    serde_json::json!({"name":name,"archived":false}),
                ),
                AgentAction::Seen { name, unread } => (
                    "agent.seen",
                    serde_json::json!({"name":name,"unread":unread}),
                ),
            };
            cli_request(&home, method, params).await?
        }
        Action::Perm { action } => {
            let (method, params) = match action {
                PermAction::List { name } => {
                    let mut params = serde_json::json!({});
                    if let Some(name) = name {
                        params["name"] = serde_json::json!(name);
                    }
                    ("perm.list", params)
                }
                PermAction::Resolve {
                    id,
                    decision,
                    scope,
                    answers,
                    message,
                } => {
                    let mut params = serde_json::json!({"id":id,"decision":decision});
                    if let Some(scope) = scope {
                        params["scope"] = serde_json::json!(scope);
                    }
                    if let Some(answers) = answers {
                        params["answers"] = parse_cli_object(&answers, "--answers")?;
                    }
                    if let Some(message) = message {
                        params["message"] = serde_json::json!(message);
                    }
                    ("perm.resolve", params)
                }
            };
            cli_request(&home, method, params).await?
        }
        Action::Events {
            action: EventsAction::Snapshot,
        } => cli_request(&home, "events.snapshot", serde_json::json!({})).await?,
        Action::Events {
            action:
                EventsAction::History {
                    session,
                    before,
                    budget,
                },
        } => {
            let mut params = serde_json::json!({"sessionId":session});
            if let Some(before) = before {
                params["before"] = serde_json::json!(before);
            }
            if let Some(budget) = budget {
                params["budget"] = serde_json::json!(budget);
            }
            cli_request(&home, "events.history", params).await?
        }
        Action::Events {
            action: EventsAction::Get { ids },
        } => cli_request(&home, "events.get", serde_json::json!({"ids":ids})).await?,
        Action::Events {
            action:
                EventsAction::Tail {
                    since,
                    session,
                    limit,
                },
        } => {
            let mut params = serde_json::json!({"since":since});
            if let Some(session) = session {
                params["sessionId"] = serde_json::json!(session);
            }
            if let Some(limit) = limit {
                params["limit"] = serde_json::json!(limit);
            }
            cli_request(&home, "events.tail", params).await?
        }
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}

async fn cli_request(
    home: &std::path::Path,
    method: &str,
    params: serde_json::Value,
) -> Result<Box<serde_json::value::RawValue>> {
    if let Some(key) = std::env::var_os("PULT_MEMORY_KEY") {
        let key = key
            .into_string()
            .map_err(|_| anyhow::anyhow!("PULT_MEMORY_KEY must be valid UTF-8"))?;
        return pult_core::memory_client::request(home, &key, method, params).await;
    }
    let locale = pult_core::cli_locale(home)?;
    pult_core::request_with_locale(home, method, params, Some(locale)).await
}

// Even a rejected or misbehaving scoped endpoint cannot make the CLI inspect
// owner display configuration when formatting a response.
fn cli_language(home: &std::path::Path) -> Result<&'static str> {
    if std::env::var_os("PULT_MEMORY_KEY").is_some() {
        return Ok(if std::env::var("PULT_LANG").as_deref() == Ok("ru") {
            "ru"
        } else {
            "en"
        });
    }
    pult_core::cli_locale(home)
}

fn parse_cli_object(value: &str, argument: &'static str) -> Result<serde_json::Value> {
    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| anyhow::anyhow!("{argument} must be a JSON object"))?;
    anyhow::ensure!(parsed.is_object(), "{argument} must be a JSON object");
    Ok(parsed)
}

// Node's CLI uses Number.parseInt(value, 10), while RPC accepts finite fractions.
fn parse_cli_cursor(value: &str) -> f64 {
    let value = value.trim_start_matches(|ch: char| matches!(ch as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff));
    let sign = usize::from(value.starts_with(['+', '-']));
    let digits = value.as_bytes()[sign..]
        .iter()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0 {
        return 0.0;
    }
    value[..sign + digits]
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_commands_parse_without_executing_a_provider() {
        for command in [
            vec!["agent", "start", "--params", "{}"],
            vec!["agent", "list"],
            vec!["agent", "prompt", "chat", "hello", "--attachments", "[]"],
            vec!["agent", "stop", "chat", "--turn-id", "public-id"],
            vec!["perm", "list", "--name", "chat"],
            vec![
                "perm",
                "resolve",
                "request-id",
                "allow",
                "--scope",
                "session",
                "--answers",
                "{}",
            ],
            vec![
                "perm",
                "resolve",
                "request-id",
                "deny",
                "--message",
                "denied",
            ],
        ] {
            let mut args = vec!["pultd-rust", "--home", "/private/scratch"];
            args.extend(command);
            assert!(Args::try_parse_from(args).is_ok());
        }
        for decision in ["approve", "ALLOW", ""] {
            assert!(
                Args::try_parse_from([
                    "pultd-rust",
                    "--home",
                    "/private/scratch",
                    "perm",
                    "resolve",
                    "id",
                    decision
                ])
                .is_err()
            );
        }
    }
    #[test]
    fn partial_json_objects_reject_arrays_scalars_and_malformed_values() {
        assert_eq!(
            parse_cli_object("{}", "--params").unwrap(),
            serde_json::json!({})
        );
        for input in ["[]", "null", "false", "5", "invalid", "\"private text\""] {
            let error = parse_cli_object(input, "--params").unwrap_err().to_string();
            assert_eq!(error, "--params must be a JSON object");
        }
    }
    #[test]
    fn prompt_modes_are_exclusive_and_help_describes_all_three() {
        for mode in ["--queue", "--interrupt", "--steer"] {
            let args =
                Args::try_parse_from(["pultd-rust", "agent", "prompt", "chat", "hello", mode])
                    .unwrap();
            let Some(Action::Agent {
                action:
                    AgentAction::Prompt {
                        queue,
                        interrupt,
                        steer,
                        ..
                    },
            }) = args.command
            else {
                panic!("wrong command")
            };
            assert_eq!(
                [queue, interrupt, steer].into_iter().filter(|v| *v).count(),
                1
            );
            assert_eq!(
                (queue, interrupt, steer),
                (mode == "--queue", mode == "--interrupt", mode == "--steer")
            );
        }
        for pair in [
            ["--queue", "--interrupt"],
            ["--queue", "--steer"],
            ["--interrupt", "--steer"],
        ] {
            assert!(
                Args::try_parse_from([
                    "pultd-rust",
                    "agent",
                    "prompt",
                    "chat",
                    "hello",
                    pair[0],
                    pair[1]
                ])
                .is_err()
            );
        }
        let help = Args::try_parse_from(["pultd-rust", "agent", "prompt", "--help"])
            .err()
            .unwrap()
            .to_string();
        for flag in ["--queue", "--interrupt", "--steer"] {
            assert!(help.contains(flag));
        }
    }
    #[test]
    fn read_cli_cursor_matches_node_parse_int() {
        for (input, expected) in [
            ("1.9", 1.0),
            ("\u{feff}12", 12.0),
            ("\u{0085}12", 0.0),
            ("12abc", 12.0),
            ("1e3", 1.0),
            ("0x10", 0.0),
            (" -3.9", -3.0),
            ("", 0.0),
            ("invalid", 0.0),
            ("Infinity", 0.0),
        ] {
            assert_eq!(super::parse_cli_cursor(input), expected);
        }
    }
}
