//! Stable, provider-independent memory identity for a registered working folder.
//!
//! Read Git's small pointer files instead of spawning Git: repository configuration,
//! hooks and process environment cannot execute code or change discovery. Malformed
//! metadata fails closed rather than creating a second, directory-scoped memory.
use anyhow::{Context, Result, ensure};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const META_MAX: u64 = 4096;

fn small_file(path: &Path) -> Result<String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .with_context(|| format!("cannot open Git metadata {}", path.display()))?;
    ensure!(
        file.metadata()?.is_file(),
        "Git metadata must be a regular file: {}",
        path.display()
    );
    let mut bytes = Vec::new();
    file.take(META_MAX + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= META_MAX,
        "Git metadata exceeds 4096 bytes: {}",
        path.display()
    );
    let value = String::from_utf8(bytes).context("Git metadata paths must be UTF-8")?;
    ensure!(!value.contains('\0'), "Git metadata contains NUL");
    Ok(value)
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("cannot inspect {}", path.display())),
    }
}

fn one_line(value: &str) -> Result<&str> {
    let value = value.trim_end_matches(['\r', '\n']);
    ensure!(
        !value.is_empty() && !value.contains(['\r', '\n']),
        "Git pointer must contain one nonempty path"
    );
    Ok(value)
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    let path = fs::canonicalize(path).with_context(|| {
        format!(
            "working directory or Git directory does not exist: {}",
            path.display()
        )
    })?;
    ensure!(
        path.is_dir(),
        "path must be an existing directory: {}",
        path.display()
    );
    ensure!(
        path.to_str().is_some(),
        "memory project paths must be UTF-8"
    );
    Ok(path)
}

fn joined(base: &Path, path: &str) -> PathBuf {
    base.join(path)
}

fn validate_repository(gitdir: &Path) -> Result<()> {
    ensure!(
        gitdir.join("objects").is_dir(),
        "Git common directory has no objects directory: {}",
        gitdir.display()
    );
    ensure!(
        gitdir.join("refs").is_dir() || gitdir.join("reftable").is_dir(),
        "Git common directory has no refs or reftable directory: {}",
        gitdir.display()
    );
    validate_head(gitdir)
}

fn validate_head(gitdir: &Path) -> Result<()> {
    let head = small_file(&gitdir.join("HEAD"))?;
    let head = one_line(&head)?;
    let symbolic = head
        .strip_prefix("ref: ")
        .is_some_and(|name| !name.is_empty());
    let detached = matches!(head.len(), 40 | 64) && head.bytes().all(|b| b.is_ascii_hexdigit());
    ensure!(
        symbolic || detached,
        "Git HEAD is malformed: {}",
        gitdir.display()
    );
    Ok(())
}

fn from_marker(marker: &Path) -> Result<PathBuf> {
    let metadata = fs::symlink_metadata(marker)?;
    ensure!(
        !metadata.file_type().is_symlink(),
        ".git metadata must not be a symlink: {}",
        marker.display()
    );
    let gitdir = if metadata.is_dir() {
        canonical_directory(marker)?
    } else {
        ensure!(
            metadata.is_file(),
            ".git metadata must be a directory or regular file"
        );
        let pointer = small_file(marker)?;
        let pointer = one_line(&pointer)?;
        let path = pointer
            .strip_prefix("gitdir: ")
            .context(".git pointer must start with 'gitdir: '")?;
        ensure!(!path.is_empty(), ".git pointer is empty");
        canonical_directory(&joined(
            marker.parent().context(".git has no parent")?,
            path,
        ))?
    };
    validate_head(&gitdir)?;
    let common_file = gitdir.join("commondir");
    let common = if exists(&common_file)? {
        let pointer = small_file(&common_file)?;
        let common = canonical_directory(&joined(&gitdir, one_line(&pointer)?))?;
        // This is Git's linked-worktree layout. The backlink prevents a forged
        // .git pointer in one folder from borrowing another worktree's identity.
        ensure!(
            gitdir.parent() == Some(common.join("worktrees").as_path()),
            "linked worktree Git directory has an unsupported layout"
        );
        let back = small_file(&gitdir.join("gitdir"))?;
        let target = fs::canonicalize(joined(&gitdir, one_line(&back)?))?;
        ensure!(
            target == fs::canonicalize(marker)?,
            "linked worktree backlink belongs to another folder"
        );
        common
    } else {
        gitdir
    };
    validate_repository(&common)?;
    Ok(common)
}

