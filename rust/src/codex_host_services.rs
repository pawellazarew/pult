//! Trusted owner services for an ordinary Codex host. The required route check
//! must validate the outer host pool's captured NetworkGuard/config stamp; a
//! callback returning true is trusted host authority, never RPC payload authority.
//! The host installs panic_guard before injecting callbacks.
use crate::codex_events::{RedactionError, Redactor};
use crate::codex_worker::{
    ApprovalHandler, Services, ThreadPrepared, ThreadReceipt, ThreadStore, ThreadStoreError,
};
use crate::consent_store::ConsentStore;
use crate::host_policy::{self, AccessFacts, SessionGrant};
use crate::registry::{Record, Registry};
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{DispatchDecision, Driver, EventSink, Task};
use crate::turn_snapshot::{Approval, Provider, SessionKey, TurnSnapshot};
use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

pub type RouteValidity = Arc<dyn Fn(&Ticket, &TurnSnapshot) -> bool + Send + Sync>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerError {
    InvalidSession,
    InvalidPath,
    UnsupportedFork,
    Unavailable,
    Storage,
}
impl OwnerError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidSession => "invalid_session",
            Self::InvalidPath => "invalid_path",
            Self::UnsupportedFork => "unsupported_fork",
            Self::Unavailable => "provider_unavailable",
            Self::Storage => "storage_unavailable",
        }
    }
}
impl std::fmt::Display for OwnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
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
fn yes(record: &Record, name: &str) -> bool {
    record.get(name).is_some_and(|raw| raw.get() == "true")
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
pub struct CodexOwner {
    home: Folder,
    original_home: PathBuf,
    registry: Arc<Mutex<Registry>>,
    driver: Weak<Driver>,
    consent: Arc<Mutex<ConsentStore>>,
    route: RouteValidity,
    // Immutable per-incarnation folder identities prevent a repeated snapshot
    // from legitimizing replacement of a previously captured directory.
    folders: Mutex<HashMap<SessionKey, Folder>>,
}
impl CodexOwner {
    /// Registry and consent must be the shared sole-writer stores opened for
    /// this same trusted home. The callback validates a captured route stamp;
    /// never substitute provider input or an implicit ambient allow decision.
    pub fn new(
        home: PathBuf,
        registry: Arc<Mutex<Registry>>,
        driver: Weak<Driver>,
        consent: Arc<Mutex<ConsentStore>>,
        route: RouteValidity,
    ) -> Result<Arc<Self>, OwnerError> {
        Ok(Arc::new(Self {
            home: folder(&home)?,
            original_home: home,
            registry,
            driver,
            consent,
            route,
            folders: Mutex::new(HashMap::new()),
        }))
    }
    fn home_ok(&self) -> Result<(), OwnerError> {
        if folder(&self.original_home)? != self.home || folder(&self.home.path)? != self.home {
            return Err(OwnerError::InvalidPath);
        }
        Ok(())
    }
    fn record(&self, key: &SessionKey) -> Result<Record, OwnerError> {
        key.validate().map_err(|_| OwnerError::InvalidSession)?;
        let registry = self.registry.lock().map_err(|_| OwnerError::Storage)?;
        let record = registry.find(&key.name).ok_or(OwnerError::InvalidSession)?;
        Self::incarnation(record, key)?;
        Ok(record.clone())
    }
    fn incarnation(record: &Record, key: &SessionKey) -> Result<(), OwnerError> {
        if record.scalar("createdAt").as_deref() != Some(&key.created_at)
            || record.scalar("provider").as_deref() != Some("codex")
            || yes(record, "archived")
        {
            return Err(OwnerError::InvalidSession);
        }
        if yes(record, "forkOnResume") {
            return Err(OwnerError::UnsupportedFork);
        }
        Ok(())
    }
    fn checked(&self, key: &SessionKey, record: &Record) -> Result<TurnSnapshot, OwnerError> {
        self.home_ok()?;
        Self::incarnation(record, key)?;
        let mut snapshot =
            TurnSnapshot::try_from(record).map_err(|_| OwnerError::InvalidSession)?;
        let consent = self
            .consent
            .lock()
            .map_err(|_| OwnerError::Storage)?
            .read()
            .map_err(|_| OwnerError::Storage)?
            .facts();
        snapshot.settings.approval = host_policy::effective_access(&AccessFacts {
            provider: Provider::Codex,
            desired: snapshot.settings.approval,
            effective_inherit_mode: None,
            inherit_seen: None,
            session_grant: (record.scalar("grant").as_deref() == Some("cli-once"))
                .then_some(SessionGrant::CliOnce),
            consent,
        })
        .effective;
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
        {
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
        }
        snapshot.cwd = actual.path;
        snapshot
            .validate()
            .map_err(|_| OwnerError::InvalidSession)?;
        Ok(snapshot)
    }
    pub fn snapshot(&self, key: &SessionKey) -> Result<TurnSnapshot, OwnerError> {
        self.checked(key, &self.record(key)?)
    }
    fn live(&self, ticket: &Ticket) -> Result<TurnSnapshot, OwnerError> {
        self.driver
            .upgrade()
            .and_then(|driver| driver.snapshot_for_dispatch(ticket))
            .ok_or(OwnerError::Unavailable)
    }
    fn route_ok(&self, ticket: &Ticket, initial: &TurnSnapshot) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.route)(ticket, initial)
        }))
        .unwrap_or(false)
    }
    fn gate(&self, ticket: &Ticket, initial: &TurnSnapshot) -> DispatchDecision {
        if self.live(ticket).as_ref() != Ok(initial) || !self.route_ok(ticket, initial) {
            return DispatchDecision::Deny;
        }
        // The route check can reenter cancellation, registry/settings mutation,
        // or shutdown. Reread every authority fact after it, outside its callback.
        if self.live(ticket).as_ref() != Ok(initial) {
            return DispatchDecision::Deny;
        }
        let Ok(current) = self.snapshot(&initial.key) else {
            return DispatchDecision::Deny;
        };
        if current.provider != initial.provider || current.cwd != initial.cwd {
            return DispatchDecision::Deny;
        }
        if rank(current.settings.approval) < rank(initial.settings.approval) {
            DispatchDecision::Restrict(current.settings.approval)
        } else {
            DispatchDecision::Allow
        }
    }
    pub fn services(
        self: &Arc<Self>,
        sink: Arc<dyn EventSink>,
        approval: Option<Arc<dyn ApprovalHandler>>,
    ) -> Services {
        let gate = self.clone();
        let weak = self.driver.clone();
        Services {
            sink,
            approval,
            redactors: Arc::new(|| Box::new(OwnerRedactor)),
            fresh_gate: Arc::new(move |ticket: &Ticket, snapshot: &TurnSnapshot| {
                gate.gate(ticket, snapshot)
            }),
            fatal_storage: Arc::new(move || {
                if let Some(driver) = weak.upgrade() {
                    driver.report_storage_failure();
                }
            }),
            thread_store: Arc::new(OwnerStore(self.clone())),
        }
    }
    fn persist(&self, request: ThreadPrepared) -> Result<ThreadReceipt, ThreadStoreError> {
        let initial = self
            .live(request.ticket())
            .map_err(|_| ThreadStoreError::Rejected)?;
        if initial.key != *request.session()
            || initial.cwd != request.cwd()
            || initial.provider != Provider::Codex
            || !self.route_ok(request.ticket(), &initial)
        {
            return Err(ThreadStoreError::Rejected);
        }
        if self.live(request.ticket()).as_ref() != Ok(&initial) {
            return Err(ThreadStoreError::Rejected);
        }
        let current = self.snapshot(request.session()).map_err(|error| {
            if error == OwnerError::Storage {
                ThreadStoreError::Unknown
            } else {
                ThreadStoreError::Rejected
            }
        })?;
        if current.cwd != request.cwd() {
            return Err(ThreadStoreError::Rejected);
        }
        let mut registry = self
            .registry
            .lock()
            .map_err(|_| ThreadStoreError::Unknown)?;
        // Recheck the current record under the write serialization. Never carry
        // a record snapshot across the transaction or replace unrelated fields.
        let record = registry
            .find(&request.session().name)
            .ok_or(ThreadStoreError::Rejected)?;
        Self::incarnation(record, request.session()).map_err(|_| ThreadStoreError::Rejected)?;
        let stored = TurnSnapshot::try_from(record).map_err(|_| ThreadStoreError::Rejected)?;
        if folder(&stored.cwd)
            .map_err(|_| ThreadStoreError::Rejected)?
            .path
            != request.cwd()
            || self.live(request.ticket()).as_ref() != Ok(&initial)
        {
            return Err(ThreadStoreError::Rejected);
        }
        registry
            .update_checked(request.session(), |record| {
                record.set_string("providerSessionId", request.native_thread_id());
                record.remove("forkOnResume");
                Ok(())
            })
            .map_err(|_| ThreadStoreError::Unknown)?;
        Ok(request.acknowledge())
    }
}
struct OwnerStore(Arc<CodexOwner>);
impl ThreadStore for OwnerStore {
    fn persist(&self, request: ThreadPrepared) -> Task<Result<ThreadReceipt, ThreadStoreError>> {
        let owner = self.0.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || owner.persist(request))
                .await
                .unwrap_or(Err(ThreadStoreError::Unknown))
        })
    }
}
struct OwnerRedactor;
impl Redactor for OwnerRedactor {
    fn redact(&mut self, value: &Value) -> Result<Value, RedactionError> {
        Ok(crate::redaction::redact(value))
    }
}
