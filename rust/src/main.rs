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
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    Events {
        #[command(subcommand)]
        action: EventsAction,
    },
}

#[derive(Subcommand)]
enum AgentAction {
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
    Status,
    Stop,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if args.skill {
        println!(
            "Rust core protocol 1. Use an explicit private scratch --home.\nCommands: daemon serve, daemon status, daemon stop, catalog, events tail, events snapshot, events history --session NAME [--before ID] [--budget BYTES], events get ID..., agent rename NAME [TITLE] [--title TEXT], agent archive|unarchive NAME, agent seen NAME [--unread]\nOwner-token connections support agent.rename, agent.archive, agent.seen, daemon.status, daemon.stop, events.tail, events.subscribe, events.unsubscribe, events.snapshot, events.history, events.get and protocol.catalog.\nHistory reads per-session files, snapshots and get use the global journal.\nSubscriptions replay committed events with bounded output. live=true sends an empty-session reset.\nevents.emit requires PULT_TEST=1 and is for deterministic verification.\nJournal append is acknowledged after sync. A failed append has an unknown outcome until replay.\nOther catalogued methods return not_implemented. Scoped credentials are rejected.\nPrivate sessions/config are allowed only in a marked Rust scratch home. Startup recovers sessions cold and pauses queues; no provider is started. Production migration and session execution follow later compatibility steps."
        );
        return Ok(());
    }
    let home = args.home.expect("clap requires home");
    let result = match args.command.unwrap_or(Action::Daemon {
        action: DaemonAction::Status,
    }) {
        Action::Daemon {
            action: DaemonAction::Serve,
        } => return pult_core::serve(home).await,
        Action::Daemon {
            action: DaemonAction::Status,
        } => pult_core::request(&home, "daemon.status").await?,
        Action::Daemon {
            action: DaemonAction::Stop,
        } => pult_core::request(&home, "daemon.stop").await?,
        Action::Catalog => pult_core::request(&home, "protocol.catalog").await?,
        Action::Agent { action } => {
            let (method, params) = match action {
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
            pult_core::request_with_params(&home, method, params).await?
        }
        Action::Events {
            action: EventsAction::Snapshot,
        } => pult_core::request(&home, "events.snapshot").await?,
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
            pult_core::request_with_params(&home, "events.history", params).await?
        }
        Action::Events {
            action: EventsAction::Get { ids },
        } => {
            pult_core::request_with_params(&home, "events.get", serde_json::json!({"ids":ids}))
                .await?
        }
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
            pult_core::request_with_params(&home, "events.tail", params).await?
        }
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
