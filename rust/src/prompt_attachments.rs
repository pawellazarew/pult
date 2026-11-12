//! Owned prompt attachment metadata and provider-only prompt material. Image
//! bytes are read only for provider input; metadata never contains image bytes.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

pub const MAX_PROMPT_ATTACHMENTS: usize = 20;
pub const MAX_PROMPT_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttachmentKind {
    File,
    Directory,
}
impl AttachmentKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PromptAttachment {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub mime: String,
    pub kind: AttachmentKind,
}
impl std::fmt::Debug for PromptAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptAttachment")
            .field("path_units", &self.path.encode_utf16().count())
            .field("name_units", &self.name.encode_utf16().count())
            .field("bytes", &self.bytes)
            .field("mime_units", &self.mime.encode_utf16().count())
            .field("kind", &self.kind)
            .finish()
    }
}
impl PromptAttachment {
    pub fn value(&self) -> Value {
        json!({"path":self.path,"name":self.name,"bytes":self.bytes,"mime":self.mime,"kind":self.kind.as_str()})
    }
}
pub struct PromptAttachmentScope<'a> {
    pub home: &'a Path,
    pub session_id: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AttachmentError {
    TooMany,
    InvalidMetadata,
    Unavailable,
    ImageUnavailable,
    ImageChanged,
    ImageFormat,
}
impl std::fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooMany => "attach no more than 20 files",
            Self::InvalidMetadata => "invalid attachment metadata",
            Self::Unavailable => "attachment is unavailable or changed",
            Self::ImageUnavailable => "image is unavailable or changed",
            Self::ImageChanged => "image changed; attach it again",
            Self::ImageFormat => "image format does not match its contents",
        })
    }
}
impl std::error::Error for AttachmentError {}
type Result<T> = std::result::Result<T, AttachmentError>;

fn session_valid(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'-'))
}
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
/// Ownership is the Node path boundary, not filesystem UID ownership. A home
/// alias may be a symlink; attachments/session/day and the file may not be.
pub fn owned_prompt_attachment(home: &Path, session_id: &str, source: &Path) -> bool {
    if !session_valid(session_id)
        || !home.is_absolute()
        || !source.is_absolute()
        || source.as_os_str().as_encoded_bytes().contains(&0)
    {
        return false;
    }
    let root = lexical(&home.join("attachments").join(session_id));
    let source_normal = lexical(source);
    let Ok(relative) = source_normal.strip_prefix(&root) else {
        return false;
    };
    if relative.as_os_str().is_empty()
        || relative.as_os_str().as_encoded_bytes().starts_with(b"..")
        || relative.components().count() != 2
    {
        return false;
    }
    let Some(day) = source.parent() else {
        return false;
    };
    for dir in [
        home.join("attachments"),
        home.join("attachments").join(session_id),
        day.to_path_buf(),
    ] {
        if !fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
            return false;
        }
    }
    if !fs::symlink_metadata(source).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
        return false;
    }
    match (source.canonicalize(), home.canonicalize()) {
        (Ok(file), Ok(home)) => file == home.join("attachments").join(session_id).join(relative),
        _ => false,
    }
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn forbidden(s: &str) -> bool {
    s.contains(['\0', '\r', '\n'])
}

