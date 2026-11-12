//! Shared host-only authority checks. No provider IO or client-selected authority.
use crate::consent_store::ConsentStore;
use crate::host_policy::{self, AccessFacts, SessionGrant};
use crate::registry::{Record, Registry};
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{DispatchDecision, Driver};
use crate::turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

pub const UNCERTAIN_MESSAGE: &str = "Предыдущая реплика Claude могла выполниться, но подтверждение потеряно. Автоматический повтор запрещён. Проверь историю Claude и импортируй подтверждённый разговор в новый чат; повторная отправка может выполнить задачу дважды.";
pub type RouteValidity = Arc<dyn Fn(&Ticket, &TurnSnapshot) -> bool + Send + Sync>;
/// Effective Claude settings, after setting-source filtering and managed policy.
/// The host captures the provider HOME/settings roots explicitly in this callback.
#[derive(Clone)]
pub struct InheritContext {
    pub cwd: PathBuf,
    pub setting_sources: Option<String>,
}
pub type InheritMode = Arc<dyn Fn(&InheritContext) -> Result<String, OwnerError> + Send + Sync>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerError {
    InvalidSession,
    InvalidPath,
    UnsupportedFork,
    Uncertain,
    Unavailable,
    Storage,
}
impl OwnerError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidSession => "invalid_session",
            Self::InvalidPath => "invalid_path",
            Self::UnsupportedFork => "unsupported_fork",
            Self::Uncertain => "start_unknown",
            Self::Unavailable => "provider_unavailable",
            Self::Storage => "storage_unavailable",
        }
    }
}
impl std::fmt::Display for OwnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if *self == Self::Uncertain {
            UNCERTAIN_MESSAGE
        } else {
            self.code()
        })
    }
}
impl std::error::Error for OwnerError {}
#[derive(Clone, PartialEq, Eq)]
struct Folder {
    path: PathBuf,
    device: u64,
    inode: u64,
}
fn folder(path: &Path) -> Result<Folder, OwnerError> {
    let path = path.canonicalize().map_err(|_| OwnerError::InvalidPath)?;
    let metadata = std::fs::metadata(&path).map_err(|_| OwnerError::InvalidPath)?;
    if !metadata.is_dir() {
        return Err(OwnerError::InvalidPath);
    }
    Ok(Folder {
        path,
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}
pub(crate) fn yes(record: &Record, name: &str) -> bool {
    record
        .get(name)
        .is_some_and(|raw| raw.get().trim() == "true")
}
fn rank(approval: Approval) -> u8 {
    match approval {
        Approval::ReadOnly => 0,
        Approval::Ask => 1,
        Approval::Workspace => 2,
        Approval::Full => 3,
        Approval::Inherit => 4,
    }
}
pub(crate) fn same_authority(a: &Record, b: &Record) -> bool {
    [
        "name",
        "createdAt",
        "provider",
        "cwd",
        "scope",
        "approval",
        "grant",
        "settingSources",
        "inheritSeen",
        "archived",
        "forkOnResume",
    ]
    .iter()
    .all(|key| a.get(key).map(|v| v.get()) == b.get(key).map(|v| v.get()))
}
pub(crate) struct PolicySnapshot {
    pub snapshot: TurnSnapshot,
    pub inherit_mode: Option<String>,
    pub record: Record,
}
pub(crate) struct OwnerTrust {
    home: Folder,
    original_home: PathBuf,
    provider: Provider,
    pub(crate) registry: Arc<Mutex<Registry>>,
    pub(crate) driver: Weak<Driver>,
    pub(crate) consent: Arc<Mutex<ConsentStore>>,
    route: RouteValidity,
    inherit: Option<InheritMode>,
    folders: Mutex<HashMap<SessionKey, Folder>>,
}
impl OwnerTrust {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        home: PathBuf,
        registry: Arc<Mutex<Registry>>,
        driver: Weak<Driver>,
        consent: Arc<Mutex<ConsentStore>>,
        route: RouteValidity,
        provider: Provider,
        inherit: Option<InheritMode>,
    ) -> Result<Self, OwnerError> {
        Ok(Self {
            home: folder(&home)?,
            original_home: home,
            provider,
            registry,
            driver,
            consent,
            route,
            inherit,
            folders: Mutex::new(HashMap::new()),
        })
    }
    pub(crate) fn storage_fault(&self) -> OwnerError {
        if let Some(driver) = self.driver.upgrade() {
            driver.report_storage_failure();
        }
        OwnerError::Storage
    }
    pub(crate) fn registry(&self) -> Result<MutexGuard<'_, Registry>, OwnerError> {
        self.registry.lock().map_err(|error| {
            drop(error);
            self.storage_fault()
        })
    }
    pub(crate) fn incarnation(&self, record: &Record, key: &SessionKey) -> Result<(), OwnerError> {
        if record.scalar("createdAt").as_deref() != Some(&key.created_at)
            || record.scalar("provider").as_deref() != Some(self.provider.as_str())
            || yes(record, "archived")
        {
            return Err(OwnerError::InvalidSession);
        }
        if self.provider != Provider::Claude && record.get("claudeReservedSessionId").is_some() {
            return Err(OwnerError::Uncertain);
        }
        if self.provider == Provider::Codex && yes(record, "forkOnResume") {
            return Err(OwnerError::UnsupportedFork);
        }
        Ok(())
    }
    fn home_ok(&self) -> Result<(), OwnerError> {
        if folder(&self.original_home)? != self.home || folder(&self.home.path)? != self.home {
            return Err(OwnerError::InvalidPath);
        }
        Ok(())
    }
    pub(crate) fn record(&self, key: &SessionKey) -> Result<Record, OwnerError> {
        key.validate().map_err(|_| OwnerError::InvalidSession)?;
        let registry = self.registry()?;
        if registry.write_poisoned() {
            drop(registry);
            return Err(self.storage_fault());
        }
        let record = registry.find(&key.name).ok_or(OwnerError::InvalidSession)?;
        self.incarnation(record, key)?;
        Ok(record.clone())
    }
    fn pin(
        &self,
        key: &SessionKey,
        snapshot: &mut TurnSnapshot,
        record: &Record,
    ) -> Result<(), OwnerError> {
        self.home_ok()?;
        if record.scalar("scope").as_deref() == Some("general") {
            crate::host_paths::validate_general(&self.home.path, &key.name, &snapshot.cwd)
                .map_err(|_| OwnerError::InvalidPath)?;
        }
        let actual = folder(&snapshot.cwd)?;
        if snapshot.settings.approval != Approval::ReadOnly
            && crate::host_paths::covers_pult_home(&actual.path, &self.home.path)
                .map_err(|_| OwnerError::InvalidPath)?
        {
            return Err(OwnerError::InvalidPath);
        }
        let mut folders = self.folders.lock().map_err(|_| OwnerError::Unavailable)?;
        if let Some(previous) = folders.get(key) {
            if previous != &actual {
                return Err(OwnerError::InvalidPath);
            }
        } else {
            if folders.len() >= 4096 {
                return Err(OwnerError::Unavailable);
            }
            folders.insert(key.clone(), actual.clone());
        }
        snapshot.cwd = actual.path;
        Ok(())
    }
    pub(crate) fn snapshot(&self, key: &SessionKey) -> Result<TurnSnapshot, OwnerError> {
        self.snapshot_policy(key).map(|facts| facts.snapshot)
    }
    pub(crate) fn snapshot_policy(&self, key: &SessionKey) -> Result<PolicySnapshot, OwnerError> {
        let record = self.record(key)?;
        let mut snapshot =
            TurnSnapshot::try_from(&record).map_err(|_| OwnerError::InvalidSession)?;
        if self.provider == Provider::Claude
            && record.get("settingSources").is_some()
            && record.scalar("settingSources").is_none()
        {
            return Err(OwnerError::InvalidSession);
        }
        // Resolve inherited policy outside every store/Driver mutex. Afterwards
        // reread the record and consent, including after either mutex wait.
        let mode = if snapshot.settings.approval == Approval::Inherit {
            let resolve = self.inherit.as_ref().ok_or(OwnerError::Unavailable)?;
            let mode = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                resolve(&InheritContext {
                    cwd: snapshot
                        .cwd
                        .canonicalize()
                        .map_err(|_| OwnerError::InvalidPath)?,
                    setting_sources: record.scalar("settingSources"),
                })
            }))
            .map_err(|_| OwnerError::Unavailable)??;
            if mode.is_empty() || mode.len() > 128 || mode.chars().any(char::is_control) {
                return Err(OwnerError::Unavailable);
            }
            Some(mode)
        } else {
            None
        };
        // Consent -> Registry is the shared sole-writer lock order. Do not call
        // injected code here. Consent is read only after the Registry wait.
        let mut consent = self.consent.lock().map_err(|error| {
            drop(error);
            self.storage_fault()
        })?;
        let registry = self.registry()?;
        if registry.write_poisoned() {
            drop(registry);
            drop(consent);
            return Err(self.storage_fault());
        }
        let current = registry.find(&key.name).ok_or(OwnerError::InvalidSession)?;
        self.incarnation(current, key)?;
        if !same_authority(&record, current) {
            return Err(OwnerError::Unavailable);
        }
        let facts = match consent.read() {
            Ok(value) => value.facts(),
            Err(_) => {
                drop(registry);
                drop(consent);
                return Err(self.storage_fault());
            }
        };
        snapshot.settings.approval = host_policy::effective_access(&AccessFacts {
            provider: self.provider,
            desired: snapshot.settings.approval,
            effective_inherit_mode: mode.clone(),
            inherit_seen: record.scalar("inheritSeen"),
            session_grant: (record.scalar("grant").as_deref() == Some("cli-once"))
                .then_some(SessionGrant::CliOnce),
            consent: facts,
        })
        .effective;
        self.pin(key, &mut snapshot, current)?;
        snapshot
            .validate()
            .map_err(|_| OwnerError::InvalidSession)?;
        Ok(PolicySnapshot {
            snapshot,
            inherit_mode: mode,
            record,
        })
    }
    /// Safe under Registry write serialization: no callbacks or consent lock.
    pub(crate) fn transaction_scope(
        &self,
        record: &Record,
        initial: &TurnSnapshot,
    ) -> Result<(), OwnerError> {
        self.incarnation(record, &initial.key)?;
        let mut current = TurnSnapshot::try_from(record).map_err(|_| OwnerError::InvalidSession)?;
        // Preserve the already checked effective approval for path guards.
        current.settings.approval = initial.settings.approval;
        self.pin(&initial.key, &mut current, record)?;
        if current.cwd != initial.cwd || current.provider != initial.provider {
            return Err(OwnerError::InvalidPath);
        }
        Ok(())
    }
    pub(crate) fn live(&self, ticket: &Ticket) -> Result<TurnSnapshot, OwnerError> {
        self.driver
            .upgrade()
            .and_then(|driver| driver.snapshot_for_dispatch(ticket))
            .ok_or(OwnerError::Unavailable)
    }
    pub(crate) fn diagnostic(&self, ticket: &Ticket) -> Result<TurnSnapshot, OwnerError> {
        self.driver
            .upgrade()
            .and_then(|driver| driver.execution_snapshot(ticket))
            .ok_or(OwnerError::Unavailable)
    }
    pub(crate) fn route_ok(&self, ticket: &Ticket, initial: &TurnSnapshot) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.route)(ticket, initial)
        }))
        .unwrap_or(false)
    }
    pub(crate) fn gate(&self, ticket: &Ticket, initial: &TurnSnapshot) -> DispatchDecision {
        if self.live(ticket).as_ref() != Ok(initial) || !self.route_ok(ticket, initial) {
            return DispatchDecision::Deny;
        }
        let Ok(current) = self.snapshot(&initial.key) else {
            return DispatchDecision::Deny;
        };
        // A store/config mutex may have waited; refresh the route afterwards.
        if !self.route_ok(ticket, initial) {
            return DispatchDecision::Deny;
        }
        let Ok(final_current) = self.snapshot(&initial.key) else {
            return DispatchDecision::Deny;
        };
        if self.live(ticket).as_ref() != Ok(initial)
            || current.provider != initial.provider
            || current.cwd != initial.cwd
            || final_current.provider != initial.provider
            || final_current.cwd != initial.cwd
        {
            return DispatchDecision::Deny;
        }
        let effective = if rank(current.settings.approval) < rank(final_current.settings.approval) {
            current.settings.approval
        } else {
            final_current.settings.approval
        };
        if rank(effective) < rank(initial.settings.approval) {
            DispatchDecision::Restrict(effective)
        } else {
            DispatchDecision::Allow
        }
    }
}
