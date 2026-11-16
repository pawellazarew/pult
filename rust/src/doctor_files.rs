//! Bounded diagnostic reads. User dotfiles follow symlinks; scratch config does not.
use crate::{
    cli_client::owner_private_file::{self, Policy},
    doctor_model::{Item, Text, redact},
};
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json, value::RawValue};
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
pub(super) const LIMIT: u64 = 1024 * 1024;
pub(super) fn private_read(home: &Path, name: &str, limit: u64) -> Result<Option<String>> {
    owner_private_file::read(
        home,
        Path::new(name),
        limit,
        Policy {
            private_config: false,
        },
    )
    .map(|b| b.map(|b| String::from_utf8_lossy(&b).into_owned()))
    .map_err(|_| anyhow!("doctor scratch input cannot be read safely"))
}
pub(super) fn follow(path: &Path, limit: u64) -> Result<Option<String>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None);
        }
        Err(_) => return Err(anyhow!("diagnostic file cannot be read")),
    };
    let before = file.metadata()?;
    ensure!(before.is_file(), "diagnostic input must be a regular file");
    ensure!(before.len() <= limit, "diagnostic input exceeds size limit");
    let mut bytes = Vec::new();
    (&file).take(limit + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    ensure!(
        bytes.len() as u64 <= limit
            && before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec(),
        "diagnostic input changed or exceeds limit"
    );
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}
/// JSON.parse accepts lone UTF-16 units; only the narrow file projection is used.
/// Rust display/OS strings follow Node's UTF-8 replacement at their output boundary.
pub(super) fn json(text: &str) -> Result<Value> {
    let _: Box<RawValue> = serde_json::from_str(text)?;
    let b = text.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    let mut start = 0;
    while at < b.len() {
        if b[at] != b'"' {
            at += 1;
            continue;
        }
        out.push_str(&text[start..at]);
        let begin = at;
        at += 1;
        while at < b.len() {
            if b[at] == b'\\' {
                at += 2;
            } else if b[at] == b'"' {
                at += 1;
                break;
            } else {
                at += 1
            }
        }
        let raw: Box<RawValue> = serde_json::from_str(&text[begin..at])?;
        out.push_str(&serde_json::to_string(&pult_core::display_string(&raw)?)?);
        start = at;
    }
    out.push_str(&text[start..]);
    Ok(serde_json::from_str(&out)?)
}
pub(super) fn private_dir(home: &Path, name: &str) -> Result<PathBuf> {
    let path = home.join(name);
    match std::fs::create_dir(&path) {
        Ok(()) => std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    };
    let m = std::fs::symlink_metadata(&path)?;
    ensure!(
        m.is_dir()
            && !m.file_type().is_symlink()
            && m.uid() == nix::unistd::getuid().as_raw()
            && m.mode() & 0o077 == 0,
        "doctor scratch directory is unsafe"
    );
    Ok(path)
}
pub(super) fn user_file(
    root: &Path,
    user: &Path,
    test: bool,
    test_name: &str,
    ordinary: &str,
) -> PathBuf {
    if test {
        root.join(test_name)
    } else {
        user.join(ordinary)
    }
}
pub(super) fn zcode(path: &Path) -> Result<&'static str> {
    let s = match follow(path, LIMIT) {
        Ok(Some(s)) => s,
        Ok(None) => return Ok("no"),
        Err(_) => return Ok("unknown"),
    };
    let Ok(v) = json(&s) else {
        return Ok("unknown");
    };
    let Some(o) = v.as_object() else {
        return Ok("unknown");
    };
    Ok(
        if o.keys().any(|k| {
            k == "zcodejwttoken" || (k.starts_with("oauth:") && k.ends_with(":access_token"))
        }) {
            "yes"
        } else {
            "no"
        },
    )
}
pub(super) fn mcp(path: &Path, selected: &[String], t: Text) -> Result<Item> {
    let base =
        |status: &str, detail: String| t.item("mcp.servers", "Свои MCP-серверы", status, detail);
    let s = follow(path, LIMIT);
    let mut warning = None;
    let mut names = Vec::new();
    match s {
        Err(_) => {
            warning = Some(format!(
                "{}: не читается (diagnostic file cannot be read)",
                path.display()
            ))
        }
        Ok(Some(s)) => match json(&s) {
            Err(_) => {
                warning = Some(format!(
                    "{}: не разбирается как JSON — серверы оттуда не видны",
                    path.display()
                ))
            }
            Ok(v) => {
                if !v.is_object() {
                    warning = Some(format!("{}: корень не объект", path.display()))
                } else if let Some(m) = v.get("mcpServers") {
                    if let Some(o) = m.as_object() {
                        let re = regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").unwrap();
                        for (k, s) in o {
                            let kind = s.get("type").and_then(Value::as_str);
                            let command = s
                                .get("command")
                                .and_then(Value::as_str)
                                .is_some_and(|s| !s.is_empty());
                            let url = s
                                .get("url")
                                .and_then(Value::as_str)
                                .is_some_and(|s| !s.is_empty());
                            if re.is_match(k)
                                && s.is_object()
                                && match kind {
                                    Some("stdio") => command,
                                    Some("http" | "sse") => url,
                                    None => command || url,
                                    _ => false,
                                }
                            {
                                names.push(k.clone());
                            }
                        }
                    } else {
                        warning = Some(format!("{}: mcpServers не объект", path.display()))
                    }
                }
            }
        },
        Ok(None) => (),
    }
    if let Some(w) = warning {
        return Ok(base("warn", w).fix(t.t(
            "проверь {0}: Пульт читает оттуда mcpServers (только чтение)",
            &[&path.display().to_string()],
        )));
    }
    let missing = selected
        .iter()
        .filter(|n| !names.contains(n))
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Ok(base("warn",t.t("выбраны, но в ~/.claude.json их нет — не подключаются: {0}",&[&missing.join(", ")])).fix(t.t("добавь их (claude mcp add --scope user …) или сними выбор: окно → doctor → «MCP-серверы…» / pult mcp select",&[])));
    }
    let detail = if selected.is_empty() {
        t.t("не выбраны (в ~/.claude.json: {0}) — выбрать: окно → doctor → «MCP-серверы» или pult mcp select",&[&names.len().to_string()])
    } else {
        t.t(
            "подключены к сессиям Claude: {0} · в ~/.claude.json: {1}",
            &[&selected.join(", "), &names.len().to_string()],
        )
    };
    Ok(base("ok", detail))
}
pub(super) fn permissions(root: &Path, display: &Path, t: Text) -> Item {
    let mut bad = vec![];
    for (name, expected) in [
        ("", 0o700),
        ("run", 0o700),
        ("events", 0o700),
        ("logs", 0o700),
        ("run/token", 0o600),
        ("run/pultd.sock", 0o600),
        ("events/journal.jsonl", 0o600),
        ("logs/pultd.log", 0o600),
        ("config.json", 0o600),
    ] {
        if let Ok(m) = std::fs::metadata(root.join(name)) {
            let mode = m.mode() & 0o777;
            if mode != expected {
                bad.push(format!("{} = {mode:o}", display.join(name).display()))
            }
        }
    }
    if bad.is_empty() {
        t.item(
            "home.permissions",
            "Права PULT_HOME",
            "ok",
            t.t(
                "каталоги 0700, файлы 0600 — {0}",
                &[&display.display().to_string()],
            ),
        )
    } else {
        t.item(
            "home.permissions",
            "Права PULT_HOME",
            "warn",
            t.t(
                "ожидаются каталоги 0700 и файлы 0600; не так: {0}",
                &[&bad.join(", ")],
            ),
        )
        .cmd(format!(
            "chmod 700 {} {} && chmod 600 {}",
            display.display(),
            display.join("run").display(),
            display.join("run/token").display()
        ))
    }
}
pub(super) fn version_items(root: &Path, daemon: Option<&Value>, t: Text) -> Result<Vec<Item>> {
    let current = root.join("current");
    let mut items = vec![];
    let link = std::fs::read_link(&current).ok();
    let base =
        |status: &str, detail: String| t.item("version.current", "Активная версия", status, detail);
    if let Some(link) = link {
        let name = link
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let target = link.display().to_string();
        let mut package = None;
        for (p, layout) in [
            (current.join("lib/node_modules/pult"), "installed"),
            (current.clone(), "dev"),
        ] {
            if let Some(s) = follow(&p.join("package.json"), LIMIT)?
                && let Ok(v) = json(&s)
                && v["name"] == "pult"
                && v["version"].is_string()
            {
                package = Some((p, layout, v["version"].as_str().unwrap().to_owned()));
                break;
            }
        }
        if let Some((path, layout, version)) = package {
            let state = private_read(root, "update.json", LIMIT)?
                .and_then(|s| json(&s).ok())
                .unwrap_or(Value::Null);
            let previous = state
                .get("previous")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let bad = state
                .get("bad")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            let mut data = json!({"current":name,"version":version,"layout":layout,"previous":previous,"bad":bad});
            let interrupted = state["current"] == name
                && state["last"]["result"] == "failed"
                && state["last"]["version"] == name
                && state["last"]["message"] == "проба идёт (прервана?)";
            if interrupted {
                data["probeInterrupted"] = json!(true);
                items.push(base("warn",t.t("current → {0}: pult {1}, но проба {2} прервана ({3}) — версия не проверена",&[&target,&version,&name,state["last"]["at"].as_str().unwrap_or("?")])).cmd(format!("pult update --to {name}")).data(data));
            } else {
                let dev = if layout == "dev" {
                    t.t(" (рабочая копия {0})", &[&path.display().to_string()])
                } else {
                    String::new()
                };
                let prev = previous
                    .map(|p| t.t("; откат — {0}", &[p]))
                    .unwrap_or_default();
                let bad = if bad.is_empty() {
                    String::new()
                } else {
                    format!("; bad: {}", bad.join(", "))
                };
                items.push(
                    base(
                        "ok",
                        format!("current → {target}: pult {version}{dev}{prev}{bad}"),
                    )
                    .data(data),
                );
                if let Some(d) = daemon
                    && d.get("version").and_then(Value::as_str) != Some(&version)
                {
                    items.push(
                        t.item(
                            "version.daemon",
                            "Версия демона",
                            "warn",
                            t.t(
                                "работает демон {0} (pid {1}), а current — {2}: перезапусти демона",
                                &[
                                    &super::doctor_model::js(d.get("version")),
                                    &super::doctor_model::js(d.get("pid")),
                                    &version,
                                ],
                            ),
                        )
                        .cmd("pult daemon stop && pult daemon start"),
                    );
                }
            }
        } else {
            items.push(base("fail",t.t("current → {0}, но там нет пакета pult: служба выйдет с кодом 78, демон из current не поднимется",&[&target])).fix(t.t("pult update --list && pult update --to <версия>",&[])));
        }
    } else {
        items.push(base("ok",t.t("current нет — демон поднимается из того пакета, откуда запущен CLI (установить версию: pult update --from <tgz>)",&[])));
    }
    if let Some(u) = daemon
        .and_then(|d| d.get("update"))
        .filter(|v| !v.is_null())
    {
        let latest = u.get("latest").filter(|v| !v.is_null());
        let base = |status: &str, detail: String| {
            t.item("update.channel", "Канал обновлений", status, detail)
        };
        items.push(if let Some(e)=u.get("error").and_then(Value::as_str).filter(|s|!s.is_empty()){base("warn",t.t("канал обновлений: {0}",&[&redact(e)])).data(json!({"checkedAt":u.get("checkedAt"),"latest":latest.and_then(|l|l.get("version"))}))}else if u["enabled"]!=true&&latest.is_none(){base("ok",t.t("сам не проверяет (updates.check: false в config.json); проверить: pult update --check",&[]))}else if latest.is_none(){base("ok",t.t("ещё не проверялся (первая проверка — через минуту после старта демона)",&[]))}else if u["available"]==true {base("ok",t.t("доступна {0} (стоит {1}) — поставить: pult update",&[&super::doctor_model::js(latest.unwrap().get("version")),&super::doctor_model::js(u.get("current"))])).cmd("pult update")}else{let checked=u.get("checkedAt").and_then(Value::as_str).map(|s|t.t(" · проверено {0}",&[s])).unwrap_or_default();base("ok",t.t("в канале {0}, стоит {1}{2}",&[&super::doctor_model::js(latest.unwrap().get("version")),&super::doctor_model::js(u.get("current")),&checked]))});
    }
    Ok(items)
}

pub(super) fn trim_first(s: &str) -> &str {
    crate::cli_runtime_files::trim(s.split('\n').next().unwrap_or(""))
}
