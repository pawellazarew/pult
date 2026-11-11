//! Filesystem checks before a session starts or resumes. These functions neither
//! create directories nor grant access; callers apply the access policy separately.
use anyhow::{Result, anyhow, ensure};
use std::ffi::OsStr;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

const GENERAL_REFUSAL: &str = "general conversation workspace is invalid or unavailable";

fn absolute(path: &Path) -> Result<()> {
    ensure!(path.is_absolute(), "session paths must be absolute");
    Ok(())
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

/// True when cwd is home or an ancestor of home, including existing symlink
/// aliases. Like Node coversDir, a failed realpath falls back to the complete
/// lexical absolute path, so unavailable storage does not silently disable this
/// ancestor check. This does not establish that cwd exists or is a directory.
pub fn covers_pult_home(cwd: &Path, home: &Path) -> Result<bool> {
    absolute(cwd)?;
    absolute(home)?;
    let cwd = fs::canonicalize(cwd).unwrap_or_else(|_| lexical_absolute(cwd));
    let home = fs::canonicalize(home).unwrap_or_else(|_| lexical_absolute(home));
    Ok(home.starts_with(cwd))
}

fn private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| anyhow!(GENERAL_REFUSAL))?;
    ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.permissions().mode() & 0o777 == 0o700,
        GENERAL_REFUSAL
    );
    Ok(())
}

fn real(path: &Path) -> Result<PathBuf> {
    fs::canonicalize(path).map_err(|_| anyhow!(GENERAL_REFUSAL))
}

/// Validate an existing owned `<home>/conversations/<name>-<six ASCII alnum>`
/// workspace, including after restoring a saved session. Root and cwd must be
/// real private directories (0700). Home may have an alias, as in Node, but root
/// and cwd themselves may not be symlinks. All failures omit local path details.
///
/// This read-only check is not an atomic directory handle or a defence against
/// replacement by another process between validation and provider spawn.
pub fn validate_general(home: &Path, name: &str, cwd: &Path) -> Result<()> {
    absolute(home)?;
    absolute(cwd)?;
    ensure!(crate::session_model::is_name(name), "invalid session name");
    let root = home.join("conversations");
    private_directory(&root)?;
    private_directory(cwd)?;

    // Preserve Node basename/dirname semantics for trailing `/.` and `/..`;
    // Path::file_name would silently discard a trailing `.` component.
    // Only slashes are separators; whitespace is part of a Unix filename.
    let raw = cwd.as_os_str().as_bytes();
    let end = raw.iter().rposition(|b| *b != b'/').map_or(0, |i| i + 1);
    let raw = &raw[..end];
    let split = raw.iter().rposition(|b| *b == b'/').unwrap_or(0);
    ensure!(raw.len() > split, GENERAL_REFUSAL);
    let leaf = &raw[split + 1..];
    let prefix = format!("{name}-");
    ensure!(
        leaf.starts_with(prefix.as_bytes())
            && leaf.len() == prefix.len() + 6
            && leaf[prefix.len()..].iter().all(u8::is_ascii_alphanumeric),
        GENERAL_REFUSAL
    );
    let parent = Path::new(OsStr::from_bytes(&raw[..split.max(1)]));
    let expected_root = real(home)?.join("conversations");
    let actual_root = real(&root)?;
    ensure!(actual_root == expected_root, GENERAL_REFUSAL);
    ensure!(real(parent)? == actual_root, GENERAL_REFUSAL);
    ensure!(
        real(cwd)? == expected_root.join(OsStr::from_bytes(leaf)),
        GENERAL_REFUSAL
    );
    Ok(())
}
