//! Private, bounded service observation. No install/start/stop authority.
use anyhow::Result;
use regex::Regex;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub const LIMIT: usize = 1024 * 1024;
#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct ExitSignal {
    num: i64,
    name: String,
}
#[derive(Clone, PartialEq, Debug)]
pub struct ManagerState {
    state_first: bool,
    loaded: bool,
    running: bool,
    pid: Option<i64>,
    last_exit_code: Option<i64>,
    last_signal: Option<ExitSignal>,
    runs: Option<i64>,
    state: Option<String>,
    error: Option<String>,
}
impl Serialize for ManagerState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(7 + usize::from(self.error.is_some())))?;
        map.serialize_entry("loaded", &self.loaded)?;
        map.serialize_entry("running", &self.running)?;
        if self.state_first {
            map.serialize_entry("state", &self.state)?;
        }
        map.serialize_entry("pid", &self.pid)?;
        map.serialize_entry("lastExitCode", &self.last_exit_code)?;
        map.serialize_entry("lastSignal", &self.last_signal)?;
        map.serialize_entry("runs", &self.runs)?;
        if !self.state_first {
            map.serialize_entry("state", &self.state)?;
        }
        if let Some(error) = &self.error {
            map.serialize_entry("error", error)?;
        }
        map.end()
    }
}
impl ManagerState {
    fn missing() -> Self {
        Self {
            state_first: false,
            loaded: false,
            running: false,
            pid: None,
            last_exit_code: None,
            last_signal: None,
            runs: None,
            state: None,
            error: None,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceReport {
    #[serde(skip)]
    pub interrupted: bool,
    #[serde(skip)]
    pub cleanup_failed: bool,
    platform: String,
    name: String,
    file: Option<PathBuf>,
    installed: bool,
    file_home: Option<String>,
    ours: bool,
    launcher: Option<String>,
    stale: Option<String>,
    launcher_ok: bool,
    manager: Option<ManagerState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
pub struct Context {
    platform: String,
    name: String,
    file: Option<PathBuf>,
    bin: Option<PathBuf>,
}
fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}
fn absolute(path: String) -> PathBuf {
    let path = PathBuf::from(path);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    };
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => (),
            _ => out.push(part),
        }
    }
    out
}
fn host_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    }
}
fn context() -> Result<Context, &'static str> {
    let test = std::env::var("PULT_TEST").as_deref() == Ok("1");
    let platform = if test {
        env("PULT_SERVICE_PLATFORM")
    } else {
        None
    }
    .unwrap_or_else(|| host_platform().to_owned());
    if platform != "darwin" && platform != "linux" {
        return Err("service platform is unsupported");
    }
    let default = if platform == "darwin" {
        "dev.pult.daemon"
    } else {
        "pultd.service"
    };
    let mut name = env("PULT_SERVICE_NAME").unwrap_or_else(|| default.into());
    if !Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
        .unwrap()
        .is_match(&name)
    {
        return Err("invalid service name");
    }
    if platform == "linux" && !name.ends_with(".service") {
        name.push_str(".service");
    }
    let dir = if test {
        env("PULT_SERVICE_DIR").map(absolute)
    } else {
        let home = env("HOME")
            .map(PathBuf::from)
            .or_else(|| {
                nix::unistd::User::from_uid(nix::unistd::getuid())
                    .ok()
                    .flatten()
                    .map(|u| u.dir)
            })
            .ok_or("service home is unavailable")?;
        if !home.is_absolute() {
            return Err("service home must be absolute");
        }
        Some(if platform == "darwin" {
            home.join("Library/LaunchAgents")
        } else {
            env("XDG_CONFIG_HOME")
                .map(absolute)
                .unwrap_or_else(|| home.join(".config"))
                .join("systemd/user")
        })
    };
    let (key, real) = if platform == "darwin" {
        ("PULT_LAUNCHCTL", "/bin/launchctl")
    } else {
        ("PULT_SYSTEMCTL", "/usr/bin/systemctl")
    };
    let bin = if test {
        env(key).map(absolute)
    } else {
        Some(PathBuf::from(real))
    };
    let file = dir.map(|dir| {
        dir.join(if platform == "darwin" {
            format!("{name}.plist")
        } else {
            name.clone()
        })
    });
    Ok(Context {
        platform,
        name,
        file,
        bin,
    })
}
fn capture(pattern: &str, text: &str) -> Option<String> {
    Regex::new(pattern)
        .unwrap()
        .captures(text)?
        .get(1)
        .map(|v| v.as_str().to_owned())
}
fn xml(s: String) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
fn unescape(s: String) -> String {
    Regex::new(r"\\(.)")
        .unwrap()
        .replace_all(&s, "$1")
        .replace("%%", "%")
}
fn service_fields(platform: &str, text: &str) -> (Option<String>, Option<String>, Option<String>) {
    if platform == "darwin" {
        let home = capture(r"<key>PULT_HOME</key>\s*<string>([^<]*)</string>", text).map(xml);
        let launcher = capture(
            r"<key>ProgramArguments</key>\s*<array>\s*<string>([^<]*)</string>",
            text,
        )
        .map(xml);
        let stale = (capture(r"<key>ProcessType</key>\s*<string>([^<]*)</string>", text).as_deref() == Some("Background")).then(|| "ProcessType Background: демон и всё, что он запускает (claude, codex, git), идут с фоновым приоритетом — в разы медленнее; нужен Standard".into());
        (home, launcher, stale)
    } else {
        (
            capture(
                r#"(?m)^Environment="PULT_HOME=((?:[^"\\]|\\.)*)"\s*$"#,
                text,
            )
            .map(unescape),
            capture(r#"(?m)^ExecStart="((?:[^"\\]|\\.)*)"\s*$"#, text)
                .map(unescape)
                .map(|s| s.replace("$$", "$")),
            None,
        )
    }
}
fn number(text: Option<&str>) -> Option<i64> {
    text.filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))?
        .parse()
        .ok()
}
fn darwin(text: &str) -> ManagerState {
    let mut top = std::collections::HashMap::new();
    let mut depth = 0_usize;
    for raw in text.lines() {
        let line = raw.trim();
        if line == "}" || line == "};" {
            depth = depth.saturating_sub(1);
            continue;
        }
        if depth == 1
            && let Some((key, value)) = line.split_once(" = ")
        {
            top.entry(key.trim()).or_insert(value.trim());
        }
        if line.ends_with('{') {
            depth += 1;
        }
    }
    let pid = number(top.get("pid").copied());
    ManagerState {
        state_first: true,
        loaded: true,
        running: pid.is_some(),
        pid,
        last_exit_code: top
            .get("last exit code")
            .and_then(|s| capture(r"^(-?\d+)", s))
            .and_then(|n| n.parse().ok()),
        last_signal: top
            .get("last terminating signal")
            .and_then(|s| Regex::new(r"^(.*?):\s*(\d+)\s*$").unwrap().captures(s))
            .and_then(|m| {
                Some(ExitSignal {
                    num: m.get(2)?.as_str().parse().ok()?,
                    name: m.get(1)?.as_str().trim().into(),
                })
            }),
        runs: number(top.get("runs").copied()),
        state: top.get("state").map(|s| (*s).into()),
        error: None,
    }
}
fn linux(text: &str) -> ManagerState {
    let mut fields = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=')
            && !key.is_empty()
        {
            fields.insert(key.trim(), value.trim());
        }
    }
    let get = |key| fields.get(key).copied();
    let pid = number(get("MainPID")).filter(|n| *n > 0);
    let active = get("ActiveState");
    let sub = get("SubState").unwrap_or("");
    let killed = matches!(get("ExecMainCode"), Some("2" | "3"));
    let status = get("ExecMainStatus").and_then(|s| {
        if Regex::new(r"^-?\d+$").unwrap().is_match(s) {
            s.parse().ok()
        } else {
            None
        }
    });
    ManagerState {
        state_first: false,
        loaded: get("LoadState") == Some("loaded"),
        running: pid.is_some() && matches!(active, Some("active" | "activating" | "reloading")),
        pid,
        last_exit_code: if killed { None } else { status },
        last_signal: if killed {
            status.map(|num| ExitSignal {
                num,
                name: String::new(),
            })
        } else {
            None
        },
        runs: number(get("ExecMainPID")).filter(|n| *n > 0),
        state: active.map(|s| {
            if s == "activating" && !sub.is_empty() {
                format!("{s} ({sub})")
            } else {
                s.into()
            }
        }),
        error: None,
    }
}
fn same_dir(a: &Path, b: &Path) -> bool {
    fn resolved(p: &Path) -> PathBuf {
        let p = if p.is_absolute() {
            p.to_owned()
        } else {
            std::env::current_dir().unwrap_or_default().join(p)
        };
        let mut out = PathBuf::new();
        for part in p.components() {
            if part == std::path::Component::ParentDir {
                out.pop();
            } else if part != std::path::Component::CurDir {
                out.push(part);
            }
        }
        out
    }
    resolved(a) == resolved(b)
        || std::fs::canonicalize(a)
            .ok()
            .zip(std::fs::canonicalize(b).ok())
            .is_some_and(|(a, b)| a == b)
}
fn executable(path: &str) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
}
fn read_file(path: &Path) -> Result<Option<String>, &'static str> {
    use rustix::fs::{Mode, OFlags, open, openat};
    use std::io::Read;
    if !path.is_absolute()
        || path
            .components()
            .any(|p| p == std::path::Component::ParentDir)
    {
        return Err("service file path must be absolute and normalized");
    }
    // Darwin exposes these standard aliases as root-owned symlinks. Normalize
    // only the known OS prefixes; arbitrary user directory symlinks stay denied.
    #[cfg(target_os = "macos")]
    let adjusted = ["/tmp", "/var", "/etc"].into_iter().find_map(|alias| {
        path.strip_prefix(alias).ok().map(|tail| {
            Path::new("/private")
                .join(alias.trim_start_matches('/'))
                .join(tail)
        })
    });
    #[cfg(target_os = "macos")]
    let path = adjusted.as_deref().unwrap_or(path);
    let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let mut dir = open("/", flags | OFlags::DIRECTORY, Mode::empty())
        .map_err(|_| "service directory is unavailable")?;
    let parts: Vec<_> = path
        .components()
        .filter_map(|c| {
            if let std::path::Component::Normal(p) = c {
                Some(p)
            } else {
                None
            }
        })
        .collect();
    for (i, part) in parts.iter().enumerate() {
        let fd = match openat(
            &dir,
            *part,
            if i + 1 == parts.len() {
                flags
            } else {
                flags | OFlags::DIRECTORY
            },
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err("service file cannot be opened safely"),
        };
        dir = fd;
    }
    let file = std::fs::File::from(dir);
    let metadata = file
        .metadata()
        .map_err(|_| "service file metadata is unavailable")?;
    if !metadata.is_file() {
        return Err("service file must be regular");
    }
    if metadata.len() > LIMIT as u64 {
        return Err("service file exceeds 1 MiB limit");
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "service file cannot be read")?;
    if bytes.len() > LIMIT {
        return Err("service file exceeds 1 MiB limit");
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

fn query_args(ctx: &Context) -> Vec<String> {
    if ctx.platform == "darwin" {
        vec![
            "print".into(),
            format!("gui/{}/{}", nix::unistd::getuid(), ctx.name),
        ]
    } else {
        vec![
            "--user".into(),
            "show".into(),
            ctx.name.clone(),
            "-p".into(),
            "LoadState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus".into(),
        ]
    }
}
fn query_env() -> std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString> {
    let mut env = std::collections::BTreeMap::new();
    for key in [
        "HOME",
        "USER",
        "PATH",
        "LANG",
        "TERM",
        "TMPDIR",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ] {
        if let Some(value) = std::env::var_os(key).filter(|v| !v.is_empty()) {
            env.insert(key.into(), value);
        }
    }
    env.entry("PATH".into())
        .or_insert_with(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into());
    if std::env::var("PULT_TEST").as_deref() == Ok("1") {
        for (key, value) in std::env::vars_os() {
            if key
                .to_str()
                .is_some_and(|key| key.starts_with("FAKE_") || key == "PULT_SERVICE_DIR")
            {
                env.insert(key, value);
            }
        }
    }
    env
}
fn query_error(error: crate::cli_owned_query::Error) -> &'static str {
    use crate::cli_owned_query::Error;
    match error {
        Error::Spawn => "service manager cannot be started",
        Error::PidUnavailable => "service manager pid is unavailable",
        Error::PidInvalid => "service manager pid is invalid",
        Error::StdoutUnavailable => "service manager stdout is unavailable",
        Error::StderrUnavailable => "service manager stderr is unavailable",
        Error::Ownership => "service manager ownership is unknown",
        Error::Timeout => "service manager query timed out",
        Error::Interrupted => "service status interrupted",
        Error::Output => "service manager output failed",
        Error::Overflow => "service manager output exceeds 1 MiB limit",
        Error::Cleanup => "service manager cleanup is unconfirmed",
        Error::OutputCleanup => "service manager output cleanup timed out",
        Error::OutputUnavailable => "service manager output is unavailable",
    }
}
async fn query(
    ctx: &Context,
    cancelled: &mut bool,
    cleanup_failed: &mut bool,
    cancellation: &mut (impl std::future::Future<Output = ()> + Unpin),
) -> Result<ManagerState, &'static str> {
    let bin = ctx
        .bin
        .as_ref()
        .ok_or("test service query requires an explicit fake manager")?;
    let env = query_env();
    if env
        .iter()
        .map(|(k, v)| k.len() + v.len() + 2)
        .sum::<usize>()
        > 65536
    {
        return Err("service manager environment exceeds limit");
    }
    let mut command = Command::new(bin);
    command.args(query_args(ctx)).env_clear().envs(env);
    let result = crate::cli_owned_query::run_with_cancel(
        &mut command,
        crate::cli_owned_query::Kind::Service,
        cancelled,
        cleanup_failed,
        cancellation,
    )
    .await
    .map_err(query_error)?;
    let status = result.status;
    let output = Some(result.stdout);
    let error_output = Some(result.stderr);
    let output = String::from_utf8_lossy(
        output
            .as_deref()
            .ok_or("service manager output is unavailable")?,
    )
    .into_owned();
    let stderr = String::from_utf8_lossy(
        error_output
            .as_deref()
            .ok_or("service manager output is unavailable")?,
    );
    if !status.success() {
        if ctx.platform == "darwin"
            && (matches!(status.code(), Some(113 | 3))
                || output.contains("No such process")
                || output.contains("Could not find service")
                || stderr.contains("No such process")
                || stderr.contains("Could not find service"))
        {
            return Ok(ManagerState::missing());
        }
        let mut state = ManagerState::missing();
        let label = if ctx.platform == "darwin" {
            "launchctl print"
        } else {
            "systemctl --user show"
        };
        state.error = Some(format!(
            "{label} {}: код {} — service manager query failed",
            ctx.name,
            status
                .code()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "null".into())
        ));
        return Ok(state);
    }
    Ok(if ctx.platform == "darwin" {
        darwin(&output)
    } else {
        linux(&output)
    })
}
pub async fn report(home: &Path, interrupt: &mut tokio::signal::unix::Signal) -> ServiceReport {
    let cancellation = async {
        interrupt.recv().await;
    };
    tokio::pin!(cancellation);
    report_with_cancel(home, &mut cancellation).await
}
pub(super) async fn report_with_cancel(
    home: &Path,
    cancellation: &mut (impl std::future::Future<Output = ()> + Unpin),
) -> ServiceReport {
    let ctx = match context() {
        Ok(ctx) => ctx,
        Err(error) => {
            return ServiceReport {
                interrupted: false,
                cleanup_failed: false,
                platform: host_platform().into(),
                name: String::new(),
                file: None,
                installed: false,
                file_home: None,
                ours: false,
                launcher: None,
                stale: None,
                launcher_ok: false,
                manager: None,
                error: Some(error.into()),
            };
        }
    };
    let mut report = ServiceReport {
        interrupted: false,
        cleanup_failed: false,
        platform: ctx.platform.clone(),
        name: ctx.name.clone(),
        file: ctx.file.clone(),
        installed: false,
        file_home: None,
        ours: false,
        launcher: None,
        stale: None,
        launcher_ok: false,
        manager: None,
        error: None,
    };
    let text = match ctx.file.as_deref().map(read_file).transpose() {
        Ok(Some(Some(text))) => {
            report.installed = true;
            text
        }
        Ok(_) => return report,
        Err(error) => {
            report.installed = true;
            report.error = Some(error.into());
            return report;
        }
    };
    (report.file_home, report.launcher, report.stale) = service_fields(&ctx.platform, &text);
    report.ours = report
        .file_home
        .as_ref()
        .is_some_and(|p| same_dir(Path::new(p), home));
    report.launcher_ok = report.launcher.as_ref().is_some_and(|p| executable(p));
    if report.ours {
        match query(
            &ctx,
            &mut report.interrupted,
            &mut report.cleanup_failed,
            cancellation,
        )
        .await
        {
            Ok(manager) => {
                report.error = manager.error.clone();
                report.manager = Some(manager);
            }
            Err(error) => {
                report.error = Some(error.into());
                let mut manager = ManagerState::missing();
                manager.error = Some(error.into());
                report.manager = Some(manager);
            }
        }
    }
    report
}

