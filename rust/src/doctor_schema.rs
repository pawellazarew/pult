//! Owned schema scratch and the Node sorted-path/per-file SHA256 bundle.
use crate::{
    doctor_exec::{DiagnosticCommand, Executor},
    doctor_files,
    doctor_model::{Item, Text, redact},
    doctor_schema_tree::{Fault, Tree},
};
use anyhow::Result;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
const EXPECTED: &str = "495ecc09e89c6fa08112a6e4b283826a953e7a6a16d082e9ee425f1346d8f0af";
fn hash(tree: &Tree, cancel: &impl Fn() -> bool) -> Result<(String, usize), Fault> {
    tree.attached()?;
    let mut paths = tree.paths();
    paths.sort_by_cached_key(|p| p.to_string_lossy().encode_utf16().collect::<Vec<_>>());
    let mut bundle = Sha256::new();
    let mut bytes = 0u64;
    for path in &paths {
        if cancel() {
            return Err(Fault::Cancelled);
        }
        let body = tree.read(path)?;
        bytes = bytes
            .checked_add(body.len() as u64)
            .ok_or(Fault::ByteLimit)?;
        if bytes > 64 * 1024 * 1024 {
            return Err(Fault::ByteLimit);
        }
        if cancel() {
            return Err(Fault::Cancelled);
        }
        bundle
            .update(format!("{:x}  {}\n", Sha256::digest(body), path.to_string_lossy()).as_bytes());
    }
    tree.attached()?;
    Ok((format!("{:x}", bundle.finalize()), paths.len()))
}
pub(super) async fn check(root: &Path, bin: PathBuf, exec: &Executor, t: Text) -> Result<Item> {
    let run = doctor_files::private_dir(root, "run")?;
    let mut random = [0; 16];
    getrandom::fill(&mut random)
        .map_err(|_| anyhow::anyhow!("schema scratch randomness unavailable"))?;
    let name = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let dir = doctor_files::private_dir(&run, &format!("codex-schema-{name}"))?;
    let result = exec
        .run(DiagnosticCommand::Schema {
            bin,
            out: dir.clone(),
        })
        .await;
    let cancel = || *exec.cancel.borrow();
    let mut retained = None;
    let mut tree = None;
    let digest = if exec.cleanup_failed() {
        retained = Some("cleanup_unconfirmed");
        Err(anyhow::anyhow!("doctor child cleanup is unconfirmed"))
    } else {
        match result {
            Ok(r) if r.code == Some(0) => match Tree::scan(&dir, &cancel, false) {
                Ok(snapshot) => {
                    let digest = hash(&snapshot, &cancel);
                    tree = Some(snapshot);
                    match digest {
                        Ok((_, 0)) => Ok((
                            "unavailable",
                            None,
                            None,
                            "generate-json-schema не записал ни одного файла".to_owned(),
                            Some(0),
                        )),
                        Ok((actual, files)) => {
                            let state = if actual == EXPECTED { "ok" } else { "drift" };
                            let detail = if state == "ok" {
                                format!(
                                    "схема совпала со снятой 19.10.2026 ({files} файлов, codex 0.163.0-alpha.10.2)"
                                )
                            } else {
                                format!(
                                    "схема протокола РАЗОШЛАСЬ: {}… против {}… ({files} файлов против 318). Работать это не мешает, но форма сообщений могла измениться",
                                    &actual[..16],
                                    &EXPECTED[..16]
                                )
                            };
                            Ok((state, Some(actual), Some(files), detail, None))
                        }
                        Err(Fault::Cancelled) => Ok((
                            "unavailable",
                            None,
                            None,
                            "schema observation cancelled".to_owned(),
                            None,
                        )),
                        Err(fault) => {
                            retained = Some(fault.reason());
                            tree = None;
                            Ok((
                                "unavailable",
                                None,
                                None,
                                "schema observation unavailable".to_owned(),
                                None,
                            ))
                        }
                    }
                }
                Err(Fault::Cancelled) => {
                    match Tree::scan(&dir, &cancel, true) {
                        Ok(snapshot) => tree = Some(snapshot),
                        Err(fault) => retained = Some(fault.reason()),
                    };
                    Ok((
                        "unavailable",
                        None,
                        None,
                        "schema observation cancelled".to_owned(),
                        None,
                    ))
                }
                Err(fault) => {
                    retained = Some(fault.reason());
                    Ok((
                        "unavailable",
                        None,
                        None,
                        "schema observation unavailable".to_owned(),
                        None,
                    ))
                }
            },
            result => {
                // A failed/cancelled generator is joined, but its tree may be huge.
                // Cleanup requires a COMPLETE bounded manifest even on these paths.
                match Tree::scan(&dir, &cancel, true) {
                    Ok(snapshot) => tree = Some(snapshot),
                    Err(fault) => retained = Some(fault.reason()),
                };
                result.map(|r| {
                    let tail = redact(
                        if r.stderr.is_empty() {
                            &r.stdout
                        } else {
                            &r.stderr
                        }
                        .trim()
                        .split('\n')
                        .next()
                        .unwrap_or(""),
                    );
                    let code = r
                        .code
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "null".into());
                    (
                        "unavailable",
                        None,
                        None,
                        format!(
                            "generate-json-schema вышел с кодом {code}{}",
                            if tail.is_empty() {
                                String::new()
                            } else {
                                format!(": {tail}")
                            }
                        ),
                        None,
                    )
                })
            }
        }
    };
    if retained.is_none()
        && let Some(tree) = tree
        && let Err(fault) = tree.cleanup(&cancel)
    {
        retained = Some(fault.reason());
    }
    if retained.is_some() {
        exec.mark_schema_retained();
    }
    let (mut state, mut actual, mut files, mut detail, empty_files) = digest?;
    if retained.is_some() {
        state = "unavailable";
        actual = None;
        files = None;
        detail = if t.0 {
            "schema scratch retained: bounded inventory or cleanup was not completed"
        } else {
            "временный каталог схемы сохранён: ограниченная проверка или очистка не завершена"
        }
        .into();
    } else if empty_files == Some(0) {
        files = Some(0);
    }
    let mut item = t
        .item(
            "codex.schema",
            "Схема протокола codex",
            if state == "ok" { "ok" } else { "warn" },
            detail,
        )
        .data(json!({"expected":EXPECTED,"actual":actual,"files":files,"state":state}));
    if let Some(reason) = retained
        && let Some(data) = item.data.as_mut()
    {
        data["scratchRetained"] = json!(true);
        data["retainedReason"] = json!(reason);
    }
    if state == "drift" {
        item = item.fix(t.t("Если CLI обновился, переподключи его из Inbox или панели CLI Пульта. Если после этого есть ошибки протокола, обнови Пульт. Редактировать исходники и принимать новую схему вручную не нужно.", &[]));
    }
    Ok(item)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sorted_bundle_matches_node() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("b.json"), b"b").unwrap();
        std::fs::write(d.path().join("a.json"), b"a").unwrap();
        assert_eq!(
            hash(&Tree::scan(d.path(), &|| false, false).unwrap(), &|| false).unwrap(),
            (
                "42b8df7d402804294392835161e9f06653d83d1e1271435f2cc06292009fab90".into(),
                2
            )
        );
    }
}
