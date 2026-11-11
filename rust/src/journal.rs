//! The global journal is authoritative. Session files are best-effort projections,
//! matching the existing Node layout. A successful append means the global record
//! and its directory entry have been synced. It does not promise atomic delivery
//! to both files, or storage hardware that honours flushes under power loss.

use anyhow::{Context, Result, bail, ensure};
use chrono::{SecondsFormat, Utc};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Value, json, value::RawValue};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const MAX_EVENT_ID: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
struct Entry {
    id: u64,
    offset: u64,
    length: u64,
    session_id: Vec<u16>,
}

/// Keep the original JSON rather than forcing JavaScript UTF-16 strings into a
/// Rust String. JSON.stringify can emit an unpaired surrogate after String.slice.
#[derive(Debug)]
pub struct JournalRecord {
    pub id: u64,
    pub json: Box<RawValue>,
}

#[derive(Deserialize)]
struct RawHeader {
    id: Value,
    #[serde(rename = "sessionId")]
    session_id: Box<RawValue>,
}

#[derive(Debug)]
struct Projection {
    file: File,
    size: u64,
    last_id: u64,
}

#[derive(Debug)]
pub struct EventStore {
    directory: PathBuf,
    file: File,
    index: Vec<Entry>,
    size: u64,
    poisoned: bool,
    projections: HashMap<String, Projection>,
    projection_error: Option<String>,
    snapshot: crate::snapshot::SnapshotIndex,
}

impl Drop for EventStore {
    fn drop(&mut self) {
        // Release ownership explicitly. A concurrent fork can temporarily hold
        // a duplicate of this open description until its CLOEXEC descriptors
        // close, even after the owner's final File is dropped.
        let _ = FileExt::unlock(&self.file);
    }
}

fn private_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    ensure!(metadata.is_dir(), "events path must be a regular directory");
    ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "events directory must be private (0700)"
    );
    Ok(())
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn checked_file(file: &File) -> Result<()> {
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "journal path must be a regular file");
    ensure!(
        metadata.nlink() == 1,
        "journal file may not have hard links"
    );
    ensure!(
        metadata.permissions().mode() & 0o077 == 0,
        "journal file must be private (0600)"
    );
    Ok(())
}

/// O_NONBLOCK makes a pre-existing FIFO fail validation without hanging at open.
/// O_NOFOLLOW protects both the first creation race and existing file opens.
fn open_file(path: &Path) -> Result<(File, bool)> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .append(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    let (file, created) = match options.create_new(true).open(path) {
        Ok(file) => (file, true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            (options.create_new(false).open(path)?, false)
        }
        Err(error) => return Err(error.into()),
    };
    checked_file(&file)?;
    Ok((file, created))
}

fn event_id(value: &Value) -> Result<u64> {
    let id = value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|id| id.is_finite() && id.fract() == 0.0 && *id > 0.0)
            .filter(|id| *id <= MAX_EVENT_ID as f64)
            .map(|id| id as u64)
    });
    let id = id.context("event id must be a positive JavaScript-safe integer")?;
    ensure!(
        id > 0 && id <= MAX_EVENT_ID,
        "event id must be a positive JavaScript-safe integer"
    );
    Ok(id)
}

pub(crate) fn decode_js_string(raw: &RawValue) -> Result<Vec<u16>> {
    let text = raw.get();
    ensure!(
        text.starts_with('"') && text.ends_with('"'),
        "event sessionId must be a string"
    );
    let mut chars = text[1..text.len() - 1].chars();
    let mut units = Vec::new();
    while let Some(character) = chars.next() {
        if character != '\\' {
            let mut pair = [0; 2];
            units.extend_from_slice(character.encode_utf16(&mut pair));
            continue;
        }
        match chars.next().context("incomplete JSON string escape")? {
            '"' => units.push(u16::from(b'"')),
            '\\' => units.push(u16::from(b'\\')),
            '/' => units.push(u16::from(b'/')),
            'b' => units.push(0x08),
            'f' => units.push(0x0c),
            'n' => units.push(0x0a),
            'r' => units.push(0x0d),
            't' => units.push(0x09),
            'u' => {
                let mut unit = 0;
                for _ in 0..4 {
                    let digit = chars
                        .next()
                        .and_then(|digit| digit.to_digit(16))
                        .context("invalid JSON unicode escape")?;
                    unit = (unit << 4) | digit as u16;
                }
                units.push(unit);
            }
            _ => bail!("invalid JSON string escape"),
        }
    }
    Ok(units)
}

