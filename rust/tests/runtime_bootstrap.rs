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
