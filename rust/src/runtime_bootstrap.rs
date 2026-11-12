//! Read-only trusted-host bootstrap. No processes, provider calls, credentials,
//! settings writes or runtime admission are performed here.
//!
//! The host supplies its own environment/current executable and must hold the
//! same Pult-home ownership lease used by the eventual runtime. Home and its
//! ancestors are trusted host choices (canonical aliases are allowed); config
//! itself must be an owned private file. This is a checked startup snapshot,
//! not protection against a same-user writer replacing binaries after return.
//! PATH lookup skips empty/relative entries instead of searching the cwd.
use crate::runtime_config::{self, RuntimeConfig, WarningCode};
use crate::worker_env::{self, Environment};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, Metadata, OpenOptions};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StaticError {
    InvalidPath,
    UnsafeHome,
    Environment,
    ConfigIo,
    UnsafeConfig,
    ConfigTooLarge,
    ConfigChanged,
    ConfigInvalid,
    ExecutableUnavailable,
}
impl fmt::Display for StaticError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidPath => "bootstrap requires an absolute path without NUL",
            Self::UnsafeHome => "bootstrap home is not an owned private directory",
            Self::Environment => "bootstrap environment is invalid",
            Self::ConfigIo => "bootstrap configuration cannot be read",
            Self::UnsafeConfig => "bootstrap configuration is not a private owned regular file",
            Self::ConfigTooLarge => "bootstrap configuration exceeds its size limit",
            Self::ConfigChanged => "bootstrap configuration changed while reading",
            Self::ConfigInvalid => "bootstrap configuration is not valid JSON",
            Self::ExecutableUnavailable => "bootstrap executable is unavailable or not executable",
        })
    }
}
impl std::error::Error for StaticError {}

