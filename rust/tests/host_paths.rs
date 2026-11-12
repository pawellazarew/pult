//! Real filesystem parity cases from general-chat.test.ts and sessions.test.ts.
use pult_core::host_paths::{covers_pult_home, validate_general};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use tempfile::{TempDir, tempdir};

fn directory(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn fixture() -> (TempDir, PathBuf, PathBuf) {
    let scratch = tempdir().unwrap();
    let home = scratch.path().join("home");
    let root = home.join("conversations");
    let cwd = root.join("chat-aB012Z");
    directory(&home);
    directory(&root);
    directory(&cwd);
    (scratch, home, cwd)
}

#[test]
fn home_self_and_ancestors_cover_but_children_and_siblings_do_not() {
    let (scratch, home, cwd) = fixture();
    assert!(covers_pult_home(&home, &home).unwrap());
    assert!(covers_pult_home(scratch.path(), &home).unwrap());
    assert!(covers_pult_home(Path::new("/"), &home).unwrap());
    assert!(!covers_pult_home(&cwd, &home).unwrap());
    assert!(!covers_pult_home(&home.join("..x"), &home).unwrap());
    assert!(!covers_pult_home(&scratch.path().join("home-other"), &home).unwrap());
}

#[test]
fn dotdot_named_component_is_not_a_parent_component() {
    let scratch = tempdir().unwrap();
    let parent = scratch.path().join("..x");
    let home = parent.join("home");
    directory(&home);
    assert!(covers_pult_home(&parent, &home).unwrap());
    assert!(covers_pult_home(scratch.path(), &home).unwrap());
    assert!(!covers_pult_home(&scratch.path().join("..y"), &home).unwrap());
}

#[test]
fn existing_aliases_resolve_before_ancestor_comparison() {
    let (scratch, home, _) = fixture();
    let alias = scratch.path().join("alias");
    symlink(&home, &alias).unwrap();
    assert!(covers_pult_home(&alias, &home).unwrap());
    assert!(covers_pult_home(&home, &alias).unwrap());
    let ancestor_alias = scratch.path().join("parent-alias");
    symlink(scratch.path(), &ancestor_alias).unwrap();
    assert!(covers_pult_home(&ancestor_alias, &home).unwrap());
}

#[test]
fn unavailable_paths_use_lexical_absolute_fallback() {
    let scratch = tempdir().unwrap();
    let missing = scratch.path().join("missing");
    assert!(covers_pult_home(&missing, &missing.join("home")).unwrap());
    assert!(covers_pult_home(&missing.join("a/.."), &missing.join("home")).unwrap());
    assert!(!covers_pult_home(&missing.join("home-other"), &missing.join("home")).unwrap());
    let loop_path = scratch.path().join("loop");
    symlink(&loop_path, &loop_path).unwrap();
    assert!(covers_pult_home(&loop_path, &loop_path.join("home")).unwrap());
}

#[test]
fn relative_inputs_are_rejected_without_resolving_process_cwd() {
    let (_scratch, home, cwd) = fixture();
    assert!(covers_pult_home(Path::new("."), &home).is_err());
    assert!(covers_pult_home(&cwd, Path::new("home")).is_err());
    assert!(validate_general(Path::new("home"), "chat", &cwd).is_err());
    assert!(validate_general(&home, "chat", Path::new("chat-aB012Z")).is_err());
}

#[test]
fn restored_owned_workspace_and_home_alias_are_accepted() {
    let (scratch, home, cwd) = fixture();
    validate_general(&home, "chat", &cwd).unwrap();
    validate_general(&home, "chat", &cwd).unwrap();
    validate_general(&fs::canonicalize(&home).unwrap(), "chat", &cwd).unwrap();
    let alias = scratch.path().join("home-alias");
    symlink(&home, &alias).unwrap();
    validate_general(&alias, "chat", &alias.join("conversations/chat-aB012Z")).unwrap();
}

#[test]
fn foreign_session_and_invalid_names_are_rejected() {
    let (_scratch, home, cwd) = fixture();
    for name in ["other", "../chat", "Chat", "", "chat/evil"] {
        assert!(validate_general(&home, name, &cwd).is_err());
    }
}

#[test]
fn suffix_requires_exactly_six_ascii_alphanumeric_characters() {
    let (_scratch, home, _) = fixture();
    for leaf in [
        "chat-12345",
        "chat-1234567",
        "chat-12345_",
        "chat-12345é",
        "chat-12345 ",
        "chatty-123456",
    ] {
        let cwd = home.join("conversations").join(leaf);
        directory(&cwd);
        assert!(validate_general(&home, "chat", &cwd).is_err());
    }
}

#[test]
fn traversal_to_foreign_location_and_nested_workspace_are_rejected() {
    let (scratch, home, cwd) = fixture();
    let foreign = scratch.path().join("chat-aB012Z");
    directory(&foreign);
    let traversal = home.join("conversations/../../chat-aB012Z");
    assert!(validate_general(&home, "chat", &traversal).is_err());
    let nested = cwd.join("chat-aB012Z");
    directory(&nested);
    assert!(validate_general(&home, "chat", &nested).is_err());
}

#[test]
fn root_symlink_is_rejected_even_if_child_is_real() {
    let (scratch, home, cwd) = fixture();
    let root = home.join("conversations");
    let moved = scratch.path().join("moved");
    fs::rename(&root, &moved).unwrap();
    symlink(&moved, &root).unwrap();
    assert!(validate_general(&home, "chat", &cwd).is_err());
}

#[test]
fn workspace_symlink_is_rejected_even_if_target_is_owned() {
    let (_scratch, home, cwd) = fixture();
    let moved = home.join("conversations/chat-Z012ab");
    fs::rename(&cwd, &moved).unwrap();
    symlink(&moved, &cwd).unwrap();
    assert!(validate_general(&home, "chat", &cwd).is_err());
    validate_general(&home, "chat", &moved).unwrap();
}

#[test]
fn missing_and_regular_file_workspaces_fail_closed_without_creating() {
    let (_scratch, home, cwd) = fixture();
    fs::remove_dir(&cwd).unwrap();
    assert!(validate_general(&home, "chat", &cwd).is_err());
    assert!(!cwd.exists());
    fs::write(&cwd, b"file").unwrap();
    assert!(validate_general(&home, "chat", &cwd).is_err());
}

#[test]
fn managed_directories_require_0700_without_chmod_side_effects() {
    let (_scratch, home, cwd) = fixture();
    for path in [&cwd, &home.join("conversations")] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(validate_general(&home, "chat", &cwd).is_err());
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755
        );
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    validate_general(&home, "chat", &cwd).unwrap();
}

#[test]
fn path_separators_match_node_basename_and_dirname_rules() {
    let (_scratch, home, cwd) = fixture();
    validate_general(
        &home,
        "chat",
        &PathBuf::from(format!("{}///", cwd.display())),
    )
    .unwrap();
    assert!(validate_general(&home, "chat", &cwd.join(".")).is_err());
    assert!(validate_general(&home, "chat", Path::new("/")).is_err());
}

#[test]
fn errors_do_not_disclose_paths_or_untrusted_session_names() {
    let (_scratch, home, cwd) = fixture();
    let error = validate_general(&home, "secret-untrusted-name", &cwd).unwrap_err();
    let rendered = format!("{error:?}");
    assert!(!rendered.contains("secret-untrusted-name"));
    assert!(!rendered.contains(&home.to_string_lossy().to_string()));
}
