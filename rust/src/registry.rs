//! Durable registry transactions. The owner daemon is the only writer; observed
//! external edits fail rather than being overwritten. Unknown post-rename
//! outcomes poison this instance until it is reopened.
use crate::session_model::{self, Record};
use anyhow::{Context, Result, ensure};
use chrono::{SecondsFormat, Utc};
use serde_json::value::RawValue;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    len: u64,
    seconds: i64,
    nanos: i64,
}
impl Identity {
    fn of(m: &fs::Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            seconds: m.mtime(),
            nanos: m.mtime_nsec(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
struct Observed {
    bytes: Vec<u8>,
    identity: Identity,
}

fn read_private(path: &Path) -> Result<Option<Observed>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("cannot open {}", path.display())),
    };
    let m = file.metadata()?;
    ensure!(
        m.is_file() && m.nlink() == 1 && m.permissions().mode() & 0o077 == 0,
        "{} must be a private regular file without links",
        path.display()
    );
    let identity = Identity::of(&m);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    ensure!(
        Identity::of(&file.metadata()?) == identity,
        "file changed while being read"
    );
    Ok(Some(Observed { bytes, identity }))
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    Write,
    FileSync,
    Rename,
    DirectorySync,
}
struct CommitError {
    error: anyhow::Error,
    uncertain: bool,
}

fn atomic_write(
    path: &Path,
    previous: &Option<Observed>,
    bytes: &[u8],
    mut before: impl FnMut(Step) -> std::io::Result<()>,
) -> std::result::Result<Observed, CommitError> {
    let mut temporary = None;
    let mut renamed = false;
    let result = (|| -> Result<Observed> {
        ensure!(
            &read_private(path)? == previous,
            "registry file changed outside its owner"
        );
        let parent = path.parent().context("registry has no parent")?;
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|error| anyhow::anyhow!("random source failed: {error}"))?;
        let suffix = random
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect::<String>();
        let tmp = parent.join(format!(
            ".rust-registry-{}-{suffix}.tmp",
            std::process::id()
        ));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&tmp)?;
        temporary = Some(tmp.clone());
        before(Step::Write)?;
        file.write_all(bytes)?;
        before(Step::FileSync)?;
        file.sync_all()?;
        ensure!(
            &read_private(path)? == previous,
            "registry file changed before replacement"
        );
        before(Step::Rename)?;
        fs::rename(&tmp, path)?;
        renamed = true;
        before(Step::DirectorySync)?;
        File::open(parent)?.sync_all()?;
        let observed = read_private(path)?.context("committed registry disappeared")?;
        ensure!(
            observed.bytes == bytes,
            "committed registry changed before acknowledgement"
        );
        Ok(observed)
    })();
    if let Some(tmp) = temporary {
        let _ = fs::remove_file(tmp);
    }
    result.map_err(|error| CommitError {
        error,
        uncertain: renamed,
    })
}

fn registry_document(bytes: &[u8]) -> Result<Box<RawValue>> {
    let raw: Box<RawValue> = serde_json::from_slice(bytes).context("sessions.json is corrupt")?;
    let fields =
        crate::history::Fields::parse(&raw).context("sessions.json root must be an object")?;
    ensure!(
        fields
            .get("sessions")
            .is_some_and(|x| x.get().starts_with('[')),
        "sessions.json must contain a sessions array"
    );
    Ok(raw)
}

fn version(raw: &RawValue) -> Result<Option<f64>> {
    let number = session_model::version(raw)?;
    ensure!(
        number.is_none_or(|v| v.is_finite() && v <= 2.0),
        "future or nonfinite sessions version is not supported"
    );
    Ok(number)
}

