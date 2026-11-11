//! Provider-independent durable memories. Current records, audit snapshots and
//! successful command receipts share one SQLite transaction.
use anyhow::{Result, ensure};
use chrono::{SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

const APPLICATION_ID: i64 = 0x504d454d; // PMEM
const SCHEMA_VERSION: i64 = 1;
const PAGE_BYTES: usize = 512 * 1024;
const MAX_VERSION: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Default)]
pub(crate) struct Context {
    pub project_id: Option<String>,
    pub session: Option<String>,
}

#[derive(Debug)]
pub(crate) struct MemoryError {
    pub code: &'static str,
    pub message: String,
}
impl fmt::Display for MemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for MemoryError {}
type MemoryResult<T> = std::result::Result<T, MemoryError>;
fn error(code: &'static str, message: impl Into<String>) -> MemoryError {
    MemoryError {
        code,
        message: message.into(),
    }
}
fn internal(error: impl fmt::Display) -> MemoryError {
    self::error("internal", error.to_string())
}
fn invalid(message: impl Into<String>) -> MemoryError {
    error("invalid_params", message)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    id: String,
    scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    name: String,
    summary: String,
    details: String,
    pinned: bool,
    version: i64,
    created_at: String,
    updated_at: String,
    deleted: bool,
    author: String,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_session: Option<String>,
}
impl Record {
    fn validate(&self) -> MemoryResult<()> {
        identifier(&self.id, "stored id")?;
        if !(1..=MAX_VERSION).contains(&self.version)
            || self.author != "owner"
            || !matches!(self.scope.as_str(), "global" | "project")
            || (self.scope == "project") != self.project_id.is_some()
        {
            return Err(internal("invalid stored memory metadata"));
        }
        for (name, value, limit, nonempty) in [
            ("name", self.name.as_str(), 120, true),
            ("summary", self.summary.as_str(), 500, true),
            ("details", self.details.as_str(), 16000, false),
            ("reason", self.reason.as_str(), 1000, true),
        ] {
            bounded(value, name, limit, nonempty).map_err(internal)?;
        }
        Ok(())
    }
    fn value(&self) -> MemoryResult<Value> {
        serde_json::to_value(self).map_err(internal)
    }
    fn summary_value(&self) -> MemoryResult<Value> {
        let mut value = self.value()?;
        value
            .as_object_mut()
            .expect("record serializes as object")
            .remove("details");
        Ok(value)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
}
impl Identity {
    fn of(metadata: &fs::Metadata) -> Self {
        Self {
            dev: metadata.dev(),
            ino: metadata.ino(),
        }
    }
}

pub(crate) struct MemoryStore {
    connection: Connection,
    directory: PathBuf,
    database: PathBuf,
    directory_identity: Identity,
    database_identity: Identity,
    owner: u32,
}

fn directory_metadata(path: &Path, owner: u32) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir()
            && !metadata.file_type().is_symlink()
            && metadata.permissions().mode() & 0o077 == 0
            && metadata.uid() == owner,
        "{} must be a private owned directory without symlinks",
        path.display()
    );
    Ok(metadata)
}
fn file_metadata(path: &Path, owner: u32) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.nlink() == 1
            && metadata.permissions().mode() & 0o077 == 0
            && metadata.uid() == owner,
        "{} must be a private owned regular file without links",
        path.display()
    );
    Ok(metadata)
}
fn check_sidecars(database: &Path, owner: u32) -> Result<()> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let path = PathBuf::from(format!("{}{suffix}", database.display()));
        match fs::symlink_metadata(&path) {
            Ok(_) => {
                file_metadata(&path, owner)?;
                ensure!(
                    suffix == "-journal",
                    "unexpected WAL sidecar in DELETE-mode memory store"
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

impl MemoryStore {
    pub(crate) fn open(home: &Path) -> Result<Self> {
        let home_metadata = fs::symlink_metadata(home)?;
        let owner = home_metadata.uid();
        directory_metadata(home, owner)?;
        // macOS exposes /var and /tmp as parent symlinks; SQLite NOFOLLOW also
        // rejects these aliases. Resolve parents only after rejecting a symlink home.
        let home = fs::canonicalize(home)?;
        let directory = home.join("memory");
        match fs::DirBuilder::new().mode(0o700).create(&directory) {
            Ok(()) => File::open(&home)?.sync_all()?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let directory_identity = Identity::of(&directory_metadata(&directory, owner)?);
        let database = directory.join("memory.sqlite3");
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&database)
        {
            Ok(file) => {
                file.sync_all()?;
                File::open(&directory)?.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let database_identity = Identity::of(&file_metadata(&database, owner)?);
        // Check ownership before SQLite has a chance to recover a hot journal.
        // An unknown application must never be modified merely by opening it.
        let mut header_file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(&database)?;
        if header_file.metadata()?.len() > 0 {
            let mut header = [0u8; 100];
            header_file.read_exact(&mut header)?;
            ensure!(
                &header[..16] == b"SQLite format 3\0",
                "invalid memory database header"
            );
            let version =
                u32::from_be_bytes(header[60..64].try_into().expect("fixed header slice"));
            let application =
                u32::from_be_bytes(header[68..72].try_into().expect("fixed header slice"));
            ensure!(
                i64::from(application) == APPLICATION_ID && i64::from(version) == SCHEMA_VERSION,
                "unsupported memory database header application/schema version {application}/{version}"
            );
        }
        check_sidecars(&database, owner)?;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW;
        let mut connection = Connection::open_with_flags(&database, flags)?;
        connection.busy_timeout(Duration::from_secs(2))?;
        let application: i64 =
            connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version == 0 && application == 0 {
            let objects: i64 = connection.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )?;
            ensure!(
                objects == 0,
                "unversioned memory database contains foreign objects"
            );
            connection.pragma_update(None, "journal_mode", "DELETE")?;
            connection.pragma_update(None, "synchronous", "FULL")?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            transaction.execute_batch("CREATE TABLE memories (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('project','global')),
                project_id TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL,
                pinned INTEGER NOT NULL, updated_at TEXT NOT NULL, record TEXT NOT NULL,
                CHECK((scope='project' AND project_id IS NOT NULL) OR (scope='global' AND project_id IS NULL))
            );
            CREATE INDEX memories_scope ON memories(scope,project_id,deleted,pinned,updated_at,id);
            CREATE TABLE memory_history (
                memory_id TEXT NOT NULL REFERENCES memories(id), version INTEGER NOT NULL,
                snapshot TEXT NOT NULL, PRIMARY KEY(memory_id,version)
            );
            CREATE TABLE memory_receipts (command_id TEXT PRIMARY KEY, request TEXT NOT NULL, response TEXT NOT NULL);
            CREATE VIRTUAL TABLE memory_fts USING fts5(id UNINDEXED,name,summary,details,tokenize='unicode61');")?;
            transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            transaction.commit()?;
            File::open(&directory)?.sync_all()?;
        } else {
            ensure!(
                application == APPLICATION_ID && version == SCHEMA_VERSION,
                "unsupported memory database application/schema version {application}/{version}"
            );
            let journal: String =
                connection.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
            ensure!(
                journal.eq_ignore_ascii_case("delete"),
                "memory database must use DELETE journaling"
            );
            connection.pragma_update(None, "synchronous", "FULL")?;
        }
        connection.pragma_update(None, "foreign_keys", true)?;
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        ensure!(
            integrity == "ok",
            "memory database integrity check failed: {integrity}"
        );
        connection.prepare("SELECT id,scope,project_id,version,deleted,pinned,updated_at,record FROM memories LIMIT 0")?;
        connection.prepare("SELECT memory_id,version,snapshot FROM memory_history LIMIT 0")?;
        connection.prepare("SELECT command_id,request,response FROM memory_receipts LIMIT 0")?;
        connection.prepare("SELECT id,name,summary,details FROM memory_fts LIMIT 0")?;
        let store = Self {
            connection,
            directory,
            database,
            directory_identity,
            database_identity,
            owner,
        };
        store.check_paths()?;
        Ok(store)
    }

    fn check_paths(&self) -> Result<()> {
        ensure!(
            Identity::of(&directory_metadata(&self.directory, self.owner)?)
                == self.directory_identity,
            "memory directory changed outside its owner"
        );
        ensure!(
            Identity::of(&file_metadata(&self.database, self.owner)?) == self.database_identity,
            "memory database changed outside its owner"
        );
        check_sidecars(&self.database, self.owner)
    }

    pub(crate) fn execute(
        &mut self,
        method: &str,
        params: &Value,
        context: &Context,
    ) -> MemoryResult<Value> {
        self.check_paths().map_err(internal)?;
        let params = params
            .as_object()
            .ok_or_else(|| invalid("memory params must be an object"))?;
        if params
            .get("session")
            .is_some_and(|value| !value.is_string())
        {
            return Err(invalid("session must be a string"));
        }
        let result = match method {
            "memory.add" | "memory.update" | "memory.forget" => {
                self.mutate(method, params, context)
            }
            "memory.get" => {
                keys(params, &["id", "scope", "session"])?;
                let filter = Filter::new(params, context, false)?;
                let id = required_identifier(params, "id")?;
                let record = find(&self.connection, id, &filter)?
                    .filter(|r| !r.deleted && filter.contains(r))
                    .ok_or_else(|| error("not_found", "memory not found"))?;
                record.value()
            }
            "memory.list" | "memory.search" => self.list(method, params, context),
            "memory.history" => self.history(params, context),
            _ => Err(error("not_found", "unknown memory method")),
        };
        self.check_paths().map_err(internal)?;
        result
    }

    fn mutate(
        &mut self,
        method: &str,
        params: &Map<String, Value>,
        context: &Context,
    ) -> MemoryResult<Value> {
        let allowed: &[&str] = match method {
            "memory.add" => &[
                "commandId",
                "name",
                "summary",
                "details",
                "reason",
                "scope",
                "pinned",
                "session",
            ],
            "memory.update" => &[
                "commandId",
                "id",
                "expectedVersion",
                "reason",
                "name",
                "summary",
                "details",
                "pinned",
                "scope",
                "session",
            ],
            _ => &[
                "commandId",
                "id",
                "expectedVersion",
                "reason",
                "scope",
                "session",
            ],
        };
        keys(params, allowed)?;
        let command_id = required_identifier(params, "commandId")?;
        let request = json!({"method":method,"params":params,"context":{"projectId":context.project_id,"session":context.session}}).to_string();
        let filter = Filter::new(params, context, true)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(internal)?;
        if let Some((previous, response)) = transaction
            .query_row(
                "SELECT request,response FROM memory_receipts WHERE command_id=?1",
                [command_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(internal)?
        {
            if previous != request {
                return Err(error(
                    "command_conflict",
                    "commandId was already used with a different request or context",
                ));
            }
            let record: Record = serde_json::from_str(&response).map_err(internal)?;
            record.validate().map_err(internal)?;
            if !filter.contains(&record) || record.source_session != context.session {
                return Err(internal("memory receipt scope or source is inconsistent"));
            }
            let valid_operation = if method == "memory.add" {
                record.version == 1 && !record.deleted
            } else {
                let id = required_identifier(params, "id").map_err(internal)?;
                let expected = integer(params, "expectedVersion", 1, MAX_VERSION)
                    .map_err(internal)?
                    .ok_or_else(|| internal("memory receipt is missing expectedVersion"))?;
                record.id == id
                    && record.version == expected + 1
                    && record.deleted == (method == "memory.forget")
            };
            if !valid_operation {
                return Err(internal(
                    "memory receipt operation metadata is inconsistent",
                ));
            }
            if record.reason != text(params, "reason", 1000, true).map_err(internal)? {
                return Err(internal("memory receipt reason is inconsistent"));
            }
            for (field, actual, limit, nonempty) in [
                ("name", record.name.as_str(), 120, true),
                ("summary", record.summary.as_str(), 500, true),
                ("details", record.details.as_str(), 16000, false),
            ] {
                if (method == "memory.add" || params.contains_key(field))
                    && actual != text(params, field, limit, nonempty).map_err(internal)?
                {
                    return Err(internal("memory receipt content is inconsistent"));
                }
            }
            let expected_pinned = boolean(params, "pinned").map_err(internal)?;
            if expected_pinned.is_some_and(|pinned| pinned != record.pinned)
                || (method == "memory.add" && record.pinned != expected_pinned.unwrap_or(false))
            {
                return Err(internal("memory receipt pin state is inconsistent"));
            }
            let snapshot: String = transaction
                .query_row(
                    "SELECT snapshot FROM memory_history WHERE memory_id=?1 AND version=?2",
                    params![record.id, record.version],
                    |row| row.get(0),
                )
                .optional()
                .map_err(internal)?
                .ok_or_else(|| internal("memory receipt has no matching history snapshot"))?;
            let snapshot: Value = serde_json::from_str(&snapshot).map_err(internal)?;
            let response = record.value()?;
            if snapshot != response {
                return Err(internal("memory receipt differs from its history snapshot"));
            }
            return Ok(response);
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let reason = text(params, "reason", 1000, true)?;
        let record = if method == "memory.add" {
            let (scope, project_id) = match filter.mode {
                "global" => ("global".to_owned(), None),
                "project" => ("project".to_owned(), filter.project.clone()),
                _ => return Err(invalid("add scope must be project or global")),
            };
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(internal)?;
            Record {
                id: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
                scope,
                project_id,
                name: text(params, "name", 120, true)?,
                summary: text(params, "summary", 500, true)?,
                details: text(params, "details", 16000, false)?,
                pinned: boolean(params, "pinned")?.unwrap_or(false),
                version: 1,
                created_at: now.clone(),
                updated_at: now,
                deleted: false,
                author: "owner".into(),
                reason,
                source_session: context.session.clone(),
            }
        } else {
            let id = required_identifier(params, "id")?;
            let mut record = find(&transaction, id, &filter)?
                .filter(|record| !record.deleted && filter.contains(record))
                .ok_or_else(|| error("not_found", "memory not found"))?;
            let expected = integer(params, "expectedVersion", 1, MAX_VERSION)?
                .ok_or_else(|| invalid("expectedVersion is required"))?;
            if expected != record.version {
                return Err(error(
                    "conflict",
                    format!(
                        "memory version conflict: current version is {}",
                        record.version
                    ),
                ));
            }
            record.version = record
                .version
                .checked_add(1)
                .filter(|version| *version <= MAX_VERSION)
                .ok_or_else(|| internal("memory version limit reached"))?;
            record.updated_at = now;
            record.reason = reason;
            record.source_session = context.session.clone();
            if method == "memory.forget" {
                record.deleted = true;
            } else {
                if params.contains_key("name") {
                    record.name = text(params, "name", 120, true)?;
                }
                if params.contains_key("summary") {
                    record.summary = text(params, "summary", 500, true)?;
                }
                if params.contains_key("details") {
                    record.details = text(params, "details", 16000, false)?;
                }
                if let Some(pinned) = boolean(params, "pinned")? {
                    record.pinned = pinned;
                }
            }
            record
        };
        let response = record.value()?;
        if method == "memory.add" {
            // A random ID collision must fail, never turn an add into an update.
            transaction.execute("INSERT INTO memories(id,scope,project_id,version,deleted,pinned,updated_at,record)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![record.id,record.scope,record.project_id,record.version,record.deleted,record.pinned,record.updated_at,response.to_string()]).map_err(internal)?;
        } else {
            let changed = transaction.execute("UPDATE memories SET version=?2,deleted=?3,pinned=?4,updated_at=?5,record=?6 WHERE id=?1",
                params![record.id,record.version,record.deleted,record.pinned,record.updated_at,response.to_string()]).map_err(internal)?;
            if changed != 1 {
                return Err(internal("memory disappeared within its transaction"));
            }
        }
        transaction
            .execute(
                "INSERT INTO memory_history(memory_id,version,snapshot) VALUES(?1,?2,?3)",
                params![record.id, record.version, response.to_string()],
            )
            .map_err(internal)?;
        transaction
            .execute("DELETE FROM memory_fts WHERE id=?1", [&record.id])
            .map_err(internal)?;
        if !record.deleted {
            transaction
                .execute(
                    "INSERT INTO memory_fts(id,name,summary,details) VALUES(?1,?2,?3,?4)",
                    params![record.id, record.name, record.summary, record.details],
                )
                .map_err(internal)?;
        }
        transaction
            .execute(
                "INSERT INTO memory_receipts(command_id,request,response) VALUES(?1,?2,?3)",
                params![command_id, request, response.to_string()],
            )
            .map_err(internal)?;
        transaction.commit().map_err(internal)?;
        Ok(response)
    }

    fn list(
        &self,
        method: &str,
        params: &Map<String, Value>,
        context: &Context,
    ) -> MemoryResult<Value> {
        keys(
            params,
            if method == "memory.search" {
                &["query", "scope", "session", "limit", "offset"]
            } else {
                &["scope", "session", "limit", "offset"]
            },
        )?;
        let filter = Filter::new(params, context, false)?;
        let (limit, offset) = page(params)?;
        let records = if method == "memory.search" {
            let query = text(params, "query", 500, true)?;
            let expression = search_expression(&query)?;
            let mut statement=self.connection.prepare("SELECT m.id,m.scope,m.project_id,m.version,m.deleted,m.pinned,m.updated_at,m.record
                FROM memory_fts JOIN memories m ON m.id=memory_fts.id WHERE memory_fts MATCH ?1 AND m.deleted=0
                AND ((?2='visible' AND (m.scope='global' OR m.project_id=?3)) OR (?2='global' AND m.scope='global')
                OR (?2='project' AND m.scope='project' AND m.project_id=?3))
                ORDER BY m.pinned DESC,bm25(memory_fts),m.updated_at DESC,m.id LIMIT ?4 OFFSET ?5").map_err(internal)?;
            statement
                .query_map(
                    params![
                        expression,
                        filter.mode,
                        filter.project,
                        (limit + 1) as i64,
                        offset as i64
                    ],
                    stored_row,
                )
                .map_err(internal)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal)?
        } else {
            let mut statement=self.connection.prepare("SELECT m.id,m.scope,m.project_id,m.version,m.deleted,m.pinned,m.updated_at,m.record
                FROM memories m WHERE m.deleted=0 AND ((?1='visible' AND (m.scope='global' OR m.project_id=?2))
                OR (?1='global' AND m.scope='global') OR (?1='project' AND m.scope='project' AND m.project_id=?2))
                ORDER BY m.pinned DESC,m.updated_at DESC,m.id LIMIT ?3 OFFSET ?4").map_err(internal)?;
            statement
                .query_map(
                    params![
                        filter.mode,
                        filter.project,
                        (limit + 1) as i64,
                        offset as i64
                    ],
                    stored_row,
                )
                .map_err(internal)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(internal)?
        };
        let records = records
            .into_iter()
            .map(decode_stored)
            .map(|r| r.and_then(|r| r.summary_value()))
            .collect::<MemoryResult<Vec<_>>>()?;
        bounded_page("memories", records, limit)
    }
    fn history(&self, params: &Map<String, Value>, context: &Context) -> MemoryResult<Value> {
        keys(params, &["id", "scope", "session", "limit", "offset"])?;
        let filter = Filter::new(params, context, false)?;
        let id = required_identifier(params, "id")?;
        let current = find(&self.connection, id, &filter)?
            .filter(|r| filter.contains(r))
            .ok_or_else(|| error("not_found", "memory not found"))?;
        let (limit, offset) = page(params)?;
        let mut statement=self.connection.prepare("SELECT version,snapshot FROM memory_history WHERE memory_id=?1 ORDER BY version DESC LIMIT ?2 OFFSET ?3").map_err(internal)?;
        let rows = statement
            .query_map(params![id, (limit + 1) as i64, offset as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(internal)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(internal)?;
        let mut versions = Vec::new();
        for (version, snapshot) in rows {
            let record: Record = serde_json::from_str(&snapshot).map_err(internal)?;
            record.validate().map_err(internal)?;
            if record.id != current.id
                || record.scope != current.scope
                || record.project_id != current.project_id
                || record.version != version
            {
                return Err(internal("memory history metadata is inconsistent"));
            }
            versions.push(record.value()?);
        }
        bounded_page("versions", versions, limit)
    }
}

// Indexed fields are checked against the snapshot before returning data. Broken
// rows must not silently cross scope boundaries through an inconsistent index.
type StoredRow = (
    String,
    String,
    Option<String>,
    i64,
    bool,
    bool,
    String,
    String,
);
fn stored_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}
fn decode_stored(row: StoredRow) -> MemoryResult<Record> {
    let record: Record = serde_json::from_str(&row.7).map_err(internal)?;
    record.validate().map_err(internal)?;
    if (
        record.id.as_str(),
        record.scope.as_str(),
        record.project_id.as_ref(),
        record.version,
        record.deleted,
        record.pinned,
        record.updated_at.as_str(),
    ) != (
        row.0.as_str(),
        row.1.as_str(),
        row.2.as_ref(),
        row.3,
        row.4,
        row.5,
        row.6.as_str(),
    ) {
        return Err(internal("memory index and snapshot are inconsistent"));
    }
    Ok(record)
}
fn find(connection: &Connection, id: &str, filter: &Filter) -> MemoryResult<Option<Record>> {
    connection.query_row("SELECT id,scope,project_id,version,deleted,pinned,updated_at,record FROM memories WHERE id=?1 AND ((?2='global' AND scope='global') OR (?2='project' AND scope='project' AND project_id=?3) OR (?2='visible' AND (scope='global' OR (scope='project' AND project_id=?3))))",params![id,filter.mode,filter.project],stored_row)
        .optional().map_err(internal)?.map(decode_stored).transpose()
}
struct Filter {
    mode: &'static str,
    project: Option<String>,
}
impl Filter {
    fn new(params: &Map<String, Value>, context: &Context, write: bool) -> MemoryResult<Self> {
        let scope = match params.get("scope") {
            Some(value) => value
                .as_str()
                .ok_or_else(|| invalid("scope must be a string"))?,
            None => {
                if write {
                    "project"
                } else {
                    "visible"
                }
            }
        };
        let mode = match scope {
            "global" => "global",
            "project" => "project",
            "visible" if !write => "visible",
            _ => return Err(invalid("invalid memory scope")),
        };
        if mode == "project" && context.project_id.as_ref().is_none_or(|p| p.is_empty()) {
            return Err(invalid("project scope requires a session project context"));
        }
        Ok(Self {
            mode,
            project: context.project_id.clone(),
        })
    }
    fn contains(&self, record: &Record) -> bool {
        match self.mode {
            "global" => record.scope == "global",
            "project" => record.scope == "project" && record.project_id == self.project,
            _ => {
                record.scope == "global"
                    || (record.scope == "project"
                        && record.project_id == self.project
                        && self.project.is_some())
            }
        }
    }
}
fn keys(params: &Map<String, Value>, allowed: &[&str]) -> MemoryResult<()> {
    for name in params.keys() {
        if !allowed.contains(&name.as_str()) {
            return Err(invalid(format!("unknown memory parameter {name}")));
        }
    }
    Ok(())
}
fn bounded(value: &str, name: &str, limit: usize, nonempty: bool) -> MemoryResult<()> {
    if value.chars().count() > limit
        || value.len() > limit * 4
        || (nonempty && value.trim().is_empty())
    {
        return Err(invalid(format!(
            "{name} must contain {}..={limit} Unicode characters",
            usize::from(nonempty)
        )));
    }
    Ok(())
}
fn text(
    params: &Map<String, Value>,
    name: &str,
    limit: usize,
    nonempty: bool,
) -> MemoryResult<String> {
    let value = params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{name} must be a string")))?;
    bounded(value, name, limit, nonempty)?;
    Ok(if nonempty {
        value.trim().to_owned()
    } else {
        value.to_owned()
    })
}
fn identifier(value: &str, name: &str) -> MemoryResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err(invalid(format!(
            "{name} must be 1..=128 ASCII identifier characters"
        )));
    }
    Ok(())
}
fn required_identifier<'a>(params: &'a Map<String, Value>, name: &str) -> MemoryResult<&'a str> {
    let value = params
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{name} must be a string")))?;
    identifier(value, name)?;
    Ok(value)
}
fn boolean(params: &Map<String, Value>, name: &str) -> MemoryResult<Option<bool>> {
    params
        .get(name)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| invalid(format!("{name} must be a boolean")))
        })
        .transpose()
}
fn integer(
    params: &Map<String, Value>,
    name: &str,
    min: i64,
    max: i64,
) -> MemoryResult<Option<i64>> {
    params
        .get(name)
        .map(|value| {
            value
                .as_f64()
                .filter(|n| {
                    n.is_finite() && n.fract() == 0.0 && *n >= min as f64 && *n <= max as f64
                })
                .map(|n| n as i64)
                .ok_or_else(|| invalid(format!("{name} must be an integer in {min}..={max}")))
        })
        .transpose()
}
fn page(params: &Map<String, Value>) -> MemoryResult<(usize, usize)> {
    Ok((
        integer(params, "limit", 1, 50)?.unwrap_or(20) as usize,
        integer(params, "offset", 0, 10000)?.unwrap_or(0) as usize,
    ))
}
fn bounded_page(name: &str, values: Vec<Value>, limit: usize) -> MemoryResult<Value> {
    let total = values.len();
    let mut page = Vec::new();
    let mut bytes = 64;
    for value in values {
        let size = serde_json::to_vec(&value).map_err(internal)?.len() + 1;
        if page.len() == limit || bytes + size > PAGE_BYTES {
            break;
        }
        bytes += size;
        page.push(value);
    }
    if page.is_empty() && total > 0 {
        return Err(internal("single memory record exceeds page budget"));
    }
    let more = page.len() < total;
    Ok(json!({name:page,"hasMore":more}))
}
fn search_expression(query: &str) -> MemoryResult<String> {
    let tokens: BTreeSet<_> = query
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|s| !s.is_empty())
        .take(16)
        .collect();
    if tokens.is_empty() {
        return Err(invalid("search query must contain a searchable word"));
    }
    Ok(tokens
        .into_iter()
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>()
        .join(" AND "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::{Arc, Barrier};

    fn scratch_home() -> tempfile::TempDir {
        let directory = tempfile::tempdir().unwrap();
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }
    fn project(name: &str) -> Context {
        Context {
            project_id: Some(format!("project:{name}")),
            session: Some(format!("session-{name}")),
        }
    }
    fn add(command: &str) -> Value {
        json!({"commandId":command,"name":"Build convention","summary":"Build the Rust core","details":"Run cargo test before submitting","reason":"Confirmed repository convention"})
    }
    fn request(store: &mut MemoryStore, method: &str, params: Value, context: &Context) -> Value {
        store.execute(method, &params, context).unwrap()
    }

    #[test]
    fn foreign_corrupt_records_are_filtered_before_decoding() {
        let home = scratch_home();
        let mut store = MemoryStore::open(home.path()).unwrap();
        let foreign = request(
            &mut store,
            "memory.add",
            add("foreign-corrupt"),
            &project("two"),
        );
        store
            .connection
            .execute(
                "UPDATE memories SET record=?2 WHERE id=?1",
                params![foreign["id"].as_str().unwrap(), "{broken-private-data"],
            )
            .unwrap();
        for method in ["memory.get", "memory.history"] {
            let failure = store
                .execute(method, &json!({"id":foreign["id"]}), &project("one"))
                .unwrap_err();
            assert_eq!(failure.code, "not_found", "{method}");
            assert_eq!(failure.message, "memory not found");
        }
    }

    #[test]
    fn durable_receipts_are_atomic_and_keep_original_success_without_resurrection() {
        let home = scratch_home();
        let context = project("one");
        let mut store = MemoryStore::open(home.path()).unwrap();
        let original = request(&mut store, "memory.add", add("create-one"), &context);
        assert_eq!(
            request(&mut store, "memory.add", add("create-one"), &context),
            original
        );
        let changed = request(
            &mut store,
            "memory.update",
            json!({"commandId":"change-one","id":original["id"],"expectedVersion":1,"summary":"Updated decision","reason":"New evidence"}),
            &context,
        );
        assert_eq!(changed["version"], 2);
        let forgotten = request(
            &mut store,
            "memory.forget",
            json!({"commandId":"forget-one","id":original["id"],"expectedVersion":2,"reason":"No longer applies"}),
            &context,
        );
        assert_eq!(forgotten["version"], 3);
        assert_eq!(forgotten["deleted"], true);
        drop(store);
        let mut store = MemoryStore::open(home.path()).unwrap();
        assert_eq!(
            request(&mut store, "memory.add", add("create-one"), &context),
            original
        );
        assert_eq!(
            store
                .execute("memory.get", &json!({"id":original["id"]}), &context)
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            request(&mut store, "memory.list", json!({}), &context)["memories"],
            json!([])
        );
        let history = request(
            &mut store,
            "memory.history",
            json!({"id":original["id"]}),
            &context,
        );
        assert_eq!(
            history["versions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value["version"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        let mut another = add("create-one");
        another["summary"] = json!("A different request");
        assert_eq!(
            store
                .execute("memory.add", &another, &context)
                .unwrap_err()
                .code,
            "command_conflict"
        );
        assert_eq!(
            store
                .execute("memory.add", &add("create-one"), &project("two"))
                .unwrap_err()
                .code,
            "command_conflict"
        );
    }

    #[test]
    fn corrupt_receipt_cannot_replay_a_foreign_or_inconsistent_snapshot() {
        let home = scratch_home();
        let context = project("one");
        let mut store = MemoryStore::open(home.path()).unwrap();
        let original = request(&mut store, "memory.add", add("trusted-command"), &context);
        let foreign = request(
            &mut store,
            "memory.add",
            add("foreign-command"),
            &project("two"),
        );
        let mut different_values = add("same-scope-command");
        different_values["summary"] = json!("Another memory in the same project");
        let same_scope = request(&mut store, "memory.add", different_values, &context);
        let update_params = json!({"commandId":"trusted-update","id":original["id"],"expectedVersion":1,"summary":"Updated","reason":"New evidence"});
        let updated = request(&mut store, "memory.update", update_params.clone(), &context);
        let forget_params = json!({"commandId":"trusted-forget","id":original["id"],"expectedVersion":2,"reason":"Outdated"});
        let forgotten = request(&mut store, "memory.forget", forget_params.clone(), &context);
        for corrupt in [
            foreign,
            same_scope,
            {
                let mut value = original.clone();
                value["id"] = json!("unrecorded-id");
                value
            },
            {
                let mut value = original.clone();
                value["createdAt"] = json!("2020-01-01T00:00:00.000Z");
                value
            },
            {
                let mut value = original.clone();
                value["sourceSession"] = json!("foreign-session");
                value
            },
            {
                let mut value = original.clone();
                value["version"] = json!(2);
                value
            },
            {
                let mut value = original.clone();
                value["deleted"] = json!(true);
                value
            },
        ] {
            store
                .connection
                .execute(
                    "UPDATE memory_receipts SET response=?2 WHERE command_id=?1",
                    params!["trusted-command", corrupt.to_string()],
                )
                .unwrap();
            assert_eq!(
                store
                    .execute("memory.add", &add("trusted-command"), &context)
                    .unwrap_err()
                    .code,
                "internal"
            );
        }
        for (method, parameters, snapshot) in [
            ("memory.update", &update_params, &updated),
            ("memory.forget", &forget_params, &forgotten),
        ] {
            for field in ["id", "version", "deleted", "details"] {
                let mut corrupt = snapshot.clone();
                corrupt[field] = match field {
                    "id" => json!("different-id"),
                    "version" => json!(99),
                    "details" => json!("Unrecorded inherited details"),
                    _ => json!(!snapshot["deleted"].as_bool().unwrap()),
                };
                store
                    .connection
                    .execute(
                        "UPDATE memory_receipts SET response=?2 WHERE command_id=?1",
                        params![
                            parameters["commandId"].as_str().unwrap(),
                            corrupt.to_string()
                        ],
                    )
                    .unwrap();
                assert_eq!(
                    store
                        .execute(method, parameters, &context)
                        .unwrap_err()
                        .code,
                    "internal"
                );
            }
            store
                .connection
                .execute(
                    "UPDATE memory_receipts SET response=?2 WHERE command_id=?1",
                    params![
                        parameters["commandId"].as_str().unwrap(),
                        snapshot.to_string()
                    ],
                )
                .unwrap();
            assert_eq!(
                request(&mut store, method, parameters.clone(), &context),
                *snapshot
            );
        }
        store
            .connection
            .execute(
                "UPDATE memory_receipts SET response=?2 WHERE command_id=?1",
                params!["trusted-command", original.to_string()],
            )
            .unwrap();
        assert_eq!(
            request(&mut store, "memory.add", add("trusted-command"), &context),
            original
        );
        assert_eq!(
            store
                .execute("memory.get", &json!({"id":original["id"]}), &context)
                .unwrap_err()
                .code,
            "not_found"
        );
    }

    #[test]
    fn scope_is_applied_to_get_search_history_and_mutations() {
        let home = scratch_home();
        let one = project("one");
        let two = project("two");
        let mut store = MemoryStore::open(home.path()).unwrap();
        let private = request(&mut store, "memory.add", add("private"), &one);
        let mut global = add("global");
        global["scope"] = json!("global");
        let shared = request(&mut store, "memory.add", global, &one);
        for method in ["memory.get", "memory.history"] {
            assert_eq!(
                store
                    .execute(method, &json!({"id":private["id"]}), &two)
                    .unwrap_err()
                    .code,
                "not_found"
            );
        }
        assert_eq!(
            request(&mut store, "memory.search", json!({"query":"cargo"}), &two)["memories"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            request(&mut store, "memory.list", json!({}), &Context::default())["memories"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            request(&mut store, "memory.list", json!({"scope":"project"}), &one)["memories"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(store.execute("memory.update",&json!({"commandId":"foreign-edit","id":private["id"],"expectedVersion":1,"summary":"bad","reason":"bad"}),&two).unwrap_err().code,"not_found");
        assert_eq!(store.execute("memory.forget",&json!({"commandId":"implicit-global","id":shared["id"],"expectedVersion":1,"reason":"bad"}),&one).unwrap_err().code,"not_found");
        assert_eq!(
            store
                .execute("memory.add", &add("no-project"), &Context::default())
                .unwrap_err()
                .code,
            "invalid_params"
        );
        let summaries = request(&mut store, "memory.list", json!({}), &one);
        assert!(
            summaries["memories"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry.get("details").is_none())
        );
    }

    #[test]
    fn concurrent_writers_conflict_instead_of_losing_an_edit() {
        let home = scratch_home();
        let context = project("one");
        let mut initial = MemoryStore::open(home.path()).unwrap();
        let record = request(&mut initial, "memory.add", add("seed"), &context);
        let barrier = Arc::new(Barrier::new(2));
        let threads:Vec<_>=(0..2).map(|index|{
            let path=home.path().to_owned(); let context=context.clone(); let barrier=barrier.clone(); let id=record["id"].clone();
            std::thread::spawn(move||{
                let mut store=MemoryStore::open(&path).unwrap(); barrier.wait();
                store.execute("memory.update",&json!({"commandId":format!("edit-{index}"),"id":id,"expectedVersion":1,"summary":format!("Writer {index}"),"reason":"Concurrent edit"}),&context)
            })
        }).collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .map(|error| error.code)
                .collect::<Vec<_>>(),
            vec!["conflict"]
        );
        assert_eq!(
            request(
                &mut initial,
                "memory.get",
                json!({"id":record["id"]}),
                &context
            )["version"],
            2
        );
        assert_eq!(
            request(
                &mut initial,
                "memory.history",
                json!({"id":record["id"]}),
                &context
            )["versions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn failed_transaction_rolls_back_record_history_fts_and_receipt() {
        let home = scratch_home();
        let context = project("one");
        let mut store = MemoryStore::open(home.path()).unwrap();
        let record = request(&mut store, "memory.add", add("seed"), &context);
        store.connection.execute_batch("CREATE TRIGGER reject_history BEFORE INSERT ON memory_history BEGIN SELECT RAISE(ABORT,'injected history failure'); END;").unwrap();
        let mutation = json!({"commandId":"retry-after-failure","id":record["id"],"expectedVersion":1,"summary":"Uncommitted keyword","reason":"Testing rollback"});
        assert_eq!(
            store
                .execute("memory.update", &mutation, &context)
                .unwrap_err()
                .code,
            "internal"
        );
        assert_eq!(
            request(
                &mut store,
                "memory.get",
                json!({"id":record["id"]}),
                &context
            ),
            record
        );
        assert_eq!(
            request(
                &mut store,
                "memory.search",
                json!({"query":"Uncommitted"}),
                &context
            )["memories"],
            json!([])
        );
        assert_eq!(
            request(
                &mut store,
                "memory.history",
                json!({"id":record["id"]}),
                &context
            )["versions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        store
            .connection
            .execute_batch("DROP TRIGGER reject_history")
            .unwrap();
        assert_eq!(
            request(&mut store, "memory.update", mutation, &context)["version"],
            2
        );
    }

    #[test]
    fn search_is_literal_unicode_and_soft_delete_removes_fts_results() {
        let home = scratch_home();
        let context = project("one");
        let mut store = MemoryStore::open(home.path()).unwrap();
        let mut values = add("russian");
        values["summary"] = json!("Проверка сборки проекта");
        values["details"] = json!("cargo test; punctuation \"quoted\" * : OR NOT");
        let record = request(&mut store, "memory.add", values, &context);
        assert_eq!(
            request(
                &mut store,
                "memory.search",
                json!({"query":"Проверка cargo"}),
                &context
            )["memories"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            request(
                &mut store,
                "memory.search",
                json!({"query":"cargo OR missing"}),
                &context
            )["memories"],
            json!([])
        );
        assert_eq!(
            store
                .execute("memory.search", &json!({"query":"\"***"}), &context)
                .unwrap_err()
                .code,
            "invalid_params"
        );
        request(
            &mut store,
            "memory.forget",
            json!({"commandId":"forget-russian","id":record["id"],"expectedVersion":1,"reason":"Outdated"}),
            &context,
        );
        assert_eq!(
            request(
                &mut store,
                "memory.search",
                json!({"query":"cargo"}),
                &context
            )["memories"],
            json!([])
        );
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM memory_fts", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn pages_bound_history_bytes_and_validate_fields_before_writes() {
        let home = scratch_home();
        let context = project("one");
        let mut store = MemoryStore::open(home.path()).unwrap();
        let mut large = add("large");
        large["details"] = json!("🌊".repeat(16000));
        let mut record = request(&mut store, "memory.add", large, &context);
        for index in 0..12 {
            record = request(
                &mut store,
                "memory.update",
                json!({"commandId":format!("large-{index}"),"id":record["id"],"expectedVersion":record["version"],"reason":"Another version"}),
                &context,
            );
        }
        let first = request(
            &mut store,
            "memory.history",
            json!({"id":record["id"],"limit":50}),
            &context,
        );
        assert!(serde_json::to_vec(&first).unwrap().len() <= PAGE_BYTES);
        assert_eq!(first["hasMore"], true);
        let count = first["versions"].as_array().unwrap().len();
        let next = request(
            &mut store,
            "memory.history",
            json!({"id":record["id"],"offset":count,"limit":50}),
            &context,
        );
        assert_eq!(count + next["versions"].as_array().unwrap().len(), 13);
        for (field, value) in [
            ("name", json!("x".repeat(121))),
            ("details", json!("🌊".repeat(16001))),
            ("pinned", json!("true")),
            ("unexpected", json!(1)),
        ] {
            let mut input = add("invalid");
            input[field] = value;
            assert_eq!(
                store
                    .execute("memory.add", &input, &context)
                    .unwrap_err()
                    .code,
                "invalid_params"
            );
        }
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM memories", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn refuses_foreign_future_or_corrupt_databases_without_reinitializing() {
        for kind in ["foreign", "future", "corrupt"] {
            let home = scratch_home();
            let store = MemoryStore::open(home.path()).unwrap();
            let database = store.database.clone();
            drop(store);
            if kind == "corrupt" {
                fs::write(&database, b"not a sqlite database").unwrap();
            } else {
                let connection = Connection::open(&database).unwrap();
                if kind == "foreign" {
                    connection.pragma_update(None, "user_version", 0).unwrap();
                    connection.pragma_update(None, "application_id", 0).unwrap();
                } else {
                    connection.pragma_update(None, "user_version", 99).unwrap();
                }
            }
            let before = fs::read(&database).unwrap();
            assert!(MemoryStore::open(home.path()).is_err(), "{kind}");
            assert_eq!(fs::read(&database).unwrap(), before, "{kind}");
        }
    }

    #[test]
    fn rejects_unsafe_paths_sidecars_permissions_and_replacement() {
        let home = scratch_home();
        let outside = scratch_home();
        symlink(outside.path(), home.path().join("memory")).unwrap();
        assert!(MemoryStore::open(home.path()).is_err());
        fs::remove_file(home.path().join("memory")).unwrap();
        let mut store = MemoryStore::open(home.path()).unwrap();
        let database = store.database.clone();
        let journal = PathBuf::from(format!("{}-journal", database.display()));
        symlink(outside.path().join("victim"), &journal).unwrap();
        assert_eq!(
            store
                .execute("memory.list", &json!({}), &Context::default())
                .unwrap_err()
                .code,
            "internal"
        );
        fs::remove_file(journal).unwrap();
        fs::set_permissions(&database, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(MemoryStore::open(home.path()).is_err());
        fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
        fs::rename(&database, database.with_extension("old")).unwrap();
        File::create(&database).unwrap();
        fs::set_permissions(&database, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            store
                .execute("memory.list", &json!({}), &Context::default())
                .unwrap_err()
                .code,
            "internal"
        );
    }
}