pub fn line(report: &ServiceReport) -> String {
    if let Some(error) = &report.error
        && !report.installed
    {
        return format!("служба: состояние неизвестно — {error}");
    }
    if !report.installed {
        return "служба: не установлена (демон поднимается по требованию; поставить — pult daemon install)".into();
    }
    let file = report
        .file
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "null".into());
    if !report.ours {
        return format!(
            "служба: {file} обслуживает другой PULT_HOME ({}) — к этому дому не относится{}",
            report.file_home.as_deref().unwrap_or("не указан"),
            report
                .error
                .as_ref()
                .map(|e| format!(" · состояние неизвестно — {e}"))
                .unwrap_or_default()
        );
    }
    let mut parts = vec![format!("служба: установлена ({file})")];
    let launcher = report.launcher.as_deref().unwrap_or("не указан");
    parts.push(if report.launcher_ok {
        format!("лаунчер {launcher}")
    } else {
        format!("лаунчер НЕ НАЙДЕН: {launcher} — pult daemon install")
    });
    match &report.manager {
        None => parts.push(format!(
            "менеджер служб: {}",
            report.error.as_deref().unwrap_or("не спрашивали")
        )),
        Some(m) if !m.loaded => parts.push(
            m.error
                .as_ref()
                .map(|e| format!("менеджер служб: {e}"))
                .unwrap_or_else(|| "не загружена (загрузить: pult daemon install)".into()),
        ),
        Some(m) => {
            parts.push("загружена".into());
            parts.push(m.pid.map(|p| format!("pid {p}")).unwrap_or_else(|| {
                format!(
                    "не запущена{}",
                    m.state
                        .as_ref()
                        .map(|s| format!(" ({s})"))
                        .unwrap_or_default()
                )
            }));
            let exit = if let Some(signal) = &m.last_signal {
                format!(
                    "сигнал {}{}",
                    signal.num,
                    if signal.name.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", signal.name)
                    }
                )
            } else {
                m.last_exit_code
                    .map(|n| format!("код {n}"))
                    .unwrap_or_else(|| "ещё не выходила".into())
            };
            parts.push(format!("последний выход: {exit}"));
        }
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    #[test]
    fn recorded_darwin_running_is_not_a_fabricated_zero_exit() {
        let state = darwin(include_str!(
            "../../test/fixtures/service/launchctl-print-running.txt"
        ));
        assert!(state.loaded && state.running);
        assert_eq!(state.pid, Some(24594));
        assert_eq!(state.last_exit_code, None);
        assert_eq!(state.last_signal, None);
    }
    #[test]
    fn recorded_signal_and_derived_78_stay_distinct() {
        let killed = darwin(include_str!(
            "../../test/fixtures/service/launchctl-print-after-kill.txt"
        ));
        assert!(!killed.running);
        assert_eq!(
            killed.last_signal,
            Some(ExitSignal {
                num: 9,
                name: "Killed".into()
            })
        );
        assert_eq!(killed.last_exit_code, None);
        let derived = darwin(include_str!(
            "../../test/fixtures/service/launchctl-print-exited-78.txt"
        ));
        assert_eq!(derived.last_exit_code, Some(78));
        assert_eq!(derived.last_signal, None);
    }
    #[test]
    fn darwin_nested_coalition_does_not_replace_first_top_fields() {
        let state = darwin(
            "service = {\nstate = spawn scheduled\nresource coalition = {\nstate = running\npid = 99\n}\nstate = fake\nlast exit code = -2: x\n}\n",
        );
        assert_eq!(state.state.as_deref(), Some("spawn scheduled"));
        assert_eq!(state.pid, None);
        assert_eq!(state.last_exit_code, Some(-2));
    }
    #[test]
    fn linux_cld_signal_and_pid_history_are_not_active_processes() {
        let state = linux(
            "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nMainPID=0\nExecMainPID=72\nExecMainCode=3\nExecMainStatus=11\n",
        );
        assert_eq!(state.runs, Some(72));
        assert_eq!(state.last_exit_code, None);
        assert_eq!(state.pid, None);
        assert!(!state.running);
        assert_eq!(state.last_signal.unwrap().num, 11);
        assert_eq!(state.state.as_deref(), Some("activating (auto-restart)"));
    }
    #[test]
    fn linux_exit_zero_and_duplicate_last_key_match_node() {
        let state = linux(
            "LoadState=not-found\nLoadState=loaded\nActiveState=active\nMainPID=7\nExecMainCode=1\nExecMainStatus=0\n",
        );
        assert!(state.loaded && state.running);
        assert_eq!(state.last_exit_code, Some(0));
    }
    #[test]
    fn service_projection_preserves_template_escaping_and_stale_type() {
        let (home, launcher, stale) = service_fields(
            "darwin",
            "<key>PULT_HOME</key><string>/a&amp;b</string><key>ProgramArguments</key><array><string>/c&lt;d</string></array><key>ProcessType</key><string>Background</string>",
        );
        assert_eq!(home.as_deref(), Some("/a&b"));
        assert_eq!(launcher.as_deref(), Some("/c<d"));
        assert!(stale.unwrap().ends_with("нужен Standard"));
        let (home, launcher, stale) = service_fields(
            "linux",
            "Environment=\"PULT_HOME=/a%%b\\\"c\"\nExecStart=\"/a$$b%%c\\\\d\"\n",
        );
        assert_eq!(home.as_deref(), Some("/a%b\"c"));
        assert_eq!(launcher.as_deref(), Some("/a$b%c\\d"));
        assert!(stale.is_none());
    }
    #[test]
    fn malformed_service_fields_are_not_invented() {
        assert_eq!(
            service_fields("darwin", "<key>PULT_HOME</key><array/>"),
            (None, None, None)
        );
        assert_eq!(
            service_fields(
                "linux",
                "Environment=PULT_HOME=/not-quoted\nExecStart=/not-quoted"
            ),
            (None, None, None)
        );
    }
    #[test]
    fn relative_and_parent_paths_are_rejected_without_substitution() {
        assert!(read_file(Path::new("relative")).is_err());
        assert!(read_file(Path::new("/x/../y")).is_err());
        assert_eq!(absolute("/x/../y/./z".into()), Path::new("/y/z"));
    }
    #[test]
    fn missing_regular_file_and_utf8_replacement_are_exact() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("unit");
        assert!(read_file(&file).unwrap().is_none());
        std::fs::write(&file, b"a\xffb").unwrap();
        assert_eq!(read_file(&file).unwrap().as_deref(), Some("a\u{fffd}b"));
    }
    #[test]
    fn final_symlink_parent_symlink_and_fifo_do_not_escape_or_hang() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::write(&target, "private").unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(read_file(&link).is_err());
        let parent = dir.path().join("parent");
        symlink(dir.path(), &parent).unwrap();
        assert!(read_file(&parent.join("target")).is_err());
        let fifo = dir.path().join("fifo");
        assert!(
            std::process::Command::new("/usr/bin/mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        assert!(read_file(&fifo).is_err());
    }
    #[test]
    fn file_bound_is_explicit_not_truncation() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("unit");
        std::fs::write(&file, vec![b'a'; LIMIT]).unwrap();
        assert_eq!(read_file(&file).unwrap().unwrap().len(), LIMIT);
        std::fs::write(&file, vec![b'a'; LIMIT + 1]).unwrap();
        assert_eq!(
            read_file(&file).unwrap_err(),
            "service file exceeds 1 MiB limit"
        );
    }
    #[test]
    fn directory_is_not_an_empty_service_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_file(dir.path()).is_err());
    }
    #[test]
    fn same_home_uses_realpath_but_not_equal_names() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        symlink(&target, &link).unwrap();
        assert!(same_dir(&target, &link));
        assert!(!same_dir(&target, &dir.path().join("other")));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn standard_mac_tmp_alias_is_read_without_allowing_arbitrary_symlinks() {
        let dir = tempfile::Builder::new().tempdir_in("/tmp").unwrap();
        let file = dir.path().join("unit");
        std::fs::write(&file, "unit").unwrap();
        assert_eq!(read_file(&file).unwrap().as_deref(), Some("unit"));
    }
    #[test]
    fn malformed_or_overflow_numeric_fields_do_not_become_pids() {
        let state = darwin(
            "service = {\npid = 999999999999999999999999999999999999\nruns = -1\nlast exit code = never\n}\n",
        );
        assert_eq!(state.pid, None);
        assert_eq!(state.runs, None);
        assert_eq!(state.last_exit_code, None);
        assert_eq!(linux("MainPID=-1\nExecMainStatus=oops\n").pid, None);
    }
    #[test]
    fn query_arguments_have_only_read_only_operations() {
        let ctx = Context {
            platform: "darwin".into(),
            name: "test".into(),
            file: None,
            bin: None,
        };
        assert_eq!(query_args(&ctx)[0], "print");
        let ctx = Context {
            platform: "linux".into(),
            ..ctx
        };
        assert_eq!(&query_args(&ctx)[..2], &["--user", "show"]);
    }
    #[test]
    fn service_projection_does_not_execute_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("launcher");
        std::fs::write(&file, "exit 99").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (_, launcher, _) =
            service_fields("linux", &format!("ExecStart=\"{}\"\n", file.display()));
        assert_eq!(launcher.as_deref(), file.to_str());
    }
    #[test]
    fn executable_observation_uses_access_not_any_execute_bit_or_execution() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("launcher");
        std::fs::write(&file, "this is not an executable format").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable(file.to_str().unwrap()));
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(executable(file.to_str().unwrap()));
        if !nix::unistd::getuid().is_root() {
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o601)).unwrap();
            assert!(!executable(file.to_str().unwrap()));
        }
        assert!(!executable(dir.path().to_str().unwrap()));
    }
}