fn envelope(records: &[Record]) -> Result<Vec<u8>> {
    #[derive(serde::Serialize)]
    struct Document<'a> {
        version: u64,
        sessions: &'a [Record],
    }
    let mut bytes = serde_json::to_vec(&Document {
        version: 2,
        sessions: records,
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn backup_once(home: &Path, original: &Observed) -> Result<()> {
    let path = home.join("sessions.json.bak-v1");
    if let Some(existing) = read_private(&path)? {
        registry_document(&existing.bytes).context("existing first registry backup is corrupt")?;
        // A prior process may have failed after writing these bytes but before
        // syncing. Re-establish durability before trusting the first backup.
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&path)?;
        let metadata = file.metadata()?;
        ensure!(
            metadata.is_file() && metadata.nlink() == 1 && metadata.mode() & 0o077 == 0,
            "first registry backup must remain a private regular file"
        );
        ensure!(
            Identity::of(&metadata) == existing.identity,
            "first registry backup changed"
        );
        file.sync_all()?;
        File::open(home)?.sync_all()?;
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    file.write_all(&original.bytes)?;
    file.sync_all()?;
    File::open(home)?.sync_all()?;
    Ok(())
}

pub(crate) struct Registry {
    path: PathBuf,
    observed: Option<Observed>,
    records: Vec<Record>,
    poisoned: bool,
    recovery: serde_json::Value,
}

impl Registry {
    pub fn open(home: &Path, store: &mut crate::journal::EventStore) -> Result<Self> {
        let path = home.join("sessions.json");
        let observed = read_private(&path)?;
        let config_path = home.join("config.json");
        let config = read_private(&config_path)?;
        let mut config_fields = match &config {
            Some(c) => crate::history::Fields::parse(
                &serde_json::from_slice::<Box<RawValue>>(&c.bytes)
                    .context("config.json is corrupt")?,
            )
            .context("config.json root must be an object")?,
            None => crate::history::Fields::default(),
        };
        let raw = observed
            .as_ref()
            .map(|o| registry_document(&o.bytes))
            .transpose()?;
        let mut records = match &raw {
            Some(raw) => session_model::parse(raw)?,
            None => Vec::new(),
        };
        let original_normalized = serde_json::to_vec(&records)?;
        let mut migrations = match config_fields.get("migrations") {
            Some(value) => crate::history::Fields::parse(value)
                .context("config migrations must be an object")?,
            None => crate::history::Fields::default(),
        };
        let marker = match migrations.get("accessLevels") {
            Some(value) => {
                let fields = crate::history::Fields::parse(value)
                    .context("access migration marker must be an object")?;
                let at = fields
                    .get("at")
                    .context("access migration marker needs at")?;
                let at = String::from_utf16(&crate::journal::decode_js_string(at)?)
                    .context("access migration marker date is not Unicode text")?;
                ensure!(
                    session_model::date_millis(&at).is_some(),
                    "unsupported access migration marker date"
                );
                Some(at)
            }
            None => None,
        };
        let mut migrated = 0;
        if let Some(raw) = &raw {
            let v = version(raw)?;
            if v.is_none_or(|v| v < 2.0) {
                backup_once(home, observed.as_ref().expect("loaded registry"))?;
                migrated = session_model::migrate(v, &mut records, marker.as_deref())?;
            }
        }
        let stats = session_model::recover_with_receipts(
            &mut records,
            store.last_id(),
            |name| store.read_session(&name.encode_utf16().collect::<Vec<_>>()),
            |name| Ok(store.accepted_queue_receipts(name)),
        )?;
        // Validate/compute every registry transition before publishing a marker.
        if raw.is_some() && marker.is_none() {
            let at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            migrations.set(
                "accessLevels",
                serde_json::value::to_raw_value(&serde_json::json!({"at":at}))?,
            );
            config_fields.set("migrations", migrations.into_raw()?);
            let mut body = config_fields.into_raw()?.get().as_bytes().to_vec();
            body.push(b'\n');
            atomic_write(&config_path, &config, &body, |_| Ok(()))
                .map_err(|e| e.error)
                .context("access migration marker was not durably saved")?;
        }
        let changed =
            migrated > 0 || stats.changed() || original_normalized != serde_json::to_vec(&records)?;
        let observed = if changed {
            Some(
                atomic_write(&path, &observed, &envelope(&records)?, |_| Ok(()))
                    .map_err(|e| e.error)
                    .context("recovered sessions were not durably saved")?,
            )
        } else {
            observed
        };
        Ok(Self {
            path,
            observed,
            records,
            poisoned: false,
            recovery: serde_json::json!({"migrationCount":migrated,"startup":stats}),
        })
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"sessions":self.records.len(),"writePoisoned":self.poisoned,"recovery":self.recovery})
    }

    pub fn find(&self, name: &str) -> Option<&Record> {
        self.records.iter().find(|record| record.name() == name)
    }

    fn replace(
        &mut self,
        name: &str,
        next: Record,
        before: impl FnMut(Step) -> std::io::Result<()>,
    ) -> Result<Record> {
        ensure!(
            !self.poisoned,
            "registry commit outcome unknown; reopen before further writes"
        );
        let index = self
            .records
            .iter()
            .position(|r| r.name() == name)
            .context("session not found")?;
        let mut records = self.records.clone();
        records[index] = next.clone();
        match atomic_write(&self.path, &self.observed, &envelope(&records)?, before) {
            Ok(observed) => {
                self.observed = Some(observed);
                self.records = records;
                Ok(next)
            }
            Err(failure) => {
                self.poisoned |= failure.uncertain;
                if failure.uncertain {
                    Err(failure.error)
                        .context("registry commit outcome unknown; reopen before further writes")
                } else {
                    Err(failure.error).context("registry write failed; memory unchanged")
                }
            }
        }
    }

    pub fn rename(&mut self, name: &str, title: &[u16]) -> Result<Record> {
        let mut next = self.find(name).context("session not found")?.clone();
        if let Some(title) = session_model::normalize_title(title) {
            ensure!(
                session_model::title_length(&title) <= 60,
                "title exceeds 60 characters"
            );
            next.set_raw(
                "title",
                RawValue::from_string(crate::history::encode_string(&title))?,
            );
        } else {
            next.remove("title");
        }
        self.replace(name, next, |_| Ok(()))
    }

    pub fn archive(&mut self, name: &str, archived: bool) -> Result<Record> {
        let mut next = self.find(name).context("session not found")?.clone();
        if archived {
            next.set_raw("archived", RawValue::from_string("true".into())?);
        } else {
            next.remove("archived");
        }
        self.replace(name, next, |_| Ok(()))
    }

    pub fn seen(
        &mut self,
        name: &str,
        unread: bool,
        up_to: Option<u64>,
        last_id: u64,
    ) -> Result<Record> {
        ensure!(
            !self.poisoned,
            "registry commit outcome unknown; reopen before further writes"
        );
        let mut next = self.find(name).context("session not found")?.clone();
        let marked = next
            .get("markedUnread")
            .is_some_and(|raw| raw.get() == "true");
        if unread {
            if marked {
                return Ok(next);
            }
            next.set_raw("markedUnread", RawValue::from_string("true".into())?);
        } else {
            let previous = next
                .get("lastSeenEventId")
                .and_then(|v| serde_json::from_str::<f64>(v.get()).ok());
            let at = (previous.unwrap_or(0.0) as u64).max(up_to.unwrap_or(last_id).min(last_id));
            if previous == Some(at as f64) && !marked {
                return Ok(next);
            }
            next.set_raw("lastSeenEventId", serde_json::value::to_raw_value(&at)?);
            next.remove("markedUnread");
        }
        self.replace(name, next, |_| Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Registry) {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("sessions.json");
        let raw = RawValue::from_string(r#"{"version":2,"sessions":[{"name":"alpha","provider":"codex","cwd":"/fixture","lastStatus":"cold","createdAt":"1970-01-01T00:00:00.000Z","lastTurnAt":"1970-01-01T00:00:00.000Z","lastSeenEventId":0}]}"#.into()).unwrap();
        let records = session_model::parse(&raw).unwrap();
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(&envelope(&records).unwrap()).unwrap();
        file.sync_all().unwrap();
        let observed = read_private(&path).unwrap();
        (
            home,
            Registry {
                path,
                observed,
                records,
                poisoned: false,
                recovery: serde_json::json!({}),
            },
        )
    }

    #[test]
    fn failed_write_sync_or_rename_retains_disk_and_memory_then_retries() {
        for failed in [Step::Write, Step::FileSync, Step::Rename] {
            let (home, mut registry) = fixture();
            let before = fs::read(&registry.path).unwrap();
            let mut next = registry.find("alpha").unwrap().clone();
            next.set_string("title", "next");
            let error = registry
                .replace("alpha", next.clone(), |step| {
                    if step == failed {
                        Err(std::io::Error::other("injected ENOSPC/EIO"))
                    } else {
                        Ok(())
                    }
                })
                .unwrap_err();
            assert!(error.to_string().contains("memory unchanged"));
            assert_eq!(fs::read(&registry.path).unwrap(), before);
            assert!(registry.find("alpha").unwrap().get("title").is_none());
            assert!(!registry.poisoned);
            assert!(!fs::read_dir(home.path()).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            }));
            registry.replace("alpha", next, |_| Ok(())).unwrap();
            assert_eq!(
                registry.find("alpha").unwrap().scalar("title").as_deref(),
                Some("next")
            );
        }
    }

    #[test]
    fn uncertain_directory_sync_disables_even_noop_mutations_until_reopen() {
        let (home, mut registry) = fixture();
        let mut next = registry.find("alpha").unwrap().clone();
        next.set_string("title", "committed");
        let error = registry
            .replace("alpha", next, |step| {
                if step == Step::DirectorySync {
                    Err(std::io::Error::other("injected directory sync EIO"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert!(error.to_string().contains("outcome unknown"));
        assert!(registry.poisoned);
        assert!(registry.find("alpha").unwrap().get("title").is_none());
        assert!(registry.seen("alpha", false, Some(0), 0).is_err());
        assert!(registry.archive("alpha", true).is_err());
        let durable = fs::read(&registry.path).unwrap();
        let parsed = session_model::parse(&registry_document(&durable).unwrap()).unwrap();
        assert_eq!(parsed[0].scalar("title").as_deref(), Some("committed"));
        let mut store = crate::journal::EventStore::open(&home.path().join("events")).unwrap();
        let mut reopened = Registry::open(home.path(), &mut store).unwrap();
        assert!(!reopened.poisoned);
        assert_eq!(
            reopened.find("alpha").unwrap().scalar("title").as_deref(),
            Some("committed")
        );
        reopened.archive("alpha", true).unwrap();
    }

    #[test]
    fn observed_external_edits_are_never_overwritten() {
        let (_home, mut registry) = fixture();
        let external = b"external edit";
        fs::write(&registry.path, external).unwrap();
        assert!(
            registry
                .rename("alpha", &"new".encode_utf16().collect::<Vec<_>>())
                .is_err()
        );
        assert_eq!(fs::read(&registry.path).unwrap(), external);
        assert!(registry.find("alpha").unwrap().get("title").is_none());
    }

    #[test]
    fn overflowing_future_version_refuses_without_marker_backup_or_writes() {
        let (home, registry) = fixture();
        let bytes = br#"{"version":1e400,"sessions":[{"name":"old","provider":"claude","cwd":"/fixture"}]}"#;
        fs::write(&registry.path, bytes).unwrap();
        let mut store = crate::journal::EventStore::open(&home.path().join("events")).unwrap();
        let error = Registry::open(home.path(), &mut store)
            .err()
            .expect("future version must fail");
        assert!(error.to_string().contains("version"));
        assert_eq!(fs::read(&registry.path).unwrap(), bytes);
        assert!(!home.path().join("config.json").exists());
        assert!(!home.path().join("sessions.json.bak-v1").exists());
    }
}
