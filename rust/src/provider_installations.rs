//! Observation of the trusted runtime-selected executable, not a permission or
//! compatibility proof. A retained runtime keeps this snapshot after updates.
use serde::Serialize;
use std::{fs, os::unix::fs::MetadataExt, path::Path};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileIdentity {
    path: String,
    realpath: String,
    dev: String,
    ino: String,
    size: String,
    mtime_ns: String,
    ctime_ns: String,
}

fn timestamp(seconds: i64, nanos: i64) -> String {
    (i128::from(seconds) * 1_000_000_000 + i128::from(nanos)).to_string()
}

impl FileIdentity {
    /// Only callers holding an already trusted host command select this path.
    /// A missing/changed observation is unknown; it never vetoes runtime work.
    pub(crate) fn capture(path: &Path) -> Option<Self> {
        if !path.is_absolute() {
            return None;
        }
        let path_text = path.to_str()?;
        let real = fs::canonicalize(path).ok()?;
        let before = fs::symlink_metadata(&real).ok()?;
        if !before.is_file() || rustix::fs::access(&real, rustix::fs::Access::EXEC_OK).is_err() {
            return None;
        }
        let identity = Self::from_metadata(path_text, &real, &before)?;
        let after = fs::metadata(path).ok()?;
        if !after.is_file()
            || Self::from_metadata(path_text, &real, &after)? != identity
            || fs::canonicalize(path).ok()? != real
        {
            return None;
        }
        Some(identity)
    }

    fn from_metadata(path: &str, real: &Path, metadata: &fs::Metadata) -> Option<Self> {
        Some(Self {
            path: path.into(),
            realpath: real.to_str()?.into(),
            dev: metadata.dev().to_string(),
            ino: metadata.ino().to_string(),
            size: metadata.len().to_string(),
            mtime_ns: timestamp(metadata.mtime(), metadata.mtime_nsec()),
            ctime_ns: timestamp(metadata.ctime(), metadata.ctime_nsec()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn executable(path: &Path, body: &[u8]) {
        fs::write(path, body).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn nonexecutables_and_nonabsolute_paths_remain_unknown() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("cli");
        fs::write(&file, b"data").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        for path in [
            temp.path(),
            file.as_path(),
            &temp.path().join("missing"),
            Path::new("cli"),
        ] {
            assert!(FileIdentity::capture(path).is_none());
        }
    }

    #[test]
    fn retained_snapshot_does_not_follow_same_path_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("cli");
        executable(&file, b"old");
        let retained = FileIdentity::capture(&file).unwrap();
        let serialized = serde_json::to_value(&retained).unwrap();
        let replacement = temp.path().join("replacement");
        executable(&replacement, b"new");
        fs::rename(&replacement, &file).unwrap();
        let discovered = FileIdentity::capture(&file).unwrap();
        assert_eq!(retained.realpath, discovered.realpath);
        assert_ne!(retained.ino, discovered.ino);
        assert_eq!(serde_json::to_value(retained).unwrap(), serialized);
    }

    #[test]
    fn retained_snapshot_does_not_follow_symlink_retargeting() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let alias = temp.path().join("cli");
        executable(&first, b"first");
        executable(&second, b"second");
        symlink(&first, &alias).unwrap();
        let retained = FileIdentity::capture(&alias).unwrap();
        fs::remove_file(&alias).unwrap();
        symlink(&second, &alias).unwrap();
        let discovered = FileIdentity::capture(&alias).unwrap();
        assert_ne!(retained.realpath, discovered.realpath);
        assert_eq!(
            retained.realpath,
            first.canonicalize().unwrap().to_str().unwrap()
        );
        assert_eq!(retained.path, discovered.path);
    }

    #[test]
    fn timestamp_and_numeric_fields_are_lossless_decimal_strings() {
        assert_eq!(timestamp(-1, 999_999_999), "-1");
        assert_eq!(timestamp(1_800_000_000, 123_456_789), "1800000000123456789");
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("cli");
        executable(&file, b"fake");
        let value = serde_json::to_value(FileIdentity::capture(&file).unwrap()).unwrap();
        for field in ["dev", "ino", "size", "mtimeNs", "ctimeNs"] {
            assert!(value[field].as_str().unwrap().parse::<i128>().is_ok());
        }
    }
}
