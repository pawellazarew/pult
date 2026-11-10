#![forbid(unsafe_code)]

mod output;

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use output::ControlOutput;
use pult_r1::{Journal, Process, bounded_sync_line};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
#[command(about = "Isolated Rust runtime experiment; not a replacement for pult")]
struct Args {
    /// Absolute scratch directory. Never defaults to ~/.pult.
    #[arg(long)]
    home: PathBuf,
    #[command(subcommand)]
    command: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Validate and print the durable experiment journal.
    Replay,
    /// JSON-lines hello/start/stop/quit control loop. Child stdout must be JSON lines.
    Serve,
    /// Initialize a real app-server and create a read-only thread; optional one-turn smoke.
    Codex {
        #[arg(long, default_value = "codex")]
        bin: String,
        #[arg(long)]
        cwd: PathBuf,
        #[arg(long)]
        prompt: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut journal = Journal::open(&args.home)?;
    let output = ControlOutput::new();
    match args.command {
        Action::Replay => {
            for record in journal.records()? {
                output.reply(&serde_json::to_value(record)?).await?;
            }
        }
        Action::Serve => serve(&mut journal, &output).await?,
        Action::Codex { bin, cwd, prompt } => {
            ensure!(cwd.is_absolute(), "--cwd must be absolute");
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
            let mut process = Process::spawn(&bin, &["app-server".into()], &cwd).await?;
            let work = tokio::time::timeout(Duration::from_secs(120), async {
                journal.append(
                    "session.started",
                    json!({"provider":"codex","pid":process.pid()}),
                )?;
                codex(&mut process, &mut journal, &cwd, prompt, &output).await
            });
            let result = tokio::select! {
                result = work => result.context("Codex smoke deadline exceeded").and_then(|value| value),
                _ = terminate.recv() => Err(anyhow::anyhow!("terminated by SIGTERM")),
                _ = tokio::signal::ctrl_c() => Err(anyhow::anyhow!("interrupted")),
            };
            let stopped = process.stop().await?;
            journal.append("session.stopped", stopped)?;
            result?;
        }
    }
    Ok(())
}

async fn codex(
    process: &mut Process,
    journal: &mut Journal,
    cwd: &std::path::Path,
    prompt: Option<String>,
    output: &ControlOutput,
) -> Result<()> {
    let init = process
        .request(
            1,
            "initialize",
            json!({"clientInfo":{"name":"pult_rust_r1","version":"0.1.0"}}),
            journal,
        )
        .await?;
    output.reply(&json!({"initialized": init})).await?;
    process
        .send(&json!({"method":"initialized","params":{}}))
        .await?;
    let thread = process
        .request(
            2,
            "thread/start",
            json!({"cwd":cwd,"sandbox":"read-only","approvalPolicy":"never"}),
            journal,
        )
        .await?;
    let id = thread["thread"]["id"]
        .as_str()
        .context("thread/start returned no thread id")?
        .to_string();
    journal.append("session.ready", json!({"threadId":id}))?;
    output
        .reply(&json!({"threadId":id,"sandbox":"read-only"}))
        .await?;
    if let Some(prompt) = prompt {
        process
            .request(
                3,
                "turn/start",
                json!({"threadId":id,"input":[{"type":"text","text":prompt}],"effort":"low"}),
                journal,
            )
            .await?;
        loop {
            let value = process
                .output
                .recv()
                .await
                .context("app-server exited before turn completed")??;
            journal.append("provider.message", value.clone())?;
            process.deny_server_request(&value).await?;
            if value["method"] == "turn/completed" && value["params"]["threadId"] == id {
                let status = &value["params"]["turn"]["status"];
                output.reply(&json!({"turnStatus":status})).await?;
                ensure!(status == "completed", "turn did not complete: {value}");
                break;
            }
        }
    }
    Ok(())
}

async fn serve(journal: &mut Journal, output: &ControlOutput) -> Result<()> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let records = journal.records()?;
    if records
        .iter()
        .rev()
        .find(|r| r.kind.starts_with("session."))
        .is_some_and(|r| r.kind != "session.stopped" && r.kind != "session.interrupted")
    {
        journal.append(
            "session.interrupted",
            json!({"reason":"prototype_restarted"}),
        )?;
    }
    // Keep partial frames in one task: select cancellation must not discard bytes already read.
    let (send_input, mut input) = tokio::sync::mpsc::channel(1);
    // Keep stdin outside Tokio blocking pool: quit must not wait for caller EOF.
    let _input_reader = std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let line = bounded_sync_line(&mut reader);
            let ended = !matches!(&line, Ok(Some(_)));
            if send_input.blocking_send(line).is_err() || ended {
                break;
            }
        }
    });
    let mut process: Option<Process> = None;
    loop {
        let provider_output = async {
            match process.as_mut() {
                Some(child) => child.output.recv().await,
                None => std::future::pending().await,
            }
        };
        enum Next {
            Input(Result<Option<Vec<u8>>>),
            Output(Option<Result<Value>>),
            Stop,
        }
        let next = tokio::select! {
            line = input.recv() => Next::Input(line.unwrap_or(Ok(None))),
            value = provider_output => Next::Output(value),
            _ = tokio::signal::ctrl_c() => Next::Stop,
            _ = terminate.recv() => Next::Stop,
        };
        let step: Result<bool> = async {
            match next {
                Next::Stop | Next::Input(Ok(None)) => return Ok(false),
                Next::Input(Err(e)) => return Err(e),
                Next::Input(Ok(Some(bytes))) => {
                    let request: Value = serde_json::from_slice(&bytes)?;
                    match request["method"].as_str() {
                        Some("hello") => output.reply(&json!({"protocol":1,"experimental":true,"methods":["hello","start","stop","quit"]})).await?,
                        Some("start") => {
                            ensure!(process.is_none(), "a session is already running");
                            let program = request["program"].as_str().context("program is required")?;
                            let cwd = PathBuf::from(request["cwd"].as_str().context("cwd is required")?);
                            ensure!(cwd.is_absolute(), "cwd must be absolute");
                            let args: Vec<String> = serde_json::from_value(request.get("args").cloned().unwrap_or(json!([])))?;
                            let child = Process::spawn(program, &args, &cwd).await?;
                            let pid = child.pid();
                            process = Some(child);
                            let sequence = journal.append("session.started", json!({"pid":pid}))?;
                            output.reply(&json!({"started":pid,"acknowledged":sequence})).await?;
                        }
                        Some("stop") => {
                            if let Some(mut child) = process.take() {
                                let result = child.stop().await?;
                                let sequence = journal.append("session.stopped", result)?;
                                output.reply(&json!({"stopped":true,"acknowledged":sequence})).await?;
                            } else { output.reply(&json!({"stopped":true})).await?; }
                        }
                        Some("quit") => return Ok(false),
                        _ => anyhow::bail!("unknown method"),
                    }
                }
                Next::Output(Some(value)) => {
                    let sequence = journal.append("provider.message", value?)?;
                    output.reply(&json!({"acknowledged":sequence})).await?;
                }
                Next::Output(None) => {
                    if let Some(mut child) = process.take() {
                        journal.append("session.stopped", child.stop().await?)?;
                    }
                }
            }
            Ok(true)
        }.await;
        match step {
            Ok(true) => (),
            result => {
                if let Some(mut child) = process.take() {
                    let stopped = child.stop().await?;
                    journal.append("session.stopped", stopped)?;
                }
                result?;
                return Ok(());
            }
        }
    }
}
