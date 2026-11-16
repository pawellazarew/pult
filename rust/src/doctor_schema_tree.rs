//! Complete, bounded, descriptor-anchored schema inventories and manifest-only deletion.
use crate::cli_client::owner_private_file::{self, Policy};
use rustix::fd::OwnedFd;
use rustix::fs::{
    AtFlags, Dir, FileType, Mode, OFlags, Stat, fstat, open, openat, statat, unlinkat,
};
use std::{
    ffi::OsString,
    os::unix::ffi::OsStrExt,
    path::{Component, Path, PathBuf},
};
pub(super) const ENTRIES: usize = 8192;
const FILES: usize = 4096;
const DEPTH: usize = 32;
const BYTES: u64 = 64 * 1024 * 1024;
const FILE_BYTES: u64 = 8 * 1024 * 1024;
const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::NONBLOCK)
    .union(OFlags::CLOEXEC);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Fault {
    EntryLimit,
    FileLimit,
    DepthLimit,
    ByteLimit,
    Unreadable,
    Cancelled,
    Changed,
}
impl Fault {
    pub fn reason(self) -> &'static str {
        match self {
            Self::EntryLimit => "entry_limit",
            Self::FileLimit => "file_limit",
            Self::DepthLimit => "depth_limit",
            Self::ByteLimit => "byte_limit",
            Self::Unreadable => "unreadable_tree",
            Self::Cancelled => "cancelled_scan",
            Self::Changed => "changed_tree",
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    kind: FileType,
}
impl Identity {
    // stat field widths differ across Darwin/Linux ABIs; retain the same normalization.
    #[allow(clippy::unnecessary_cast)]
    fn of(s: &Stat) -> Self {
        Self {
            device: s.st_dev as u64,
            inode: s.st_ino,
            kind: FileType::from_raw_mode(s.st_mode as _),
        }
    }
}
struct Entry {
    relative: PathBuf,
    identity: Identity,
}
pub(super) struct Tree {
    parent: OwnedFd,
    root: OwnedFd,
    name: OsString,
    identity: Identity,
    entries: Vec<Entry>,
    files: usize,
    bytes: u64,
}
fn io<T>(r: rustix::io::Result<T>) -> Result<T, Fault> {
    r.map_err(|_| Fault::Unreadable)
}
impl Tree {
    /// Optional observation scans stop on cancellation. Mandatory cleanup scans
    /// still finish only within the same hard entry/depth/byte budgets.
    pub fn scan(path: &Path, cancel: &impl Fn() -> bool, cleanup: bool) -> Result<Self, Fault> {
        let parent = io(open(
            path.parent().ok_or(Fault::Unreadable)?,
            DIRECTORY,
            Mode::empty(),
        ))?;
        let name = path.file_name().ok_or(Fault::Unreadable)?.to_owned();
        let root = io(openat(&parent, &name, DIRECTORY, Mode::empty()))?;
        let identity = Identity::of(&io(fstat(&root))?);
        let mut tree = Self {
            parent,
            root,
            name,
            identity,
            entries: Vec::new(),
            files: 0,
            bytes: 0,
        };
        let directory = io(rustix::io::dup(&tree.root))?;
        tree.walk(&directory, Path::new(""), cancel, cleanup && cancel())?;
        tree.attached()?;
        Ok(tree)
    }
    fn walk(
        &mut self,
        directory: &OwnedFd,
        relative: &Path,
        cancel: &impl Fn() -> bool,
        cleanup: bool,
    ) -> Result<(), Fault> {
        let entries = io(Dir::read_from(directory))?;
        for entry in entries {
            let entry = io(entry)?;
            let name = entry.file_name().to_bytes();
            if matches!(name, b"." | b"..") {
                continue;
            }
            let cancelled = cancel();
            if cancelled && !cleanup {
                return Err(Fault::Cancelled);
            }
            if self.entries.len() >= ENTRIES {
                return Err(Fault::EntryLimit);
            }
            let name = std::ffi::OsStr::from_bytes(name);
            let path = relative.join(name);
            if path.components().count() > DEPTH {
                return Err(Fault::DepthLimit);
            }
            let metadata = io(statat(directory, name, AtFlags::SYMLINK_NOFOLLOW))?;
            let identity = Identity::of(&metadata);
            self.entries.push(Entry {
                relative: path.clone(),
                identity,
            });
            if identity.kind == FileType::Directory {
                let child = io(openat(directory, name, DIRECTORY, Mode::empty()))?;
                if Identity::of(&io(fstat(&child))?) != identity {
                    return Err(Fault::Changed);
                }
                self.walk(&child, &path, cancel, cleanup)?;
            } else if identity.kind == FileType::RegularFile {
                self.files += 1;
                if self.files > FILES {
                    return Err(Fault::FileLimit);
                }
                let size = u64::try_from(metadata.st_size).map_err(|_| Fault::ByteLimit)?;
                if size > FILE_BYTES {
                    return Err(Fault::ByteLimit);
                }
                self.bytes = self.bytes.checked_add(size).ok_or(Fault::ByteLimit)?;
                if self.bytes > BYTES {
                    return Err(Fault::ByteLimit);
                }
            }
        }
        Ok(())
    }
    pub fn attached(&self) -> Result<(), Fault> {
        if Identity::of(&io(statat(
            &self.parent,
            &self.name,
            AtFlags::SYMLINK_NOFOLLOW,
        ))?) != self.identity
        {
            return Err(Fault::Changed);
        }
        Ok(())
    }
    pub fn paths(&self) -> Vec<&Path> {
        self.entries
            .iter()
            .filter(|e| e.identity.kind == FileType::RegularFile)
            .map(|e| e.relative.as_path())
            .collect()
    }
    fn parent_at(&self, relative: &Path) -> Result<(OwnedFd, OsString), Fault> {
        let mut parent = io(rustix::io::dup(&self.root))?;
        let mut parts = relative.components().collect::<Vec<_>>();
        let Some(Component::Normal(name)) = parts.pop() else {
            return Err(Fault::Changed);
        };
        let mut prefix = PathBuf::new();
        for part in parts {
            let Component::Normal(name) = part else {
                return Err(Fault::Changed);
            };
            prefix.push(name);
            let expected = self
                .entries
                .iter()
                .find(|e| e.relative == prefix)
                .ok_or(Fault::Changed)?;
            parent = io(openat(&parent, name, DIRECTORY, Mode::empty()))?;
            if Identity::of(&io(fstat(&parent))?) != expected.identity {
                return Err(Fault::Changed);
            }
        }
        Ok((parent, name.to_owned()))
    }
    pub fn read(&self, path: &Path) -> Result<Vec<u8>, Fault> {
        self.attached()?;
        let entry = self
            .entries
            .iter()
            .find(|e| e.relative == path)
            .ok_or(Fault::Changed)?;
        let (parent, name) = self.parent_at(path)?;
        if Identity::of(&io(statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW))?) != entry.identity {
            return Err(Fault::Changed);
        }
        let bytes = owner_private_file::read_from_fd(
            &self.root,
            path,
            FILE_BYTES,
            Policy {
                private_config: false,
            },
            DEPTH,
        )
        .map_err(|_| Fault::Unreadable)?
        .ok_or(Fault::Changed)?;
        self.attached()?;
        Ok(bytes)
    }
    /// Never readdir/recurse during deletion: remove only the completed manifest.
    /// New/replaced/unknown entries cause retain, never an unbounded recursive rm.
    pub fn cleanup(self, cancel: &impl Fn() -> bool) -> Result<(), Fault> {
        self.attached()?;
        let mandatory_cancelled_cleanup = cancel();
        for entry in self.entries.iter().rev() {
            if cancel() && !mandatory_cancelled_cleanup {
                return Err(Fault::Cancelled);
            }
            self.attached()?;
            let (parent, name) = self.parent_at(&entry.relative)?;
            if Identity::of(&io(statat(&parent, &name, AtFlags::SYMLINK_NOFOLLOW))?)
                != entry.identity
            {
                return Err(Fault::Changed);
            }
            self.attached()?;
            io(unlinkat(
                &parent,
                &name,
                if entry.identity.kind == FileType::Directory {
                    AtFlags::REMOVEDIR
                } else {
                    AtFlags::empty()
                },
            ))?;
        }
        self.attached()?;
        io(unlinkat(&self.parent, &self.name, AtFlags::REMOVEDIR))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, os::unix::fs::symlink};
    #[test]
    fn cleanup_preserves_a_whole_root_moved_after_preflight() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        let moved = temp.path().join("moved");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("known"), "owned before move").unwrap();
        let tree = Tree::scan(&root, &|| false, false).unwrap();
        std::fs::rename(&root, &moved).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("replacement"), "keep replacement").unwrap();
        assert!(matches!(tree.read(Path::new("known")), Err(Fault::Changed)));
        assert!(matches!(tree.cleanup(&|| false), Err(Fault::Changed)));
        assert_eq!(
            std::fs::read_to_string(moved.join("known")).unwrap(),
            "owned before move"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("replacement")).unwrap(),
            "keep replacement"
        );
    }
    #[test]
    fn cleanup_stops_before_more_unlinks_when_root_moves_at_a_later_checkpoint() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        let moved = temp.path().join("moved");
        std::fs::create_dir(&root).unwrap();
        for name in ["a", "b"] {
            std::fs::write(root.join(name), name).unwrap();
        }
        let tree = Tree::scan(&root, &|| false, false).unwrap();
        let checks = Cell::new(0);
        let checkpoint = || {
            checks.set(checks.get() + 1);
            if checks.get() == 3 {
                std::fs::rename(&root, &moved).unwrap();
                std::fs::create_dir(&root).unwrap();
                std::fs::write(root.join("replacement"), "keep replacement").unwrap();
            }
            false
        };
        assert!(matches!(tree.cleanup(&checkpoint), Err(Fault::Changed)));
        let remaining = std::fs::read_dir(&moved).unwrap().collect::<Vec<_>>();
        assert_eq!(
            remaining.len(),
            1,
            "the second known entry must remain after attachment changes"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("replacement")).unwrap(),
            "keep replacement"
        );
    }
    #[test]
    fn cancellation_stops_optional_inventory_before_visiting_the_whole_tree() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        std::fs::create_dir(&root).unwrap();
        for i in 0..20 {
            std::fs::create_dir(root.join(i.to_string())).unwrap();
        }
        let checks = Cell::new(0);
        let cancel = || {
            checks.set(checks.get() + 1);
            checks.get() >= 3
        };
        assert!(matches!(
            Tree::scan(&root, &cancel, false),
            Err(Fault::Cancelled)
        ));
        assert!(checks.get() <= 3);
        assert!(root.exists());
    }
    #[test]
    fn cleanup_never_discovers_or_deletes_entries_added_after_preflight() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("known"), "known").unwrap();
        let tree = Tree::scan(&root, &|| false, false).unwrap();
        std::fs::write(root.join("late"), "retain").unwrap();
        assert!(tree.cleanup(&|| false).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("late")).unwrap(),
            "retain"
        );
        assert!(root.exists());
    }
    #[test]
    fn cleanup_does_not_follow_a_directory_swapped_to_an_external_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("tree");
        let external = temp.path().join("external");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&external).unwrap();
        std::fs::create_dir(root.join("child")).unwrap();
        std::fs::write(root.join("child/known"), "known").unwrap();
        std::fs::write(external.join("known"), "do not touch").unwrap();
        let tree = Tree::scan(&root, &|| false, false).unwrap();
        std::fs::rename(root.join("child"), temp.path().join("saved")).unwrap();
        symlink(&external, root.join("child")).unwrap();
        assert!(tree.cleanup(&|| false).is_err());
        assert_eq!(
            std::fs::read_to_string(external.join("known")).unwrap(),
            "do not touch"
        );
        assert!(
            root.join("child")
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
