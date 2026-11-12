//! Private, durable consent.json storage. Refresh on every read; never infer a
//! grant from unreadable state. Unknown commit outcomes require reopening.
//! The host must serialize all writers through one store; identity checks are
//! conflict detection, not a lock across concurrent store instances/processes.
use crate::{host_policy, session_model, turn_snapshot::Provider};
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Value, json, value::RawValue};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const LIMIT: u64 = 64 * 1024;
const PROVIDERS: [Provider; 3] = [Provider::Claude, Provider::Codex, Provider::Zcode];

#[derive(Clone, Default, Eq, PartialEq)]
pub struct ConsentData {
    pub version: i64,
    pub rev: u64,
    pub providers: Vec<Provider>,
    pub granted_at: Option<String>,
    pub revoked_at: Option<String>,
    // date_millis is deliberately conservative: None does not prove that V8
    // rejects a date. Retain every unrecognized revocation string as a blocker.
    uncertain_revoked_at: Option<String>,
}

impl std::fmt::Debug for ConsentData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConsentData")
            .field("version", &self.version)
            .field("rev", &self.rev)
            .field("providers", &self.providers)
            .field("has_granted_at", &self.granted_at.is_some())
            .field("has_revoked_at", &self.revoked_at.is_some())
            .field("uncertain_revocation", &self.uncertain_revoked_at.is_some())
            .finish()
    }
}

impl ConsentData {
    pub fn facts(&self) -> host_policy::Consent {
        host_policy::Consent {
            version: self.version.max(0) as u64,
            rev: self.rev,
            providers: self.providers.clone(),
            has_valid_granted_at: self
                .granted_at
                .as_deref()
                .is_some_and(|s| session_model::date_millis(s).is_some()),
            has_valid_revoked_at: self.uncertain_revoked_at.is_some()
                || self
                    .revoked_at
                    .as_deref()
                    .is_some_and(|s| session_model::date_millis(s).is_some()),
        }
    }

    pub fn value(&self) -> Value {
        // An unrecognized revocation must not become a grant in a consumer
        // that uses a different date parser. Present a non-grant consistently.
        if let Some(at) = &self.uncertain_revoked_at {
            return json!({"version":self.version,"rev":self.rev,"providers":[],"revokedAt":at});
        }
        let mut value = json!({"version":self.version,"rev":self.rev,"providers":self.providers.iter().map(|p|p.as_str()).collect::<Vec<_>>()});
        if let Some(at) = &self.granted_at {
            value["grantedAt"] = json!(at);
        }
        if let Some(at) = &self.revoked_at {
            value["revokedAt"] = json!(at);
        }
        value
    }
}

fn parse(bytes: &[u8]) -> ConsentData {
    let Ok(raw) = serde_json::from_slice::<Box<RawValue>>(bytes) else {
        return ConsentData::default();
    };
    let Ok(fields) = crate::history::Fields::parse(&raw) else {
        return ConsentData::default();
    };
    let safe = |key| {
        fields
            .get(key)
            .and_then(|raw| raw.get().parse::<f64>().ok())
            .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64)
    };
    let version = safe("version").unwrap_or(0.0) as i64;
    let rev = safe("rev").filter(|n| *n >= 0.0).unwrap_or(0.0) as u64;
    let mut providers = Vec::new();
    if let Some(raw) = fields.get("providers")
        && let Ok(items) = serde_json::from_str::<Vec<Box<RawValue>>>(raw.get())
    {
        for item in items {
            if let Ok(name) = serde_json::from_str::<String>(item.get())
                && let Some(provider) = PROVIDERS.iter().find(|p| p.as_str() == name)
                && !providers.contains(provider)
            {
                providers.push(*provider);
            }
        }
    }
    let at = |key| {
        fields
            .get(key)
            .and_then(|raw| serde_json::from_str::<String>(raw.get()).ok())
            .filter(|s| session_model::date_millis(s).is_some())
    };
    let revoked_at: Option<String> = fields.get("revokedAt").and_then(|raw| {
        // RawValue accepts JSON UTF-16 strings that Rust String cannot represent.
        // V8 may still recognize a date with such a code unit in a comment.
        // Never turn that decoding failure into absence of revocation.
        if raw.get().starts_with('"') {
            Some(
                serde_json::from_str::<String>(raw.get())
                    .unwrap_or_else(|_| "[unsupported Unicode revocation]".into()),
            )
        } else {
            None
        }
    });
    let uncertain_revoked_at = revoked_at.filter(|s| session_model::date_millis(s).is_none());
    ConsentData {
        version,
        rev,
        providers,
        granted_at: at("grantedAt"),
        revoked_at: at("revokedAt"),
        uncertain_revoked_at,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: i64,
    mtime_ns: i64,
    ctime: i64,
    ctime_ns: i64,
}
impl Identity {
    fn of(m: &fs::Metadata) -> Self {
        Self {
            dev: m.dev(),
            ino: m.ino(),
            len: m.len(),
            mtime: m.mtime(),
            mtime_ns: m.mtime_nsec(),
            ctime: m.ctime(),
            ctime_ns: m.ctime_nsec(),
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct Observed {
    identity: Identity,
    bytes: Vec<u8>,
}

fn owned(m: &fs::Metadata) -> bool {
    m.uid() == nix::unistd::geteuid().as_raw()
}
fn directory(path: &Path) -> Result<Identity> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.is_dir() && !m.file_type().is_symlink() && owned(&m) && m.mode() & 0o777 == 0o700,
        "consent home must be an owned private directory (0700)"
    );
    Ok(Identity::of(&m))
}
fn read_private(path: &Path) -> Result<Option<Observed>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context("cannot open consent file"),
    };
    let m = file.metadata()?;
    ensure!(
        m.is_file() && m.nlink() == 1 && owned(&m) && m.mode() & 0o777 == 0o600,
        "consent file must be an owned private regular file (0600) without links"
    );
    ensure!(
        m.len() <= LIMIT,
        "consent file exceeds 64 KiB; refusing to overwrite"
    );
    let identity = Identity::of(&m);
    let mut bytes = Vec::new();
    (&mut file).take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= LIMIT && Identity::of(&file.metadata()?) == identity,
        "consent changed while reading"
    );
    let current = fs::symlink_metadata(path)?;
    ensure!(
        Identity::of(&current) == identity
            && owned(&current)
            && current.nlink() == 1
            && current.mode() & 0o777 == 0o600,
        "consent changed while reading"
    );
    Ok(Some(Observed { identity, bytes }))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Step {
    Write,
    FileSync,
    BeforeReplace,
    DirectorySync,
}

