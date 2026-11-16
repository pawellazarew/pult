//! Full local CLI doctor. RPC doctor.run and installed cutover are separate scopes.
use crate::{
    cli_browser_status,
    cli_client::{self, OwnerClient},
    doctor_config,
    doctor_exec::{DiagnosticCommand, Executor},
    doctor_files as files,
    doctor_model::{Item, Report, Text, js, redact},
    doctor_net::{self, DiagnosticProvider},
    doctor_path::{self, Tool},
    doctor_schema, doctor_service, doctor_toml,
};
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn safe_id(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| {
        let b = s.as_bytes();
        !b.is_empty()
            && b.len() <= 32
            && b[0].is_ascii_alphanumeric()
            && b.iter()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
    })
}
fn claude_items(r: super::doctor_exec::Output, t: Text) -> Vec<Item> {
    let text = r.stdout.trim();
    fn parsed(text: &str) -> Option<Value> {
        let raw: Box<serde_json::value::RawValue> = serde_json::from_str(text).ok()?;
        let fields = pult_core::RawFields::parse(&raw).ok()?;
        let logged = fields
            .get("loggedIn")
            .and_then(|v| serde_json::from_str::<bool>(v.get()).ok());
        let string = |name| {
            fields
                .get(name)
                .filter(|v| v.get().starts_with('"'))
                .and_then(|v| pult_core::display_string(v).ok())
        };
        Some(
            json!({"loggedIn":logged,"subscriptionType":string("subscriptionType"),"authMethod":string("authMethod")}),
        )
    }
    let raw = parsed(text).or_else(|| text.find('{').and_then(|i| parsed(&text[i..])));
    let logged = raw.as_ref().and_then(|v| v["loggedIn"].as_bool());
    let code = r
        .code
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".into());
    let detail = if let Some(logged) = logged {
        t.t(
            "loggedIn: {0} (код выхода {1} игнорируется — измерено спайком)",
            &[if logged { "true" } else { "false" }, &code],
        )
    } else {
        t.t(
            "ответ не разобран (код выхода {0}) — код выхода мы игнорируем намеренно",
            &[&code],
        )
    };
    let mut login = t
        .item(
            "login.claude",
            "Вход claude",
            match logged {
                Some(true) => "ok",
                Some(false) => "fail",
                None => "warn",
            },
            detail,
        )
        .data(json!({"exitCode":r.code,"loggedIn":logged}));
    if logged != Some(true) {
        login = login.cmd(if logged == Some(false) {
            "claude /login"
        } else {
            "claude auth status"
        })
    }
    let plan = raw
        .as_ref()
        .and_then(|v| safe_id(v.get("subscriptionType")));
    let method = raw.as_ref().and_then(|v| safe_id(v.get("authMethod")));
    let how = method.map(|m| t.t(", вход {0}", &[m])).unwrap_or_default();
    let mut subscription = match logged {
        None => t
            .item(
                "subscription.claude",
                "Подписка claude",
                "warn",
                t.t("вход не разобран — тип подписки неизвестен", &[]),
            )
            .cmd("claude auth status"),
        Some(false) => t
            .item(
                "subscription.claude",
                "Подписка claude",
                "warn",
                t.t("не вошёл — ходам агентов claude тратить нечего", &[]),
            )
            .cmd("claude /login"),
        Some(true) => {
            if let Some(plan) = plan {
                t.item("subscription.claude","Подписка claude","ok",t.t("{0}{1} — ходы агентов Пульта тратят лимиты ЭТОЙ подписки: той, в которую вошёл терминальный claude",&[plan,&how]))
            } else {
                t.item("subscription.claude","Подписка claude","warn",t.t("тип подписки не сообщён{0} — ходы Пульта тратят тот вход, что у терминального claude",&[&how])).cmd("claude auth status")
            }
        }
    };
    subscription.data = Some(json!({"subscriptionType":plan,"authMethod":method}));
    vec![login, subscription]
}
fn codex_items(r: super::doctor_exec::Output, t: Text) -> Vec<Item> {
    let units = [&r.stdout, &r.stderr]
        .into_iter()
        .find_map(|s| {
            s.split('\n')
                .map(crate::cli_runtime_files::trim)
                .find(|l| !l.is_empty())
        })
        .map(|s| redact(s).encode_utf16().take(160).collect::<Vec<_>>())
        .unwrap_or_default();
    let split_pair = std::char::decode_utf16(units.iter().copied()).any(|u| u.is_err());
    let line = String::from_utf16_lossy(&units);
    let code = r
        .code
        .map(|v| v.to_string())
        .unwrap_or_else(|| "null".into());
    let fallback = t.t("вход есть, способ не сообщён", &[]);
    let tail = if line.is_empty() {
        String::new()
    } else {
        format!(": {line}")
    };
    let mut login = t
        .item(
            "login.codex",
            "Вход codex",
            if r.code == Some(0) { "ok" } else { "fail" },
            t.t("код выхода {0}{1}", &[&code, &tail]),
        )
        .data(json!({"exitCode":r.code}));
    if r.code != Some(0) {
        login = login.cmd("codex login")
    }
    if split_pair {
        let mut detail = t
            .t("код выхода {0}{1}", &[&code, ": "])
            .encode_utf16()
            .collect::<Vec<_>>();
        detail.extend(&units);
        login.raw_detail = Some(super::doctor_model::raw_string(&detail));
    }
    let mut out = vec![login];
    if r.code == Some(0) {
        let mut subscription=t.item("subscription.codex","Подписка codex","ok",t.t("{0} — ходы агентов Пульта тратят ту учётку, в которую вошёл терминальный codex",&[if line.is_empty(){&fallback}else{&line}])).data(json!({"login":line}));
        if split_pair {
            let mut detail = units.clone();
            detail.extend(t.t("{0} — ходы агентов Пульта тратят ту учётку, в которую вошёл терминальный codex",&[""]).encode_utf16());
            subscription.raw_detail = Some(super::doctor_model::raw_string(&detail));
            subscription.raw_login = Some(super::doctor_model::raw_string(&units));
        }
        out.push(subscription);
    }
    out
}
fn daemon_projection(raw: &serde_json::value::RawValue) -> Result<Value> {
    fn fields(raw: &serde_json::value::RawValue, names: &[&str]) -> Result<Value> {
        let source = pult_core::RawFields::parse(raw)?;
        let mut out = serde_json::Map::new();
        for name in names {
            if let Some(raw) = source.get(name) {
                out.insert((*name).into(), files::json(raw.get())?);
            }
        }
        Ok(Value::Object(out))
    }
    let source = pult_core::RawFields::parse(raw)?;
    let mut out = serde_json::Map::new();
    for name in ["version", "pid", "uptimeMs", "lastEventId"] {
        if let Some(raw) = source.get(name) {
            out.insert(name.into(), files::json(raw.get())?);
        }
    }
    for (name, known) in [
        ("node", &["path", "version", "alive", "own"][..]),
        ("browser", &["sessions"][..]),
    ] {
        if let Some(raw) = source.get(name) {
            out.insert(
                name.into(),
                if raw.get().starts_with('{') {
                    fields(raw, known)?
                } else {
                    files::json(raw.get())?
                },
            );
        }
    }
    if let Some(raw) = source.get("update") {
        let update = if raw.get().starts_with('{') {
            let f = pult_core::RawFields::parse(raw)?;
            let mut v = fields(
                raw,
                &["error", "enabled", "checkedAt", "current", "available"],
            )?;
            if let Some(latest) = f.get("latest") {
                v["latest"] = if latest.get().starts_with('{') {
                    fields(latest, &["version"])?
                } else {
                    files::json(latest.get())?
                };
            }
            v
        } else {
            files::json(raw.get())?
        };
        out.insert("update".into(), update);
    }
    Ok(Value::Object(out))
}
fn daemon_items(status: Option<&Value>, t: Text) -> Vec<Item> {
    let mut out = vec![];
    let detail = if let Some(s) = status {
        let uptime = s["uptimeMs"]
            .as_f64()
            .map(|v| format!("{:.0}", (v / 1000.0).round()))
            .unwrap_or_else(|| "NaN".into());
        t.t(
            "версия {0}, pid {1}, аптайм {2} с, события до {3}",
            &[
                &js(s.get("version")),
                &js(s.get("pid")),
                &uptime,
                &js(s.get("lastEventId")),
            ],
        )
    } else {
        t.t(
            "не отвечает (это нормально: демон поднимается по требованию)",
            &[],
        )
    };
    let mut daemon = t.item(
        "daemon",
        "Демон pultd",
        if status.is_some() { "ok" } else { "warn" },
        detail,
    );
    if status.is_none() {
        daemon = daemon.cmd("pult daemon start")
    }
    out.push(daemon);
    if let Some(n) = status.and_then(|s| s.get("node")).filter(|v| !v.is_null()) {
        let p = js(n.get("path"));
        let v = js(n.get("version"));
        let i = if n["alive"] != true {
            t.item("daemon.node","Node демона","fail",format!("{}{}",t.t("node демона {0} ({1}) удалён или заменён обновлением (brew upgrade?) — macOS не пустит ",&[&p,&v]),t.t("агентов в ~/Desktop, ходы claude там падают с «An unknown error occurred (Unexpected)». Перезапусти демона",&[]))).cmd("pult daemon stop && pult daemon start")
        } else if n["own"] != true {
            t.item("daemon.node","Node демона","warn",format!("{}{}",t.t("системный node {0} ({1}) — его обновление (brew upgrade node) уронит доступ агентов к ~/Desktop. ",&[&p,&v]),t.t("Свой node Пульта: pult runtime install, затем перезапуск демона",&[]))).cmd("pult runtime install && pult daemon stop && pult daemon start")
        } else {
            t.item(
                "daemon.node",
                "Node демона",
                "ok",
                t.t("свой node Пульта {0}: {1}", &[&v, &p]),
            )
        };
        out.push(i)
    }
    out
}
fn browser_items(
    root: &Path,
    display: &Path,
    user: &Path,
    test: bool,
    daemon: Option<&Value>,
    selected: &[String],
    t: Text,
) -> Result<Vec<Item>> {
    let installed = cli_browser_status::installed(root)?;
    let chrome = cli_browser_status::chrome(root)?;
    let wanted = daemon.and_then(|d| d["browser"]["sessions"].as_f64());
    let want = wanted.is_some_and(|n| n > 0.0);
    let pkg = "@playwright/mcp 0.0.84";
    let mut mcp=t.item("browser.mcp","Браузер агента",if installed||!want{"ok"}else{"warn"},if installed{t.t("{0} стоит: {1}",&[pkg,&display.join("mcp/playwright-mcp-0.0.84").display().to_string()])}else if want{t.t("{0} не поставлен, а браузер включён у сессий: {1}",&[pkg,&wanted.unwrap().to_string()])}else{t.t("{0} не поставлен — поставится сам, когда сессии включат браузер (или: pult browser install)",&[pkg])});
    if !installed && want {
        mcp = mcp.cmd("pult browser install")
    }
    let need = want || installed;
    let mut chr=t.item("browser.chrome","Chrome для браузера агента",if chrome.is_some()||!need{"ok"}else{"warn"},chrome.map(|p|p.display().to_string()).unwrap_or_else(||t.t(if need{"Google Chrome не найден — браузер агента работает на системном Chrome, своих браузеров Пульт не качает"}else{"Google Chrome не найден (нужен только браузеру агента)"},&[])));
    if chr.status == "warn" {
        chr = chr.fix(t.t(
            "поставь Google Chrome (https://www.google.com/chrome/) в /Applications",
            &[],
        ))
    }
    let mut out = vec![
        mcp,
        chr,
        files::mcp(
            &files::user_file(root, user, test, "claude.json", ".claude.json"),
            selected,
            t,
        )?,
    ];
    let mode = pult_core::claude_settings::default_mode(&[files::user_file(
        root,
        user,
        test,
        "claude-settings.json",
        ".claude/settings.json",
    )]);
    if mode == Some("bypassPermissions".encode_utf16().collect()) {
        out.push(t.item("browser.permissions","Браузер агента и режим разрешений Claude",if want{"warn"}else{"ok"},t.t("в ~/.claude/settings.json permissions.defaultMode = \"bypassPermissions\" — браузер для сессий Claude не включается (вызовы шли бы без вопроса)",&[])).fix(t.t("поменяй defaultMode (например, на \"auto\") в ~/.claude/settings.json",&[])))
    }
    Ok(out)
}
async fn auth(
    root: &Path,
    tools: &[Tool],
    exec: &Executor,
    schema_exec: &Executor,
    t: Text,
) -> Result<Vec<Item>> {
    let mut jobs = tokio::task::JoinSet::new();
    if let Some(bin) = tools
        .iter()
        .find(|t| t.name == "claude")
        .and_then(|t| t.path.clone())
    {
        let exec = exec.clone();
        jobs.spawn(async move {
            Ok::<_, anyhow::Error>((
                0,
                claude_items(exec.run(DiagnosticCommand::ClaudeAuth(bin)).await?, t),
            ))
        });
    }
    if let Some(bin) = tools
        .iter()
        .find(|t| t.name == "codex")
        .and_then(|t| t.path.clone())
    {
        let exec1 = exec.clone();
        let login_bin = bin.clone();
        jobs.spawn(async move {
            Ok((
                1,
                codex_items(
                    exec1.run(DiagnosticCommand::CodexLogin(login_bin)).await?,
                    t,
                ),
            ))
        });
        let exec = schema_exec.clone();
        let root = root.to_owned();
        jobs.spawn(async move { Ok((2, vec![doctor_schema::check(&root, bin, &exec, t).await?])) });
    }
    let mut out = vec![];
    let mut error = None;
    while let Some(r) = jobs.join_next().await {
        match r {
            Ok(Ok(v)) => out.push(v),
            Ok(Err(e)) => {
                error.get_or_insert(e);
            }
            Err(_) => {
                error.get_or_insert(anyhow!("doctor auth job failed"));
            }
        }
    }
    if let Some(e) = error {
        return Err(e);
    }
    out.sort_by_key(|v| v.0);
    Ok(out.into_iter().flat_map(|v| v.1).collect())
}
async fn execute(
    root: &Path,
    display: &Path,
    json_output: bool,
    no_net: bool,
    exec: &Executor,
) -> Result<i32> {
    let (config, t, warnings) = doctor_config::load(root)?;
    for w in warnings {
        cli_client::emit(format!("config: {w}\n"), true)
            .await
            .map_err(|_| anyhow!("doctor warning output failed"))?;
    }
    let test = std::env::var("PULT_TEST").as_deref() == Ok("1");
    let user = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| {
            nix::unistd::User::from_uid(nix::unistd::getuid())
                .ok()
                .flatten()
                .map(|u| u.dir)
        })
        .ok_or_else(|| anyhow!("doctor user home unavailable"))?;
    let paths = doctor_path::login_path(root, &user, test, exec).await?;
    let tools = doctor_path::locate(root, &user, &paths, test, exec).await?;
    let mut child_exec = exec.clone();
    if !paths.is_empty() {
        child_exec.env.insert("PATH".into(), paths.join(":").into());
    }
    let active = files::follow(&root.join("runtime/active"), 16 * 1024)?;
    let managed = active
        .as_deref()
        .map(files::trim_first)
        .filter(|s| !s.is_empty())
        .and_then(crate::cli_runtime_files::program);
    let located = tools.iter().find(|t| t.name == "node").unwrap();
    let mut selected = (located.path.clone(), located.version.clone(), "located");
    if let Some(bin) = managed {
        if test {
            ensure!(
                std::fs::canonicalize(&bin)?.starts_with(root),
                "test managed node must stay in scratch home"
            );
        }
        let r = exec
            .run(DiagnosticCommand::Version {
                bin: bin.clone(),
                node: true,
            })
            .await?;
        let version = crate::cli_runtime_files::trim(&r.stdout).to_owned();
        if r.code == Some(0) && doctor_path::node_supported(&version) {
            selected = (Some(bin), Some(version), "managed-active");
        }
    }
    let (node_path, node_version, source) = selected;
    let version = node_version.as_deref().unwrap_or("unknown");
    let supported = doctor_path::node_supported(version);
    let mut node = t
        .item(
            "node.version",
            "Node",
            if supported { "ok" } else { "fail" },
            t.t("{0} (нужен >= {1})", &[version, "22"]),
        )
        .data(json!({"path":node_path,"source":source}));
    if !supported {
        node = node.cmd("brew upgrade node")
    };
    let mut items = vec![node];
    items.extend(tools.iter().map(|tool| doctor_path::item(tool, &user, t)));
    items.extend(auth(root, &tools, &child_exec, exec, t).await?);
    let codex_file = if test {
        root.join("codex-config.toml")
    } else {
        std::env::var_os("CODEX_HOME")
            .filter(|v| !v.to_string_lossy().trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| user.join(".codex"))
            .join("config.toml")
    };
    if let Some(i) = doctor_toml::item(&codex_file, t) {
        items.push(i)
    }
    let present = |name: &str| {
        tools
            .iter()
            .any(|tool| tool.name == name && tool.path.is_some())
    };
    let mut opencode=t.item("login.opencode","Вход opencode",if present("opencode"){"ok"}else{"warn"},t.t(if present("opencode"){"проверяется только наличие CLI: ключи opencode живут в его конфиге, отдельной команды входа Пульт не дёргает"}else{"CLI не найден — проверять нечего"},&[]));
    if !present("opencode") {
        opencode = opencode.cmd("brew install sst/tap/opencode")
    }
    items.push(opencode);
    if present("zcode") {
        let path = if test {
            root.join("zcode-credentials.json")
        } else {
            std::env::var_os("ZCODE_DATA_BASE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| user.join(".zcode/v2"))
                .join("credentials.json")
        };
        let login = files::zcode(&path)?;
        let mut i=t.item("login.zcode","Вход zcode",match login{"yes"=>"ok","no"=>"fail",_=>"warn"},t.t(match login{"yes"=>"креды на месте (файл кред есть, токен в нём)","no"=>"файла кред нет — терминальный zcode не входил (zcode login открывает браузер)",_=>"файл кред не разбирается — посмотри его сам"},&[])).data(json!({"login":login}));
        if login != "yes" {
            i = i.cmd("zcode login")
        }
        items.push(i)
    }
    items.push(doctor_net::guard(&config, t));
    if !no_net {
        let mut jobs = tokio::task::JoinSet::new();
        for (index, provider) in DiagnosticProvider::ALL.into_iter().enumerate() {
            let exec = exec.clone();
            let config = config.clone();
            let root = root.to_owned();
            let display = display.to_owned();
            jobs.spawn(async move {
                doctor_net::check(&root, &display, provider, &config, test, &exec, t)
                    .await
                    .map(|i| (index, i))
            });
        }
        let mut network = vec![];
        let mut error = None;
        while let Some(r) = jobs.join_next().await {
            match r {
                Ok(Ok(v)) => network.push(v),
                Ok(Err(e)) => {
                    error.get_or_insert(e);
                }
                Err(_) => {
                    error.get_or_insert(anyhow!("doctor network job failed"));
                }
            }
        }
        if let Some(e) = error {
            return Err(e);
        }
        network.sort_by_key(|v| v.0);
        items.extend(network.into_iter().map(|v| v.1));
    }
    items.push(files::permissions(root, display, t));
    let (_, _, status) = OwnerClient::status_at(
        root.to_owned(),
        if t.0 { "en" } else { "ru" },
        Some(Duration::from_secs(2)),
    )
    .await
    .map_err(|e| anyhow!(e.message))?;
    let status = status.as_deref().map(daemon_projection).transpose()?;
    items.extend(daemon_items(status.as_ref(), t));
    items.extend(files::version_items(root, status.as_ref(), t, display)?);
    items.extend(browser_items(
        root,
        display,
        &user,
        test,
        status.as_ref(),
        &config.mcp.servers,
        t,
    )?);
    items.extend(doctor_service::items(root, display, test, exec, t).await?);
    ensure!(!*exec.cancel.borrow(), "doctor interrupted");
    let report = Report::new(display.display().to_string(), items);
    let output = if json_output {
        serde_json::to_string_pretty(&report)?
    } else {
        report.text(t)
    };
    let mut rx = exec.cancel.clone();
    tokio::select! {biased;_=super::doctor_exec::cancelled(&mut rx)=>return Ok(130),result=cli_client::emit(format!("{output}\n"),false)=>result.map_err(|_|anyhow!("doctor output failed"))?};
    Ok(report.exit())
}
pub(super) async fn run(display: &Path, json: bool, no_net: bool) -> Result<i32> {
    ensure!(
        [
            "PULT_MEMORY_KEY",
            "PULT_CODEX_MEMORY_KEY",
            "PULT_MEMORY_TURN_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY"
        ]
        .iter()
        .all(|k| std::env::var_os(k).is_none()),
        "doctor requires owner authentication"
    );
    let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let (tx, rx) = tokio::sync::watch::channel(false);
    let exec = Executor::new(rx)?;
    let monitor = tokio::spawn(async move {
        while signal.recv().await.is_some() {
            let _ = tx.send(true);
        }
    });
    let result = async {
        let root = pult_core::checked_home(display)?;
        execute(&root, display, json, no_net, &exec).await
    }
    .await;
    let interrupted = *exec.cancel.borrow();
    monitor.abort();
    let _ = monitor.await;
    if exec.schema_retained() && (interrupted || result.is_err()) {
        let _ = cli_client::emit(
            "Warning: schema scratch retained; bounded cleanup was not completed\n".into(),
            true,
        )
        .await;
    }
    ensure!(
        !exec.cleanup_failed(),
        "doctor child cleanup is unconfirmed; retained scratch requires inspection"
    );
    if interrupted {
        let _ = cli_client::emit("Error: doctor interrupted\n".into(), true).await;
        return Ok(130);
    }
    result
}

