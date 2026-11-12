//! Real-file bootstrap tests. Fake executables are resolved, never launched.
use pult_core::runtime_bootstrap::{self, Bootstrap, MAX_CONFIG_BYTES, StaticError};
use pult_core::runtime_config;
use pult_core::worker_env::Environment;
use serde_json::json;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    bin: PathBuf,
    current: PathBuf,
    parent: Environment,
}
fn executable(path: &Path) {
    fs::write(path, b"#!/bin/sh\nexit 97\n").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("PRIVATE-home");
        let bin = temp.path().join("бин 🌊");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(&bin).unwrap();
        for name in ["pultd-rust", "pult-worker-holder", "codex", "curl"] {
            executable(&bin.join(name));
        }
        let current = bin.join("pultd-rust");
        let parent = Environment::from([
            ("PATH".into(), bin.as_os_str().into()),
            ("HOME".into(), home.as_os_str().into()),
            ("PULT_TEST".into(), "1".into()),
            ("PULT_CURL_BIN".into(), bin.join("curl").into_os_string()),
        ]);
        Self {
            _temp: temp,
            home,
            bin,
            current,
            parent,
        }
    }
    fn config(&self, bytes: &[u8]) {
        fs::write(self.home.join("config.json"), bytes).unwrap();
        fs::set_permissions(
            self.home.join("config.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    fn load(&self) -> Result<Bootstrap, StaticError> {
        runtime_bootstrap::load(&self.home, &self.current, &self.parent)
    }
}
#[test]
fn missing_config_defaults_without_writing_or_executing_anything() {
    let f = Fixture::new();
    let b = f.load().unwrap();
    assert_eq!(
        b.config.to_file(),
        runtime_config::RuntimeConfig::default().to_file()
    );
    assert_eq!(b.codex, fs::canonicalize(f.bin.join("codex")).unwrap());
    assert_eq!(
        b.holder,
        fs::canonicalize(f.bin.join("pult-worker-holder")).unwrap()
    );
    assert_eq!(b.curl, fs::canonicalize(f.bin.join("curl")).unwrap());
    assert_eq!(b.prefix_args, vec![OsString::from("app-server")]);
    assert!(!f.home.join("config.json").exists());
    assert_eq!(fs::read_dir(&f.home).unwrap().count(), 0);
}
#[test]
fn actual_private_protocol_json_uses_existing_typed_validator() {
    let f = Fixture::new();
    let raw = json!({"version":1,"language":"ru","network":{"codex":{"mode":"required","proxy":"http://private:pass@localhost:7777","noProxy":["localhost"]},"guard":{"mode":"allow","countries":["DE"]}},"updates":{"check":false},"newSession":{"provider":"codex","defaults":{"codex":{"approval":"full"}}},"unknown":{"keep":"private"}});
    let bytes = serde_json::to_vec(&raw).unwrap();
    f.config(&bytes);
    let b = f.load().unwrap();
    assert_eq!(
        b.config.to_file(),
        runtime_config::parse(&raw).config.to_file()
    );
    assert_eq!(b.config.to_file()["network"]["codex"]["mode"], "required");
    assert_eq!(fs::read(f.home.join("config.json")).unwrap(), bytes);
}
#[test]
fn malformed_json_utf8_surrogates_and_oversized_files_refuse_defaults() {
    let f = Fixture::new();
    for raw in [
        b"{".as_slice(),
        b"\xff",
        br#"{"network":{"codex":{"mode":"required","proxy":"\ud800"}}}"#,
        br#"{"unknown":"\udfff"}"#,
        br#"{"n":1e999}"#,
    ] {
        f.config(raw);
        assert_eq!(f.load().err(), Some(StaticError::ConfigInvalid));
        assert_eq!(fs::read(f.home.join("config.json")).unwrap(), raw);
    }
    f.config(&vec![b' '; MAX_CONFIG_BYTES as usize + 1]);
    assert_eq!(f.load().err(), Some(StaticError::ConfigTooLarge));
}
#[test]
fn valid_non_object_json_retains_the_pure_parsers_warning_policy() {
    let f = Fixture::new();
    f.config(b"[]");
    assert_eq!(
        f.load().unwrap().config.to_file(),
        runtime_config::parse(&json!([])).config.to_file()
    );
}
#[test]
fn unsafe_config_modes_directory_and_hardlinks_are_refused() {
    let f = Fixture::new();
    f.config(b"{}");
    let path = f.home.join("config.json");
    for mode in [0o644, 0o400, 0o700, 0o4600] {
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(f.load().err(), Some(StaticError::UnsafeConfig));
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let alias = f.home.join("link");
    fs::hard_link(&path, &alias).unwrap();
    assert_eq!(f.load().err(), Some(StaticError::UnsafeConfig));
    fs::remove_file(&alias).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(f.load().err(), Some(StaticError::UnsafeConfig));
}
#[test]
fn config_symlinks_including_dangling_ones_are_never_missing_defaults() {
    let f = Fixture::new();
    let path = f.home.join("config.json");
    let target = f.home.join("target");
    fs::write(&target, b"{}").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &path).unwrap();
    assert!(f.load().is_err());
    fs::remove_file(&target).unwrap();
    assert!(f.load().is_err());
}
#[test]
fn home_must_be_an_existing_owned_private_directory_with_an_absolute_path() {
    let f = Fixture::new();
    fs::set_permissions(&f.home, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(f.load().err(), Some(StaticError::UnsafeHome));
    fs::set_permissions(&f.home, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        runtime_bootstrap::load(Path::new("relative"), &f.current, &f.parent).err(),
        Some(StaticError::InvalidPath)
    );
    assert_eq!(
        runtime_bootstrap::load(&f.home.join("missing"), &f.current, &f.parent).err(),
        Some(StaticError::UnsafeHome)
    );
    let alias = f._temp.path().join("home-alias");
    symlink(&f.home, &alias).unwrap();
    assert!(runtime_bootstrap::load(&alias, &f.current, &f.parent).is_ok());
}
#[test]
fn output_parent_is_base_only_and_debug_never_contains_private_values() {
    let mut f = Fixture::new();
    for key in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "PULT_MEMORY_KEY",
        "PULT_OWNER_TOKEN",
    ] {
        f.parent.insert(key.into(), "PRIVATE_SENTINEL".into());
    }
    f.parent.insert("LANG".into(), "ru_RU.UTF-8".into());
    f.config(br#"{"notifyCommand":"PRIVATE_COMMAND","network":{"codex":{"mode":"required","proxy":"http://PRIVATE_PROXY"}}}"#);
    let b = f.load().unwrap();
    for key in b.parent.keys() {
        assert!(
            ["HOME", "USER", "PATH", "LANG", "TERM", "TMPDIR"].contains(&key.to_str().unwrap())
        );
    }
    assert_eq!(
        b.parent.get(OsStr::new("LANG")),
        Some(&OsString::from("ru_RU.UTF-8"))
    );
    let debug = format!("{b:?}");
    for private in [
        "PRIVATE",
        f.home.to_str().unwrap(),
        f.bin.to_str().unwrap(),
        "app-server",
    ] {
        assert!(!debug.contains(private));
    }
}
#[test]
fn path_resolution_ignores_relative_and_empty_entries_and_canonicalizes_aliases() {
    let mut f = Fixture::new();
    let real = f.bin.join("real-codex");
    fs::rename(f.bin.join("codex"), &real).unwrap();
    symlink(&real, f.bin.join("codex")).unwrap();
    let paths =
        std::env::join_paths([Path::new(""), Path::new("relative"), f.bin.as_path()]).unwrap();
    f.parent.insert("PATH".into(), paths);
    assert_eq!(f.load().unwrap().codex, fs::canonicalize(&real).unwrap());
    // The default holder is a sibling of the supplied host executable path,
    // including a trusted executable alias, then canonicalized independently.
    let aliases = f._temp.path().join("daemon-aliases");
    fs::create_dir(&aliases).unwrap();
    let alias = aliases.join("pultd-rust");
    symlink(&f.current, &alias).unwrap();
    executable(&aliases.join("pult-worker-holder"));
    assert_eq!(
        runtime_bootstrap::load(&f.home, &alias, &f.parent)
            .unwrap()
            .holder,
        fs::canonicalize(aliases.join("pult-worker-holder")).unwrap()
    );
    f.parent.insert("PATH".into(), ":relative:".into());
    assert_eq!(f.load().err(), Some(StaticError::ExecutableUnavailable));
}
#[test]
fn explicit_codex_override_is_trusted_absolute_and_does_not_fallback_on_error() {
    let mut f = Fixture::new();
    let selected = f.bin.join("selected");
    executable(&selected);
    f.parent
        .insert("PULT_CODEX_BIN".into(), selected.clone().into_os_string());
    assert_eq!(
        f.load().unwrap().codex,
        fs::canonicalize(&selected).unwrap()
    );
    assert!(
        !f.load()
            .unwrap()
            .parent
            .contains_key(OsStr::new("PULT_CODEX_BIN"))
    );
    for path in [OsString::from("codex"), OsString::from("")] {
        f.parent.insert("PULT_CODEX_BIN".into(), path);
        assert_eq!(f.load().err(), Some(StaticError::InvalidPath));
    }
    f.parent.insert(
        "PULT_CODEX_BIN".into(),
        f.bin.join("missing").into_os_string(),
    );
    assert_eq!(f.load().err(), Some(StaticError::ExecutableUnavailable));
}
#[test]
fn holder_and_curl_overrides_require_exact_test_flag_and_do_not_enter_env() {
    let mut f = Fixture::new();
    let selected = f.bin.join("holder-fixture");
    executable(&selected);
    f.parent.insert(
        "PULT_WORKER_HOLDER_BIN".into(),
        selected.clone().into_os_string(),
    );
    assert_eq!(
        f.load().unwrap().holder,
        fs::canonicalize(&selected).unwrap()
    );
    for flag in [None, Some("0"), Some("true"), Some("01")] {
        f.parent.remove(OsStr::new("PULT_TEST"));
        if let Some(flag) = flag {
            f.parent.insert("PULT_TEST".into(), flag.into());
        }
        f.parent
            .insert("PULT_WORKER_HOLDER_BIN".into(), "relative-ignored".into());
        f.parent
            .insert("PULT_CURL_BIN".into(), "relative-ignored".into());
        let b = f.load().unwrap();
        assert_eq!(
            b.holder,
            fs::canonicalize(f.bin.join("pult-worker-holder")).unwrap()
        );
        assert_eq!(b.curl, fs::canonicalize("/usr/bin/curl").unwrap());
        assert!(!b.parent.contains_key(OsStr::new("PULT_TEST")));
    }
    f.parent.insert("PULT_TEST".into(), "1".into());
    assert_eq!(f.load().err(), Some(StaticError::InvalidPath));
}
#[test]
fn non_executable_regular_files_and_directories_never_become_commands() {
    let f = Fixture::new();
    let codex = f.bin.join("codex");
    for mode in [0o600, 0o000, 0o001] {
        fs::set_permissions(&codex, fs::Permissions::from_mode(mode)).unwrap();
        // Root can execute with any execute bit; ordinary owner cannot use the
        // other-execute bit when its own execute bit is absent.
        if mode == 0o001 && nix::unistd::geteuid().as_raw() == 0 {
            continue;
        }
        assert_eq!(f.load().err(), Some(StaticError::ExecutableUnavailable));
    }
    fs::remove_file(&codex).unwrap();
    fs::create_dir(&codex).unwrap();
    assert_eq!(f.load().err(), Some(StaticError::ExecutableUnavailable));
}
#[test]
fn nul_paths_and_invalid_base_environment_have_static_errors() {
    let mut f = Fixture::new();
    let nul = OsString::from_vec(b"/PRIVATE\0SENTINEL".to_vec());
    f.parent.insert("PULT_CODEX_BIN".into(), nul.clone());
    let error = f.load().err().unwrap();
    assert_eq!(error, StaticError::InvalidPath);
    assert!(!format!("{error:?} {error}").contains("PRIVATE"));
    f.parent.remove(OsStr::new("PULT_CODEX_BIN"));
    f.parent.insert("PATH".into(), nul.clone());
    assert_eq!(f.load().err(), Some(StaticError::Environment));
    assert_eq!(
        runtime_bootstrap::load(Path::new(&nul), &f.current, &f.parent).err(),
        Some(StaticError::InvalidPath)
    );
}
#[test]
fn non_unicode_path_entry_does_not_hide_later_unicode_executable() {
    let mut f = Fixture::new();
    // APFS refuses non-UTF8 filenames. The environment can still contain an
    // unavailable non-UTF8 candidate, which must not prevent later safe lookup.
    let missing = f
        ._temp
        .path()
        .join(OsString::from_vec(b"bin-\xff".to_vec()));
    f.parent.insert(
        "PATH".into(),
        std::env::join_paths([missing.as_path(), f.bin.as_path()]).unwrap(),
    );
    assert_eq!(
        f.load().unwrap().codex,
        fs::canonicalize(f.bin.join("codex")).unwrap()
    );
}

#[test]
fn claude_bootstrap_never_requires_codex_and_never_invokes_selected_commands() {
    let f = Fixture::new();
    executable(&f.bin.join("claude"));
    fs::remove_file(f.bin.join("codex")).unwrap();
    let before: Vec<_> = fs::read_dir(&f.home)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    let b = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).unwrap();
    assert_eq!(b.claude, fs::canonicalize(f.bin.join("claude")).unwrap());
    assert!(b.prefix_args.is_empty());
    assert_eq!(
        b.child_home,
        PathBuf::from(f.parent.get(OsStr::new("HOME")).unwrap())
    );
    assert_eq!(
        b.parent.get(OsStr::new("HOME")).unwrap(),
        b.child_home.as_os_str()
    );
    assert_eq!(
        b.config.to_file(),
        runtime_config::RuntimeConfig::default().to_file()
    );
    assert_eq!(
        before,
        fs::read_dir(&f.home)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>()
    );
    assert_eq!(f.load().err(), Some(StaticError::ExecutableUnavailable));
}
#[test]
fn claude_missing_binary_refuses_even_with_codex_installed() {
    let f = Fixture::new();
    assert!(f.load().is_ok());
    assert_eq!(
        runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).err(),
        Some(StaticError::ExecutableUnavailable)
    );
}
#[test]
fn claude_override_is_absolute_no_fallback_and_not_a_child_argument_or_environment() {
    let mut f = Fixture::new();
    executable(&f.bin.join("claude"));
    let selected = f.bin.join("selected-claude");
    executable(&selected);
    f.parent
        .insert("PULT_CLAUDE_BIN".into(), selected.clone().into_os_string());
    let b = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).unwrap();
    assert_eq!(b.claude, fs::canonicalize(&selected).unwrap());
    assert!(b.prefix_args.is_empty());
    assert!(!b.parent.contains_key(OsStr::new("PULT_CLAUDE_BIN")));
    for (path, error) in [
        (OsString::from("claude"), StaticError::InvalidPath),
        (OsString::from(""), StaticError::InvalidPath),
        (
            f.bin.join("missing").into_os_string(),
            StaticError::ExecutableUnavailable,
        ),
        (
            OsString::from_vec(b"/PRIVATE\0PATH".to_vec()),
            StaticError::InvalidPath,
        ),
    ] {
        f.parent.insert("PULT_CLAUDE_BIN".into(), path);
        let result = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent)
            .err()
            .unwrap();
        assert_eq!(result, error);
        assert!(!format!("{result:?} {result}").contains("PRIVATE"));
    }
}
#[test]
fn claude_path_skips_relative_and_empty_entries_and_preserves_child_home_alias() {
    let mut f = Fixture::new();
    let real = f.bin.join("real-claude");
    executable(&real);
    symlink(&real, f.bin.join("claude")).unwrap();
    let home_alias = f._temp.path().join("child-home-alias");
    symlink(&f.home, &home_alias).unwrap();
    f.parent
        .insert("HOME".into(), home_alias.clone().into_os_string());
    f.parent.insert(
        "PATH".into(),
        std::env::join_paths([Path::new(""), Path::new("relative"), &f.bin]).unwrap(),
    );
    let b = runtime_bootstrap::load_claude(&home_alias, &f.current, &f.parent).unwrap();
    assert_eq!(b.claude, fs::canonicalize(real).unwrap());
    assert_eq!(b.child_home, home_alias);
    assert_eq!(
        b.parent.get(OsStr::new("HOME")).unwrap(),
        b.child_home.as_os_str()
    );
    f.parent.insert("PATH".into(), ":relative:".into());
    assert_eq!(
        runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).err(),
        Some(StaticError::ExecutableUnavailable)
    );
}
#[test]
fn claude_child_home_is_required_absolute_and_native_auth_is_never_read() {
    let mut f = Fixture::new();
    executable(&f.bin.join("claude"));
    // A native auth path that cannot be opened as a file must not affect bootstrap.
    fs::create_dir(f.home.join(".claude.json")).unwrap();
    fs::create_dir(f.home.join(".claude")).unwrap();
    fs::create_dir(f.home.join(".claude/settings.json")).unwrap();
    assert!(runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).is_ok());
    f.parent.remove(OsStr::new("HOME"));
    assert_eq!(
        runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).err(),
        Some(StaticError::Environment)
    );
    for home in ["relative", ""] {
        f.parent.insert("HOME".into(), home.into());
        assert!(runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).is_err());
    }
    f.parent.insert(
        "HOME".into(),
        OsString::from_vec(b"/PRIVATE\0HOME".to_vec()),
    );
    let error = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent)
        .err()
        .unwrap();
    assert_eq!(error, StaticError::Environment);
    assert!(!error.to_string().contains("PRIVATE"));
}
#[test]
fn claude_drops_credentials_hooks_proxy_owner_ask_and_memory_authority() {
    let mut f = Fixture::new();
    executable(&f.bin.join("claude"));
    for key in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "NODE_OPTIONS",
        "DYLD_INSERT_LIBRARIES",
        "LD_PRELOAD",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "PULT_MEMORY_KEY",
        "PULT_MEMORY_TURN_KEY",
        "PULT_OWNER_TOKEN",
        "PULT_ASK_KEY",
    ] {
        f.parent.insert(key.into(), "PRIVATE_SENTINEL".into());
    }
    f.config(br#"{"notifyCommand":"PRIVATE_COMMAND"}"#);
    let b = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).unwrap();
    assert!(b.parent.keys().all(|key| {
        ["HOME", "USER", "PATH", "LANG", "TERM", "TMPDIR"].contains(&key.to_str().unwrap())
    }));
    let debug = format!("{b:?}");
    for private in ["PRIVATE", f.home.to_str().unwrap(), f.bin.to_str().unwrap()] {
        assert!(!debug.contains(private));
    }
}
#[test]
fn claude_uses_node_platform_managed_path_without_native_filesystem_reads() {
    let f = Fixture::new();
    executable(&f.bin.join("claude"));
    let b = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).unwrap();
    let expected = if cfg!(target_os = "macos") {
        "/Library/Application Support/ClaudeCode"
    } else {
        "/etc/claude-code"
    };
    assert_eq!(b.managed_directory, Path::new(expected));
    // Existing Node testHome is a *file* seam, not a directory override. Test
    // mode must not silently substitute a different native policy directory.
    assert!(!b.managed_directory.starts_with(&f.home));
}
#[test]
fn claude_reuses_checked_config_snapshot_and_test_only_holder_curl_overrides() {
    let mut f = Fixture::new();
    executable(&f.bin.join("claude"));
    let selected = f.bin.join("selected-holder");
    executable(&selected);
    f.parent.insert(
        "PULT_WORKER_HOLDER_BIN".into(),
        selected.clone().into_os_string(),
    );
    assert_eq!(
        runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent)
            .unwrap()
            .holder,
        fs::canonicalize(selected).unwrap()
    );
    f.parent.insert("PULT_TEST".into(), "true".into());
    f.parent
        .insert("PULT_WORKER_HOLDER_BIN".into(), "ignored-relative".into());
    f.parent
        .insert("PULT_CURL_BIN".into(), "ignored-relative".into());
    let b = runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).unwrap();
    assert_eq!(
        b.holder,
        fs::canonicalize(f.bin.join("pult-worker-holder")).unwrap()
    );
    assert_eq!(b.curl, fs::canonicalize("/usr/bin/curl").unwrap());
    f.config(b"{");
    assert_eq!(
        runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).err(),
        Some(StaticError::ConfigInvalid)
    );
    f.config(b"{}");
    fs::set_permissions(
        f.home.join("config.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(
        runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).err(),
        Some(StaticError::UnsafeConfig)
    );
}

