//! Service doctor projection over the reviewed bounded service observer.
use crate::{
    cli_service,
    doctor_exec::{DiagnosticCommand, Executor, cancelled},
    doctor_files as files,
    doctor_model::{Item, Text, js},
    doctor_path,
};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::path::{Path, PathBuf};
fn last_exit(m: &Value) -> String {
    if let Some(sig) = m.get("lastSignal").filter(|v| !v.is_null()) {
        format!(
            "сигнал {}{}",
            js(sig.get("num")),
            sig.get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| format!(" ({s})"))
                .unwrap_or_default()
        )
    } else if let Some(code) = m.get("lastExitCode").filter(|v| !v.is_null()) {
        format!("код {}", js(Some(code)))
    } else {
        "ещё не выходила".into()
    }
}
pub(super) async fn items(
    root: &Path,
    display: &Path,
    test: bool,
    exec: &Executor,
    t: Text,
) -> Result<Vec<Item>> {
    let mut rx = exec.cancel.clone();
    let c = cancelled(&mut rx);
    tokio::pin!(c);
    let r = cli_service::report_with_cancel(root, &mut c).await;
    ensure!(!r.cleanup_failed, "doctor service cleanup is unconfirmed");
    ensure!(!r.interrupted, "doctor interrupted");
    let r = serde_json::to_value(r)?;
    let mut items = vec![];
    let item = |status: &str, detail: String| t.item("service", "Служба", status, detail);
    let error = r.get("error").and_then(Value::as_str);
    let file = js(r.get("file"));
    if r["installed"] != true {
        items.push(if let Some(e)=error {item("warn",t.t("состояние не выяснено: {0}",&[e]))}else{item("ok",t.t("не установлена — демон поднимается по требованию и не переживает перезагрузку (поставить: pult daemon install)",&[]))});
        return Ok(items);
    }
    if r["ours"] != true {
        items.push(
            item(
                "warn",
                t.t(
                    "{0} обслуживает другой PULT_HOME ({1}); у этого дома службы нет",
                    &[
                        &file,
                        r["fileHome"].as_str().unwrap_or(&t.t("не указан", &[])),
                    ],
                ),
            )
            .fix(t.t(
                "PULT_SERVICE_NAME=<другое имя> pult daemon install   # вторая служба рядом",
                &[],
            )),
        );
        return Ok(items);
    }
    let launcher = r["launcher"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| t.t("(не разобран)", &[]));
    let launcher_ok = r["launcherOk"] == true;
    let mut launch = t.item(
        "service.launcher",
        "Лаунчер службы",
        if launcher_ok { "ok" } else { "fail" },
        if launcher_ok {
            format!("{file} → {launcher}")
        } else {
            t.t(
                "{0} указывает на {1}, а его нет или он не исполняемый — служба не стартует",
                &[&file, &launcher],
            )
        },
    );
    if !launcher_ok {
        launch = launch.cmd("pult daemon install")
    }
    items.push(launch);
    let m = r.get("manager").filter(|v| !v.is_null());
    if m.is_none() || m.unwrap().get("error").is_some() {
        items.push(
            item(
                "warn",
                t.t(
                    "установлена ({0}), но менеджер служб не ответил: {1}",
                    &[
                        &file,
                        error
                            .or_else(|| m.and_then(|m| m["error"].as_str()))
                            .unwrap_or(&t.t("неизвестно", &[])),
                    ],
                ),
            )
            .cmd("pult daemon install"),
        );
    } else {
        let m = m.unwrap();
        let code = m["lastExitCode"].as_i64();
        let running = !m["pid"].is_null();
        if m["loaded"] != true {
            items.push(item("warn",t.t("файл {0} есть, но служба не загружена — после перезагрузки или входа поднимется; сейчас её нет",&[&file])).cmd("pult daemon install"));
        } else if code == Some(78) && !running {
            items.push(item("fail",t.t("последний выход с кодом 78: служба указывает на несуществующий node или точку входа (нет активной версии?) — смотри {0}",&[&display.join("logs/service.log").display().to_string()])).cmd("pult update --list && pult daemon install"));
        } else if m["state"] == "failed" {
            items.push(item("fail",format!("{}{}",t.t("systemd остановил службу после петли падений (последний выход: {0}); ",&[&last_exit(m)]),t.t("код 3 значит «lock держит другой демон» — под systemd это конечная остановка",&[]))).cmd(format!("pult daemon stop; systemctl --user reset-failed {} && systemctl --user start {}",js(r.get("name")),js(r.get("name")))));
        } else {
            let bad = !running && (code.is_some_and(|n| n != 0) || !m["lastSignal"].is_null());
            let state = m["state"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            let pid = if running {
                format!(", pid {}", js(m.get("pid")))
            } else {
                t.t(", процесса нет{0}", &[&state])
            };
            let mut detail = t.t("загружена{0}, последний выход: {1}", &[&pid, &last_exit(m)]);
            if !running && code == Some(0) {
                detail += &t.t(
                    " (штатная остановка — следующая команда поднимет через службу)",
                    &[],
                )
            }
            if !running && code == Some(3) {
                detail += &t.t(
                    " (lock держит другой демон — служба заберёт его, когда тот уйдёт)",
                    &[],
                )
            }
            let mut i = item(if bad { "warn" } else { "ok" }, detail);
            if bad {
                i = i.cmd(format!(
                    "tail -n 50 {}",
                    display.join("logs/service.log").display()
                ))
            }
            items.push(i)
        }
    }
    if let Some(stale) = r["stale"].as_str().filter(|s| !s.is_empty()) {
        items.push(
            t.item(
                "service.file",
                "Файл службы",
                "warn",
                t.t("{0} записан прежней версией — {1}", &[&file, stale]),
            )
            .cmd("pult daemon install"),
        )
    }
    let saved = files::private_read(root, "node-path", 16384)?.unwrap_or_default();
    let saved = files::trim_first(&saved);
    let node =
        |status: &str, detail: String| t.item("service.node", "Node для службы", status, detail);
    if saved.is_empty() {
        items.push(
            node(
                "warn",
                t.t(
                    "{0} пуст или отсутствует — лаунчер будет искать node заново на каждом старте",
                    &[&display.join("node-path").display().to_string()],
                ),
            )
            .cmd("pult daemon install"),
        )
    } else if !doctor_path::executable(Path::new(saved)) {
        items.push(node("warn",t.t("node-path указывает на {0}, а его нет или он не исполняемый (brew/nvm переехали?) — лаунчер найдёт node сам при следующем старте",&[saved])).cmd("pult daemon install"))
    } else {
        if test {
            ensure!(
                std::fs::canonicalize(saved)?.starts_with(root),
                "test saved node must stay in scratch home"
            )
        };
        let r = exec.run(DiagnosticCommand::SavedNode(saved.into())).await?;
        let v = r.stdout.trim();
        let major = v
            .trim_start_matches('v')
            .split('.')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let detail = format!(
            "{saved} ({}){}",
            if v.is_empty() {
                t.t("версия не прочиталась", &[])
            } else {
                super::doctor_model::redact(v)
            },
            if major >= 22 {
                String::new()
            } else {
                t.t(" — нужен >= 22, лаунчер будет искать другой", &[])
            }
        );
        let mut i = node(if major >= 22 { "ok" } else { "warn" }, detail);
        if major < 22 {
            i = i.cmd("brew upgrade node && pult daemon install")
        }
        items.push(i)
    }
    if r["platform"] == "linux" {
        let user = std::env::var("USER").unwrap_or_default();
        let bin = if test {
            std::env::var_os("PULT_TEST_DOCTOR_LOGINCTL").map(PathBuf::from)
        } else {
            Some(PathBuf::from("/usr/bin/loginctl"))
        };
        let mut state = None;
        let mut why = String::new();
        if let Some(bin) = bin {
            if test {
                ensure!(
                    std::fs::canonicalize(&bin)?.starts_with(root),
                    "test loginctl must stay in scratch home"
                )
            };
            let r = exec
                .run(DiagnosticCommand::Linger {
                    bin,
                    user: user.clone(),
                })
                .await?;
            if r.code == Some(0) {
                for line in r.stdout.lines() {
                    if let Some(v) = line.strip_prefix("Linger=") {
                        state = match v.trim() {
                            "yes" => Some(true),
                            "no" => Some(false),
                            _ => None,
                        }
                    }
                }
            }
        } else {
            why = "test doctor requires an explicit fake loginctl".into()
        }
        let prefix = if state == Some(false) {
            t.t("выключен", &[])
        } else {
            t.t(
                "не выяснено{0}",
                &[&if why.is_empty() {
                    String::new()
                } else {
                    format!(" ({why})")
                }],
            )
        };
        let mut i = t.item(
            "service.linger",
            "Linger (systemd --user)",
            if state == Some(true) { "ok" } else { "warn" },
            if state == Some(true) {
                t.t(
                    "включён для {0}: демон живёт и без открытой сессии",
                    &[&user],
                )
            } else {
                t.t(
                    "{0} — systemd --user остановит демона, когда закроется последняя сессия",
                    &[&prefix],
                )
            },
        );
        if state != Some(true) {
            i = i.cmd(format!("sudo loginctl enable-linger {user}"))
        }
        items.push(i)
    }
    Ok(items)
}
