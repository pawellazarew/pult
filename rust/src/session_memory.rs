//! Ephemeral, read-only memory authority bound to an owner-registered session.
//! No credential is persisted or reused across daemon restarts.
use crate::history::{Fields, normalize};
use crate::memory::MemoryError;
use crate::session_model::Record;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use subtle::ConstantTimeEq;

const MAX_CONTEXTS: usize = 256;

pub(crate) struct MemoryLease {
    pub session: String,
    pub fingerprint: String,
    pub generation: String,
    pub project_id: Option<String>,
    valid: AtomicBool,
}

impl MemoryLease {
    pub fn is_valid(&self) -> bool {
        self.valid.load(Ordering::Acquire)
    }

    fn invalidate(&self) {
        self.valid.store(false, Ordering::Release);
    }

    fn copy_for_key(&self) -> Self {
        Self {
            session: self.session.clone(),
            fingerprint: self.fingerprint.clone(),
            generation: self.generation.clone(),
            project_id: self.project_id.clone(),
            valid: AtomicBool::new(true),
        }
    }

    /// A lease only exists for enabled access. Disabled registrations use status().
    pub fn public_context(&self) -> Value {
        public_context(self, true)
    }
}

struct Registration {
    lease: Arc<MemoryLease>,
    enabled: bool,
}

struct KeyEntry {
    secret: String,
    lease: Arc<MemoryLease>,
}

#[derive(Default)]
pub(crate) struct SessionMemory {
    registrations: BTreeMap<String, Registration>,
    keys: Vec<KeyEntry>,
}

fn error(code: &'static str, message: impl Into<String>) -> MemoryError {
    MemoryError {
        code,
        message: message.into(),
    }
}