pub struct Bootstrap {
    pub config: RuntimeConfig,
    /// BASE-only environment: never ambient provider credentials, hooks, proxy
    /// routing, memory keys or bootstrap overrides. Explicit per-worker grants
    /// must be constructed separately immediately before checked dispatch.
    pub parent: Environment,
    pub holder: PathBuf,
    pub codex: PathBuf,
    pub prefix_args: Vec<OsString>,
    pub curl: PathBuf,
    warning_codes: Vec<WarningCode>,
}
impl fmt::Debug for Bootstrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Bootstrap")
            .field("parent_variables", &self.parent.len())
            .field("prefix_arguments", &self.prefix_args.len())
            .field("configuration_warnings", &self.warning_codes.len())
            .finish_non_exhaustive()
    }
}
#[derive(Eq, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
}
impl Identity {
    fn of(m: &Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            mtime: m.mtime(),
            mtime_ns: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_ns: m.ctime_nsec(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
            links: m.nlink(),
        }
    }
}
fn absolute(path: &Path) -> Result<(), StaticError> {
    if !path.is_absolute() || path.as_os_str().as_bytes().contains(&0) {
        return Err(StaticError::InvalidPath);
    }
    Ok(())
}
fn home_metadata(home: &Path) -> Result<Metadata, StaticError> {
    let m = fs::symlink_metadata(home).map_err(|_| StaticError::UnsafeHome)?;
    if !m.is_dir() || m.uid() != nix::unistd::geteuid().as_raw() || m.mode() & 0o7777 != 0o700 {
        return Err(StaticError::UnsafeHome);
    }
    Ok(m)
}
fn private_config(m: &Metadata) -> bool {
    m.is_file()
        && m.uid() == nix::unistd::geteuid().as_raw()
        && m.mode() & 0o7777 == 0o600
        && m.nlink() == 1
}
fn config_bytes(home: &Path) -> Result<Option<Vec<u8>>, StaticError> {
    read_config(&home.join("config.json"), || {})
}
// The seam is private and used only to deterministically exercise overwrite,
// rename and permission races after the open/fstat snapshot in unit tests.
fn read_config(path: &Path, after_snapshot: impl FnOnce()) -> Result<Option<Vec<u8>>, StaticError> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return match fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                _ => Err(StaticError::ConfigChanged),
            };
        }
        Err(_) => return Err(StaticError::ConfigIo),
    };
    let before = file.metadata().map_err(|_| StaticError::ConfigIo)?;
    if !private_config(&before) {
        return Err(StaticError::UnsafeConfig);
    }
    if before.len() > MAX_CONFIG_BYTES {
        return Err(StaticError::ConfigTooLarge);
    }
    let identity = Identity::of(&before);
    let observed = fs::symlink_metadata(path).map_err(|_| StaticError::ConfigChanged)?;
    if !private_config(&observed) || Identity::of(&observed) != identity {
        return Err(StaticError::ConfigChanged);
    }
    after_snapshot();
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| StaticError::ConfigIo)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(StaticError::ConfigTooLarge);
    }
    let after = file.metadata().map_err(|_| StaticError::ConfigChanged)?;
    let observed = fs::symlink_metadata(path).map_err(|_| StaticError::ConfigChanged)?;
    if bytes.len() as u64 != identity.len
        || !private_config(&after)
        || !private_config(&observed)
        || Identity::of(&after) != identity
        || Identity::of(&observed) != identity
    {
        return Err(StaticError::ConfigChanged);
    }
    Ok(Some(bytes))
}
fn executable(path: &Path) -> Result<PathBuf, StaticError> {
    absolute(path)?;
    let path = fs::canonicalize(path).map_err(|_| StaticError::ExecutableUnavailable)?;
    let m = fs::symlink_metadata(&path).map_err(|_| StaticError::ExecutableUnavailable)?;
    if !m.is_file() {
        return Err(StaticError::ExecutableUnavailable);
    }
    // Root/system-owned binaries are supported. Check the effective user's
    // applicable execute bit instead of mistaking somebody else's bit for ours.
    let uid = nix::unistd::geteuid().as_raw();
    let executable = if uid == 0 {
        m.mode() & 0o111 != 0
    } else if m.uid() == uid {
        m.mode() & 0o100 != 0
    } else if m.gid() == nix::unistd::getegid().as_raw()
        || rustix::process::getgroups()
            .map_err(|_| StaticError::ExecutableUnavailable)?
            .iter()
            .any(|gid| gid.as_raw() == m.gid())
    {
        m.mode() & 0o010 != 0
    } else {
        m.mode() & 0o001 != 0
    };
    if !executable {
        return Err(StaticError::ExecutableUnavailable);
    }
    Ok(path)
}
fn codex(parent: &Environment, filtered: &Environment) -> Result<PathBuf, StaticError> {
    if let Some(path) = parent.get(OsStr::new("PULT_CODEX_BIN")) {
        return executable(Path::new(path));
    }
    let paths = filtered
        .get(OsStr::new("PATH"))
        .ok_or(StaticError::Environment)?;
    for path in std::env::split_paths(paths) {
        if !path.is_absolute() {
            continue;
        }
        let candidate = path.join("codex");
        if let Ok(path) = executable(&candidate) {
            return Ok(path);
        }
    }
    Err(StaticError::ExecutableUnavailable)
}
/// Loads config and resolves trusted executables without spawning any of them.
/// Only a missing config defaults; malformed JSON (including lone UTF-16
/// surrogates), unsafe files and unreadable/changed files refuse bootstrap.
/// PULT_CODEX_BIN is an absolute trusted-host override. Holder/curl overrides
/// are fixtures only, enabled by exact PULT_TEST=1; they never reach child env.
pub fn load(
    home: &Path,
    current_exe: &Path,
    parent: &Environment,
) -> Result<Bootstrap, StaticError> {
    absolute(home)?;
    absolute(current_exe)?;
    let home = fs::canonicalize(home).map_err(|_| StaticError::UnsafeHome)?;
    let before = home_metadata(&home)?;
    let filtered = worker_env::from_parent(parent, &Environment::new())
        .map_err(|_| StaticError::Environment)?;
    let bytes = config_bytes(&home)?;
    let raw = bytes
        .as_deref()
        .map(serde_json::from_slice::<serde_json::Value>)
        .transpose()
        .map_err(|_| StaticError::ConfigInvalid)?;
    let parsed = runtime_config::parse(raw.as_ref().unwrap_or(&serde_json::json!({})));
    executable(current_exe)?;
    let test = parent
        .get(OsStr::new("PULT_TEST"))
        .is_some_and(|v| v == "1");
    let holder = if test {
        parent
            .get(OsStr::new("PULT_WORKER_HOLDER_BIN"))
            .map(PathBuf::from)
    } else {
        None
    }
    .unwrap_or_else(|| current_exe.with_file_name("pult-worker-holder"));
    let curl = if test {
        parent.get(OsStr::new("PULT_CURL_BIN")).map(PathBuf::from)
    } else {
        None
    }
    .unwrap_or_else(|| PathBuf::from("/usr/bin/curl"));
    let holder = executable(&holder)?;
    let curl = executable(&curl)?;
    let codex = codex(parent, &filtered)?;
    let after = home_metadata(&home)?;
    if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
        return Err(StaticError::UnsafeHome);
    }
    Ok(Bootstrap {
        config: parsed.config,
        parent: filtered,
        holder,
        codex,
        prefix_args: vec![OsString::from("app-server")],
        curl,
        warning_codes: parsed.warnings.into_iter().map(|w| w.code).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn config_changes_after_open_are_never_accepted_as_a_stable_snapshot() {
        for race in 0..4 {
            let home = tempfile::tempdir().unwrap();
            let path = home.path().join("config.json");
            fs::write(&path, b"{}").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let replacement = home.path().join("replacement");
            fs::write(&replacement, b"{}").unwrap();
            fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
            let result = read_config(&path, || match race {
                0 => fs::rename(&replacement, &path).unwrap(),
                1 => fs::write(&path, b"{ } ").unwrap(),
                2 => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
                _ => fs::remove_file(&path).unwrap(),
            });
            assert_eq!(result.err(), Some(StaticError::ConfigChanged));
        }
    }
    #[test]
    fn growing_config_read_is_stopped_after_one_extra_byte() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.json");
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let result = read_config(&path, || {
            fs::write(&path, vec![b' '; MAX_CONFIG_BYTES as usize + 2]).unwrap()
        });
        assert_eq!(result.err(), Some(StaticError::ConfigTooLarge));
    }
}