/// Git worktrees share the canonical common Git directory. Non-Git folders have
/// an exact canonical-directory identity. No environment variables affect this.
pub(crate) fn resolve(cwd: &Path) -> Result<String> {
    ensure!(
        cwd.is_absolute(),
        "memory working directory must be absolute"
    );
    let directory = canonical_directory(cwd)?;
    for ancestor in directory.ancestors() {
        let marker = ancestor.join(".git");
        if exists(&marker)? {
            let common = from_marker(&marker)?;
            return Ok(format!(
                "git:{}",
                common.to_str().context("Git directory must be UTF-8")?
            ));
        }
        // Bare repositories have no .git marker. These three independent
        // structural markers avoid mistaking a normal source folder for one.
        if exists(&ancestor.join("HEAD"))?
            && ancestor.join("objects").is_dir()
            && (ancestor.join("refs").is_dir() || ancestor.join("reftable").is_dir())
        {
            validate_repository(ancestor)?;
            return Ok(format!(
                "git:{}",
                ancestor.to_str().context("Git directory must be UTF-8")?
            ));
        }
    }
    Ok(format!(
        "dir:{}",
        directory.to_str().context("directory must be UTF-8")?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let result = Command::new("git")
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Memory fixture")
            .env("GIT_COMMITTER_NAME", "Memory fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git fixture launch");
        assert!(
            result.status.success(),
            "git fixture failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn main_repository_linked_worktree_and_subfolders_share_memory() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let worktree = temp.path().join("linked");
        fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "fixture"]);
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fixture-linked",
                worktree.to_str().unwrap(),
            ],
        );
        let nested = worktree.join("nested");
        fs::create_dir(&nested).unwrap();
        let expected = format!(
            "git:{}",
            fs::canonicalize(repo.join(".git")).unwrap().display()
        );
        assert_eq!(resolve(&repo).unwrap(), expected);
        assert_eq!(resolve(&worktree).unwrap(), expected);
        assert_eq!(resolve(&nested).unwrap(), expected);
    }

    #[test]
    fn non_git_folders_use_exact_canonical_identity_and_aliases_do_not_split_it() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("plain");
        let child = dir.join("child");
        let alias = temp.path().join("alias");
        fs::create_dir_all(&child).unwrap();
        symlink(&dir, &alias).unwrap();
        let expected = format!("dir:{}", fs::canonicalize(&dir).unwrap().display());
        assert_eq!(resolve(&dir).unwrap(), expected);
        assert_eq!(resolve(&alias).unwrap(), expected);
        assert_ne!(resolve(&child).unwrap(), expected);
        assert!(resolve(&temp.path().join("missing")).is_err());
        assert!(resolve(Path::new("relative")).is_err());
    }

    #[test]
    fn separate_git_directory_and_bare_repository_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let common = temp.path().join("separate.git");
        fs::create_dir(&repo).unwrap();
        git(
            &repo,
            &["init", "-q", "--separate-git-dir", common.to_str().unwrap()],
        );
        assert_eq!(
            resolve(&repo).unwrap(),
            format!("git:{}", fs::canonicalize(&common).unwrap().display())
        );
        let bare = temp.path().join("bare.git");
        git(
            temp.path(),
            &["init", "--bare", "-q", bare.to_str().unwrap()],
        );
        assert_eq!(
            resolve(&bare).unwrap(),
            format!("git:{}", fs::canonicalize(&bare).unwrap().display())
        );
    }

    #[test]
    fn malformed_symlinked_or_oversized_git_metadata_fails_instead_of_changing_scope() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        fs::create_dir(&repo).unwrap();
        fs::write(repo.join(".git"), "not a Git pointer").unwrap();
        assert!(resolve(&repo).is_err());
        fs::write(
            repo.join(".git"),
            format!("gitdir: {}", "x".repeat(META_MAX as usize)),
        )
        .unwrap();
        assert!(resolve(&repo).is_err());
        fs::remove_file(repo.join(".git")).unwrap();
        let target = temp.path().join("pointer");
        fs::write(&target, "gitdir: nowhere").unwrap();
        symlink(&target, repo.join(".git")).unwrap();
        assert!(resolve(&repo).is_err());
    }

    #[test]
    fn source_folders_do_not_become_bare_repositories_from_one_git_like_file() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("source");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("HEAD"), "ordinary fixture content").unwrap();
        fs::create_dir(dir.join("objects")).unwrap();
        assert!(resolve(&dir).unwrap().starts_with("dir:"));
    }

    #[test]
    fn nested_repositories_keep_independent_project_scopes() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("parent");
        let nested = repo.join("nested");
        fs::create_dir_all(&nested).unwrap();
        git(&repo, &["init", "-q"]);
        git(&nested, &["init", "-q"]);
        assert_ne!(resolve(&repo).unwrap(), resolve(&nested).unwrap());
        assert_eq!(
            resolve(&nested).unwrap(),
            format!(
                "git:{}",
                fs::canonicalize(nested.join(".git")).unwrap().display()
            )
        );
    }

    #[test]
    fn non_utf8_paths_are_not_collapsed_to_a_lossy_project_identifier() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join(OsString::from_vec(vec![b'p', 0xff]));
        match fs::create_dir(&dir) {
            Ok(()) => {}
            // APFS rejects non-UTF-8 names before they can reach our resolver.
            Err(error) if error.raw_os_error() == Some(nix::libc::EILSEQ) => {
                assert!(resolve(&dir).is_err());
                return;
            }
            Err(error) => panic!("cannot create non-UTF-8 path fixture: {error}"),
        }
        assert!(resolve(&dir).is_err());
    }

    #[test]
    fn forged_linked_worktree_pointer_cannot_borrow_another_folder_identity() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let worktree = temp.path().join("linked");
        let impostor = temp.path().join("impostor");
        fs::create_dir(&repo).unwrap();
        fs::create_dir(&impostor).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "fixture"]);
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "fixture-linked",
                worktree.to_str().unwrap(),
            ],
        );
        fs::copy(worktree.join(".git"), impostor.join(".git")).unwrap();
        assert!(resolve(&impostor).is_err());
    }
}