fn random_hex<const N: usize>() -> Result<String, MemoryError> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| error("internal", "cannot create memory credential"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn public_context(lease: &MemoryLease, enabled: bool) -> Value {
    let mut context = json!({
        "session":lease.session, "generation":lease.generation,
        "enabled":enabled, "readOnly":true,
    });
    if let Some(project) = &lease.project_id {
        context["projectId"] = json!(project);
    }
    context
}

impl SessionMemory {
    /// Registration is an explicit owner action. Resolve the project before this call.
    pub fn bind(
        &mut self,
        session: &str,
        fingerprint: String,
        project_id: Option<String>,
        enabled: bool,
    ) -> Result<Value, MemoryError> {
        if !crate::session_model::is_name(session)
            || fingerprint.is_empty()
            || project_id.as_ref().is_some_and(|id| id.is_empty())
        {
            return Err(error(
                "invalid_params",
                "invalid session memory registration",
            ));
        }
        if self.registrations.len() >= MAX_CONTEXTS && !self.registrations.contains_key(session) {
            return Err(error(
                "busy",
                "at most 256 session memory contexts may be registered",
            ));
        }
        // A failed entropy source must leave the previous registration usable.
        let generation = random_hex::<16>()?;
        self.revoke(session);
        let lease = Arc::new(MemoryLease {
            session: session.to_owned(),
            fingerprint,
            generation,
            project_id,
            valid: AtomicBool::new(true),
        });
        let context = public_context(&lease, enabled);
        self.registrations
            .insert(session.to_owned(), Registration { lease, enabled });
        Ok(context)
    }

    /// Owner catalog access does not issue a key or rotate agent credentials.
    pub fn registration(
        &self,
        session: &str,
        fingerprint: &str,
    ) -> Result<Arc<MemoryLease>, MemoryError> {
        let registration = self
            .registrations
            .get(session)
            .ok_or_else(|| error("not_found", "session memory context is not registered"))?;
        if !registration.enabled {
            return Err(error("forbidden", "memory is disabled for this session"));
        }
        if !registration.lease.is_valid() || registration.lease.fingerprint != fingerprint {
            return Err(error(
                "forbidden",
                "session context changed; bind memory again",
            ));
        }
        Ok(registration.lease.clone())
    }

    /// Each issuance rotates the session's old key, but leaves owner access intact.
    pub fn issue(&mut self, session: &str, fingerprint: &str) -> Result<Value, MemoryError> {
        let registration = self.registration(session, fingerprint)?;
        let key = format!("mem_{}", random_hex::<32>()?);
        self.revoke_keys(session);
        let lease = Arc::new(registration.copy_for_key());
        let context = lease.public_context();
        self.keys.push(KeyEntry {
            secret: key.clone(),
            lease,
        });
        Ok(json!({"key":key,"context":context}))
    }

    pub fn revoke(&mut self, session: &str) -> Value {
        let registration = self.registrations.remove(session);
        if let Some(registration) = &registration {
            registration.lease.invalidate();
        }
        let keys = self.revoke_keys(session);
        json!({"revoked":registration.is_some() || keys > 0})
    }

    fn revoke_keys(&mut self, session: &str) -> usize {
        let before = self.keys.len();
        self.keys.retain(|entry| {
            if entry.lease.session == session {
                entry.lease.invalidate();
                false
            } else {
                true
            }
        });
        before - self.keys.len()
    }

    pub fn revoke_all(&mut self) {
        for registration in self.registrations.values() {
            registration.lease.invalidate();
        }
        for entry in &self.keys {
            entry.lease.invalidate();
        }
        self.registrations.clear();
        self.keys.clear();
    }

    pub fn status(&self, session: Option<&str>) -> Value {
        let contexts: Vec<_> = self
            .registrations
            .iter()
            .filter(|(name, _)| session.is_none_or(|wanted| wanted == name.as_str()))
            .map(|(_, registration)| public_context(&registration.lease, registration.enabled))
            .collect();
        json!({"contexts":contexts})
    }

    pub fn lookup(&self, key: &str) -> Option<Arc<MemoryLease>> {
        if key.len() != 68
            || !key.starts_with("mem_")
            || !key.as_bytes()[4..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return None;
        }
        // Match every entry without a secret-prefix-dependent HashMap lookup or
        // early return. Clone once, after the fixed scan has finished.
        let mut found = None;
        for (index, entry) in self.keys.iter().enumerate() {
            if bool::from(entry.secret.as_bytes().ct_eq(key.as_bytes())) && entry.lease.is_valid() {
                found = Some(index);
            }
        }
        found.map(|index| self.keys[index].lease.clone())
    }
}

impl Drop for SessionMemory {
    fn drop(&mut self) {
        self.revoke_all();
    }
}

/// Only fields that establish authority participate. Routine title/read-status
/// edits must not revoke a key. Values remain lossless JSON, including UTF-16.
pub(crate) fn fingerprint(record: &Record) -> Result<String, MemoryError> {
    let name = record
        .scalar("name")
        .filter(|name| crate::session_model::is_name(name))
        .ok_or_else(|| {
            error(
                "invalid_params",
                "session memory needs a valid session name",
            )
        })?;
    let provider = record
        .scalar("provider")
        .filter(|provider| matches!(provider.as_str(), "claude" | "codex" | "zcode"))
        .ok_or_else(|| error("invalid_params", "session memory needs a known provider"))?;
    for field in ["createdAt", "cwd"] {
        if record.string(field).is_none_or(|value| value.is_empty()) {
            return Err(error(
                "invalid_params",
                format!("session memory needs {field}"),
            ));
        }
    }
    if record.get("scope").is_some()
        && !matches!(
            record.scalar("scope").as_deref(),
            Some("general" | "project")
        )
    {
        return Err(error(
            "invalid_params",
            "session memory has an unknown scope",
        ));
    }
    if record.get("approval").is_some()
        && !matches!(
            record.scalar("approval").as_deref(),
            Some("read-only" | "ask" | "workspace" | "full" | "inherit")
        )
    {
        return Err(error(
            "invalid_params",
            "session memory has an unknown access mode",
        ));
    }
    let mut fields = Fields::default();
    for field in [
        "name",
        "createdAt",
        "provider",
        "scope",
        "cwd",
        "worktree",
        "approval",
    ] {
        if let Some(value) = record.get(field) {
            fields.set(
                field,
                normalize(value)
                    .map_err(|_| error("invalid_params", "invalid session context JSON"))?,
            );
        }
    }
    // Keep validation variables explicit without coercing the raw stored strings.
    let _ = (name, provider);
    fields
        .into_raw()
        .map(|raw| raw.get().to_owned())
        .map_err(|_| error("internal", "cannot encode session memory context"))
}

pub(crate) fn validate_record(record: &Record, lease: &MemoryLease) -> Result<(), MemoryError> {
    if !lease.is_valid() {
        return Err(error("forbidden", "memory credential was revoked"));
    }
    let archived = record
        .get("archived")
        .map(|raw| serde_json::from_str::<bool>(raw.get()))
        .transpose()
        .map_err(|_| error("forbidden", "invalid session archive state"))?
        .unwrap_or(false);
    if archived
        || record.scalar("name").as_deref() != Some(lease.session.as_str())
        || fingerprint(record)
            .map_err(|_| error("forbidden", "session memory context is invalid"))?
            != lease.fingerprint
    {
        return Err(error(
            "forbidden",
            "session memory context changed or was archived",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        let mut record = Record::default();
        for (name, value) in [
            ("name", "chat"),
            ("provider", "codex"),
            ("createdAt", "2026-01-01T00:00:00Z"),
            ("cwd", "/project"),
            ("approval", "ask"),
        ] {
            record.set_string(name, value);
        }
        record
    }
    fn bound() -> (SessionMemory, Record) {
        let record = record();
        let mut service = SessionMemory::default();
        service
            .bind(
                "chat",
                fingerprint(&record).unwrap(),
                Some("git:/repo/.git".into()),
                true,
            )
            .unwrap();
        (service, record)
    }
    fn issue(service: &mut SessionMemory, record: &Record) -> (String, Arc<MemoryLease>) {
        let value = service
            .issue("chat", &fingerprint(record).unwrap())
            .unwrap();
        let key = value["key"].as_str().unwrap().to_owned();
        let lease = service.lookup(&key).unwrap();
        (key, lease)
    }

    #[test]
    fn issuance_rotates_keys_without_invalidating_owner_registration() {
        let (mut service, record) = bound();
        let owner = service
            .registration("chat", &fingerprint(&record).unwrap())
            .unwrap();
        let (key, first) = issue(&mut service, &record);
        assert_eq!(key.len(), 68);
        assert_eq!(first.generation.len(), 32);
        assert!(first.is_valid());
        let (next, second) = issue(&mut service, &record);
        assert_ne!(key, next);
        assert!(service.lookup(&key).is_none());
        assert!(!first.is_valid());
        assert!(second.is_valid());
        assert!(owner.is_valid());
        assert_eq!(first.generation, second.generation);
        assert_eq!(second.public_context()["readOnly"], true);
    }

    #[test]
    fn rebind_revoke_and_drop_invalidate_outstanding_leases() {
        let (mut service, record) = bound();
        let owner = service
            .registration("chat", &fingerprint(&record).unwrap())
            .unwrap();
        let (old, lease) = issue(&mut service, &record);
        let generation = lease.generation.clone();
        service
            .bind("chat", fingerprint(&record).unwrap(), None, true)
            .unwrap();
        assert!(!owner.is_valid());
        assert!(!lease.is_valid());
        assert!(service.lookup(&old).is_none());
        let (_, lease) = issue(&mut service, &record);
        assert_ne!(generation, lease.generation);
        assert_eq!(lease.project_id, None);
        assert_eq!(service.revoke("chat"), json!({"revoked":true}));
        assert!(!lease.is_valid());
        assert_eq!(service.revoke("chat"), json!({"revoked":false}));
        service
            .bind("chat", fingerprint(&record).unwrap(), None, true)
            .unwrap();
        let owner = service
            .registration("chat", &fingerprint(&record).unwrap())
            .unwrap();
        let (_, lease) = issue(&mut service, &record);
        drop(service);
        assert!(!owner.is_valid());
        assert!(!lease.is_valid());
    }

    #[test]
    fn disabled_context_never_issues_a_key_or_owner_catalog_lease() {
        let mut service = SessionMemory::default();
        service.bind("chat", "fp".into(), None, false).unwrap();
        assert_eq!(service.issue("chat", "fp").unwrap_err().code, "forbidden");
        assert!(service.registration("chat", "fp").is_err());
        assert_eq!(
            service.status(None),
            json!({"contexts":[{"session":"chat","generation":service.status(None)["contexts"][0]["generation"],"enabled":false,"readOnly":true}]})
        );
        assert!(
            service.status(Some("other"))["contexts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn credentials_are_strictly_shaped_and_never_exposed_by_status() {
        let (mut service, record) = bound();
        let (key, _) = issue(&mut service, &record);
        for invalid in [
            "".to_owned(),
            "a".repeat(68),
            key.to_uppercase(),
            format!("{key}x"),
            format!("mem_{}", "é".repeat(32)),
            format!("mem_{}", "A".repeat(64)),
        ] {
            assert!(service.lookup(&invalid).is_none());
        }
        assert!(!service.status(None).to_string().contains(&key));
        assert!(!service.status(None).to_string().contains("fingerprint"));
        assert!(
            service.status(None)["contexts"][0]
                .get("projectId")
                .is_some()
        );
    }

    #[test]
    fn live_authority_changes_invalidate_but_metadata_edits_do_not() {
        let (mut service, record) = bound();
        let (_, lease) = issue(&mut service, &record);
        validate_record(&record, &lease).unwrap();
        let mut metadata = record.clone();
        metadata.set_string("title", "New title");
        metadata.set_number("lastSeenEventId", 12.0);
        assert_eq!(
            fingerprint(&record).unwrap(),
            fingerprint(&metadata).unwrap()
        );
        validate_record(&metadata, &lease).unwrap();
        for (name, value) in [
            ("name", "other"),
            ("provider", "claude"),
            ("cwd", "/different"),
            ("createdAt", "2026-01-02"),
            ("scope", "general"),
            ("approval", "read-only"),
        ] {
            let mut changed = record.clone();
            changed.set_string(name, value);
            assert_eq!(
                validate_record(&changed, &lease).unwrap_err().code,
                "forbidden"
            );
        }
        let mut archived = record.clone();
        archived.set_bool("archived", true);
        assert!(validate_record(&archived, &lease).is_err());
        assert_eq!(
            service.issue("chat", "changed").unwrap_err().code,
            "forbidden"
        );
    }

    #[test]
    fn fingerprint_preserves_utf16_and_worktree_changes() {
        let (mut service, mut record) = bound();
        record.set_units("cwd", &[47, 0xd800]);
        record.set_raw(
            "worktree",
            serde_json::value::RawValue::from_string(
                r#"{"repo":"/repo","path":"/work\ud800","branch":"topic"}"#.into(),
            )
            .unwrap(),
        );
        let fp = fingerprint(&record).unwrap();
        assert!(fp.contains("\\ud800"));
        service
            .bind("chat", fp, Some("git:/repo/.git".into()), true)
            .unwrap();
        let (_, lease) = issue(&mut service, &record);
        validate_record(&record, &lease).unwrap();
        record.set_raw(
            "worktree",
            serde_json::value::RawValue::from_string(
                r#"{"repo":"/other","path":"/work\ud800","branch":"topic"}"#.into(),
            )
            .unwrap(),
        );
        assert!(validate_record(&record, &lease).is_err());
    }

    #[test]
    fn malformed_or_incomplete_identity_fails_closed() {
        for field in ["name", "provider", "createdAt", "cwd"] {
            let mut missing = record();
            missing.remove(field);
            assert!(fingerprint(&missing).is_err());
        }
        let mut unknown = record();
        unknown.set_string("approval", "future");
        assert!(fingerprint(&unknown).is_err());
        let mut service = SessionMemory::default();
        assert!(service.bind("BAD", "fp".into(), None, true).is_err());
        assert!(service.bind("chat", String::new(), None, true).is_err());
        assert!(
            service
                .bind("chat", "fp".into(), Some(String::new()), true)
                .is_err()
        );
        assert_eq!(
            service.issue("missing", "fp").unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn registration_limit_allows_replacement_and_releases_capacity_on_revoke() {
        let mut service = SessionMemory::default();
        for index in 0..MAX_CONTEXTS {
            service
                .bind(&format!("chat-{index}"), "fp".into(), None, true)
                .unwrap();
        }
        assert_eq!(
            service
                .bind("extra", "fp".into(), None, true)
                .unwrap_err()
                .code,
            "busy"
        );
        service.bind("chat-0", "next".into(), None, true).unwrap();
        service.revoke("chat-1");
        service.bind("extra", "fp".into(), None, true).unwrap();
        assert_eq!(
            service.status(None)["contexts"].as_array().unwrap().len(),
            MAX_CONTEXTS
        );
    }

    #[test]
    fn rotating_one_session_does_not_change_another_sessions_authority() {
        let mut service = SessionMemory::default();
        service
            .bind("one", "fp-one".into(), Some("git:/one".into()), true)
            .unwrap();
        service
            .bind("two", "fp-two".into(), Some("git:/two".into()), true)
            .unwrap();
        let first_key = service.issue("one", "fp-one").unwrap()["key"]
            .as_str()
            .unwrap()
            .to_owned();
        let second_key = service.issue("two", "fp-two").unwrap()["key"]
            .as_str()
            .unwrap()
            .to_owned();
        let second = service.lookup(&second_key).unwrap();
        service.issue("one", "fp-one").unwrap();
        assert!(service.lookup(&first_key).is_none());
        assert!(second.is_valid());
        assert_eq!(service.lookup(&second_key).unwrap().session, "two");
        service.revoke("one");
        assert!(service.lookup(&second_key).is_some());
        assert_eq!(second.project_id.as_deref(), Some("git:/two"));
    }
}
