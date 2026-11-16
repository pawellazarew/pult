//! Private owner-input reads. Callers admit the home and credential purpose first.
use rustix::fs::{Mode, OFlags, open, openat};
use std::{
    fs::{File, Metadata},
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Component, Path},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadError {
    Io,
    Unsafe,
    TooLarge,
    Changed,
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Io => "owner input cannot be read",
            Self::Unsafe => "owner input is unsafe",
            Self::TooLarge => "owner input exceeds its size limit",
            Self::Changed => "owner input changed while being read",
        })
    }
}
impl std::error::Error for ReadError {}

#[derive(PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    length: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    links: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl From<&Metadata> for Identity {
    fn from(m: &Metadata) -> Self {
        Self {
            device: m.dev(),
            inode: m.ino(),
            length: m.len(),
            mode: m.mode(),
            uid: m.uid(),
            gid: m.gid(),
            links: m.nlink(),
            modified: (m.mtime(), m.mtime_nsec()),
            changed: (m.ctime(), m.ctime_nsec()),
        }
    }
}
fn open_error(error: rustix::io::Errno) -> ReadError {
    match error {
        rustix::io::Errno::LOOP | rustix::io::Errno::NOTDIR => ReadError::Unsafe,
        _ => ReadError::Io,
    }
}
#[derive(Clone, Copy)]
pub(crate) struct Policy {
    pub(crate) private_config: bool,
}
fn regular(m: &Metadata, policy: Policy) -> bool {
    m.is_file() && (!policy.private_config || (m.mode() & 0o077 == 0 && m.nlink() == 1))
}

pub(crate) fn read(
    home: &Path,
    relative: &Path,
    limit: u64,
    policy: Policy,
) -> Result<Option<Vec<u8>>, ReadError> {
    read_with_depth(home, relative, limit, policy, 8)
}
/// Closed diagnostic schema callers may admit the reviewed depth-32 bundle;
/// ordinary owner reads retain their fixed depth-eight wrapper above.
pub(crate) fn read_with_depth(
    home: &Path,
    relative: &Path,
    limit: u64,
    policy: Policy,
    max_depth: usize,
) -> Result<Option<Vec<u8>>, ReadError> {
    if !(1..=32).contains(&max_depth)
        || relative.is_absolute()
        || relative.components().count() > max_depth
        || !relative
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
    {
        return Err(ReadError::Unsafe);
    }
    let mut parts = relative
        .components()
        .map(|p| p.as_os_str())
        .collect::<Vec<_>>();
    let name = parts.pop().ok_or(ReadError::Unsafe)?;
    let flags =
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    let mut directory = match open(home, flags, Mode::empty()) {
        Ok(directory) => directory,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(open_error(error)),
    };
    for part in parts {
        directory = match openat(&directory, part, flags, Mode::empty()) {
            Ok(directory) => directory,
            Err(rustix::io::Errno::NOENT) => return Ok(None),
            Err(error) => return Err(open_error(error)),
        };
    }
    let mut file = match openat(
        &directory,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => File::from(file),
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(open_error(error)),
    };
    let before = file.metadata().map_err(|_| ReadError::Io)?;
    if !regular(&before, policy) {
        return Err(ReadError::Unsafe);
    }
    if before.len() > limit {
        return Err(ReadError::TooLarge);
    }
    let identity = Identity::from(&before);
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ReadError::Io)?;
    if bytes.len() as u64 > limit {
        return Err(ReadError::TooLarge);
    }
    let after = file.metadata().map_err(|_| ReadError::Changed)?;
    if !regular(&after, policy)
        || Identity::from(&after) != identity
        || bytes.len() as u64 != identity.length
    {
        return Err(ReadError::Changed);
    }
    Ok(Some(bytes))
}