pub struct ConsentStore {
    home: PathBuf,
    home_identity: (u64, u64),
    seen_rev: u64,
    poisoned: bool,
}
impl ConsentStore {
    pub fn open(home: &Path) -> Result<Self> {
        if !home.try_exists()? {
            fs::DirBuilder::new().mode(0o700).create(home)?;
        }
        let m = directory(home)?;
        let mut store = Self {
            home: home.to_path_buf(),
            home_identity: (m.dev, m.ino),
            seen_rev: 0,
            poisoned: false,
        };
        store.read()?;
        Ok(store)
    }
    fn check_home(&self) -> Result<()> {
        let m = directory(&self.home)?;
        ensure!((m.dev, m.ino) == self.home_identity, "consent home changed");
        Ok(())
    }
    fn observe(&mut self) -> Result<(ConsentData, Option<Observed>)> {
        ensure!(
            !self.poisoned,
            "consent commit outcome unknown; reopen store"
        );
        self.check_home()?;
        let observed = read_private(&self.home.join("consent.json"))?;
        self.check_home()?;
        let data = observed
            .as_ref()
            .map_or_else(ConsentData::default, |o| parse(&o.bytes));
        self.seen_rev = self.seen_rev.max(data.rev);
        Ok((data, observed))
    }
    pub fn read(&mut self) -> Result<ConsentData> {
        self.observe().map(|(data, _)| data)
    }
    pub fn grant(&mut self, providers: &[Provider], now: DateTime<Utc>) -> Result<ConsentData> {
        self.update(Some(providers), now, |_| Ok(()))
    }
    pub fn revoke(&mut self, now: DateTime<Utc>) -> Result<ConsentData> {
        self.update(None, now, |_| Ok(()))
    }
    fn update(
        &mut self,
        providers: Option<&[Provider]>,
        now: DateTime<Utc>,
        mut before: impl FnMut(Step) -> Result<()>,
    ) -> Result<ConsentData> {
        let (prev, observed) = self.observe()?;
        ensure!(
            self.seen_rev < MAX_SAFE,
            "consent revision exceeds JavaScript safe integer range"
        );
        let at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        ensure!(
            session_model::date_millis(&at).is_some(),
            "unsupported consent timestamp"
        );
        let next = match providers {
            Some(list) => ConsentData {
                version: host_policy::CONSENT_VERSION as i64,
                rev: self.seen_rev + 1,
                providers: PROVIDERS.into_iter().filter(|p| list.contains(p)).collect(),
                granted_at: Some(at),
                revoked_at: None,
                uncertain_revoked_at: None,
            },
            None => ConsentData {
                version: if prev.version == 0 {
                    host_policy::CONSENT_VERSION as i64
                } else {
                    prev.version
                },
                rev: self.seen_rev + 1,
                providers: vec![],
                granted_at: None,
                revoked_at: Some(at),
                uncertain_revoked_at: None,
            },
        };
        let mut bytes = serde_json::to_vec_pretty(&next.value())?;
        bytes.push(b'\n');
        let path = self.home.join("consent.json");
        let mut random = [0; 16];
        getrandom::fill(&mut random)
            .map_err(|e| anyhow::anyhow!("consent randomness failed: {e}"))?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let tmp = self
            .home
            .join(format!(".consent-{}-{suffix}.tmp", std::process::id()));
        let mut renamed = false;
        let mut temporary_identity = None;
        let result = (|| -> Result<()> {
            self.check_home()?;
            ensure!(
                read_private(&path)? == observed,
                "consent changed before write"
            );
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
                .open(&tmp)?;
            let created = file.metadata()?;
            temporary_identity = Some((created.dev(), created.ino()));
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            before(Step::Write)?;
            file.write_all(&bytes)?;
            before(Step::FileSync)?;
            file.sync_all()?;
            let identity = Identity::of(&file.metadata()?);
            before(Step::BeforeReplace)?;
            self.check_home()?;
            ensure!(
                read_private(&path)? == observed,
                "consent changed before replacement"
            );
            ensure!(
                read_private(&tmp)?.is_some_and(|o| o.identity == identity && o.bytes == bytes),
                "consent temporary file changed"
            );
            fs::rename(&tmp, &path)?;
            renamed = true;
            before(Step::DirectorySync)?;
            File::open(&self.home)?.sync_all()?;
            self.check_home()?;
            ensure!(
                read_private(&path)?.is_some_and(|o| o.identity.dev == identity.dev
                    && o.identity.ino == identity.ino
                    && o.bytes == bytes),
                "consent changed after replacement"
            );
            Ok(())
        })();
        // Do not touch a swapped home or an unknown temporary file.
        if !renamed
            && self.check_home().is_ok()
            && fs::symlink_metadata(&tmp).is_ok_and(|m| {
                temporary_identity == Some((m.dev(), m.ino())) && m.is_file() && owned(&m)
            })
        {
            let _ = fs::remove_file(&tmp);
        }
        if let Err(error) = result {
            self.poisoned |= renamed;
            return Err(error).context(if renamed {
                "consent commit outcome unknown; reopen store"
            } else {
                "consent write failed"
            });
        }
        self.seen_rev = next.rev;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, ConsentStore) {
        let home = tempfile::tempdir().unwrap();
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut store = ConsentStore::open(home.path()).unwrap();
        store.grant(&[Provider::Claude], Utc::now()).unwrap();
        (home, store)
    }
    #[test]
    fn failures_before_rename_leave_original_and_retry() {
        for step in [Step::Write, Step::FileSync, Step::BeforeReplace] {
            let (home, mut store) = fixture();
            let path = home.path().join("consent.json");
            let original = fs::read(&path).unwrap();
            assert!(
                store
                    .update(None, Utc::now(), |at| {
                        ensure!(at != step, "injected failure");
                        Ok(())
                    })
                    .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(store.read().unwrap().facts().covers(Provider::Claude));
            assert_eq!(store.revoke(Utc::now()).unwrap().rev, 2);
            assert_eq!(fs::read_dir(home.path()).unwrap().count(), 1);
        }
    }
    #[test]
    fn directory_sync_uncertainty_disables_reads_and_writes_until_reopen() {
        let (home, mut store) = fixture();
        assert!(
            store
                .update(None, Utc::now(), |at| {
                    ensure!(at != Step::DirectorySync, "injected sync error");
                    Ok(())
                })
                .is_err()
        );
        assert!(store.read().is_err());
        assert!(store.grant(&[Provider::Codex], Utc::now()).is_err());
        let mut reopened = ConsentStore::open(home.path()).unwrap();
        assert_eq!(reopened.read().unwrap().rev, 2);
        assert!(!reopened.read().unwrap().facts().covers(Provider::Claude));
        assert_eq!(
            reopened.grant(&[Provider::Codex], Utc::now()).unwrap().rev,
            3
        );
    }
    #[test]
    fn external_changes_during_commit_are_preserved() {
        let (home, mut store) = fixture();
        let path = home.path().join("consent.json");
        let external = br#"{"version":1,"rev":78,"revokedAt":"2024-01-01"}"#;
        assert!(
            store
                .update(Some(&[Provider::Codex]), Utc::now(), |at| {
                    if at == Step::BeforeReplace {
                        fs::write(&path, external)?;
                    }
                    Ok(())
                })
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), external);
        assert_eq!(store.read().unwrap().rev, 78);
        assert_eq!(store.revoke(Utc::now()).unwrap().rev, 79);
    }
}
