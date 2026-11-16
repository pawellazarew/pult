//! Owned schema scratch and the Node sorted-path/per-file SHA256 bundle.
use crate::{
    doctor_exec::{DiagnosticCommand, Executor},
    doctor_files,
    doctor_model::{Item, Text, redact},
};
use anyhow::{Result, ensure};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
const EXPECTED: &str = "495ecc09e89c6fa08112a6e4b283826a953e7a6a16d082e9ee425f1346d8f0af";
fn hash(dir: &Path) -> Result<(String, usize)> {
    fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<PathBuf>) -> Result<()> {
        ensure!(depth <= 32, "schema depth exceeds limit");
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            let kind = e.file_type()?;
            if kind.is_dir() {
                walk(root, &e.path(), depth + 1, out)?
            } else if kind.is_file() {
                out.push(e.path().strip_prefix(root)?.to_owned());
                ensure!(out.len() <= 8192, "schema file count exceeds limit");
            }
        }
        Ok(())
    }
    let mut paths = vec![];
    walk(dir, dir, 0, &mut paths)?;
    paths.sort_by_cached_key(|p| p.to_string_lossy().encode_utf16().collect::<Vec<_>>());
    let mut bundle = Sha256::new();
    let mut total = 0;
    for path in &paths {
        let s = std::fs::symlink_metadata(dir.join(path))?;
        ensure!(
            s.is_file() && s.len() <= 8 * 1024 * 1024,
            "schema file exceeds limit"
        );
        total += s.len();
        ensure!(total <= 64 * 1024 * 1024, "schema bundle exceeds limit");
        let body = crate::cli_client::owner_private_file::read(
            dir,
            path,
            8 * 1024 * 1024,
            crate::cli_client::owner_private_file::Policy {
                private_config: false,
            },
        )?
        .ok_or_else(|| anyhow::anyhow!("schema file vanished"))?;
        bundle
            .update(format!("{:x}  {}\n", Sha256::digest(body), path.to_string_lossy()).as_bytes());
    }
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
    let digest = match result {
        Ok(r) => {
            if r.code != Some(0) {
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
                Ok((
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
                ))
            } else {
                match hash(&dir) {
                    Ok((_, 0)) => Ok((
                        "unavailable",
                        None,
                        Some(0),
                        "generate-json-schema не записал ни одного файла".into(),
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
                        Ok((state, Some(actual), Some(files), detail))
                    }
                    Err(e) => Ok((
                        "unavailable",
                        None,
                        None,
                        format!("схему не прочитать: {}", redact(&e.to_string())),
                    )),
                }
            }
        }
        Err(e) => Err(e),
    };
    // Executor returned only after process group and all readers were joined.
    std::fs::remove_dir_all(&dir)?;
    let (state, actual, files, detail) = digest?;
    let mut item = t
        .item(
            "codex.schema",
            "Схема протокола codex",
            if state == "ok" { "ok" } else { "warn" },
            detail,
        )
        .data(json!({"expected":EXPECTED,"actual":actual,"files":files,"state":state}));
    if state == "drift" {
        item=item.fix(format!("{}{}",t.t("сверь изменения для адаптера (node scripts/diff-codex-schema.mjs <старая> <новая> по spike/codex/schema/) ",&[]),t.t("и обнови CODEX_SCHEMA_SHA256 в src/adapters/codex/schema.ts на {0}",&[actual.as_deref().unwrap_or("")])))
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
            hash(d.path()).unwrap(),
            (
                "42b8df7d402804294392835161e9f06653d83d1e1271435f2cc06292009fab90".into(),
                2
            )
        );
    }
}
