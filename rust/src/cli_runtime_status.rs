//! Managed Node status only: no install/update/provider/manager authority.
use crate::{
    cli_agent,
    cli_client::{self, OwnerClient},
    cli_owned_query, cli_runtime_files as files,
};
use anyhow::{Result, anyhow, ensure};
use serde::Serialize;
use serde_json::value::RawValue;
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::process::Command;
const PIN: &str = include_str!("../../runtime.env");
const RESTART: &str = "pult daemon stop && pult daemon start";

fn parse_pin(text: &str) -> Result<String> {
    ensure!(text.len() <= 64 * 1024, "runtime pin exceeds size limit");
    let mut version = None;
    for raw in text.split('\n') {
        let line = files::trim(raw);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once('=')
            .filter(|(key, _)| !key.is_empty())
            .ok_or_else(|| anyhow!("invalid runtime pin assignment"))?;
        if key == "PULT_NODE_VERSION" {
            let parts = value.split('.').collect::<Vec<_>>();
            ensure!(
                parts.len() == 3
                    && parts
                        .iter()
                        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
                "invalid runtime pin version"
            );
            version = Some(value.to_owned());
        } else if [
            "PULT_NODE_SHA256_DARWIN_ARM64",
            "PULT_NODE_SHA256_DARWIN_X64",
            "PULT_NODE_SHA256_LINUX_ARM64",
            "PULT_NODE_SHA256_LINUX_X64",
        ]
        .contains(&key)
        {
            ensure!(
                value.len() == 64
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "invalid runtime pin checksum"
            );
        }
    }
    version.ok_or_else(|| anyhow!("runtime pin has no Node version"))
}
fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        arch => arch,
    };
    format!("{os}-{arch}")
}
fn platform_key(platform: &str) -> Option<&str> {
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
        .contains(&platform)
        .then_some(platform)
}
fn query_env() -> Result<BTreeMap<std::ffi::OsString, std::ffi::OsString>> {
    let mut env: BTreeMap<std::ffi::OsString, std::ffi::OsString> = BTreeMap::new();
    for name in ["HOME", "USER", "PATH", "LANG", "TERM", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name).filter(|v| !v.is_empty()) {
            env.insert(name.into(), value);
        }
    }
    env.entry("PATH".into())
        .or_insert_with(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into());
    ensure!(
        env.iter()
            .map(|(k, v)| k.len() + v.len() + 2)
            .sum::<usize>()
            <= 65536,
        "runtime query environment exceeds limit"
    );
    Ok(env)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    platform: String,
    key: Option<String>,
    pinned: Option<String>,
    active: Option<String>,
    active_version: Option<String>,
    installed: Vec<String>,
    daemon: Option<Box<RawValue>>,
}
fn field(raw: &RawValue, name: &str) -> Option<Box<RawValue>> {
    pult_core::raw_field(raw, name).ok().flatten()
}
fn display(raw: &RawValue, name: &str) -> Result<String> {
    cli_agent::display(field(raw, name).as_deref())
        .map_err(|_| anyhow!("invalid runtime daemon status"))
}
fn daemon_line(status: Option<&RawValue>, english: bool) -> Result<String> {
    let Some(status) = status.filter(|status| cli_agent::truthy(status)) else {
        return Ok(if english {
            "Daemon is not responding"
        } else {
            "демон не отвечает"
        }
        .into());
    };
    let node = field(status, "node").filter(|node| cli_agent::truthy(node));
    let Some(node) = node else {
        let version = display(status, "version")?;
        return Ok(if english {
            format!("Daemon {version} does not report its node (version older than 0.2.18)")
        } else {
            format!("демон {version} не сообщает свой node (версия старше 0.2.18)")
        });
    };
    let path = display(&node, "path")?;
    let version = display(&node, "version")?;
    let alive = field(&node, "alive").is_some_and(|v| cli_agent::truthy(&v));
    let own = field(&node, "own").is_some_and(|v| cli_agent::truthy(&v));
    Ok(match (english, alive, own) {
        (true, false, _) => {
            format!("Daemon node {path} ({version}) was removed or replaced — restart: {RESTART}")
        }
        (false, false, _) => {
            format!("node демона {path} ({version}) удалён или заменён — перезапусти: {RESTART}")
        }
        (true, true, true) => format!("Daemon uses Pult's Node {version}: {path}"),
        (false, true, true) => format!("демон на своём node {version}: {path}"),
        (true, true, false) => format!("Daemon uses system node {path} ({version})"),
        (false, true, false) => format!("демон на системном node {path} ({version})"),
    })
}
fn text(report: &Report, status: Option<&RawValue>, locale: &str) -> Result<String> {
    let en = locale == "en";
    let first = match (
        &report.key,
        &report.pinned,
        &report.active,
        &report.active_version,
    ) {
        (None, _, _, _) => {
            if en {
                format!(
                    "No Pult Node for {} — daemon uses system node",
                    report.platform
                )
            } else {
                format!(
                    "своего node под {} нет — демон работает на системном node",
                    report.platform
                )
            }
        }
        (_, None, _, _) => {
            if en {
                "Package has no runtime.env — this Pult version does not support bundled Node"
                    .into()
            } else {
                "в пакете нет runtime.env — эта версия Пульта своего node не знает".into()
            }
        }
        (_, Some(pin), None, _) => {
            if en {
                format!("Pult's Node {pin} is not installed — install: pult runtime install")
            } else {
                format!("свой node {pin} не поставлен — поставить: pult runtime install")
            }
        }
        (_, _, Some(active), None) => {
            if en {
                format!("Pult's Node is not responding: {active} — reinstall: pult runtime install")
            } else {
                format!("свой node не отвечает: {active} — поставить заново: pult runtime install")
            }
        }
        (_, Some(pin), Some(active), Some(version)) => {
            let suffix = if version == &format!("v{pin}") {
                String::new()
            } else if en {
                format!(" (package pin: {pin}: pult runtime install)")
            } else {
                format!(" (пин пакета — {pin}: pult runtime install)")
            };
            if en {
                format!("Pult's Node {version}: {active}{suffix}")
            } else {
                format!("свой node {version}: {active}{suffix}")
            }
        }
    };
    let disk = if report.installed.is_empty() {
        String::new()
    } else if en {
        format!("On disk: {}\n", report.installed.join(", "))
    } else {
        format!("на диске: {}\n", report.installed.join(", "))
    };
    Ok(format!("{first}\n{}\n{disk}", daemon_line(status, en)?))
}
async fn interrupted() -> Result<i32> {
    let _ = cli_client::emit("Error: runtime status interrupted\n".into(), true).await;
    Ok(130)
}
pub(super) async fn run(home: &Path, json: bool) -> Result<i32> {
    ensure!(
        [
            "PULT_MEMORY_KEY",
            "PULT_MEMORY_TURN_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY"
        ]
        .iter()
        .all(|key| std::env::var_os(key).is_none()),
        "runtime status requires owner authentication"
    );
    let root = pult_core::checked_home(home)
        .map_err(|_| anyhow!("runtime status requires a private Rust scratch home"))?;
    let locale = pult_core::cli_locale(&root)
        .map_err(|_| anyhow!("runtime status locale is unavailable"))?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|_| anyhow!("runtime status signal handler unavailable"))?;
    let pinned = parse_pin(PIN)?;
    let disk = files::observe(&root)?;
    let mut active_version = None;
    if let Some(program) = disk.active.as_deref().and_then(files::program) {
        // Tests must explicitly select their fake; test mode has no fallback to
        // an installed/system executable from a copied active pointer.
        if std::env::var("PULT_TEST").as_deref() == Ok("1") {
            ensure!(
                std::env::var_os("PULT_TEST_RUNTIME_EXEC")
                    .is_some_and(|fake| Path::new(&fake) == program),
                "runtime query test requires an explicit fake executable"
            );
        }
        let mut command = Command::new(program);
        command.arg("-v").env_clear().envs(query_env()?);
        let mut cancelled = false;
        let mut cleanup_failed = false;
        // The query retains its child/group/readers through cancellation and join.
        let result = cli_owned_query::run(
            &mut command,
            cli_owned_query::Kind::NodeVersion,
            &mut cancelled,
            &mut cleanup_failed,
            &mut interrupt,
        )
        .await;
        ensure!(
            !cleanup_failed
                && !matches!(
                    &result,
                    Err(cli_owned_query::Error::Ownership
                        | cli_owned_query::Error::Cleanup
                        | cli_owned_query::Error::OutputCleanup)
                ),
            "runtime query cleanup is unconfirmed"
        );
        if cancelled {
            return interrupted().await;
        }
        if let Ok(output) = result
            && output.status.success()
        {
            let version = files::trim(&String::from_utf8_lossy(&output.stdout)).to_owned();
            if !version.is_empty() {
                active_version = Some(version);
            }
        }
    }
    let (_, _, status) = tokio::select! {biased;
        _=interrupt.recv()=>return interrupted().await,
        result=OwnerClient::status_with_deadline(&root,Some(Duration::from_secs(2)))=>result.map_err(|e|anyhow!(e.message))?,
    };
    let daemon = status
        .as_deref()
        .and_then(|status| field(status, "node"))
        .filter(|v| v.get() != "null");
    let platform = platform();
    let report = Report {
        key: platform_key(&platform).map(str::to_owned),
        platform,
        pinned: Some(pinned),
        active: disk.active,
        active_version,
        installed: disk.installed,
        daemon,
    };
    let output = if json {
        format!("{}\n", serde_json::to_string(&report)?)
    } else {
        text(&report, status.as_deref(), locale)?
    };
    ensure!(
        output.len() <= 4 * 1024 * 1024,
        "runtime status output exceeds limit"
    );
    tokio::select! {biased;
        _=interrupt.recv()=>return interrupted().await,
        result=cli_client::emit(output,false)=>result.map_err(|_|anyhow!("runtime status output failed"))?,
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_pin_and_parser_retain_known_values_and_ignore_unknown_keys() {
        assert!(!parse_pin(PIN).unwrap().is_empty());
        assert_eq!(parse_pin("\u{feff}# comment\r\nOTHER=x\nPULT_NODE_SHA256_WINDOWS_X64=invalid\nPULT_NODE_VERSION=01.002.3\nPULT_NODE_VERSION=4.5.6\n").unwrap(),"4.5.6");
        for text in [
            "",
            "unknown line",
            "PULT_NODE_VERSION=24",
            "PULT_NODE_VERSION=24.1.2 #comment",
            "PULT_NODE_VERSION =1.2.3",
            "PULT_NODE_VERSION=1.2.3\nPULT_NODE_SHA256_LINUX_X64=ABC",
            "PULT_NODE_VERSION=bad\nPULT_NODE_VERSION=1.2.3",
        ] {
            assert!(parse_pin(text).is_err(), "{text}");
        }
        assert!(parse_pin(&"x".repeat(64 * 1024 + 1)).is_err());
        assert_eq!(platform_key("darwin-arm64"), Some("darwin-arm64"));
        assert_eq!(platform_key("win32-x64"), None);
    }
    #[test]
    fn unsupported_platform_and_missing_pin_are_text_policy_not_install_actions() {
        let mut report = Report {
            platform: "win32-x64".into(),
            key: None,
            pinned: None,
            active: Some("external-node".into()),
            active_version: Some("v1.2.3".into()),
            installed: vec![],
            daemon: None,
        };
        assert_eq!(
            text(&report, None, "en").unwrap(),
            "No Pult Node for win32-x64 — daemon uses system node\nDaemon is not responding\n"
        );
        report.key = Some("darwin-arm64".into());
        assert_eq!(
            text(&report, None, "ru").unwrap(),
            "в пакете нет runtime.env — эта версия Пульта своего node не знает\nдемон не отвечает\n"
        );
    }
    #[test]
    fn daemon_text_retains_js_truthiness_and_bounded_scalar_conversion() {
        let raw = RawValue::from_string(r#"{"version":"old","node":0}"#.into()).unwrap();
        assert_eq!(
            daemon_line(Some(&raw), true).unwrap(),
            "Daemon old does not report its node (version older than 0.2.18)"
        );
        let raw = RawValue::from_string(
            r#"{"node":{"alive":"yes","own":[],"path":["a",null,"b"],"version":1e2}}"#.into(),
        )
        .unwrap();
        assert_eq!(
            daemon_line(Some(&raw), true).unwrap(),
            "Daemon uses Pult's Node 100: a,,b"
        );
        let raw = RawValue::from_string("null".into()).unwrap();
        assert_eq!(
            daemon_line(Some(&raw), true).unwrap(),
            "Daemon is not responding"
        );
    }
}