fn parse_event(line: &[u8]) -> Result<(JournalRecord, Vec<u16>)> {
    let raw: Box<RawValue> =
        serde_json::from_slice(line).context("corrupt complete journal record")?;
    ensure!(
        raw.get().starts_with('{'),
        "journal record must be an object"
    );
    // Decode only the index metadata. Ignored values may contain JavaScript
    // UTF-16 code units that serde_json::Value cannot represent losslessly.
    let header: RawHeader = serde_json::from_str(raw.get())?;
    let id = event_id(&header.id)?;
    let session_id = decode_js_string(&header.session_id)?;
    Ok((JournalRecord { id, json: raw }, session_id))
}

/// Validate every committed row before returning the incomplete tail boundary.
/// The caller can then repair only that tail without hiding earlier corruption.
fn scan(file: &File) -> Result<(Vec<Entry>, u64, u64)> {
    let mut input = file.try_clone()?;
    input.seek(SeekFrom::Start(0))?;
    let mut input = BufReader::new(input);
    let mut line = Vec::new();
    let mut index = Vec::new();
    let mut offset = 0;
    let mut last_id = 0;
    loop {
        line.clear();
        let count = input.read_until(b'\n', &mut line)?;
        if count == 0 || line.last() != Some(&b'\n') {
            break;
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            let (record, session_id) =
                parse_event(&line).with_context(|| format!("journal record at byte {offset}"))?;
            let id = record.id;
            ensure!(
                id > last_id,
                "journal event ids must be strictly increasing at byte {offset}"
            );
            index.push(Entry {
                id,
                offset,
                length: count as u64,
                session_id,
            });
            last_id = id;
        }
        offset += count as u64;
    }
    Ok((index, offset, last_id))
}

fn repair(file: &File, directory: &Path, valid_size: u64, created: bool) -> Result<()> {
    let shortened = file.metadata()?.len() != valid_size;
    if shortened {
        file.set_len(valid_size)?;
    }
    if shortened || created {
        file.sync_all()?;
        sync_directory(directory)?;
    }
    Ok(())
}

pub fn session_file_name(session_id: &str) -> String {
    let bytes = session_id.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(byte));
    if !valid {
        "_other.jsonl".to_owned()
    } else if session_id == "journal" {
        "_journal.jsonl".to_owned()
    } else {
        format!("{session_id}.jsonl")
    }
}

impl EventStore {
    pub fn open(events_dir: &Path) -> Result<Self> {
        if !events_dir.try_exists()? {
            fs::DirBuilder::new().mode(0o700).create(events_dir)?;
            sync_directory(
                events_dir
                    .parent()
                    .context("events directory has no parent")?,
            )?;
        }
        private_directory(events_dir)?;
        let directory = events_dir.canonicalize()?;
        let (file, created) = open_file(&directory.join("journal.jsonl"))?;
        file.try_lock_exclusive()
            .context("another writer owns the journal")?;
        let (index, size, _) = scan(&file)?;
        repair(&file, &directory, size, created)?;
        let mut store = Self {
            directory,
            file,
            index,
            size,
            poisoned: false,
            projections: HashMap::new(),
            projection_error: None,
            snapshot: crate::snapshot::SnapshotIndex::default(),
        };
        for position in 0..store.index.len() {
            let record = store.read_at(position)?;
            store.snapshot.note(record.id, &record.json)?;
        }
        Ok(store)
    }

    pub fn last_id(&self) -> u64 {
        self.index.last().map_or(0, |entry| entry.id)
    }

    /// A failed projection does not undo an already durable global record. The
    /// daemon can report this diagnostic and rebuild projections in a later step.
    pub fn projection_error(&self) -> Option<&str> {
        self.projection_error.as_deref()
    }

    pub fn append(&mut self, draft: Value) -> Result<Value> {
        self.append_using(draft, |file, bytes| {
            file.write_all(bytes)?;
            file.sync_all()
        })
    }

