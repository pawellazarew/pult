//! Local status wrapper. No daemon spawn, retry, provider, or OS mutation.
use crate::{
    cli_client::{self, OwnerClient},
    cli_service,
};
use anyhow::{Result, ensure};
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::path::Path;

fn scalar(fields: &HashMap<String, Box<RawValue>>, key: &str) -> String {
    fields
        .get(key)
        .map(|v| {
            if v.get().starts_with('"') {
                pult_core::display_string(v).unwrap_or_else(|_| "undefined".into())
            } else {
                v.get().into()
            }
        })
        .unwrap_or_else(|| "undefined".into())
}
fn status_text(raw: &RawValue, locale: &str) -> Result<String> {
    let fields: HashMap<String, Box<RawValue>> = serde_json::from_str(raw.get())?;
    let uptime = fields
        .get("uptimeMs")
        .and_then(|v| serde_json::from_str::<f64>(v.get()).ok())
        .map(|n| ((n / 1000.0) + 0.5).floor().to_string())
        .unwrap_or_else(|| "NaN".into());
    let get = |key| scalar(&fields, key);
    let mode = fields
        .get("mode")
        .filter(|v| v.get() != "null")
        .map(|_| get("mode"))
        .unwrap_or_else(|| "on-demand".into());
    Ok(if locale == "ru" {
        format!(
            "pultd {} · pid {} · протокол {} · аптайм {uptime} с\nрежим {mode} · дом {}\nклиентов {}, подписок {}, событий до #{}\n",
            get("version"),
            get("pid"),
            get("protocol"),
            get("home"),
            get("clients"),
            get("subscriptions"),
            get("lastEventId")
        )
    } else {
        format!(
            "pultd {} · pid {} · protocol {} · uptime {uptime} s\nmode {mode} · home {}\nclients {}, subscriptions {}, events through #{}\n",
            get("version"),
            get("pid"),
            get("protocol"),
            get("home"),
            get("clients"),
            get("subscriptions"),
            get("lastEventId")
        )
    })
}
pub async fn run(home: &Path, json_output: bool) -> Result<i32> {
    // Presence, not value. This preflight precedes all owner/service FS access;
    // forbidden is never reinterpreted as an offline daemon.
    ensure!(
        [
            "PULT_MEMORY_KEY",
            "PULT_MEMORY_TURN_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY"
        ]
        .iter()
        .all(|key| std::env::var_os(key).is_none()),
        "service status requires owner authentication"
    );
    let mut interrupt =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .map_err(|_| anyhow::anyhow!("service status signal handler unavailable"))?;
    let display_home = home;
    let (home, locale, status) = tokio::select! {
        biased;
        _ = interrupt.recv() => { let _ = cli_client::emit("Error: service status interrupted\n".into(), true).await; return Ok(130); },
        probe = OwnerClient::status(home) => probe.map_err(|error| anyhow::anyhow!(error.message))?,
    };
    // Never outer-cancel the query: it must retain the leader and join cleanup.
    let service = cli_service::report(&home, &mut interrupt).await;
    if service.cleanup_failed {
        let _ = cli_client::emit(
            "Error: service manager cleanup is unconfirmed\n".into(),
            true,
        )
        .await;
        return Ok(1);
    }
    if service.interrupted {
        let _ = cli_client::emit("Error: service status interrupted\n".into(), true).await;
        return Ok(130);
    }
    let (text, exit) = match status {
        Some(raw) => {
            // Require an object; retain all bounded opaque extension fields and
            // JS UTF-16 strings when adding the local wrapper.
            let object = raw.get().trim();
            ensure!(
                object.starts_with('{') && object.ends_with('}'),
                "invalid daemon status response"
            );
            if json_output {
                let body = &object[1..object.len() - 1];
                (
                    format!(
                        "{{\"running\":true,{}\"service\":{}}}\n",
                        if body.trim().is_empty() {
                            String::new()
                        } else {
                            format!("{body},")
                        },
                        serde_json::to_string(&service)?
                    ),
                    0,
                )
            } else {
                (
                    format!(
                        "{}{}\n",
                        status_text(&raw, locale)?,
                        cli_service::line(&service)
                    ),
                    0,
                )
            }
        }
        None => {
            if json_output {
                (
                    format!(
                        "{{\"running\":false,\"home\":{},\"service\":{}}}\n",
                        serde_json::to_string(&display_home)?,
                        serde_json::to_string(&service)?
                    ),
                    1,
                )
            } else {
                (
                    format!(
                        "{}\n{}\n",
                        if locale == "ru" {
                            "демон не запущен"
                        } else {
                            "Daemon is not running"
                        },
                        cli_service::line(&service)
                    ),
                    1,
                )
            }
        }
    };
    tokio::select! {
        biased;
        _ = interrupt.recv() => { let _ = cli_client::emit("Error: service status interrupted\n".into(), true).await; return Ok(130); },
        output = cli_client::emit(text, false) => output.map_err(|_| anyhow::anyhow!("service status output failed"))?,
    }
    Ok(exit)
}