pub fn validate_owned_prompt_attachments(
    home: &Path,
    session_id: &str,
    raw: Option<&Value>,
) -> Result<Vec<PromptAttachment>> {
    let Some(raw) = raw else {
        return Ok(vec![]);
    };
    let list = raw
        .as_array()
        .filter(|a| a.len() <= MAX_PROMPT_ATTACHMENTS)
        .ok_or(AttachmentError::TooMany)?;
    list.iter()
        .map(|v| {
            let string = |key| {
                v.get(key)
                    .and_then(Value::as_str)
                    .ok_or(AttachmentError::InvalidMetadata)
            };
            let path = string("path")?;
            let name = string("name")?;
            let mime = string("mime")?;
            let bytes = v
                .get("bytes")
                .and_then(Value::as_f64)
                .filter(|n| {
                    n.is_finite()
                        && n.fract() == 0.0
                        && *n >= 0.0
                        && *n <= MAX_PROMPT_ATTACHMENT_BYTES as f64
                })
                .ok_or(AttachmentError::InvalidMetadata)? as u64;
            let kind = match string("kind")? {
                "file" => AttachmentKind::File,
                "directory" => AttachmentKind::Directory,
                _ => return Err(AttachmentError::InvalidMetadata),
            };
            if !Path::new(path).is_absolute()
                || forbidden(path)
                || path.encode_utf16().count() > 16_384
                || name.trim_matches(js_space).is_empty()
                || forbidden(name)
                || name.encode_utf16().count() > 512
                || mime.is_empty()
                || mime.encode_utf16().count() > 128
            {
                return Err(AttachmentError::InvalidMetadata);
            }
            let m = fs::symlink_metadata(path).map_err(|_| AttachmentError::Unavailable)?;
            let valid = match kind {
                AttachmentKind::Directory => {
                    m.is_dir()
                        && !m.file_type().is_symlink()
                        && bytes == 0
                        && mime == "inode/directory"
                }
                AttachmentKind::File => {
                    m.is_file()
                        && m.len() == bytes
                        && owned_prompt_attachment(home, session_id, Path::new(path))
                }
            };
            if !valid {
                return Err(AttachmentError::Unavailable);
            }
            Ok(PromptAttachment {
                path: path.into(),
                name: name.into(),
                bytes,
                mime: mime.into(),
                kind,
            })
        })
        .collect()
}
pub fn is_native_prompt_image(a: &PromptAttachment) -> bool {
    a.kind == AttachmentKind::File
        && matches!(
            a.mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        )
}
pub fn prompt_attachment_context(
    text: &str,
    attachments: &[PromptAttachment],
    include_images: bool,
) -> String {
    let refs: Vec<_> = attachments
        .iter()
        .filter(|a| include_images || !is_native_prompt_image(a))
        .map(|a| {
            format!(
                "- {}",
                crate::history::encode_string(&a.path.encode_utf16().collect::<Vec<_>>())
            )
        })
        .collect();
    if refs.is_empty() {
        return text.into();
    }
    let context = format!("Прикреплённые файлы:\n{}", refs.join("\n"));
    if text.is_empty() {
        context
    } else {
        format!("{text}\n\n{context}")
    }
}
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        Some("image/png")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Some("image/jpeg")
    } else if bytes.len() >= 6
        && (bytes[..6]
            .iter()
            .map(|b| b & 0x7f)
            .eq(b"GIF87a".iter().copied())
            || bytes[..6]
                .iter()
                .map(|b| b & 0x7f)
                .eq(b"GIF89a".iter().copied()))
    {
        Some("image/gif")
    } else if bytes.len() >= 12
        && bytes[..4]
            .iter()
            .map(|b| b & 0x7f)
            .eq(b"RIFF".iter().copied())
        && bytes[8..12]
            .iter()
            .map(|b| b & 0x7f)
            .eq(b"WEBP".iter().copied())
    {
        Some("image/webp")
    } else {
        None
    }
}
fn image_bytes(scope: &PromptAttachmentScope<'_>, a: &PromptAttachment) -> Result<Vec<u8>> {
    image_bytes_with(scope, a, || {})
}
fn image_bytes_with(
    scope: &PromptAttachmentScope<'_>,
    a: &PromptAttachment,
    before_read: impl FnOnce(),
) -> Result<Vec<u8>> {
    if !owned_prompt_attachment(scope.home, scope.session_id, Path::new(&a.path)) {
        return Err(AttachmentError::Unavailable);
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&a.path)
        .map_err(|_| AttachmentError::ImageUnavailable)?;
    let stat = file
        .metadata()
        .map_err(|_| AttachmentError::ImageUnavailable)?;
    if !stat.is_file()
        || stat.len() != a.bytes
        || stat.len() == 0
        || stat.len() > MAX_PROMPT_ATTACHMENT_BYTES
    {
        return Err(AttachmentError::ImageUnavailable);
    }
    before_read();
    let mut bytes = Vec::new();
    (&mut file)
        .take(stat.len() + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AttachmentError::ImageChanged)?;
    if bytes.len() as u64 != stat.len() {
        return Err(AttachmentError::ImageChanged);
    }
    if image_mime(&bytes) != Some(a.mime.as_str()) {
        return Err(AttachmentError::ImageFormat);
    }
    Ok(bytes)
}
fn revalidate(
    scope: &PromptAttachmentScope<'_>,
    attachments: &[PromptAttachment],
) -> Result<Vec<PromptAttachment>> {
    validate_owned_prompt_attachments(
        scope.home,
        scope.session_id,
        Some(&Value::Array(
            attachments.iter().map(PromptAttachment::value).collect(),
        )),
    )
}
pub fn codex_prompt_input(
    scope: &PromptAttachmentScope<'_>,
    text: &str,
    attachments: &[PromptAttachment],
) -> Result<Vec<Value>> {
    let checked = revalidate(scope, attachments)?;
    let mut input = Vec::new();
    let context = prompt_attachment_context(text, &checked, false);
    if !context.is_empty() {
        input.push(json!({"type":"text","text":context}));
    }
    for a in checked.iter().filter(|a| is_native_prompt_image(a)) {
        image_bytes(scope, a)?;
        input.push(json!({"type":"localImage","path":a.path}));
    }
    Ok(input)
}
pub fn claude_prompt_attachment_blocks(
    scope: &PromptAttachmentScope<'_>,
    attachments: &[PromptAttachment],
) -> Result<Vec<Value>> {
    let checked = revalidate(scope, attachments)?;
    let mut blocks = Vec::new();
    for a in checked.iter().filter(|a| is_native_prompt_image(a)) {
        blocks.push(json!({"type":"image","source":{"type":"base64","media_type":a.mime,"data":STANDARD.encode(image_bytes(scope,a)? )}}));
    }
    let context = prompt_attachment_context("", &checked, false);
    if !context.is_empty() {
        blocks.push(json!({"type":"text","text":context}));
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_read_detects_growth_and_shrink_after_fstat() {
        for replacement in [vec![137, 80, 78, 71, 13, 10, 26, 10, 1], vec![137]] {
            let home = tempfile::tempdir().unwrap();
            let path = home.path().join("attachments/alpha/day/image.png");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, [137, 80, 78, 71, 13, 10, 26, 10]).unwrap();
            let a = PromptAttachment {
                path: path.to_str().unwrap().into(),
                name: "image.png".into(),
                bytes: 8,
                mime: "image/png".into(),
                kind: AttachmentKind::File,
            };
            let scope = PromptAttachmentScope {
                home: home.path(),
                session_id: "alpha",
            };
            assert_eq!(
                image_bytes_with(&scope, &a, || fs::write(&path, replacement).unwrap()),
                Err(AttachmentError::ImageChanged)
            );
        }
    }
}