    fn append_using(
        &mut self,
        draft: Value,
        commit: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    ) -> Result<Value> {
        ensure!(
            !self.poisoned,
            "journal is poisoned after an uncertain write; reopen to recover"
        );
        ensure!(draft.is_object(), "event draft must be an object");
        for field in ["sessionId", "provider", "kind"] {
            ensure!(
                draft[field].is_string(),
                "event draft {field} must be a string"
            );
        }
        ensure!(
            draft.get("parentId").is_none_or(Value::is_string),
            "event draft parentId must be a string"
        );
        ensure!(
            draft.get("ts").is_none_or(Value::is_string),
            "event draft ts must be a string"
        );
        ensure!(
            draft.get("data").is_none_or(Value::is_object),
            "event draft data must be an object"
        );
        ensure!(
            self.last_id() < MAX_EVENT_ID,
            "journal event id space exhausted"
        );
        let id = self.last_id() + 1;
        let mut event = json!({
            "id": id,
            "ts": draft.get("ts").cloned().unwrap_or_else(|| Value::String(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))),
            "sessionId": draft["sessionId"],
            "provider": draft["provider"],
            "kind": draft["kind"],
            "data": draft.get("data").cloned().unwrap_or_else(|| json!({})),
        });
        if let Some(parent) = draft.get("parentId") {
            event["parentId"] = parent.clone();
        }
        let mut line = serde_json::to_vec(&event)?;
        line.push(b'\n');
        let write_result = (|| {
            if self.file.metadata()?.len() != self.size {
                return Err(io::Error::other("journal changed outside its owner"));
            }
            commit(&mut self.file, &line)
        })();
        if let Err(error) = write_result {
            self.poisoned = true;
            return Err(error).context("journal append failed; further writes disabled");
        }
        self.index.push(Entry {
            id,
            offset: self.size,
            length: line.len() as u64,
            session_id: event["sessionId"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .collect(),
        });
        self.size += line.len() as u64;
        self.snapshot
            .note(id, &serde_json::value::to_raw_value(&event)?)?;
        if let Err(error) = self.append_projection(event["sessionId"].as_str().unwrap(), id, &line)
        {
            self.projection_error = Some(format!("session projection update failed: {error:#}"));
        }
        Ok(event)
    }

    fn append_projection(&mut self, session_id: &str, id: u64, line: &[u8]) -> Result<()> {
        let name = session_file_name(session_id);
        // Removing the descriptor makes every uncertain failure reopen and repair
        // its torn tail before a later record can be appended to that projection.
        let mut projection = match self.projections.remove(&name) {
            Some(projection) => projection,
            None => {
                let (file, created) = open_file(&self.directory.join(&name))?;
                let (_, size, last_id) = scan(&file)?;
                repair(&file, &self.directory, size, created)?;
                Projection {
                    file,
                    size,
                    last_id,
                }
            }
        };
        ensure!(
            projection.last_id < id,
            "session projection is ahead of global journal"
        );
        ensure!(
            projection.file.metadata()?.len() == projection.size,
            "session projection changed outside its owner"
        );
        projection.file.write_all(line)?;
        projection.file.sync_all()?;
        projection.size += line.len() as u64;
        projection.last_id = id;
        self.projections.insert(name, projection);
        Ok(())
    }

