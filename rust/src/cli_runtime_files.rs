//! Descriptor-anchored managed Node observations inside an admitted scratch home.
use crate::cli_client::owner_private_file::{self, Policy};
use anyhow::{Result, anyhow, ensure};
use rustix::fs::{Dir, Mode, OFlags, open, openat};
use std::path::{Path, PathBuf};
const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::NONBLOCK)
    .union(OFlags::CLOEXEC);

pub(super) fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c as u32, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}
pub(super) struct Disk {
    pub active: Option<String>,
    pub installed: Vec<String>,
}
pub(super) fn observe(home: &Path) -> Result<Disk> {
    let active = owner_private_file::read(
        home,
        Path::new("runtime/active"),
        16 * 1024,
        Policy {
            private_config: false,
        },
    )
    .map_err(|_| anyhow!("runtime active pointer cannot be read safely"))?
    .map(|bytes| {
        trim(
            String::from_utf8_lossy(&bytes)
                .split('\n')
                .next()
                .unwrap_or(""),
        )
        .to_owned()
    })
    .filter(|value| !value.is_empty());
    let root = match open(home, DIRECTORY, Mode::empty()) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => {
            return Ok(Disk {
                active,
                installed: vec![],
            });
        }
        Err(_) => return Err(anyhow!("runtime home cannot be opened safely")),
    };
    let runtime = match openat(&root, "runtime", DIRECTORY, Mode::empty()) {
        Ok(fd) => fd,
        Err(rustix::io::Errno::NOENT) => {
            return Ok(Disk {
                active,
                installed: vec![],
            });
        }
        Err(_) => return Err(anyhow!("runtime directory cannot be opened safely")),
    };
    let entries = Dir::new(runtime).map_err(|_| anyhow!("runtime directory cannot be read"))?;
    let mut installed = Vec::new();
    let mut count = 0;
    let mut bytes = 0;
    for entry in entries {
        let entry = entry.map_err(|_| anyhow!("runtime directory cannot be read"))?;
        let name = entry.file_name().to_bytes();
        if matches!(name, b"." | b"..") {
            continue;
        }
        count += 1;
        bytes += name.len();
        ensure!(
            count <= 4096 && bytes <= 1024 * 1024,
            "runtime directory exceeds observation limits"
        );
        let name = String::from_utf8_lossy(name);
        if name.starts_with("node-v") && !name.contains(".partial-") && !name.contains("~old-") {
            installed.push(name.into_owned());
        }
    }
    installed.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(Disk { active, installed })
}

/// Executable observation deliberately follows ordinary symlinks and accepts
/// external/relative pointers, as Node's stat + access(X_OK) does. No data is read.
pub(super) fn program(active: &str) -> Option<PathBuf> {
    let path = Path::new(active);
    (std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && rustix::fs::access(path, rustix::fs::Access::EXEC_OK).is_ok())
    .then(|| path.to_owned())
}
