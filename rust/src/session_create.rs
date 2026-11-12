//! Trusted synchronous metadata creation. Run via an owned blocking job. Registry
//! and ConsentStore must be the shared sole-writer stores for this same home.
//! Consent -> Registry is the lock order; no provider or callbacks run here.
//! Unsupported start/draft/folder/browser flows fail before mutations. Existing
//! general roots must already be private (no implicit chmod). A failed general
//! creation/commit may leave a private orphan: never remove an uncertain commit's
//! folder or recursively clean a path which another process could replace.
//! This creates metadata only; fresh dispatch policy and folder identity checks
//! remain mandatory before execution. Value decoding must reject lone surrogates.
use crate::consent_store::ConsentStore;
pub use crate::host_policy::ClientKind;
use crate::host_policy::{self, AccessFacts, SelectionConfirmation, SessionGrant};
use crate::registry::{Record, Registry};
use crate::turn_snapshot::{
    Approval, Provider, ServiceTier, SessionKey, TurnSettings, TurnSnapshot,
};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, Ordering},
};
const SAFE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateError {
    Invalid,
    Unsupported,
    Duplicate,
    Storage,
    Forbidden,
    ConsentRequired,
    ConsentChanged,
    Unavailable,
}
impl CreateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid_params",
            Self::Unsupported => "not_implemented",
            Self::Duplicate => "already_exists",
            Self::Storage => "storage_unavailable",
            Self::Forbidden => "forbidden",
            Self::ConsentRequired => "consent_required",
            Self::ConsentChanged => "consent_changed",
            Self::Unavailable => "unavailable",
        }
    }
}
impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for CreateError {}
impl From<host_policy::PolicyError> for CreateError {
    fn from(e: host_policy::PolicyError) -> Self {
        match e {
            host_policy::PolicyError::InvalidParams => Self::Invalid,
            host_policy::PolicyError::Forbidden => Self::Forbidden,
            host_policy::PolicyError::ConsentRequired => Self::ConsentRequired,
            host_policy::PolicyError::ConsentChanged => Self::ConsentChanged,
        }
    }
}
fn optional<'a>(p: &'a Value, key: &str) -> Result<Option<&'a str>, CreateError> {
    p.get(key)
        .map(|v| v.as_str().ok_or(CreateError::Invalid))
        .transpose()
}
fn random_suffix(length: usize) -> Result<String, CreateError> {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::with_capacity(length);
    while out.len() < length {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| CreateError::Unavailable)?;
        for byte in bytes {
            if byte < 248 {
                out.push(ABC[(byte % 62) as usize] as char);
                if out.len() == length {
                    break;
                }
            }
        }
    }
    Ok(out)
}
fn created_at() -> Result<String, CreateError> {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = Utc::now()
        .timestamp_nanos_opt()
        .filter(|v| *v > 0)
        .ok_or(CreateError::Unavailable)? as u64;
    let old = LAST
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |old| {
            Some(now.max(old.checked_add(1)?))
        })
        .map_err(|_| CreateError::Unavailable)?;
    let next = now.max(old + 1);
    let next = i64::try_from(next).map_err(|_| CreateError::Unavailable)?;
    Ok(Utc
        .timestamp_nanos(next)
        .to_rfc3339_opts(SecondsFormat::Nanos, true))
}
fn private(path: &Path) -> Result<(), CreateError> {
    let m = fs::symlink_metadata(path).map_err(|_| CreateError::Invalid)?;
    if !m.is_dir()
        || m.file_type().is_symlink()
        || m.uid() != nix::unistd::geteuid().as_raw()
        || m.permissions().mode() & 0o777 != 0o700
    {
        return Err(CreateError::Invalid);
    }
    Ok(())
}
fn general(home: &Path, name: &str) -> Result<PathBuf, CreateError> {
    let root = home.join("conversations");
    match fs::DirBuilder::new().mode(0o700).create(&root) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(CreateError::Storage),
    }
    private(&root)?;
    if root.canonicalize().map_err(|_| CreateError::Invalid)? != root {
        return Err(CreateError::Invalid);
    }
    for _ in 0..32 {
        let child = root.join(format!("{name}-{}", random_suffix(6)?));
        match fs::DirBuilder::new().mode(0o700).create(&child) {
            Ok(()) => {
                crate::host_paths::validate_general(home, name, &child)
                    .map_err(|_| CreateError::Invalid)?;
                return Ok(child);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(CreateError::Storage),
        }
    }
    Err(CreateError::Unavailable)
}
pub fn create(
    home: &Path,
    registry: &Arc<Mutex<Registry>>,
    consent: &Arc<Mutex<ConsentStore>>,
    params: &Value,
    client: ClientKind,
    last_journal_id: u64,
) -> Result<Record, CreateError> {
    let fields = params.as_object().ok_or(CreateError::Invalid)?;
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "kind"
                | "name"
                | "cwd"
                | "scope"
                | "title"
                | "model"
                | "effort"
                | "serviceTier"
                | "mode"
                | "approval"
                | "confirm"
                | "consentRev"
                | "grant"
                | "browser"
        )
    }) {
        return Err(CreateError::Unsupported);
    }
    if params
        .get("browser")
        .is_some_and(|v| !v.is_null() && *v != false)
    {
        return Err(CreateError::Unsupported);
    }
    let provider = match optional(params, "kind")? {
        None | Some("claude") => Provider::Claude,
        Some("codex") => Provider::Codex,
        Some("zcode") => Provider::Zcode,
        _ => return Err(CreateError::Invalid),
    };
    let approval = match optional(params, "approval")? {
        None | Some("ask") => Approval::Ask,
        Some("read-only") => Approval::ReadOnly,
        Some("workspace") => Approval::Workspace,
        Some("full") => Approval::Full,
        Some("inherit") => return Err(CreateError::Unsupported),
        _ => return Err(CreateError::Invalid),
    };
    let requested_grant = match optional(params, "grant")? {
        None => None,
        Some("cli-once") => Some(SessionGrant::CliOnce),
        _ => return Err(CreateError::Invalid),
    };
    let confirm = params
        .get("confirm")
        .map(|v| v.as_bool().ok_or(CreateError::Invalid))
        .transpose()?
        .unwrap_or(false);
    let rev = params
        .get("consentRev")
        .map(|v| {
            v.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= SAFE as f64)
                .map(|n| n as u64)
                .ok_or(CreateError::Invalid)
        })
        .transpose()?;
    let selection = SelectionConfirmation {
        confirm,
        consent_rev: rev,
        requested_grant,
        client,
    };
    host_policy::validate_selection_source(selection)?;
    if last_journal_id > SAFE {
        return Err(CreateError::Invalid);
    }
    let explicit_name = optional(params, "name")?;
    if explicit_name.is_some_and(|name| !crate::session_model::is_name(name)) {
        return Err(CreateError::Invalid);
    }
    let mode = match optional(params, "mode")? {
        None | Some("turn") => "turn",
        Some("warm") => "warm",
        _ => return Err(CreateError::Invalid),
    };
    let scope = match optional(params, "scope")? {
        None | Some("project") => "project",
        Some("general") => "general",
        _ => return Err(CreateError::Invalid),
    };
    let cwd = optional(params, "cwd")?;
    if scope == "general" && cwd.is_some() {
        return Err(CreateError::Invalid);
    }
    let settings = TurnSettings {
        approval,
        model: optional(params, "model")?.map(str::to_owned),
        effort: optional(params, "effort")?.map(str::to_owned),
        service_tier: match optional(params, "serviceTier")? {
            None => None,
            Some("default") => Some(ServiceTier::Default),
            Some("fast") => Some(ServiceTier::Fast),
            _ => return Err(CreateError::Invalid),
        },
        browser: None,
    };
    settings
        .validate(provider)
        .map_err(|_| CreateError::Invalid)?;
    let title = optional(params, "title")?
        .and_then(|s| crate::session_model::normalize_title(&s.encode_utf16().collect::<Vec<_>>()));
    if title
        .as_deref()
        .is_some_and(|t| crate::session_model::title_length(t) > 200)
    {
        return Err(CreateError::Invalid);
    }
    if !home.is_absolute() {
        return Err(CreateError::Invalid);
    }
    let home = home.canonicalize().map_err(|_| CreateError::Invalid)?;
    private(&home)?;
    let project = if scope == "project" {
        let cwd = Path::new(cwd.ok_or(CreateError::Invalid)?);
        if !cwd.is_absolute() {
            return Err(CreateError::Invalid);
        }
        let cwd = cwd.canonicalize().map_err(|_| CreateError::Invalid)?;
        if !cwd.is_dir() {
            return Err(CreateError::Invalid);
        }
        if approval != Approval::ReadOnly
            && crate::host_paths::covers_pult_home(&cwd, &home).map_err(|_| CreateError::Invalid)?
        {
            return Err(CreateError::Invalid);
        }
        Some(cwd)
    } else {
        None
    };
    let mut consent = consent.lock().map_err(|_| CreateError::Storage)?;
    let facts = consent.read().map_err(|_| CreateError::Storage)?.facts();
    let grant = host_policy::validate_full_selection(
        &AccessFacts {
            provider,
            desired: approval,
            effective_inherit_mode: None,
            inherit_seen: None,
            session_grant: None,
            consent: facts,
        },
        selection,
    )?;
    let mut registry = registry.lock().map_err(|_| CreateError::Storage)?;
    let name = if let Some(name) = explicit_name {
        if registry.find(name).is_some() {
            return Err(CreateError::Duplicate);
        }
        name.to_owned()
    } else {
        let mut found = None;
        for _ in 0..32 {
            let name = format!("chat-{}", random_suffix(12)?.to_ascii_lowercase());
            if registry.find(&name).is_none() {
                found = Some(name);
                break;
            }
        }
        found.ok_or(CreateError::Unavailable)?
    };
    let cwd = match project {
        Some(cwd) => cwd,
        None => general(&home, &name)?,
    };
    let created = created_at()?;
    let snapshot = TurnSnapshot {
        key: SessionKey {
            name: name.clone(),
            created_at: created.clone(),
        },
        provider,
        cwd: cwd.clone(),
        settings,
    };
    snapshot.validate().map_err(|_| CreateError::Invalid)?;
    let mut record = Record::default();
    for (key, value) in [
        ("name", name.as_str()),
        ("provider", provider.as_str()),
        ("cwd", cwd.to_str().ok_or(CreateError::Invalid)?),
        ("mode", mode),
        ("createdAt", created.as_str()),
        ("lastStatus", "cold"),
    ] {
        record.set_string(key, value);
    }
    if scope == "general" {
        record.set_string("scope", "general");
    }
    if approval != Approval::Ask {
        record.set_string("approval", optional(params, "approval")?.unwrap());
    }
    for key in ["model", "effort", "serviceTier"] {
        if let Some(value) = optional(params, key)? {
            record.set_string(key, value);
        }
    }
    if let Some(title) = title {
        record.set_string(
            "title",
            &String::from_utf16(&title).map_err(|_| CreateError::Invalid)?,
        );
    }
    if grant == Some(SessionGrant::CliOnce) {
        record.set_string("grant", "cli-once");
    }
    record.set_number("lastEventId", 0.0);
    record.set_number("lastSeenEventId", last_journal_id as f64);
    registry.insert(record).map_err(|_| CreateError::Storage)
}
