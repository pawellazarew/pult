//! Durable registry transactions. The owner daemon is the only writer; observed
//! external edits fail rather than being overwritten. Unknown post-rename
//! outcomes poison this instance until it is reopened.
use crate::session_model;
pub use crate::session_model::Record;
use crate::turn_snapshot::{SessionKey, TurnSnapshot};
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

pub struct Registry {
    path: PathBuf,
    observed: Option<Observed>,
    records: Vec<Record>,
    poisoned: bool,
    recovery: serde_json::Value,
    language: crate::locale::Setting,
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
        let language = crate::locale::setting(config_fields.get("language"));
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
            language,
        })
    }

    pub(crate) fn language(&self) -> crate::locale::Setting {
        self.language
    }

    pub(crate) fn configured_language(home: &Path) -> Result<crate::locale::Setting> {
        let config = read_private(&home.join("config.json"))?;
        match config {
            None => Ok(crate::locale::Setting::Auto),
            Some(config) => {
                let raw: Box<RawValue> = serde_json::from_slice(&config.bytes)?;
                let fields = crate::history::Fields::parse(&raw)?;
                Ok(crate::locale::setting(fields.get("language")))
            }
        }
    }

    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({"sessions":self.records.len(),"writePoisoned":self.poisoned,"recovery":self.recovery})
    }

    /// A prior replacement may have committed without a durability acknowledgement.
    /// Hosts must revoke execution authority until this store is reopened.
    pub fn write_poisoned(&self) -> bool {
        self.poisoned
    }

    pub fn find(&self, name: &str) -> Option<&Record> {
        self.records.iter().find(|record| record.name() == name)
    }

    /// Trusted owner data, including private queued input. Redact the public
    /// projection in the host; this is not the agent.list wire representation.
    pub fn records(&self) -> &[Record] {
        &self.records
    }

    fn validate_record(record: &Record) -> Result<SessionKey> {
        let snapshot = TurnSnapshot::try_from(record)?;
        snapshot.validate()?;
        ensure!(
            serde_json::to_vec(record)?.len() < crate::MAX_LINE - 4096,
            "session record exceeds metadata budget"
        );
        Ok(snapshot.key)
    }

    fn current(&self, expected: &SessionKey) -> Result<&Record> {
        expected.validate()?;
        let record = self.find(&expected.name).context("session not found")?;
        ensure!(
            record.scalar("createdAt").as_deref() == Some(expected.created_at.as_str()),
            "session identity changed"
        );
        Ok(record)
    }

    /// Host-only metadata creation, not permission to launch a provider. The
    /// host validates consent, cwd, settings and lifecycle before calling this.
    pub fn insert(&mut self, mut record: Record) -> Result<Record> {
        let key = Self::validate_record(&record)?;
        // Record::name reads canonical ASCII directly from its JSON string.
        // Public typed callers can supply escaped JSON; normalize before any
        // lookup or persistence so an escape cannot disguise a duplicate.
        record.set_string("name", &key.name);
        ensure!(self.find(&key.name).is_none(), "session already exists");
        if record.get("lastStatus").is_none() {
            record.set_string("lastStatus", "cold");
        }
        if record.get("lastTurnAt").is_none() {
            record.set_string("lastTurnAt", &key.created_at);
        }
        if record.get("lastSeenEventId").is_none() {
            record.set_number("lastSeenEventId", 0.0);
        }
        Self::validate_record(&record)?;
        let mut records = self.records.clone();
        records.push(record.clone());
        self.commit_records(records, |_| Ok(()))?;
        Ok(record)
    }

    /// A delayed callback cannot overwrite a newer record or a recreated
    /// session. previous must be the exact snapshot used to prepare record.
    /// Prefer update_checked for a small update to freshly read metadata.
    pub fn replace_checked(
        &mut self,
        expected: &SessionKey,
        previous: &Record,
        mut record: Record,
    ) -> Result<Record> {
        let current = self.current(expected)?;
        ensure!(
            current.0.len() == previous.0.len()
                && current.0.iter().all(|(key, value)| previous
                    .0
                    .get(key)
                    .is_some_and(|old| old.get() == value.get())),
            "session metadata changed"
        );
        ensure!(
            Self::validate_record(&record)? == *expected,
            "session identity changed"
        );
        record.set_string("name", &expected.name);
        ensure!(
            record.string("provider") == current.string("provider")
                && record.string("cwd") == current.string("cwd"),
            "session execution identity changed"
        );
        self.replace(&expected.name, record, |_| Ok(()))
    }

    /// Applies a synchronous host patch to current metadata. No record snapshot
    /// is carried across an await, so unrelated title/settings/queue changes
    /// cannot be lost when a provider callback stores its thread ID. Callback
    /// panics are caught; hosts install panic_guard before callbacks to suppress
    /// the default panic hook, which runs before catch_unwind.
    pub fn update_checked(
        &mut self,
        expected: &SessionKey,
        update: impl FnOnce(&mut Record) -> Result<()>,
    ) -> Result<Record> {
        let previous = self.current(expected)?.clone();
        let mut next = previous.clone();
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| update(&mut next)))
            .map_err(|_| anyhow::anyhow!("session metadata mutation failed"))??;
        self.replace_checked(expected, &previous, next)
    }

    /// The host must first quiesce this exact session's workers and revoke its
    /// credentials; removing metadata is not proof that execution stopped.
    pub fn remove_checked(&mut self, expected: &SessionKey) -> Result<Record> {
        let removed = self.current(expected)?.clone();
        let records = self
            .records
            .iter()
            .filter(|r| r.name() != expected.name)
            .cloned()
            .collect();
        self.commit_records(records, |_| Ok(()))?;
        Ok(removed)
    }

    fn commit_records(
        &mut self,
        records: Vec<Record>,
        before: impl FnMut(Step) -> std::io::Result<()>,
    ) -> Result<()> {
        ensure!(
            !self.poisoned,
            "registry commit outcome unknown; reopen before further writes"
        );
        match atomic_write(&self.path, &self.observed, &envelope(&records)?, before) {
            Ok(observed) => {
                self.observed = Some(observed);
                self.records = records;
                Ok(())
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
        self.commit_records(records, before)?;
        Ok(next)
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
                language: crate::locale::Setting::Auto,
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
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
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
        assert!(registry.write_poisoned());
        let driver = std::sync::Arc::new(
            crate::turn_driver::Driver::new(
                std::sync::Arc::new(
                    crate::turn_journal::JournalSink::new(std::sync::Arc::new(
                        std::sync::Mutex::new(
                            crate::journal::EventStore::open(&home.path().join("owner-events"))
                                .unwrap(),
                        ),
                    ))
                    .unwrap(),
                ),
                std::sync::Arc::new(crate::redaction::redact_string),
                crate::turn_driver::Options::default(),
            )
            .unwrap(),
        );
        let registry = std::sync::Arc::new(std::sync::Mutex::new(registry));
        let owner = crate::codex_host_services::CodexOwner::new(
            home.path().into(),
            registry.clone(),
            std::sync::Arc::downgrade(&driver),
            std::sync::Arc::new(std::sync::Mutex::new(
                crate::consent_store::ConsentStore::open(home.path()).unwrap(),
            )),
            std::sync::Arc::new(|_, _| true),
        )
        .unwrap();
        let key = crate::turn_snapshot::SessionKey {
            name: "alpha".into(),
            created_at: "1970-01-01T00:00:00.000Z".into(),
        };
        assert!(matches!(
            owner.snapshot(&key),
            Err(crate::codex_host_services::OwnerError::Storage)
        ));
        assert!(driver.storage_failed());
        let mut registry = registry.lock().unwrap();
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

    fn key(record: &Record) -> SessionKey {
        SessionKey {
            name: record.name().into(),
            created_at: record.scalar("createdAt").unwrap(),
        }
    }
    fn new_record() -> Record {
        let mut record = Record::default();
        record.set_string("name", "beta");
        record.set_string("provider", "codex");
        record.set_string("cwd", "/fixture/beta");
        record.set_string("createdAt", "2026-11-12T00:00:00.000Z");
        record
    }
    #[test]
    fn insert_is_durable_preserves_other_sessions_and_rejects_escaped_duplicate() {
        let (_home, mut registry) = fixture();
        let record = registry.insert(new_record()).unwrap();
        assert_eq!(record.scalar("lastStatus").as_deref(), Some("cold"));
        assert_eq!(registry.records().len(), 2);
        let disk: Box<RawValue> =
            serde_json::from_slice(&fs::read(&registry.path).unwrap()).unwrap();
        let parsed = session_model::parse(&disk).unwrap();
        assert_eq!(
            parsed.iter().map(Record::name).collect::<Vec<_>>(),
            ["alpha", "beta"]
        );
        let before = fs::read(&registry.path).unwrap();
        let mut duplicate = new_record();
        duplicate.set_raw(
            "name",
            RawValue::from_string(r#""\u0062eta""#.into()).unwrap(),
        );
        assert!(registry.insert(duplicate).is_err());
        assert_eq!(fs::read(&registry.path).unwrap(), before);
    }
    #[test]
    fn malformed_new_records_never_change_disk_or_memory() {
        let (_home, mut registry) = fixture();
        let before = fs::read(&registry.path).unwrap();
        let mut records = vec![Record::default()];
        for (field, value) in [
            ("name", "../beta"),
            ("provider", "unknown"),
            ("cwd", "relative"),
            ("createdAt", ""),
            ("approval", "inherit"),
        ] {
            let mut record = new_record();
            record.set_string(field, value);
            records.push(record);
        }
        let mut oversized = new_record();
        oversized.set_string("privateMetadata", &"x".repeat(crate::MAX_LINE));
        records.push(oversized);
        for record in records {
            assert!(registry.insert(record).is_err());
            assert_eq!(fs::read(&registry.path).unwrap(), before);
            assert_eq!(registry.records().len(), 1);
        }
    }
    #[test]
    fn checked_replacement_and_removal_reject_stale_identity_and_execution_changes() {
        let (_home, mut registry) = fixture();
        let created = registry.insert(new_record()).unwrap();
        let expected = key(&created);
        let mut stale = expected.clone();
        stale.created_at = "2025-01-01T00:00:00.000Z".into();
        let before = fs::read(&registry.path).unwrap();
        assert!(
            registry
                .replace_checked(&stale, &created, created.clone())
                .is_err()
        );
        assert!(registry.remove_checked(&stale).is_err());
        for (field, value) in [
            ("name", "gamma"),
            ("createdAt", "different"),
            ("provider", "claude"),
            ("cwd", "/foreign"),
        ] {
            let mut changed = created.clone();
            changed.set_string(field, value);
            assert!(
                registry
                    .replace_checked(&expected, &created, changed)
                    .is_err()
            );
        }
        assert_eq!(fs::read(&registry.path).unwrap(), before);
        let mut changed = created.clone();
        changed.set_raw(
            "name",
            RawValue::from_string(r#""\u0062eta""#.into()).unwrap(),
        );
        changed.set_string("providerSessionId", "native-thread");
        let updated = registry
            .replace_checked(&expected, &created, changed)
            .unwrap();
        assert_eq!(updated.name(), "beta");
        assert_eq!(
            registry
                .find("beta")
                .unwrap()
                .scalar("providerSessionId")
                .as_deref(),
            Some("native-thread")
        );
        registry.remove_checked(&expected).unwrap();
        assert!(registry.find("beta").is_none());
        assert_eq!(registry.records().len(), 1);
    }
    #[test]
    fn lifecycle_transactions_preserve_observed_external_edits() {
        for operation in 0..3 {
            let (_home, mut registry) = fixture();
            let current = registry.find("alpha").unwrap().clone();
            let expected = key(&current);
            let external = b"external owner edit";
            fs::write(&registry.path, external).unwrap();
            let failed = match operation {
                0 => registry.insert(new_record()).is_err(),
                1 => registry
                    .replace_checked(&expected, &current, current.clone())
                    .is_err(),
                _ => registry.remove_checked(&expected).is_err(),
            };
            assert!(failed);
            assert_eq!(fs::read(&registry.path).unwrap(), external);
            assert_eq!(registry.records().len(), 1);
        }
    }
    #[test]
    fn stale_full_record_cannot_overwrite_a_newer_title() {
        let (_home, mut registry) = fixture();
        let mut stale = registry.insert(new_record()).unwrap();
        let expected = key(&stale);
        let previous = stale.clone();
        registry
            .rename("beta", &"new title".encode_utf16().collect::<Vec<_>>())
            .unwrap();
        stale.set_string("providerSessionId", "native-thread");
        assert!(
            registry
                .replace_checked(&expected, &previous, stale)
                .is_err()
        );
        assert_eq!(
            registry.find("beta").unwrap().scalar("title").as_deref(),
            Some("new title")
        );
        let updated = registry
            .update_checked(&expected, |record| {
                record.set_string("providerSessionId", "native-thread");
                Ok(())
            })
            .unwrap();
        assert_eq!(updated.scalar("title").as_deref(), Some("new title"));
        assert_eq!(
            updated.scalar("providerSessionId").as_deref(),
            Some("native-thread")
        );
    }

    #[test]
    fn raw_record_debug_is_private_and_invalid_names_do_not_panic() {
        let mut record = Record::default();
        assert_eq!(record.name(), "");
        record.set_string("name", "../private");
        record.set_string("queue", "PRIVATE_QUEUE_SECRET");
        record.set_string("cwd", "/PRIVATE_PATH");
        assert_eq!(record.name(), "");
        let debug = format!("{record:?}");
        assert!(!debug.contains("PRIVATE"));
        assert!(debug.contains("fields: 3"));
        record.set_raw(
            "name",
            RawValue::from_string(r#""\u0062eta""#.into()).unwrap(),
        );
        assert_eq!(record.name(), "");
        record.set_string("name", "beta");
        assert_eq!(record.name(), "beta");
    }

    #[test]
    fn failed_or_panicking_metadata_patch_does_not_write_or_poison_the_owner_lock() {
        let (_home, registry) = fixture();
        let before = fs::read(&registry.path).unwrap();
        let expected = key(registry.find("alpha").unwrap());
        let registry = std::sync::Mutex::new(registry);
        for panic in [false, true] {
            let error = registry
                .lock()
                .unwrap()
                .update_checked(&expected, |next| {
                    next.set_string("title", "must not persist");
                    if panic {
                        panic!("PRIVATE_CALLBACK_SECRET");
                    }
                    anyhow::bail!("validation failed")
                })
                .unwrap_err();
            if panic {
                assert!(!error.to_string().contains("PRIVATE"));
            }
            assert!(!registry.is_poisoned());
            let owner = registry.lock().unwrap();
            assert!(owner.find("alpha").unwrap().get("title").is_none());
            assert_eq!(fs::read(&owner.path).unwrap(), before);
        }
    }
    #[test]
    fn stale_callback_cannot_restore_full_after_read_only_selection() {
        let (_home, mut registry) = fixture();
        let mut initial = new_record();
        initial.set_string("approval", "full");
        let previous = registry.insert(initial).unwrap();
        let expected = key(&previous);
        registry
            .update_checked(&expected, |record| {
                record.set_string("approval", "read-only");
                Ok(())
            })
            .unwrap();
        let mut stale = previous.clone();
        stale.set_string("providerSessionId", "thread");
        assert!(
            registry
                .replace_checked(&expected, &previous, stale)
                .is_err()
        );
        let fresh = registry
            .update_checked(&expected, |record| {
                record.set_string("providerSessionId", "thread");
                Ok(())
            })
            .unwrap();
        assert_eq!(fresh.scalar("approval").as_deref(), Some("read-only"));
        assert_eq!(fresh.scalar("providerSessionId").as_deref(), Some("thread"));
    }
}
