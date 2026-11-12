use pult_core::prompt_attachments::*;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
};
const PNG: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10];
fn file(home: &Path, name: &str, bytes: &[u8], mime: &str) -> Value {
    let path = home.join("attachments/alpha/day").join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    json!({"path":path.to_str().unwrap(),"name":name,"bytes":bytes.len(),"mime":mime,"kind":"file"})
}
fn checked(home: &Path, raw: &Value) -> Vec<PromptAttachment> {
    validate_owned_prompt_attachments(home, "alpha", Some(raw)).unwrap()
}
#[test]
fn validates_owned_metadata_and_preserves_wire_fields() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "notes.txt", b"hi", "text/plain");
    assert!(
        validate_owned_prompt_attachments(home.path(), "alpha", None)
            .unwrap()
            .is_empty()
    );
    let data = checked(home.path(), &json!([a]));
    assert_eq!(data[0].value(), a);
    assert!(owned_prompt_attachment(
        home.path(),
        "alpha",
        Path::new(a["path"].as_str().unwrap())
    ));
}
#[test]
fn rejects_other_session_depth_and_traversal() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "notes.txt", b"hi", "text/plain");
    let path = Path::new(a["path"].as_str().unwrap());
    assert!(!owned_prompt_attachment(home.path(), "beta", path));
    for session in [
        "",
        "A",
        "alpha/../alpha",
        "a012345678901234567890123456789012",
    ] {
        assert!(!owned_prompt_attachment(home.path(), session, path));
    }
    let shallow = home.path().join("attachments/alpha/file");
    fs::write(&shallow, b"x").unwrap();
    let deep = home.path().join("attachments/alpha/day/sub/file");
    fs::create_dir_all(deep.parent().unwrap()).unwrap();
    fs::write(&deep, b"x").unwrap();
    assert!(!owned_prompt_attachment(home.path(), "alpha", &shallow));
    assert!(!owned_prompt_attachment(home.path(), "alpha", &deep));
    assert!(!owned_prompt_attachment(
        home.path(),
        "alpha",
        &home.path().join("attachments/alpha/day/../../alpha/file")
    ));
}
#[test]
fn rejects_symlink_at_every_attachment_level_and_file() {
    for component in [
        "attachments",
        "attachments/alpha",
        "attachments/alpha/day",
        "attachments/alpha/day/image.png",
    ] {
        let home = tempfile::tempdir().unwrap();
        let a = file(home.path(), "image.png", PNG, "image/png");
        let source = PathBuf::from(a["path"].as_str().unwrap());
        let link = home.path().join(component);
        let moved = home.path().join("moved");
        fs::rename(&link, &moved).unwrap();
        symlink(&moved, &link).unwrap();
        assert!(!owned_prompt_attachment(home.path(), "alpha", &source));
        assert_eq!(
            validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([a]))),
            Err(AttachmentError::Unavailable)
        );
    }
}
#[test]
fn accepts_home_symlink_alias_like_node() {
    let outer = tempfile::tempdir().unwrap();
    let real = outer.path().join("real");
    fs::create_dir(&real).unwrap();
    let alias = outer.path().join("alias");
    symlink(&real, &alias).unwrap();
    let a = file(&alias, "image.png", PNG, "image/png");
    assert_eq!(checked(&alias, &json!([a])).len(), 1);
}
#[test]
fn directories_are_explicit_external_references_and_never_native_images() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let mut a = json!({"path":outside.path().to_str().unwrap(),"name":"directory","bytes":0,"mime":"inode/directory","kind":"directory"});
    let refs = checked(home.path(), &json!([a]));
    assert!(!is_native_prompt_image(&refs[0]));
    let scope = PromptAttachmentScope {
        home: home.path(),
        session_id: "alpha",
    };
    assert_eq!(
        codex_prompt_input(&scope, "", &refs).unwrap()[0]["type"],
        "text"
    );
    for (key, value) in [("bytes", json!(1)), ("mime", json!("image/png"))] {
        let mut bad = a.clone();
        bad[key] = value;
        assert!(
            validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([bad]))).is_err()
        );
    }
    let link = home.path().join("dirlink");
    symlink(outside.path(), &link).unwrap();
    a["path"] = json!(link);
    assert!(validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([a]))).is_err());
}
#[test]
fn maximum_count_is_twenty_and_per_file_limit_is_twenty_five_mib() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "file", b"x", "text/plain");
    assert_eq!(checked(home.path(), &json!(vec![a.clone(); 20])).len(), 20);
    assert_eq!(
        validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!(vec![a.clone(); 21]))),
        Err(AttachmentError::TooMany)
    );
    let path = PathBuf::from(a["path"].as_str().unwrap());
    let f = fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_len(MAX_PROMPT_ATTACHMENT_BYTES).unwrap();
    let mut at_limit = a.clone();
    at_limit["bytes"] = json!(MAX_PROMPT_ATTACHMENT_BYTES);
    assert_eq!(checked(home.path(), &json!([at_limit])).len(), 1);
    let mut too_large = a;
    too_large["bytes"] = json!(MAX_PROMPT_ATTACHMENT_BYTES + 1);
    assert_eq!(
        validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([too_large]))),
        Err(AttachmentError::InvalidMetadata)
    );
}
#[test]
fn metadata_limits_count_utf16_and_use_javascript_whitespace() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "file", b"x", "text/plain");
    let mut good = a.clone();
    good["name"] = json!("🌊".repeat(256));
    good["mime"] = json!("🌊".repeat(64));
    assert_eq!(checked(home.path(), &json!([good])).len(), 1);
    for (key, value) in [
        ("name", json!("🌊".repeat(257))),
        ("mime", json!("🌊".repeat(65))),
        ("name", json!("\u{feff} \t")),
        ("path", json!(format!("/{}", "🌊".repeat(8192)))),
    ] {
        let mut bad = a.clone();
        bad[key] = value;
        assert_eq!(
            validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([bad]))),
            Err(AttachmentError::InvalidMetadata)
        );
    }
    let mut node_nonspace = a;
    node_nonspace["name"] = json!("\u{0085}");
    assert_eq!(checked(home.path(), &json!([node_nonspace])).len(), 1);
}
#[test]
fn malformed_scalars_and_control_characters_fail_closed() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "file", b"x", "text/plain");
    for (key, value) in [
        ("path", json!("relative")),
        ("path", json!("/bad\0path")),
        ("name", json!("line\nname")),
        ("name", json!("")),
        ("mime", json!("")),
        ("bytes", json!(-1)),
        ("bytes", json!(1.5)),
        ("bytes", json!("1")),
        ("kind", json!(["file"])),
    ] {
        let mut bad = a.clone();
        bad[key] = value;
        assert_eq!(
            validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([bad]))),
            Err(AttachmentError::InvalidMetadata)
        );
    }
    assert_eq!(
        validate_owned_prompt_attachments(home.path(), "alpha", Some(&Value::Null)),
        Err(AttachmentError::TooMany)
    );
    assert_eq!(
        validate_owned_prompt_attachments(home.path(), "alpha", Some(&json!([null]))),
        Err(AttachmentError::InvalidMetadata)
    );
}
#[test]
fn prompt_context_matches_russian_and_json_string_escaping() {
    let home = tempfile::tempdir().unwrap();
    let text = file(
        home.path(),
        "quote\"back\\tab\t🌊\u{2028}.txt",
        b"x",
        "text/plain",
    );
    let image = file(home.path(), "image.png", PNG, "image/png");
    let refs = checked(home.path(), &json!([text, image]));
    let quoted = serde_json::to_string(&refs[0].path).unwrap();
    assert_eq!(
        prompt_attachment_context("hello", &refs, false),
        format!("hello\n\nПрикреплённые файлы:\n- {quoted}")
    );
    assert_eq!(prompt_attachment_context("", &[], false), "");
    assert_eq!(prompt_attachment_context("hello", &[], false), "hello");
    assert!(prompt_attachment_context("", &refs, true).contains("image.png"));
}
#[test]
fn native_mime_magic_matches_node_and_rejects_spoofed_extensions() {
    for (bytes, mime) in [
        (PNG, "image/png"),
        (&[255, 216, 255][..], "image/jpeg"),
        (&b"GIF87a"[..], "image/gif"),
        (&b"GIF89a"[..], "image/gif"),
        (&b"RIFF1234WEBP"[..], "image/webp"),
    ] {
        assert_eq!(image_mime(bytes), Some(mime));
    }
    assert_eq!(image_mime(b"<svg>"), None);
    assert_eq!(image_mime(&PNG[..7]), None);
    // Node Buffer.toString('ascii') masks the high bit for GIF/WebP.
    assert_eq!(
        image_mime(&b"GIF89a".iter().map(|b| b | 128).collect::<Vec<_>>()),
        Some("image/gif")
    );
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "fake.png", b"<html>", "image/png");
    let refs = checked(home.path(), &json!([a]));
    let scope = PromptAttachmentScope {
        home: home.path(),
        session_id: "alpha",
    };
    assert_eq!(
        codex_prompt_input(&scope, "", &refs),
        Err(AttachmentError::ImageFormat)
    );
}
#[test]
fn codex_inputs_are_text_then_local_images_and_claude_images_then_context() {
    let home = tempfile::tempdir().unwrap();
    let image = file(home.path(), "image.png", PNG, "image/png");
    let text = file(home.path(), "notes.txt", b"hi", "text/plain");
    let refs = checked(home.path(), &json!([image, text]));
    let scope = PromptAttachmentScope {
        home: home.path(),
        session_id: "alpha",
    };
    let codex = codex_prompt_input(&scope, "look", &refs).unwrap();
    assert_eq!(codex.len(), 2);
    assert_eq!(codex[0]["type"], "text");
    assert_eq!(codex[1], json!({"type":"localImage","path":refs[0].path}));
    let claude = claude_prompt_attachment_blocks(&scope, &refs).unwrap();
    assert_eq!(
        claude[0],
        json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}})
    );
    assert_eq!(claude[1]["type"], "text");
    assert!(!refs[0].value().to_string().contains("iVBOR"));
}
#[test]
fn builder_revalidates_changed_files_and_rejects_empty_native_image() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "image.png", PNG, "image/png");
    let refs = checked(home.path(), &json!([a]));
    fs::write(&refs[0].path, b"short").unwrap();
    let scope = PromptAttachmentScope {
        home: home.path(),
        session_id: "alpha",
    };
    assert_eq!(
        codex_prompt_input(&scope, "", &refs),
        Err(AttachmentError::Unavailable)
    );
    let empty = file(home.path(), "empty.png", b"", "image/png");
    let refs = checked(home.path(), &json!([empty]));
    assert_eq!(
        claude_prompt_attachment_blocks(&scope, &refs),
        Err(AttachmentError::ImageUnavailable)
    );
}
#[test]
fn fifo_is_rejected_without_opening_or_blocking() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("attachments/alpha/day/fifo");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(&path)
            .status()
            .unwrap()
            .success()
    );
    let raw = json!([{"path":path,"name":"fifo","bytes":0,"mime":"image/png","kind":"file"}]);
    assert_eq!(
        validate_owned_prompt_attachments(home.path(), "alpha", Some(&raw)),
        Err(AttachmentError::Unavailable)
    );
}
#[test]
fn metadata_debug_and_errors_do_not_expose_paths_names_or_mime() {
    let home = tempfile::tempdir().unwrap();
    let a = file(home.path(), "NAME_SECRET", b"x", "MIME_SECRET");
    let refs = checked(home.path(), &json!([a]));
    let debug = format!("{:?}", refs[0]);
    for secret in [home.path().to_str().unwrap(), "NAME_SECRET", "MIME_SECRET"] {
        assert!(!debug.contains(secret));
        for error in [
            AttachmentError::InvalidMetadata,
            AttachmentError::Unavailable,
            AttachmentError::ImageChanged,
        ] {
            assert!(!error.to_string().contains(secret));
        }
    }
}
