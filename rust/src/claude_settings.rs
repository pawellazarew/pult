//! Bounded inherited Claude permission settings, matching the Node resolver.
//! Call from owned blocking work. Paths/HOME are trusted host input, not RPC data.
use crate::{history::Fields, journal::decode_js_string};
use serde_json::value::RawValue;
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
const MAX_BYTES: u64 = 1024 * 1024;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsError {
    InvalidPath,
    UnrepresentableMode,
    Capacity,
}
pub struct Settings {
    user: PathBuf,
    managed: PathBuf,
}
impl Settings {
    /// Capture the actual child HOME, not PULT_HOME. Managed configuration is
    /// always considered, independently of setting-sources.
    pub fn new(child_home: &Path, managed_directory: PathBuf) -> Result<Self, SettingsError> {
        if !child_home.is_absolute() || !managed_directory.is_absolute() {
            return Err(SettingsError::InvalidPath);
        }
        Ok(Self {
            user: child_home.join(".claude/settings.json"),
            managed: managed_directory,
        })
    }
    pub fn effective_mode(
        &self,
        cwd: &Path,
        sources: Option<&str>,
    ) -> Result<String, SettingsError> {
        if !cwd.is_absolute() {
            return Err(SettingsError::InvalidPath);
        }
        let allowed = sources.filter(|s| !s.is_empty()).map(|s| {
            s.split(',')
                .map(|s| s.trim_matches(crate::claude_launch::js_whitespace))
                .collect::<Vec<_>>()
        });
        let mut files = Vec::new();
        for (kind, path) in [
            ("user", self.user.clone()),
            ("project", cwd.join(".claude/settings.json")),
            ("local", cwd.join(".claude/settings.local.json")),
        ] {
            if allowed.as_ref().is_none_or(|a| a.contains(&kind)) {
                files.push(path);
            }
        }
        files.push(self.managed.join("managed-settings.json"));
        if let Ok(entries) = fs::read_dir(self.managed.join("managed-settings.d")) {
            let mut names = Vec::new();
            for (index, entry) in entries.enumerate() {
                if index >= 4096 {
                    return Err(SettingsError::Capacity);
                }
                if let Some(name) = entry
                    .ok()
                    .and_then(|e| e.file_name().into_string().ok())
                    .filter(|s| s.ends_with(".json"))
                {
                    names.push(name);
                }
            }
            // JS Array.sort compares UTF-16 code units, not UTF-8 bytes.
            names.sort_by_cached_key(|s| s.encode_utf16().collect::<Vec<_>>());
            files.extend(
                names
                    .into_iter()
                    .map(|name| self.managed.join("managed-settings.d").join(name)),
            );
        }
        default_mode(&files).map_or_else(
            || Ok("default".into()),
            |s| String::from_utf16(&s).map_err(|_| SettingsError::UnrepresentableMode),
        )
    }
}
/// Exact JS string units retain unknown/future modes, including lone surrogates.
/// An unsafe existing file counts as bypass, malformed JSON contributes nothing.
pub fn default_mode(files: &[PathBuf]) -> Option<Vec<u16>> {
    files.iter().rev().find_map(|f| mode_of(f))
}
fn mode_of(path: &Path) -> Option<Vec<u16>> {
    // Match Node stat failure behavior; there is no file contribution.
    let metadata = fs::metadata(path).ok()?;
    let bypass = || Some("bypassPermissions".encode_utf16().collect());
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return bypass();
    }
    // Follow dotfile symlinks, but inspect the opened descriptor and never block
    // opening a swapped FIFO. Recheck the bound while reading a growing file.
    let raw = (|| {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() > MAX_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
        (bytes.len() as u64 <= MAX_BYTES).then_some(bytes)
    })();
    let Some(raw) = raw else {
        return bypass();
    };
    let text = String::from_utf8_lossy(&raw);
    let parsed: Box<RawValue> = serde_json::from_str(&text).ok()?;
    let fields = Fields::parse(&parsed).ok()?;
    let permissions = Fields::parse(fields.get("permissions")?).ok()?;
    let mode = permissions.get("defaultMode")?;
    mode.get()
        .starts_with('"')
        .then(|| decode_js_string(mode).ok())
        .flatten()
}
