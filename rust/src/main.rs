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
    Events {
        #[command(subcommand)]
        action: EventsAction,
    },
}

#[derive(Subcommand)]
enum EventsAction {
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
            "Rust core protocol 1. Use an explicit private scratch --home.\nCommands: daemon serve, daemon status, daemon stop, catalog, events tail [--since ID] [--session NAME] [--limit N].\nOwner-token connections support daemon.status, daemon.stop, events.tail, events.subscribe, events.unsubscribe and protocol.catalog.\nSubscriptions replay committed events with bounded output. live=true sends an empty-session reset.\nevents.emit requires PULT_TEST=1 and is for deterministic verification.\nJournal append is acknowledged after sync. A failed append has an unknown outcome until replay.\nOther catalogued methods return not_implemented. Scoped credentials are rejected.\nProduction migration and session execution follow later compatibility steps."
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
