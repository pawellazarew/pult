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
            "Rust core foundation protocol 1. Use an explicit private scratch --home.\nCommands: daemon serve, daemon status, daemon stop, catalog.\nOwner-token connections support daemon.status, daemon.stop and protocol.catalog.\nOther catalogued methods return not_implemented. Scoped credentials are rejected.\nProduction migration and session execution follow later compatibility steps."
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
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
