//! Tool inventory and clean login-shell PATH; no execution-provider adapter.
use crate::{
    doctor_exec::{DiagnosticCommand, Executor},
    doctor_files as files,
    doctor_model::{Item, Text, now, redact},
};
use anyhow::{Result, anyhow, ensure};
use serde_json::json;
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
pub(super) const TOOLS: [&str; 8] = [
    "claude", "codex", "opencode", "zcode", "git", "gh", "node", "npm",
];
#[derive(Clone)]
pub(super) struct Tool {
    pub name: &'static str,
    pub path: Option<PathBuf>,
    pub real: Option<PathBuf>,
    pub version: Option<String>,
    pub via_path: bool,
    pub tried: usize,
}
pub(super) fn candidates(user: &Path, name: &str) -> Vec<PathBuf> {
    let local = |s: &str| user.join(s);
    let system = |s: &str| PathBuf::from(s);
    match name {
        "claude" => vec![
            system("/opt/homebrew/bin/claude"),
            local(".claude/local/claude"),
            system("/usr/local/bin/claude"),
            local(".local/bin/claude"),
        ],
        "codex" => vec![
            local(".local/bin/codex"),
            system("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"),
            system("/Applications/ChatGPT.app/Contents/Resources/codex"),
            system("/opt/homebrew/bin/codex"),
            system("/usr/local/bin/codex"),
        ],
        "opencode" => vec![
            system("/opt/homebrew/bin/opencode"),
            local(".local/bin/opencode"),
            local(".opencode/bin/opencode"),
            system("/usr/local/bin/opencode"),
        ],
        "zcode" => vec![
            local(".local/bin/zcode"),
            system("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
            local("Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
            system("/opt/homebrew/bin/zcode"),
            system("/usr/local/bin/zcode"),
        ],
        "git" => vec![
            system("/opt/homebrew/bin/git"),
            system("/usr/bin/git"),
            system("/usr/local/bin/git"),
        ],
        "gh" => vec![
            system("/opt/homebrew/bin/gh"),
            system("/usr/local/bin/gh"),
            local(".local/bin/gh"),
        ],
        _ => vec![
            system(&format!("/opt/homebrew/bin/{name}")),
            system(&format!("/usr/local/bin/{name}")),
            system(&format!("/usr/bin/{name}")),
        ],
    }
}
pub(super) fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
}
fn sanitize(s: &str) -> Vec<String> {
    let mut out = vec![];
    for s in s
        .split(':')
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('~'))
    {
        if !out.iter().any(|v| v == s) {
            out.push(s.into())
        }
    }
    out
}
pub(super) async fn login_path(
    root: &Path,
    user: &Path,
    test: bool,
    exec: &Executor,
) -> Result<Vec<String>> {
    if test {
        let path = std::env::var("PULT_TEST_DOCTOR_PATH")
            .map_err(|_| anyhow!("test doctor requires explicit PULT_TEST_DOCTOR_PATH"))?;
        let paths = sanitize(&path);
        for path in &paths {
            ensure!(
                Path::new(path).is_absolute() && std::fs::canonicalize(path)?.starts_with(root),
                "test doctor PATH must stay in scratch home"
            );
        }
        return Ok(paths);
    }
    if let Some(s) = files::private_read(root, "env.json", files::LIMIT)?
        && let Ok(v) = files::json(&s)
        && let Some(at) = v["capturedAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        && chrono::Utc::now()
            .signed_duration_since(at)
            .num_milliseconds()
            < 86_400_000
        && let Some(paths) = v["pathEntries"].as_array().filter(|a| !a.is_empty())
    {
        let paths = paths
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>();
        if let Some(paths) = paths {
            return Ok(paths);
        }
    }
    let shell = std::env::var_os("SHELL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/zsh"));
    let r = exec
        .run(DiagnosticCommand::Shell {
            shell: shell.clone(),
            home: user.to_owned(),
            user: std::env::var("USER").unwrap_or_default(),
        })
        .await?;
    if r.code != Some(0) {
        return Ok(sanitize("/usr/bin:/bin:/usr/sbin:/sbin"));
    }
    let vars = r
        .stdout
        .split('\0')
        .filter_map(|s| s.split_once('='))
        .filter(|(k, _)| !k.is_empty())
        .collect::<std::collections::BTreeMap<_, _>>();
    let paths = sanitize(vars.get("PATH").copied().unwrap_or_default());
    let secret =
        regex::Regex::new("(?i)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)").unwrap();
    let names = vars
        .keys()
        .filter(|n| !secret.is_match(n))
        .copied()
        .collect::<Vec<_>>();
    let secrets = vars
        .keys()
        .filter(|n| secret.is_match(n))
        .copied()
        .collect::<Vec<_>>();
    let cache = json!({"capturedAt":now(),"shell":shell,"pathEntries":paths,"names":names,"secretNames":secrets});
    // Existing unsafe cache is fatal above. Write only a new private scratch file;
    // failure to cache is observational and does not change the captured PATH.
    let path = root.join("env.json");
    let write = || -> Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(path)?;
        ensure!(f.metadata()?.is_file(), "unsafe env cache");
        f.write_all(format!("{}\n", serde_json::to_string_pretty(&cache)?).as_bytes())?;
        Ok(())
    };
    let _ = write();
    Ok(paths)
}
pub(super) async fn locate(
    root: &Path,
    user: &Path,
    paths: &[String],
    test: bool,
    exec: &Executor,
) -> Result<Vec<Tool>> {
    let mut jobs = tokio::task::JoinSet::new();
    for (index, name) in TOOLS.iter().copied().enumerate() {
        let list = candidates(user, name);
        let tried = list.len();
        let (path, via_path) = if test {
            let p = paths
                .iter()
                .map(|p| Path::new(p).join(name))
                .find(|p| executable(p));
            (p, true)
        } else if let Some(p) = list.into_iter().find(|p| executable(p)) {
            (Some(p), false)
        } else {
            (
                paths
                    .iter()
                    .map(|p| Path::new(p).join(name))
                    .find(|p| executable(p)),
                true,
            )
        };
        if test && let Some(p) = &path {
            let real = std::fs::canonicalize(p)?;
            ensure!(
                real.starts_with(root),
                "test doctor tool resolves outside scratch home"
            )
        }
        let exec = exec.clone();
        jobs.spawn(async move {
            let real = path.as_deref().and_then(|p| std::fs::canonicalize(p).ok());
            let version = if let Some(bin) = &path {
                let r = exec
                    .run(DiagnosticCommand::Version {
                        bin: bin.clone(),
                        node: matches!(name, "node" | "npm"),
                    })
                    .await?;
                let output = format!("{}{}", r.stdout, r.stderr);
                let first = output.trim().split('\n').next().unwrap_or("");
                (!first.is_empty()).then(|| first.to_owned())
            } else {
                None
            };
            Ok::<_, anyhow::Error>((
                index,
                Tool {
                    name,
                    path,
                    real,
                    version,
                    via_path,
                    tried,
                },
            ))
        });
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
                error.get_or_insert(anyhow!("doctor inventory job failed"));
            }
        }
    }
    if let Some(e) = error {
        return Err(e);
    }
    out.sort_by_key(|v| v.0);
    Ok(out.into_iter().map(|v| v.1).collect())
}
pub(super) fn item(tool: &Tool, user: &Path, t: Text) -> Item {
    let id = format!("cli.{}", tool.name);
    let title = format!("CLI {}", tool.name);
    let Some(path) = &tool.path else {
        return t
            .item(
                &id,
                &title,
                if ["claude", "codex", "opencode", "zcode", "node"].contains(&tool.name) {
                    "fail"
                } else {
                    "warn"
                },
                t.t(
                    "не найден (проверено {0} кандидатов и PATH логин-шелла)",
                    &[&tool.tried.to_string()],
                ),
            )
            .fix(t.t(
                "установи {0} и убедись, что он лежит в PATH логин-шелла",
                &[tool.name],
            ));
    };
    let path = path.display().to_string();
    let real = tool.real.as_ref().map(|p| p.display().to_string());
    let app = |part: &str| path.contains(part) || real.as_deref().is_some_and(|p| p.contains(part));
    let codex = tool.name == "codex" && app("/ChatGPT.app/Contents/Resources/");
    let zcode = tool.name == "zcode" && app("/ZCode.app/Contents/Resources/");
    let version = tool.version.as_deref().map(redact);
    let arrow = real
        .as_deref()
        .filter(|p| *p != path)
        .map(|p| format!(" → {p}"))
        .unwrap_or_default();
    let mut detail = format!(
        "{path}{arrow}{}",
        t.t(
            ", версия {0}",
            &[version.as_deref().unwrap_or(&t.t("неизвестна", &[]))]
        )
    );
    if codex {
        detail += &t.t(
            " — бинарь внутри ChatGPT.app: меняется с каждым обновлением приложения",
            &[],
        )
    }
    if zcode {
        detail += &t.t(
            " — бинарь внутри ZCode.app: путь меняется с обновлением приложения",
            &[],
        )
    }
    if tool.via_path {
        detail += &t.t(
            " (найден через PATH логин-шелла, не по списку кандидатов)",
            &[],
        )
    }
    let mut item = t
        .item(
            &id,
            &title,
            if codex || zcode { "warn" } else { "ok" },
            detail,
        )
        .data(json!({"path":path,"realpath":real,"version":version}));
    if codex {
        let link = user.join(".local/bin/codex");
        let link = link.display().to_string();
        if real.as_deref().is_some_and(|r| r != path) {
            item=item.fix(t.t("ничего не ломается; после обновления ChatGPT.app перезапусти pult doctor — если симлинк повиснет, здесь будет команда починки",&[]));
        } else {
            let meta = std::fs::symlink_metadata(&link);
            if path != link && meta.as_ref().is_ok_and(|m| m.file_type().is_symlink()) {
                let c = format!("ln -sf {path} {link}");
                item.fix = Some(t.t(
                    "симлинк {0} повис (ChatGPT.app переложил codex) — перенаправь: {1}",
                    &[&link, &c],
                ));
                item.fix_cmd = Some(c);
            } else if path != link && meta.is_err() {
                let c = format!(
                    "mkdir -p {} && ln -sf {path} {link}",
                    user.join(".local/bin").display()
                );
                item.fix = Some(t.t(
                    "codex не виден в PATH терминала — положи симлинк: {0}",
                    &[&c],
                ));
                item.fix_cmd = Some(c);
            } else {
                item=item.fix(t.t("ничего не ломается; Пульт ищет codex внутри ChatGPT.app по обеим раскладкам (Resources/codex-cli/bin/codex и Resources/codex)",&[]));
            }
        }
    }
    if zcode {
        item=item.fix(t.t("надёжнее симлинк: ln -sf {0} ~/.local/bin/zcode — Пульт найдёт бинарь и без него, но терминалу он нужен",&[&path]))
    }
    item
}