fn zcode_fixture() -> Fixture {
    let f = Fixture::new();
    executable(&f.bin.join("zcode"));
    f
}
fn load_zcode(f: &Fixture) -> Result<runtime_bootstrap::ZcodeBootstrap, StaticError> {
    runtime_bootstrap::load_zcode(&f.home, &f.current, &f.parent)
}
#[test]
fn zcode_bootstrap_selects_only_zcode_without_executing_any_command_or_reading_native_files() {
    let mut f = zcode_fixture();
    fs::remove_file(f.bin.join("codex")).unwrap();
    f.parent.insert(
        "PULT_CODEX_BIN".into(),
        f.bin.join("missing-codex").into_os_string(),
    );
    f.parent.insert(
        "PULT_CLAUDE_BIN".into(),
        OsString::from_vec(b"PRIVATE\0ignored".to_vec()),
    );
    // These deliberately non-file native paths must not be opened by bootstrap.
    for name in [".zcode", ".claude", ".claude.json", ".codex"] {
        fs::create_dir(f.home.join(name)).unwrap();
    }
    let native = f.home.join("native-config-is-directory");
    fs::create_dir(&native).unwrap();
    f.parent.insert(
        "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE".into(),
        native.into_os_string(),
    );
    let marker = f.home.join("COMMAND_MUST_NOT_EXECUTE");
    for name in ["pultd-rust", "pult-worker-holder", "zcode", "curl"] {
        fs::write(
            f.bin.join(name),
            format!("#!/bin/sh\n: > \"{}\"\nexit 97\n", marker.display()),
        )
        .unwrap();
    }
    let before = fs::read_dir(&f.home).unwrap().count();
    let b = load_zcode(&f).unwrap();
    assert_eq!(b.zcode, fs::canonicalize(f.bin.join("zcode")).unwrap());
    assert_eq!(
        b.holder,
        fs::canonicalize(f.bin.join("pult-worker-holder")).unwrap()
    );
    assert_eq!(b.curl, fs::canonicalize(f.bin.join("curl")).unwrap());
    assert!(b.prefix_args.is_empty());
    assert_eq!(
        b.config.to_file(),
        runtime_config::RuntimeConfig::default().to_file()
    );
    assert_eq!(fs::read_dir(&f.home).unwrap().count(), before);
    assert!(!marker.exists());
    assert!(!f.home.join("config.json").exists());
    assert!(f.load().is_err());
    assert!(runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).is_err());
}
#[test]
fn zcode_missing_binary_is_not_replaced_by_installed_codex_or_claude() {
    let f = Fixture::new();
    executable(&f.bin.join("claude"));
    assert!(f.load().is_ok());
    assert!(runtime_bootstrap::load_claude(&f.home, &f.current, &f.parent).is_ok());
    assert_eq!(
        load_zcode(&f).err(),
        Some(StaticError::ExecutableUnavailable)
    );
}
#[test]
fn zcode_override_is_absolute_executable_and_has_no_error_fallback() {
    let mut f = zcode_fixture();
    let selected = f.bin.join("selected-zcode");
    executable(&selected);
    let alias = f.bin.join("selected-zcode-alias");
    symlink(&selected, &alias).unwrap();
    f.parent
        .insert("PULT_ZCODE_BIN".into(), alias.into_os_string());
    let b = load_zcode(&f).unwrap();
    assert_eq!(b.zcode, fs::canonicalize(&selected).unwrap());
    assert!(!b.parent.contains_key(OsStr::new("PULT_ZCODE_BIN")));
    assert!(!b.extra_env.contains_key(OsStr::new("PULT_ZCODE_BIN")));
    assert!(b.prefix_args.is_empty());
    for (value, expected) in [
        (OsString::from(""), StaticError::InvalidPath),
        (OsString::from("zcode"), StaticError::InvalidPath),
        (
            f.bin.join("missing").into_os_string(),
            StaticError::ExecutableUnavailable,
        ),
        (
            f.bin.clone().into_os_string(),
            StaticError::ExecutableUnavailable,
        ),
        (
            OsString::from_vec(b"/PRIVATE\0PATH".to_vec()),
            StaticError::InvalidPath,
        ),
    ] {
        f.parent.insert("PULT_ZCODE_BIN".into(), value);
        let error = load_zcode(&f).unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?} {error}").contains("PRIVATE"));
    }
    f.parent
        .insert("PULT_ZCODE_BIN".into(), selected.clone().into_os_string());
    for mode in [0o600, 0o000, 0o001] {
        if mode == 0o001 && nix::unistd::geteuid().as_raw() == 0 {
            continue;
        }
        fs::set_permissions(&selected, fs::Permissions::from_mode(mode)).unwrap();
        assert_eq!(
            load_zcode(&f).err(),
            Some(StaticError::ExecutableUnavailable)
        );
    }
}
#[test]
fn zcode_path_skips_empty_relative_and_unavailable_entries_without_changing_alias_rules() {
    let mut f = zcode_fixture();
    let real = f.bin.join("real-zcode");
    fs::rename(f.bin.join("zcode"), &real).unwrap();
    symlink(&real, f.bin.join("zcode")).unwrap();
    let unavailable = f
        ._temp
        .path()
        .join(OsString::from_vec(b"missing-\xff".to_vec()));
    f.parent.insert(
        "PATH".into(),
        std::env::join_paths([Path::new(""), Path::new("relative"), &unavailable, &f.bin]).unwrap(),
    );
    assert_eq!(
        load_zcode(&f).unwrap().zcode,
        fs::canonicalize(real).unwrap()
    );
    let aliases = f._temp.path().join("daemon-aliases");
    fs::create_dir(&aliases).unwrap();
    let alias = aliases.join("pultd-rust");
    symlink(&f.current, &alias).unwrap();
    executable(&aliases.join("pult-worker-holder"));
    let b = runtime_bootstrap::load_zcode(&f.home, &alias, &f.parent).unwrap();
    assert_eq!(
        b.holder,
        fs::canonicalize(aliases.join("pult-worker-holder")).unwrap()
    );
    f.parent.insert("PATH".into(), ":relative:".into());
    assert_eq!(
        load_zcode(&f).err(),
        Some(StaticError::ExecutableUnavailable)
    );
}
#[test]
fn zcode_actual_filtered_home_preserves_alias_and_need_not_exist() {
    let mut f = zcode_fixture();
    let alias = f._temp.path().join("child-home-alias");
    symlink(&f.home, &alias).unwrap();
    f.parent
        .insert("HOME".into(), alias.clone().into_os_string());
    let b = runtime_bootstrap::load_zcode(&alias, &f.current, &f.parent).unwrap();
    assert_eq!(b.child_home, alias);
    assert_eq!(
        b.parent.get(OsStr::new("HOME")).unwrap(),
        b.child_home.as_os_str()
    );
    let missing = f._temp.path().join("native-HOME-does-not-exist");
    f.parent
        .insert("HOME".into(), missing.clone().into_os_string());
    assert_eq!(load_zcode(&f).unwrap().child_home, missing);
    assert!(!missing.exists());
    let non_utf8 = OsString::from_vec(b"/native-home-\xff".to_vec());
    f.parent.insert("HOME".into(), non_utf8.clone());
    assert_eq!(load_zcode(&f).unwrap().child_home.as_os_str(), non_utf8);
    f.parent.remove(OsStr::new("HOME"));
    assert_eq!(load_zcode(&f).err(), Some(StaticError::Environment));
    for (home, expected) in [
        ("", StaticError::Environment),
        ("relative", StaticError::InvalidPath),
    ] {
        f.parent.insert("HOME".into(), home.into());
        assert_eq!(load_zcode(&f).err(), Some(expected));
    }
    f.parent.insert(
        "HOME".into(),
        OsString::from_vec(b"/PRIVATE\0HOME".to_vec()),
    );
    assert_eq!(load_zcode(&f).err(), Some(StaticError::Environment));
}
#[test]
fn zcode_extracts_seven_private_config_values_before_base_filtering_and_debug_hides_them() {
    let mut f = zcode_fixture();
    for name in pult_core::zcode_launch::ENV_PASS {
        f.parent
            .insert(name.into(), format!("PRIVATE_настройка🌊_{name}").into());
    }
    for name in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "ZCODE_OFFICIAL_ENDPOINT_TOKEN",
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "PULT_MEMORY_KEY",
        "PULT_MEMORY_TURN_KEY",
        "PULT_ASK_KEY",
        "PULT_OWNER_TOKEN",
    ] {
        f.parent.insert(name.into(), "PRIVATE_AMBIENT".into());
    }
    f.config(br#"{"notifyCommand":"PRIVATE_COMMAND"}"#);
    let b = load_zcode(&f).unwrap();
    assert_eq!(
        b.extra_env,
        pult_core::zcode_launch::extra_env(&f.parent).unwrap()
    );
    assert_eq!(b.extra_env.len(), 7);
    assert!(b.parent.keys().all(|key| {
        ["HOME", "USER", "PATH", "LANG", "TERM", "TMPDIR"].contains(&key.to_str().unwrap())
    }));
    for name in pult_core::zcode_launch::ENV_PASS {
        assert!(!b.parent.contains_key(OsStr::new(name)));
        assert_eq!(
            b.extra_env.get(OsStr::new(name)),
            f.parent.get(OsStr::new(name))
        );
    }
    let debug = format!("{b:?}");
    for private in [
        "PRIVATE",
        "настройка",
        "AMBIENT",
        f.home.to_str().unwrap(),
        f.bin.to_str().unwrap(),
    ] {
        assert!(!debug.contains(private));
    }
    assert!(debug.contains("explicit_variables: 7"));
}
#[test]
fn zcode_config_env_omits_empty_and_rejects_nul_or_aggregate_overflow_without_truncation() {
    let mut f = zcode_fixture();
    for name in pult_core::zcode_launch::ENV_PASS {
        f.parent.insert(name.into(), "".into());
    }
    assert!(load_zcode(&f).unwrap().extra_env.is_empty());
    for name in pult_core::zcode_launch::ENV_PASS {
        f.parent
            .insert(name.into(), OsString::from_vec(b"PRIVATE\0value".to_vec()));
        let error = load_zcode(&f).unwrap_err();
        assert_eq!(error, StaticError::Environment);
        assert!(!format!("{error:?} {error}").contains("PRIVATE"));
        f.parent.insert(name.into(), "".into());
    }
    let name = pult_core::zcode_launch::ENV_PASS[0];
    let value = "x".repeat(65536 - name.len() - 2);
    f.parent.insert(name.into(), value.clone().into());
    assert_eq!(
        load_zcode(&f).unwrap().extra_env.get(OsStr::new(name)),
        Some(&OsString::from(&value))
    );
    f.parent.insert(name.into(), (value.clone() + "x").into());
    assert_eq!(load_zcode(&f).err(), Some(StaticError::Environment));
    f.parent.insert(name.into(), value.into());
    f.parent
        .insert(pult_core::zcode_launch::ENV_PASS[1].into(), "🌊".into());
    assert_eq!(load_zcode(&f).err(), Some(StaticError::Environment));
}
#[test]
fn zcode_reuses_checked_config_and_private_home_guards_with_static_warning_counts() {
    let f = zcode_fixture();
    let raw = json!({"language":"ru","network":{"zcode":{"mode":"required","proxy":"http://PRIVATE_PROXY"}},"newSession":{"defaults":{"zcode":{"approval":"full"}}}});
    let bytes = serde_json::to_vec(&raw).unwrap();
    f.config(&bytes);
    let b = load_zcode(&f).unwrap();
    let parsed = runtime_config::parse(&raw);
    assert_eq!(b.config.to_file(), parsed.config.to_file());
    assert!(format!("{b:?}").contains(&format!(
        "configuration_warnings: {}",
        parsed.warnings.len()
    )));
    assert!(!format!("{b:?}").contains("PRIVATE"));
    assert_eq!(fs::read(f.home.join("config.json")).unwrap(), bytes);
    for raw in [b"{".as_slice(), b"\xff", br#"{"unknown":"\ud800"}"#] {
        f.config(raw);
        assert_eq!(load_zcode(&f).err(), Some(StaticError::ConfigInvalid));
    }
    f.config(b"{}");
    fs::set_permissions(
        f.home.join("config.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert_eq!(load_zcode(&f).err(), Some(StaticError::UnsafeConfig));
    f.config(&vec![b' '; MAX_CONFIG_BYTES as usize + 1]);
    assert_eq!(load_zcode(&f).err(), Some(StaticError::ConfigTooLarge));
    fs::set_permissions(&f.home, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(load_zcode(&f).err(), Some(StaticError::UnsafeHome));
    assert_eq!(
        runtime_bootstrap::load_zcode(Path::new("relative"), &f.current, &f.parent).err(),
        Some(StaticError::InvalidPath)
    );
}
#[test]
fn zcode_fixture_holder_curl_require_exact_flag_and_invalid_base_env_is_not_hidden() {
    let mut f = zcode_fixture();
    for (key, name) in [
        ("PULT_WORKER_HOLDER_BIN", "selected-holder"),
        ("PULT_CURL_BIN", "selected-curl"),
    ] {
        executable(&f.bin.join(name));
        f.parent
            .insert(key.into(), f.bin.join(name).into_os_string());
    }
    let b = load_zcode(&f).unwrap();
    assert_eq!(
        b.holder,
        fs::canonicalize(f.bin.join("selected-holder")).unwrap()
    );
    assert_eq!(
        b.curl,
        fs::canonicalize(f.bin.join("selected-curl")).unwrap()
    );
    for flag in [None, Some("0"), Some("true"), Some("01")] {
        f.parent.remove(OsStr::new("PULT_TEST"));
        if let Some(flag) = flag {
            f.parent.insert("PULT_TEST".into(), flag.into());
        }
        f.parent
            .insert("PULT_WORKER_HOLDER_BIN".into(), "ignored-relative".into());
        f.parent
            .insert("PULT_CURL_BIN".into(), "ignored-relative".into());
        let b = load_zcode(&f).unwrap();
        assert_eq!(
            b.holder,
            fs::canonicalize(f.bin.join("pult-worker-holder")).unwrap()
        );
        assert_eq!(b.curl, fs::canonicalize("/usr/bin/curl").unwrap());
    }
    f.parent.insert("PULT_TEST".into(), "1".into());
    assert_eq!(load_zcode(&f).err(), Some(StaticError::InvalidPath));
    f.parent.insert(
        "PULT_WORKER_HOLDER_BIN".into(),
        f.bin.join("pult-worker-holder").into_os_string(),
    );
    f.parent
        .insert("PULT_CURL_BIN".into(), f.bin.join("curl").into_os_string());
    for value in [
        OsString::from_vec(b"PRIVATE\0PATH".to_vec()),
        OsString::from("x".repeat(65537)),
    ] {
        f.parent.insert("PATH".into(), value);
        assert_eq!(load_zcode(&f).err(), Some(StaticError::Environment));
    }
}
