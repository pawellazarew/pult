#[tokio::main]
async fn main() {
    pult_core::panic_guard::install();
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = async {
        anyhow::ensure!(
            args.len() == 2 && args[0] == "--home",
            "memory MCP requires --home"
        );
        let key = std::env::var("PULT_MEMORY_TURN_KEY")
            .map_err(|_| anyhow::anyhow!("memory credential is unavailable"))?;
        pult_core::memory_mcp::run(std::path::PathBuf::from(&args[1]), key).await
    }
    .await;
    if result.is_err() {
        // Never print arbitrary endpoint/IO errors or reflected credentials.
        eprintln!("memory MCP is unavailable");
        std::process::exit(1);
    }
}