    pub fn read_from(
        &mut self,
        cursor: u64,
        session_id: Option<&str>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Vec<JournalRecord>> {
        let start = self.index.partition_point(|entry| entry.id <= cursor);
        let session_id = session_id.map(|session| session.encode_utf16().collect::<Vec<_>>());
        let mut out = Vec::new();
        if limit == 0 {
            return Ok(out);
        }
        let mut bytes = 0u64;
        for entry in &self.index[start..] {
            if session_id
                .as_ref()
                .is_some_and(|session| session != &entry.session_id)
            {
                continue;
            }
            if !out.is_empty() && bytes.saturating_add(entry.length) > max_bytes as u64 {
                break;
            }
            self.file.seek(SeekFrom::Start(entry.offset))?;
            let mut line = vec![0; usize::try_from(entry.length)?];
            self.file.read_exact(&mut line)?;
            let (event, session_id) = parse_event(&line)?;
            ensure!(
                event.id == entry.id && session_id == entry.session_id,
                "journal record changed after indexing"
            );
            bytes = bytes.saturating_add(entry.length);
            out.push(event);
            if out.len() == limit {
                break;
            }
        }
        Ok(out)
    }

    fn read_at(&mut self, position: usize) -> Result<JournalRecord> {
        let entry = &self.index[position];
        self.file.seek(SeekFrom::Start(entry.offset))?;
        let mut bytes = vec![0; usize::try_from(entry.length)?];
        self.file.read_exact(&mut bytes)?;
        let (record, session) = parse_event(&bytes)?;
        ensure!(
            record.id == entry.id && session == entry.session_id,
            "journal record changed after indexing"
        );
        Ok(record)
    }

    /// Preserve requested order and duplicates; unknown IDs do not produce rows.
    pub fn read_ids(&mut self, ids: &[u64]) -> Result<Vec<JournalRecord>> {
        let mut records = Vec::new();
        for id in ids {
            if let Ok(position) = self.index.binary_search_by_key(id, |entry| entry.id) {
                records.push(self.read_at(position)?);
            }
        }
        Ok(records)
    }

    pub fn snapshot(&mut self) -> Result<Box<RawValue>> {
        #[derive(serde::Serialize)]
        struct Snapshot {
            events: Vec<Box<RawValue>>,
            activity: Box<RawValue>,
            cursor: u64,
        }
        let records = self.read_ids(&self.snapshot.ids())?;
        Ok(serde_json::value::to_raw_value(&Snapshot {
            events: records.into_iter().map(|record| record.json).collect(),
            activity: self.snapshot.activity()?,
            cursor: self.last_id(),
        })?)
    }

    /// The Node history API reads the session projection, including external
    /// rewrites. Never silently replace these bytes with the global journal.
    pub fn read_session(&self, session: &[u16]) -> Result<Vec<JournalRecord>> {
        let name = String::from_utf16(session)
            .map(|session| session_file_name(&session))
            .unwrap_or_else(|_| "_other.jsonl".into());
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
            .open(self.directory.join(name))
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        checked_file(&file)?;
        let mut input = BufReader::new(file);
        let mut line = Vec::new();
        let mut records = Vec::new();
        let mut last = 0;
        loop {
            line.clear();
            if input.read_until(b'\n', &mut line)? == 0 {
                break;
            }
            if let Ok((record, own_session)) = parse_event(&line)
                && own_session == session
                && record.id > last
            {
                last = record.id;
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn session_stamp(&self, session: &[u16]) -> Result<Option<(u64, u64, i64, i64)>> {
        let name = String::from_utf16(session)
            .map(|session| session_file_name(&session))
            .unwrap_or_else(|_| "_other.jsonl".into());
        let metadata = match fs::symlink_metadata(self.directory.join(name)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            metadata.is_file() && metadata.nlink() == 1 && metadata.mode() & 0o077 == 0,
            "session projection must be a private regular file without links"
        );
        Ok(Some((
            metadata.len(),
            metadata.ino(),
            metadata.mtime(),
            metadata.mtime_nsec(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    fn directory() -> (TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let events = temp.path().join("events");
        (temp, events)
    }

    fn draft(session_id: &str) -> Value {
        json!({"sessionId":session_id,"provider":"codex","kind":"message.done","data":{"text":"Привет 🦀\n次"},"parentId":"parent","ts":"2026-11-11T00:00:00.000Z"})
    }

    fn seed(events: &Path, bytes: &[u8]) {
        fs::DirBuilder::new().mode(0o700).create(events).unwrap();
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(events.join("journal.jsonl"))
            .unwrap();
        file.write_all(bytes).unwrap();
    }

    fn line(id: u64, session: &str) -> Vec<u8> {
        let mut event = draft(session);
        event["id"] = json!(id);
        event["kind"] = json!("future.kind");
        event["future"] = json!({"preserve":true});
        let mut bytes = serde_json::to_vec(&event).unwrap();
        bytes.push(b'\n');
        bytes
    }

    fn values(records: Vec<JournalRecord>) -> Vec<Value> {
        records
            .into_iter()
            .map(|record| serde_json::from_str(record.json.get()).unwrap())
            .collect()
    }

    #[test]
    fn persists_unicode_and_projections_then_continues_after_reopen() {
        let (_temp, directory) = directory();
        let mut store = EventStore::open(&directory).unwrap();
        let first = store.append(draft("alpha")).unwrap();
        assert_eq!(first["id"], 1);
        store.append(draft("journal")).unwrap();
        store.append(draft("../escape")).unwrap();
        assert!(store.projection_error().is_none());
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(directory.join("alpha.jsonl")).unwrap())
                .unwrap(),
            first
        );
        assert!(directory.join("_journal.jsonl").is_file());
        assert!(directory.join("_other.jsonl").is_file());
        drop(store);
        let mut reopened = EventStore::open(&directory).unwrap();
        assert_eq!(reopened.last_id(), 3);
        assert_eq!(reopened.append(draft("alpha")).unwrap()["id"], 4);
        assert_eq!(
            reopened
                .read_from(0, Some("alpha"), 20, usize::MAX)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn reads_legacy_gaps_unknown_fields_and_budgeted_cursor_pages() {
        let (_temp, directory) = directory();
        let mut bytes = line(2, "alpha");
        bytes.extend(line(5, "beta"));
        bytes.extend(line(20, "alpha"));
        seed(&directory, &bytes);
        let mut store = EventStore::open(&directory).unwrap();
        let page = values(store.read_from(2, None, 1, usize::MAX).unwrap());
        assert_eq!(page[0]["id"], 5);
        assert_eq!(page[0]["kind"], "future.kind");
        assert_eq!(page[0]["future"]["preserve"], true);
        assert_eq!(
            store.read_from(2, Some("alpha"), 10, 0).unwrap()[0].id,
            20u64
        );
        assert_eq!(store.read_from(0, None, 10, 0).unwrap().len(), 1);
        assert!(store.read_from(0, None, 0, usize::MAX).unwrap().is_empty());
        assert!(
            store
                .read_from(20, None, 10, usize::MAX)
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.append(draft("beta")).unwrap()["id"], 21);
    }

    #[test]
    fn repairs_only_incomplete_tail_even_when_it_is_valid_json() {
        let (_temp, directory) = directory();
        let committed = line(7, "alpha");
        let mut bytes = committed.clone();
        bytes.extend(br#"{"id":8,"sessionId":"alpha"}"#);
        seed(&directory, &bytes);
        let mut store = EventStore::open(&directory).unwrap();
        assert_eq!(store.last_id(), 7);
        assert_eq!(
            fs::read(directory.join("journal.jsonl")).unwrap(),
            committed
        );
        assert_eq!(store.append(draft("beta")).unwrap()["id"], 8);
    }

    #[test]
    fn complete_corruption_and_unordered_ids_preserve_every_byte() {
        for corrupt in [
            b"null\n".to_vec(),
            b"{bad}\n".to_vec(),
            line(2, "beta"),
            line(1, "alpha"),
            line(MAX_EVENT_ID + 1, "alpha"),
        ] {
            let (_temp, directory) = directory();
            let mut bytes = line(2, "alpha");
            bytes.extend(corrupt);
            bytes.extend(b"torn");
            seed(&directory, &bytes);
            assert!(EventStore::open(&directory).is_err());
            assert_eq!(fs::read(directory.join("journal.jsonl")).unwrap(), bytes);
        }
    }

    #[test]
    fn refuses_second_writer_and_unsafe_paths() {
        let (_temp, directory) = directory();
        let first = EventStore::open(&directory).unwrap();
        assert!(EventStore::open(&directory).is_err());
        drop(first);
        let outside = directory.parent().unwrap().join("outside");
        fs::write(&outside, b"private").unwrap();
        fs::remove_file(directory.join("journal.jsonl")).unwrap();
        symlink(&outside, directory.join("journal.jsonl")).unwrap();
        assert!(EventStore::open(&directory).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"private");
        fs::remove_file(directory.join("journal.jsonl")).unwrap();
        std::process::Command::new("mkfifo")
            .arg(directory.join("journal.jsonl"))
            .status()
            .unwrap();
        assert!(EventStore::open(&directory).is_err());
        fs::remove_file(directory.join("journal.jsonl")).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(EventStore::open(&directory).is_err());
    }

    #[test]
    fn poisoned_partial_write_is_repaired_only_after_reopen() {
        let (_temp, directory) = directory();
        let mut store = EventStore::open(&directory).unwrap();
        store.append(draft("alpha")).unwrap();
        let result = store.append_using(draft("alpha"), |file, bytes| {
            file.write_all(&bytes[..bytes.len() / 2])?;
            Err(io::Error::from_raw_os_error(nix::libc::ENOSPC))
        });
        assert!(result.is_err());
        assert_eq!(store.last_id(), 1);
        assert!(store.append(draft("alpha")).is_err());
        drop(store);
        let mut reopened = EventStore::open(&directory).unwrap();
        assert_eq!(reopened.last_id(), 1);
        assert_eq!(reopened.append(draft("alpha")).unwrap()["id"], 2);
    }

    #[test]
    fn uncertain_sync_does_not_acknowledge_or_reuse_ids_in_same_instance() {
        let (_temp, directory) = directory();
        let mut store = EventStore::open(&directory).unwrap();
        let result = store.append_using(draft("alpha"), |file, bytes| {
            file.write_all(bytes)?;
            Err(io::Error::from_raw_os_error(nix::libc::EIO))
        });
        assert!(result.is_err());
        assert_eq!(store.last_id(), 0);
        assert!(store.append(draft("alpha")).is_err());
        drop(store);
        let mut reopened = EventStore::open(&directory).unwrap();
        assert_eq!(reopened.last_id(), 1);
        assert_eq!(reopened.append(draft("alpha")).unwrap()["id"], 2);
    }

    #[test]
    fn projection_failure_leaves_global_durable_and_retry_repairs_tail() {
        let (_temp, directory) = directory();
        let mut store = EventStore::open(&directory).unwrap();
        symlink(directory.join("absent"), directory.join("alpha.jsonl")).unwrap();
        assert_eq!(store.append(draft("alpha")).unwrap()["id"], 1);
        assert!(store.projection_error().is_some());
        fs::remove_file(directory.join("alpha.jsonl")).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join("alpha.jsonl"))
            .unwrap();
        file.write_all(b"torn").unwrap();
        assert_eq!(store.append(draft("alpha")).unwrap()["id"], 2);
        let projection: Value =
            serde_json::from_slice(&fs::read(directory.join("alpha.jsonl")).unwrap()).unwrap();
        assert_eq!(projection["id"], 2);
        drop(store);
        assert_eq!(EventStore::open(&directory).unwrap().last_id(), 2);
    }

    #[test]
    fn exhausted_safe_integer_ids_refuse_append_without_mutation() {
        let (_temp, directory) = directory();
        let bytes = line(MAX_EVENT_ID, "alpha");
        seed(&directory, &bytes);
        let mut store = EventStore::open(&directory).unwrap();
        assert!(store.append(draft("alpha")).is_err());
        assert_eq!(fs::read(directory.join("journal.jsonl")).unwrap(), bytes);
    }

    #[test]
    fn large_legacy_records_are_read_without_a_protocol_frame_cap() {
        let (_temp, directory) = directory();
        let mut event = draft("alpha");
        event["data"]["text"] = json!("x".repeat(2 * 1024 * 1024));
        let mut store = EventStore::open(&directory).unwrap();
        let written = store.append(event).unwrap();
        drop(store);
        let mut reopened = EventStore::open(&directory).unwrap();
        let page = values(reopened.read_from(0, None, 10, 256).unwrap());
        assert_eq!(page, vec![written]);
    }

    #[test]
    fn preserves_javascript_lone_surrogates_in_data_and_session_ids() {
        let (_temp, directory) = directory();
        let first = r#"{"id":3,"sessionId":"chat","provider":"codex","kind":"message.delta","data":{"text":"\ud83c","\udc00":"key"}}"#;
        let second = r#"{"id":9,"sessionId":"\ud83c","data":{"text":"\udc00"}}"#;
        let third = r#"{"id":10,"sessionId":"\ud83c\udf0a","data":{}}"#;
        seed(
            &directory,
            format!("{first}\n{second}\n{third}\n").as_bytes(),
        );
        let original = fs::read(directory.join("journal.jsonl")).unwrap();
        let mut store = EventStore::open(&directory).unwrap();
        let records = store.read_from(0, None, 10, usize::MAX).unwrap();
        assert_eq!(records[0].json.get(), first);
        assert_eq!(records[1].json.get(), second);
        assert_eq!(records[2].json.get(), third);
        assert_eq!(
            store.read_from(0, Some("chat"), 10, usize::MAX).unwrap()[0].id,
            3
        );
        assert_eq!(
            store.read_from(0, Some("🌊"), 10, usize::MAX).unwrap()[0].id,
            10
        );
        assert_eq!(fs::read(directory.join("journal.jsonl")).unwrap(), original);
        drop(store);
        let mut reopened = EventStore::open(&directory).unwrap();
        assert_eq!(reopened.last_id(), 10);
        assert_eq!(reopened.append(draft("chat")).unwrap()["id"], 11);
        assert_eq!(
            reopened.read_from(3, None, 10, usize::MAX).unwrap()[0]
                .json
                .get(),
            second
        );
    }

    #[test]
    fn rejects_directory_symlinks_and_hard_linked_journals() {
        let (temp, directory) = directory();
        let actual = temp.path().join("actual");
        fs::DirBuilder::new().mode(0o700).create(&actual).unwrap();
        symlink(&actual, &directory).unwrap();
        assert!(EventStore::open(&directory).is_err());
        fs::remove_file(&directory).unwrap();
        seed(&directory, &line(1, "alpha"));
        let outside = temp.path().join("linked");
        fs::hard_link(directory.join("journal.jsonl"), &outside).unwrap();
        assert!(EventStore::open(&directory).is_err());
    }
}