#[cfg(test)]
mod combined_capture_tests {
    use super::*;
    use crate::cli_owned_query::{self, Error, Kind};
    use std::os::unix::process::ExitStatusExt;
    fn auth(primary: Option<Error>, reader: Option<Error>) -> Vec<Item> {
        let raw = cli_owned_query::Output {
            status: std::process::ExitStatus::from_raw(0),
            failure: cli_owned_query::failure_kind(Kind::DoctorAuth, primary, reader),
            stdout: br#"{"loggedIn":true}"#.to_vec(),
            stderr: vec![],
        };
        claude_items(crate::doctor_exec::project(raw), Text(true))
    }
    #[test]
    fn timeout_and_joined_reader_overflow_never_confirm_partial_auth() {
        for first in [Error::Output, Error::Overflow] {
            let second = if matches!(first, Error::Output) {
                Error::Overflow
            } else {
                Error::Output
            };
            let joined = cli_owned_query::failure_kind(Kind::DoctorAuth, Some(first), Some(second));
            assert!(
                matches!(joined, Some(Error::Overflow)),
                "every observed reader cap survives join order"
            );
            assert_eq!(auth(Some(Error::Timeout), joined)[0].status, "warn");
        }
        let items = auth(Some(Error::Timeout), Some(Error::Overflow));
        assert_eq!(items[0].status, "warn");
        assert_eq!(items[0].data.as_ref().unwrap()["loggedIn"], Value::Null);
        assert_eq!(
            auth(Some(Error::Timeout), None)[0].status,
            "ok",
            "source timeout-only partial stdout stays qualified"
        );
        assert_eq!(
            auth(Some(Error::Timeout), Some(Error::Output))[0].status,
            "warn",
            "observed reader I/O failure also stays incomplete"
        );
        assert_eq!(
            auth(None, Some(Error::Overflow))[0].status,
            "warn",
            "overflow-only control"
        );
    }
    #[test]
    fn fatal_lifecycle_observations_and_legacy_query_projection_keep_priority() {
        for fatal in [
            Error::Interrupted,
            Error::Ownership,
            Error::Cleanup,
            Error::OutputCleanup,
        ] {
            let chosen =
                cli_owned_query::failure_kind(Kind::DoctorAuth, Some(fatal), Some(Error::Overflow));
            assert_eq!(format!("{chosen:?}"), format!("{:?}", Some(fatal)));
            let chosen =
                cli_owned_query::failure_kind(Kind::DoctorAuth, Some(Error::Timeout), Some(fatal));
            assert_eq!(format!("{chosen:?}"), format!("{:?}", Some(fatal)));
        }
        for kind in [Kind::Service, Kind::NodeVersion] {
            assert!(matches!(
                cli_owned_query::failure_kind(kind, Some(Error::Timeout), Some(Error::Overflow)),
                Some(Error::Timeout)
            ));
        }
    }
}
