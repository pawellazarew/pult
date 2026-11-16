//! Local browser installation observation; no install, launch or provider IO.
use crate::cli_client::{self, OwnerClient};
use anyhow::{Result, anyhow, ensure};
use rustix::fs::{AtFlags, FileType, Mode, OFlags, open, openat, statat};
use serde_json::value::RawValue;
use std::{
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

const VERSION: &str = "0.0.84";
const PACKAGE: &str = "@playwright/mcp 0.0.84";
const PACKAGE_LIMIT: u64 = 1024 * 1024;
const PACKAGE_DIR: &str = "mcp/playwright-mcp-0.0.84/node_modules/@playwright/mcp";
type Fields = pult_core::RawFields;
fn fields(raw: &RawValue) -> Result<Fields> {
    Fields::parse(raw).map_err(|_| anyhow!("invalid browser status response"))
}
fn parent(
    root: &Path,
    relative: &Path,
) -> Result<Option<(rustix::fd::OwnedFd, std::ffi::OsString)>> {
    ensure!(
        !relative.is_absolute()
            && relative
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "invalid browser input path"
    );
    let mut parts = relative
        .components()
        .map(|part| part.as_os_str())
        .collect::<Vec<_>>();
    let name = parts
        .pop()
        .ok_or_else(|| anyhow!("invalid browser input path"))?
        .to_owned();
    ensure!(parts.len() <= 32, "browser input path exceeds depth limit");
    let mut directory = match open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(anyhow!("browser scratch home cannot be opened")),
    };
    for part in parts {
        directory = match openat(
            &directory,
            part,
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(_) => return Err(anyhow!("browser input directory cannot be opened safely")),
        };
    }
    Ok(Some((directory, name)))
}
fn regular(root: &Path, relative: &Path) -> Result<bool> {
    let Some((directory, name)) = parent(root, relative)? else {
        return Ok(false);
    };
    let metadata = match statat(&directory, &name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(metadata) => metadata,
        Err(rustix::io::Errno::NOENT) => return Ok(false),
        Err(_) => return Err(anyhow!("browser input metadata is unavailable")),
    };
    ensure!(
        FileType::from_raw_mode(metadata.st_mode as _) == FileType::RegularFile,
        "browser input must be a regular file without symlinks"
    );
    Ok(true)
}
fn package_bytes(root: &Path) -> Result<Option<Vec<u8>>> {
    let relative = Path::new(PACKAGE_DIR).join("package.json");
    let Some((directory, name)) = parent(root, &relative)? else {
        return Ok(None);
    };
    let file = match openat(
        &directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(_) => return Err(anyhow!("browser package cannot be opened safely")),
    };
    let metadata = file
        .metadata()
        .map_err(|_| anyhow!("browser package metadata is unavailable"))?;
    ensure!(metadata.is_file(), "browser package must be a regular file");
    ensure!(
        metadata.len() <= PACKAGE_LIMIT,
        "browser package exceeds 1 MiB limit"
    );
    let mut bytes = Vec::new();
    file.take(PACKAGE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| anyhow!("browser package cannot be read"))?;
    ensure!(
        bytes.len() as u64 <= PACKAGE_LIMIT,
        "browser package exceeds 1 MiB limit"
    );
    Ok(Some(bytes))
}
pub(super) fn installed(root: &Path) -> Result<bool> {
    if !regular(root, &Path::new(PACKAGE_DIR).join("cli.js"))? {
        return Ok(false);
    }
    let Some(bytes) = package_bytes(root)? else {
        return Ok(false);
    };
    // Node decodes file bytes with UTF-8 replacement. Unknown values remain raw
    // so unrelated valid JS strings do not invalidate the pinned version field.
    let raw: Box<RawValue> = match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
        Ok(raw) => raw,
        Err(_) => return Ok(false),
    };
    let fields = match Fields::parse(&raw) {
        Ok(fields) => fields,
        Err(_) => return Ok(false),
    };
    Ok(fields
        .get("version")
        .and_then(|v| pult_core::display_string(v).ok())
        .as_deref()
        == Some(VERSION))
}
fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok()
}
fn chrome_candidates(platform: &str, home: Option<&Path>) -> Vec<PathBuf> {
    match platform {
        "macos" | "darwin" => {
            std::iter::once(PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ))
            .chain(home.map(|home| {
                home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
            }))
            .collect()
        }
        "linux" => [
            "/opt/google/chrome/chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect(),
        _ => vec![],
    }
}
fn fixture_relative(path: &Path, root: &Path) -> Result<PathBuf> {
    ensure!(
        path.is_absolute() && !path.components().any(|part| part == Component::ParentDir),
        "browser fixture Chrome path must stay inside scratch home"
    );
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
    path.strip_prefix(root)
        .map(Path::to_owned)
        .map_err(|_| anyhow!("browser fixture Chrome path must stay inside scratch home"))
}
pub(super) fn chrome(root: &Path) -> Result<Option<PathBuf>> {
    if std::env::var("PULT_TEST").as_deref() == Ok("1") {
        // A missing fake is None, never a fallback into real HOME/Applications.
        let Some(path) = std::env::var_os("PULT_TEST_BROWSER_CHROME_FILE").map(PathBuf::from)
        else {
            return Ok(None);
        };
        let relative = fixture_relative(&path, root)?;
        if !regular(root, &relative)? {
            return Ok(None);
        }
        return Ok(executable(&path).then_some(path));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).or_else(|| {
        nix::unistd::User::from_uid(nix::unistd::getuid())
            .ok()
            .flatten()
            .map(|user| user.dir)
    });
    // Executable metadata follows a legitimate system Chrome symlink like Node;
    // no executable content is read and the executable is never launched.
    Ok(chrome_candidates(std::env::consts::OS, home.as_deref())
        .into_iter()
        .find(|path| executable(path)))
}
fn display(raw: &RawValue) -> Result<String> {
    pult_core::display_string(raw).map_err(|_| anyhow!("invalid browser status response"))
}
fn js_truthy(raw: &RawValue) -> bool {
    let raw = raw.get().trim();
    if matches!(raw, "null" | "false" | "\"\"") {
        return false;
    }
    // JSON number spellings 0e0, 0.0 and -0.0 are also false in JavaScript.
    // A nonempty JSON string remains truthy, even if its content is "0".
    serde_json::from_str::<f64>(raw).map_or(true, |n| n != 0.0)
}
fn text(
    browser: Option<&RawValue>,
    installed: bool,
    prefix: &Path,
    chrome: Option<&Path>,
    locale: &str,
) -> Result<String> {
    let english = locale != "ru";
    let object = browser.filter(|v| js_truthy(v));
    let projection = object
        .filter(|raw| raw.get().starts_with('{'))
        .map(fields)
        .transpose()?
        .unwrap_or_default();
    let state = projection.get("state").map(display).transpose()?;
    let state = if object.is_none() {
        if installed { "installed" } else { "missing" }
    } else {
        state.as_deref().unwrap_or("missing")
    };
    let sessions = projection
        .get("sessions")
        .filter(|raw| raw.get() != "null")
        .map(|raw| {
            serde_json::from_str::<f64>(raw.get())
                .map_err(|_| anyhow!("invalid browser status response"))
        })
        .transpose()?;
    let wanted = sessions.is_some_and(|n| n > 0.0);
    let mut number = ryu_js::Buffer::new();
    let count = sessions
        .map(|n| number.format(n).to_owned())
        .unwrap_or_else(|| "null".into());
    let prefix = prefix.display();
    let (status, detail) = match state {
        "installed" => (
            "ok  ",
            if english {
                format!("{PACKAGE} installed: {prefix}")
            } else {
                format!("{PACKAGE} стоит: {prefix}")
            },
        ),
        "installing" => (
            "ok  ",
            if english {
                format!("{PACKAGE} installing")
            } else {
                format!("{PACKAGE} ставится")
            },
        ),
        "failed" => {
            let error = projection
                .get("error")
                .filter(|v| v.get() != "null")
                .map(display)
                .transpose()?
                .unwrap_or_else(|| {
                    if english {
                        "no reason given".into()
                    } else {
                        "причина не сообщена".into()
                    }
                });
            let error = error.split('\n').next().unwrap_or("");
            (
                "warn",
                if english {
                    format!("{PACKAGE} failed to install: {error}")
                } else {
                    format!("{PACKAGE} не поставился: {error}")
                },
            )
        }
        _ if wanted => (
            "warn",
            if english {
                format!("{PACKAGE} not installed, but browser enabled for sessions: {count}")
            } else {
                format!("{PACKAGE} не поставлен, а браузер включён у сессий: {count}")
            },
        ),
        _ => (
            "ok  ",
            if english {
                format!(
                    "{PACKAGE} not installed — installs automatically when a session enables the browser (or: pult browser install)"
                )
            } else {
                format!(
                    "{PACKAGE} не поставлен — поставится сам, когда сессии включат браузер (или: pult browser install)"
                )
            },
        ),
    };
    let need_chrome = wanted || state == "installed";
    let chrome_status = if chrome.is_some() || !need_chrome {
        "ok  "
    } else {
        "warn"
    };
    let chrome_detail = chrome.map(|path| path.display().to_string()).unwrap_or_else(|| match (english, need_chrome) {
        (true, true) => "Google Chrome not found — agent browser uses system Chrome; Pult does not download browsers".into(),
        (true, false) => "Google Chrome not found (only required for agent browser)".into(),
        (false, true) => "Google Chrome не найден — браузер агента работает на системном Chrome, своих браузеров Пульт не качает".into(),
        (false, false) => "Google Chrome не найден (нужен только браузеру агента)".into(),
    });
    Ok(format!(
        "[{status}] {}: {detail}\n[{chrome_status}] {}: {chrome_detail}\n",
        if english {
            "Agent browser"
        } else {
            "Браузер агента"
        },
        if english {
            "Chrome for agent browser"
        } else {
            "Chrome для браузера агента"
        }
    ))
}
pub async fn run(display_home: &Path, json_output: bool) -> Result<i32> {
    ensure!(
        [
            "PULT_MEMORY_KEY",
            "PULT_MEMORY_TURN_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY"
        ]
        .iter()
        .all(|name| std::env::var_os(name).is_none()),
        "browser status requires owner authentication"
    );
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|_| anyhow!("browser status signal handler unavailable"))?;
    let (root, locale, status) = tokio::select! { biased;
        _=interrupt.recv()=>{let _=cli_client::emit("Error: browser status interrupted\n".into(),true).await;return Ok(130);},
        probe=OwnerClient::status(display_home)=>probe.map_err(|error|anyhow!(error.message))?,
    };
    let installed = self::installed(&root)?;
    let chrome = self::chrome(&root)?;
    let daemon = status
        .as_deref()
        .map(fields)
        .transpose()?
        .and_then(|mut fields| fields.remove("browser"));
    let prefix = display_home.join("mcp/playwright-mcp-0.0.84");
    let output = if json_output {
        format!(
            "{{\"installed\":{installed},\"version\":\"{VERSION}\",\"path\":{},\"chrome\":{},\"daemon\":{}}}\n",
            serde_json::to_string(&prefix)?,
            serde_json::to_string(&chrome)?,
            daemon.as_deref().map(RawValue::get).unwrap_or("null")
        )
    } else {
        text(
            daemon.as_deref(),
            installed,
            &prefix,
            chrome.as_deref(),
            locale,
        )?
    };
    tokio::select! { biased;
        _=interrupt.recv()=>{let _=cli_client::emit("Error: browser status interrupted\n".into(),true).await;return Ok(130);},
        result=cli_client::emit(output,false)=>result.map_err(|_|anyhow!("browser status output failed"))?,
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn package(root: &Path, body: &[u8], cli: bool) -> PathBuf {
        let dir = root.join(PACKAGE_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), body).unwrap();
        if cli {
            std::fs::write(dir.join("cli.js"), "not executed").unwrap();
        }
        dir
    }
    #[test]
    fn installed_requires_exact_pin_and_cli_presence() {
        let root = tempfile::tempdir().unwrap();
        assert!(!installed(root.path()).unwrap());
        package(root.path(), br#"{"version":"0.0.84"}"#, false);
        assert!(!installed(root.path()).unwrap());
        package(root.path(), br#"{"version":"0.0.84"}"#, true);
        assert!(installed(root.path()).unwrap());
        package(root.path(), br#"{"version":"0.0.83"}"#, true);
        assert!(!installed(root.path()).unwrap());
    }
    #[test]
    fn malformed_missing_and_nonstring_package_versions_are_not_installed() {
        let root = tempfile::tempdir().unwrap();
        for body in [
            "bad",
            "null",
            "[]",
            "{}",
            "{\"version\":84}",
            "{\"version\":null}",
        ] {
            package(root.path(), body.as_bytes(), true);
            assert!(!installed(root.path()).unwrap());
        }
    }
    #[test]
    fn utf8_replacement_and_unknown_js_strings_do_not_break_version_projection() {
        let root = tempfile::tempdir().unwrap();
        package(
            root.path(),
            b"{\"version\":\"0.0.84\",\"future\":\"\xff\"}",
            true,
        );
        assert!(installed(root.path()).unwrap());
        package(
            root.path(),
            br#"{"version":"0.0.84","future":"\ud800"}"#,
            true,
        );
        assert!(installed(root.path()).unwrap());
    }
    #[test]
    fn bounded_package_never_becomes_silently_missing() {
        let root = tempfile::tempdir().unwrap();
        let dir = package(root.path(), br#"{"version":"0.0.84"}"#, true);
        std::fs::write(
            dir.join("package.json"),
            vec![b' '; PACKAGE_LIMIT as usize + 1],
        )
        .unwrap();
        assert_eq!(
            installed(root.path()).unwrap_err().to_string(),
            "browser package exceeds 1 MiB limit"
        );
    }
    #[test]
    fn cli_is_metadata_only_with_no_executable_or_content_size_requirement() {
        let root = tempfile::tempdir().unwrap();
        let dir = package(root.path(), br#"{"version":"0.0.84"}"#, true);
        let cli = dir.join("cli.js");
        std::fs::File::create(&cli)
            .unwrap()
            .set_len(PACKAGE_LIMIT * 8)
            .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o200)).unwrap();
        assert!(installed(root.path()).unwrap());
    }
    #[test]
    fn package_and_cli_symlinks_are_explicit_errors() {
        let root = tempfile::tempdir().unwrap();
        let dir = package(root.path(), br#"{"version":"0.0.84"}"#, true);
        for name in ["package.json", "cli.js"] {
            let path = dir.join(name);
            let target = dir.join(format!("{name}.target"));
            std::fs::rename(&path, &target).unwrap();
            symlink(&target, &path).unwrap();
            assert!(installed(root.path()).is_err());
            std::fs::remove_file(&path).unwrap();
            std::fs::rename(target, path).unwrap();
        }
    }
    #[test]
    fn parent_symlink_and_unsafe_relative_paths_never_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        package(outside.path(), br#"{"version":"0.0.84"}"#, true);
        symlink(outside.path().join("mcp"), root.path().join("mcp")).unwrap();
        assert!(installed(root.path()).is_err());
        assert!(regular(root.path(), Path::new("../file")).is_err());
        assert!(regular(root.path(), Path::new("/absolute")).is_err());
    }
    #[test]
    fn production_chrome_observation_follows_a_legitimate_executable_symlink() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("real");
        let candidate = root
            .path()
            .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        std::fs::create_dir_all(candidate.parent().unwrap()).unwrap();
        std::fs::write(&target, "not an executable format").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&target, &candidate).unwrap();
        let candidates = chrome_candidates("darwin", Some(root.path()));
        assert_eq!(candidates[1], candidate);
        assert!(executable(&candidates[1]));
        assert_eq!(
            candidates.into_iter().skip(1).find(|p| executable(p)),
            Some(candidate)
        );
        assert_eq!(
            chrome_candidates("linux", None),
            [
                "/opt/google/chrome/chrome",
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable"
            ]
            .map(PathBuf::from)
        );
    }
    #[test]
    fn fixture_chrome_cannot_reference_outside_home() {
        let root = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        assert!(fixture_relative(Path::new("relative"), &canonical).is_err());
        assert!(fixture_relative(&canonical.join("../outside"), &canonical).is_err());
        assert!(fixture_relative(Path::new("/not-under-home"), &canonical).is_err());
        assert_eq!(
            fixture_relative(&root.path().join("chrome"), &canonical).unwrap(),
            Path::new("chrome")
        );
    }
    #[test]
    fn daemon_state_overrides_disk_but_missing_browser_uses_disk() {
        let raw =
            RawValue::from_string(r#"{"state":"future","sessions":2,"future":"\ud800"}"#.into())
                .unwrap();
        let output = text(Some(&raw), true, Path::new("/p"), None, "en").unwrap();
        assert!(output.starts_with("[warn] Agent browser: @playwright/mcp 0.0.84 not installed, but browser enabled for sessions: 2\n"));
        assert!(output.contains("[warn] Chrome"));
        assert!(
            text(None, true, Path::new("/p"), None, "en")
                .unwrap()
                .starts_with("[ok  ] Agent browser: @playwright/mcp 0.0.84 installed: /p\n")
        );
    }
    #[test]
    fn failure_empty_reason_fallback_and_first_line_keep_node_meaning() {
        for (json, expected) in [
            (r#"{"state":"failed","error":""}"#, "failed to install: \n"),
            (
                r#"{"state":"failed"}"#,
                "failed to install: no reason given\n",
            ),
            (
                r#"{"state":"failed","error":"first\nsecond"}"#,
                "failed to install: first\n",
            ),
        ] {
            let raw = RawValue::from_string(json.into()).unwrap();
            assert!(
                text(Some(&raw), false, Path::new("/p"), None, "en")
                    .unwrap()
                    .contains(expected)
            );
        }
    }
    #[test]
    fn numeric_zero_spellings_use_disk_fallback_but_string_zero_is_truthy() {
        for json in ["0", "-0", "0.0", "-0.0", "0e0", "0e100"] {
            let raw = RawValue::from_string(json.into()).unwrap();
            assert!(!js_truthy(&raw));
            assert!(
                text(Some(&raw), true, Path::new("/p"), None, "en")
                    .unwrap()
                    .contains("installed: /p")
            );
        }
        let raw = RawValue::from_string("\"0\"".into()).unwrap();
        assert!(js_truthy(&raw));
    }
}
