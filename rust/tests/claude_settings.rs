use pult_core::claude_settings::{Settings, SettingsError, default_mode};
use std::{fs, path::PathBuf, process::Command};
#[test]
fn bounded_mode_files_match_actual_node_utf16_and_filesystem_policy() {
    let home = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for (name, body) in [
        ("normal", r#"{"permissions":{"defaultMode":"auto"}}"#),
        (
            "bypass",
            r#"{"permissions":{"defaultMode":"bypassPermissions"}}"#,
        ),
        ("invalid", "{"),
        (
            "escaped",
            r#"{"permissions":{"default\u004dode":"acceptEdits"},"noise":"\ud800"}"#,
        ),
        (
            "duplicate",
            r#"{"permissions":{"defaultMode":"bypassPermissions"},"permissions":{"defaultMode":"plan"}}"#,
        ),
        ("surrogate", r#"{"permissions":{"defaultMode":"\ud800"}}"#),
        ("null", "null"),
        ("wrong", r#"{"permissions":{"defaultMode":17}}"#),
        ("badutf8", ""),
    ] {
        let p = home.path().join(name);
        fs::write(&p, body).unwrap();
        paths.push(p);
    }
    fs::write(
        &paths[8],
        b"{\"noise\":\"\xff\",\"permissions\":{\"defaultMode\":\"bypassPermissions\"}}",
    )
    .unwrap();
    let large = home.path().join("large");
    fs::write(&large, vec![b' '; 1024 * 1024 + 1]).unwrap();
    paths.push(large);
    let fifo = home.path().join("fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    paths.push(fifo);
    let link = home.path().join("link");
    std::os::unix::fs::symlink(&paths[0], &link).unwrap();
    paths.push(link);
    paths.push(home.path().join("missing"));
    paths.push(home.path().to_owned());
    let script = r#"const{claudeDefaultMode}=await import('./dist/mcp/browser.js');const fs=await import('node:fs');let sets=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(sets.map(s=>{let v=claudeDefaultMode(s);return v===null?null:Array.from({length:v.length},(_,i)=>v.charCodeAt(i))})))"#;
    let mut sets: Vec<Vec<PathBuf>> = paths.iter().map(|p| vec![p.clone()]).collect();
    sets.push(vec![paths[1].clone(), paths[2].clone(), paths[12].clone()]);
    sets.push(vec![paths[1].clone(), paths[5].clone()]);
    sets.push(vec![]);
    let mut cmd = Command::new(std::env::var_os("PULT_NODE").unwrap_or_else(|| "node".into()));
    let mut child = cmd
        .args(["--input-type=module", "-e", script])
        .current_dir(env!("CARGO_MANIFEST_DIR").to_owned() + "/..")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&sets).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let expected: Vec<Option<Vec<u16>>> = serde_json::from_slice(&output.stdout).unwrap();
    let actual: Vec<_> = sets.iter().map(|s| default_mode(s)).collect();
    assert_eq!(actual, expected);
}
#[test]
fn managed_settings_override_selected_sources_in_utf16_filename_order() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let cwd = root.path().join("project");
    let managed = root.path().join("managed");
    for dir in [
        home.join(".claude"),
        cwd.join(".claude"),
        managed.join("managed-settings.d"),
    ] {
        fs::create_dir_all(dir).unwrap();
    }
    let write = |p: PathBuf, mode: &str| {
        fs::write(
            p,
            serde_json::json!({"permissions":{"defaultMode":mode}}).to_string(),
        )
        .unwrap()
    };
    write(home.join(".claude/settings.json"), "bypassPermissions");
    write(cwd.join(".claude/settings.json"), "plan");
    write(cwd.join(".claude/settings.local.json"), "manual");
    let settings = Settings::new(&home, managed.clone()).unwrap();
    assert_eq!(
        settings.effective_mode(&cwd, Some("project")).unwrap(),
        "plan"
    );
    assert_eq!(
        settings
            .effective_mode(&cwd, Some("\u{feff}local\u{feff}"))
            .unwrap(),
        "manual"
    );
    write(managed.join("managed-settings.json"), "acceptEdits");
    // UTF-16 sorts astral U+10000 before BMP U+E000, opposite UTF-8 order.
    write(managed.join("managed-settings.d/\u{10000}.json"), "auto");
    write(
        managed.join("managed-settings.d/\u{e000}.json"),
        "bypassPermissions",
    );
    assert_eq!(
        settings.effective_mode(&cwd, Some("project")).unwrap(),
        "bypassPermissions"
    );
    fs::write(
        managed.join("managed-settings.d/\u{e000}.json"),
        r#"{"permissions":{"defaultMode":"\ud800"}}"#,
    )
    .unwrap();
    assert_eq!(
        settings.effective_mode(&cwd, None),
        Err(SettingsError::UnrepresentableMode)
    );
}

#[test]
fn managed_directory_over_capacity_denies_instead_of_ignoring_later_policy() {
    let root = tempfile::tempdir().unwrap();
    let managed = root.path().join("managed");
    let extra = managed.join("managed-settings.d");
    fs::create_dir_all(&extra).unwrap();
    for n in 0..4097 {
        fs::write(extra.join(format!("{n}.ignored")), b"").unwrap();
    }
    let settings = Settings::new(root.path(), managed).unwrap();
    assert_eq!(
        settings.effective_mode(root.path(), None),
        Err(SettingsError::Capacity)
    );
}
