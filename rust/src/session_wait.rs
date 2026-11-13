//! Connection-owned read wait. No provider startup, observer task or execution lease.
use crate::{
    State,
    turn_driver::{Driver, Progress},
    turn_snapshot::SessionKey,
};
use crate::{
    history::{Fields, array_values},
    session_api::ApiError,
    session_live::Status,
};
use serde_json::json;
use serde_json::{Value, value::RawValue};
use std::sync::Arc;
use std::sync::TryLockError;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub(crate) const PER_CONNECTION: usize = 8;
const GLOBAL: usize = 128;
const DEFAULT_TIMEOUT_MS: f64 = 600_000.0;

fn error(code: &'static str, message: &'static str) -> ApiError {
    ApiError {
        code,
        message: message.into(),
    }
}
fn invalid() -> ApiError {
    error("invalid_params", "invalid wait parameters")
}

pub(crate) struct Gate(Arc<Semaphore>);
impl Default for Gate {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(GLOBAL)))
    }
}
impl Gate {
    pub(crate) fn admit(&self) -> Result<OwnedSemaphorePermit, ApiError> {
        self.0
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("capacity", "wait capacity reached"))
    }
}

#[derive(Clone, Copy)]
struct Until {
    idle: bool,
    blocked: bool,
    done: bool,
}
impl Until {
    const ALL: Self = Self {
        idle: true,
        blocked: true,
        done: true,
    };
    fn matches(self, status: Status) -> bool {
        (self.blocked && status.needs_human())
            || (self.done && status.is_terminal())
            || (self.idle && matches!(status, Status::Idle | Status::Limited | Status::Interrupted))
    }
    fn parse(value: Option<&RawValue>) -> Result<Self, ApiError> {
        let Some(raw) = value.filter(|v| v.get().starts_with('[')) else {
            return Ok(Self::ALL);
        };
        let values = array_values(raw).map_err(|_| invalid())?;
        if values.is_empty() {
            return Ok(Self::ALL);
        }
        let mut until = Self {
            idle: false,
            blocked: false,
            done: false,
        };
        for value in values {
            let units = crate::session_read::javascript_string(&value).map_err(|_| invalid())?;
            match units.as_slice() {
                [105, 100, 108, 101] => until.idle = true,
                [98, 108, 111, 99, 107, 101, 100] => until.blocked = true,
                [100, 111, 110, 101] => until.done = true,
                _ => {}
            }
        }
        Ok(until)
    }
}

// No Debug: name/params are private caller data.
pub(crate) struct Query {
    name: Vec<u16>,
    until: Until,
    timeout_ms: f64,
}
pub(crate) fn parse(bytes: &[u8]) -> Option<(Value, Result<Query, ApiError>)> {
    let raw: Box<RawValue> = serde_json::from_slice(bytes).ok()?;
    let fields = Fields::parse(&raw).ok()?;
    let method: String = serde_json::from_str(fields.get("method")?.get()).ok()?;
    if method != "agent.wait" {
        return None;
    }
    let id = fields
        .get("id")
        .and_then(|v| serde_json::from_str::<Value>(v.get()).ok())
        .unwrap_or(Value::Null);
    let query = (|| {
        if !(id.is_string() || id.is_number()) {
            return Err(invalid());
        }
        let params = fields
            .get("params")
            .map(Fields::parse)
            .transpose()
            .map_err(|_| invalid())?
            .unwrap_or_default();
        let name = params
            .get("name")
            .filter(|v| v.get() != "null")
            .map(crate::session_read::javascript_string)
            .transpose()
            .map_err(|_| invalid())?
            .unwrap_or_default();
        let until = Until::parse(params.get("until"))?;
        let timeout_ms = match params.get("timeoutMs") {
            Some(v)
                if v.get()
                    .starts_with(|ch: char| ch == '-' || ch.is_ascii_digit()) =>
            {
                let number = v.get().parse::<f64>().map_err(|_| invalid())?;
                if !number.is_finite() {
                    return Err(invalid());
                }
                number
            }
            _ => DEFAULT_TIMEOUT_MS,
        };
        Ok(Query {
            name,
            until,
            timeout_ms,
        })
    })();
    Some((id, query))
}

#[derive(Clone, Copy)]
enum Entry {
    Absent,
    Pending,
    Completed { ok: bool },
}
#[derive(Debug, Eq, PartialEq)]
enum Decision {
    Status,
    Completed,
    Timeout,
    Pending,
}
fn decide(until: Until, status: Status, entry: Entry, expired: bool) -> Decision {
    if status.needs_human() && until.blocked {
        return Decision::Status;
    }
    match entry {
        Entry::Completed { ok } if until.matches(status) || !ok => return Decision::Completed,
        Entry::Absent if until.matches(status) => return Decision::Status,
        _ => {}
    }
    if expired {
        Decision::Timeout
    } else {
        Decision::Pending
    }
}

fn unavailable() -> ApiError {
    error("unavailable", "qualified completion is unavailable")
}
fn closed() -> ApiError {
    error("closed", "wait connection or daemon closed")
}
fn storage() -> ApiError {
    error("storage_unavailable", "wait state is unavailable")
}
fn not_found() -> ApiError {
    error("not_found", "session no longer exists")
}
fn healthy(state: &State, driver: &Driver) -> Result<(), ApiError> {
    if *state.stop.borrow() || driver.closed() {
        return Err(closed());
    }
    if crate::runtime_state::unavailable(state) || driver.storage_failed() {
        return Err(storage());
    }
    Ok(())
}
// Never hold a synchronous guard across await, or block the reactor behind
// registry IO. A busy snapshot retries; it is not evidence of cold/no entry.
fn current(
    state: &State,
    name: &str,
    pinned: Option<&SessionKey>,
) -> Result<Option<(SessionKey, Status)>, ApiError> {
    let registry = match state.registry.try_lock() {
        Ok(registry) => registry,
        Err(TryLockError::WouldBlock) => return Ok(None),
        Err(_) => return Err(storage()),
    };
    let record = registry.find(name).ok_or_else(not_found)?;
    let key = SessionKey {
        name: record.name().into(),
        created_at: record.scalar("createdAt").ok_or_else(storage)?,
    };
    if pinned.is_some_and(|pinned| pinned != &key) {
        return Err(not_found());
    }
    let cache = match state.live_sessions.try_lock() {
        Ok(cache) => cache,
        Err(TryLockError::WouldBlock) => return Ok(None),
        Err(_) => return Err(storage()),
    };
    let status = cache.view(&key).ok_or_else(unavailable)?.status;
    drop(cache);
    drop(registry);
    let status = if crate::permission_state::list(state, Some(name)).is_empty() {
        status
    } else {
        Status::BlockedPermission
    };
    Ok(Some((key, status)))
}
fn response(
    name: &str,
    status: Status,
    reason: &str,
    answer: Option<(
        &crate::turn_completion::CompletionRef,
        &crate::turn_completion::CompletedAnswer,
    )>,
) -> Result<Box<RawValue>, ApiError> {
    let mut value = json!({"name":name,"status":status.as_str(),"reason":reason});
    if let Some((reference, answer)) = answer {
        value["turnId"] = json!(reference.public_turn_id());
        value["ok"] = json!(answer.ok());
        for (key, value_text) in [
            ("errorCode", answer.error_code()),
            ("text", answer.text()),
            ("message", answer.message()),
        ] {
            if let Some(text) = value_text.filter(|text| !text.is_empty()) {
                value[key] = json!(text);
            }
        }
    }
    let raw = serde_json::value::to_raw_value(&value).map_err(|_| unavailable())?;
    if raw.get().len() >= crate::MAX_LINE - 512 {
        return Err(error("capacity", "wait result exceeds frame budget"));
    }
    Ok(raw)
}
fn read_error(error: crate::turn_completion::CompletionReadError) -> ApiError {
    use crate::turn_completion::{CompletionReadError, CompletionUnavailable};
    match error {
        CompletionReadError::Unavailable(CompletionUnavailable::Capacity) => {
            self::error("capacity", "completion read capacity reached")
        }
        CompletionReadError::Storage => storage(),
        _ => unavailable(),
    }
}
async fn changed(
    stop: &mut watch::Receiver<bool>,
    committed: &mut watch::Receiver<u64>,
    progress: Option<&mut watch::Receiver<Progress>>,
) -> Result<(), ApiError> {
    let progress = async {
        if let Some(progress) = progress.filter(|progress| progress.has_changed().is_ok()) {
            let _ = progress.changed().await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        _=stop.changed()=>Err(closed()),
        _=committed.changed()=>Ok(()),
        _=progress=>Ok(()),
        _=tokio::time::sleep(Duration::from_millis(40))=>Ok(()),
    }
}

pub(crate) async fn wait(
    state: Arc<State>,
    query: Query,
    _admission: OwnedSemaphorePermit,
) -> Result<Box<RawValue>, ApiError> {
    let start = Instant::now();
    let name = String::from_utf16(&query.name).map_err(|_| not_found())?;
    let driver = state.driver.get().cloned().ok_or_else(unavailable)?;
    let (mut stop, mut committed) = (state.stop.subscribe(), state.committed.subscribe());
    let mut pinned = None;
    loop {
        healthy(&state, &driver)?;
        let Some((key, mut status)) = current(&state, &name, pinned.as_ref())? else {
            if start.elapsed().as_secs_f64() * 1000.0 >= query.timeout_ms {
                return Err(error("timeout", "wait state snapshot deadline reached"));
            }
            changed(&mut stop, &mut committed, None).await?;
            continue;
        };
        if pinned.is_none() {
            pinned = Some(key.clone());
        }
        healthy(&state, &driver)?;
        if decide(query.until, status, Entry::Pending, false) == Decision::Status {
            return response(&name, status, "matched", None);
        }
        let mut latest = driver.latest_progress(&key);
        healthy(&state, &driver)?;
        let progress = latest
            .as_mut()
            .map(|(_, receiver)| receiver.borrow_and_update().clone());
        let mut entry = Entry::Absent;
        if let Some(progress) = progress {
            entry = Entry::Pending;
            if let Progress::Finished(terminal) = progress {
                let terminal = terminal.map_err(|_| unavailable())?;
                let ok = matches!(
                    terminal.turn.outcome,
                    crate::turn_coordinator::Outcome::Success
                );
                entry = Entry::Completed { ok };
                let expired = start.elapsed().as_secs_f64() * 1000.0 >= query.timeout_ms;
                if decide(query.until, status, entry, expired) == Decision::Completed {
                    // No completion IO for an ineligible successful outcome:
                    // e.g. until=["UNKNOWN"], timeout=0 must be status-only timeout.
                    let reference = terminal.completion_ref.ok_or_else(unavailable)?;
                    if reference.session() != &key {
                        return Err(unavailable());
                    }
                    let ticket = latest.as_ref().ok_or_else(unavailable)?.0.clone();
                    let ref_id = reference.terminal_event_id();
                    // read_completion owns admitted IO/budget independently of this
                    // caller. Dropping the connection does not detach that Store job.
                    let answer = tokio::select! {
                        _=stop.changed()=>return Err(closed()),
                        _=driver.wait_for_storage_failure()=>return Err(storage()),
                        answer=driver.read_completion(reference.clone())=>answer,
                    };
                    healthy(&state, &driver)?;
                    let Some((_, after)) = current(&state, &name, Some(&key))? else {
                        if start.elapsed().as_secs_f64() * 1000.0 >= query.timeout_ms {
                            return Err(error("timeout", "wait state snapshot deadline reached"));
                        }
                        changed(&mut stop, &mut committed, None).await?;
                        continue;
                    };
                    status = after;
                    let Some((now, receiver)) = driver.latest_progress(&key) else {
                        return Err(unavailable());
                    };
                    healthy(&state, &driver)?;
                    if now != ticket {
                        continue;
                    }
                    if !matches!(&*receiver.borrow(), Progress::Finished(Ok(terminal)) if terminal.completion_ref.as_ref().is_some_and(|r| r.terminal_event_id()==ref_id))
                    {
                        return Err(unavailable());
                    }
                    if decide(query.until, status, Entry::Pending, false) == Decision::Status {
                        return response(&name, status, "matched", None);
                    }
                    let answer = answer.map_err(read_error)?;
                    if answer.ok() != ok {
                        return Err(unavailable());
                    }
                    let expired = start.elapsed().as_secs_f64() * 1000.0 >= query.timeout_ms;
                    match decide(query.until, status, entry, expired) {
                        Decision::Completed => {
                            return response(&name, status, "matched", Some((&reference, &answer)));
                        }
                        Decision::Timeout => return response(&name, status, "timeout", None),
                        Decision::Status => return response(&name, status, "matched", None),
                        Decision::Pending => {}
                    }
                }
            }
        }
        let expired = start.elapsed().as_secs_f64() * 1000.0 >= query.timeout_ms;
        match decide(query.until, status, entry, expired) {
            Decision::Status => return response(&name, status, "matched", None),
            Decision::Timeout => return response(&name, status, "timeout", None),
            Decision::Completed => return Err(unavailable()), // must go through exact-ref read above
            Decision::Pending => {}
        }
        changed(
            &mut stop,
            &mut committed,
            latest.as_mut().map(|(_, receiver)| receiver),
        )
        .await?;
    }
}

#[cfg(test)]
#[path = "session_wait_tests.rs"]
mod state_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn query(params: &str) -> Query {
        let bytes = format!(r#"{{"id":1,"method":"agent.wait","params":{params}}}"#);
        parse(bytes.as_bytes())
            .unwrap()
            .1
            .unwrap_or_else(|e| panic!("{}", e.code))
    }
    #[test]
    fn raw_rpc_coercion_preserves_arrays_unknown_aliases_and_numeric_timeout() {
        let q = query(
            r#"{"name":[["chat"],null,2],"until":[["idle"]," blocked","done,blocked",null],"timeoutMs":-0.5,"ignored":true}"#,
        );
        assert_eq!(String::from_utf16(&q.name).unwrap(), "chat,,2");
        assert!(q.until.matches(Status::Idle));
        assert!(!q.until.matches(Status::BlockedPermission));
        assert!(!q.until.matches(Status::Done));
        assert_eq!(q.timeout_ms, -0.5);
        for value in ["null", "{}", "\"idle\"", "[]"] {
            let q = query(&format!(
                r#"{{"name":null,"until":{value},"timeoutMs":"0"}}"#
            ));
            assert!(q.name.is_empty());
            assert!(q.until.matches(Status::Idle) && q.until.matches(Status::Done));
            assert_eq!(q.timeout_ms, DEFAULT_TIMEOUT_MS);
        }
        let q = query(r#"{"until":["UNKNOWN"],"timeoutMs":1e300}"#);
        assert!(!Status::ALL.into_iter().any(|s| q.until.matches(s)));
        assert_eq!(q.timeout_ms, 1e300);
    }
    #[test]
    fn policy_matches_before_timeout_but_pending_never_becomes_status_only_success() {
        assert_eq!(
            decide(
                Until::ALL,
                Status::BlockedQuestion,
                Entry::Completed { ok: false },
                true
            ),
            Decision::Status
        );
        assert_eq!(
            decide(Until::ALL, Status::Idle, Entry::Absent, true),
            Decision::Status
        );
        assert_eq!(
            decide(Until::ALL, Status::Idle, Entry::Pending, true),
            Decision::Timeout
        );
        assert_eq!(
            decide(Until::ALL, Status::Done, Entry::Pending, false),
            Decision::Pending
        );
        let unknown = query(r#"{"until":["UNKNOWN"]}"#).until;
        assert_eq!(
            decide(
                unknown,
                Status::Working,
                Entry::Completed { ok: false },
                true
            ),
            Decision::Completed
        );
        assert_eq!(
            decide(unknown, Status::Idle, Entry::Completed { ok: true }, true),
            Decision::Timeout
        );
        assert_eq!(
            decide(Until::ALL, Status::Failed, Entry::Absent, false),
            Decision::Status
        );
    }

    #[test]
    fn aliases_cover_the_exact_nine_statuses_without_case_or_whitespace_normalization() {
        for status in Status::ALL {
            let expected = !matches!(status, Status::Cold | Status::Working);
            assert_eq!(Until::ALL.matches(status), expected, "{}", status.as_str());
            let pending = decide(Until::ALL, status, Entry::Pending, false);
            assert_eq!(
                pending,
                if status.needs_human() {
                    Decision::Status
                } else {
                    Decision::Pending
                }
            );
        }
        for aliases in [
            r#"["IDLE"]"#,
            r#"[" idle "]"#,
            r#"["idle,blocked"]"#,
            r#"[[]]"#,
            r#"[null]"#,
        ] {
            let q = query(&format!(r#"{{"until":{aliases}}}"#));
            assert!(!Status::ALL.into_iter().any(|s| q.until.matches(s)));
        }
    }

    #[test]
    fn malformed_selected_fields_fail_without_reflecting_payload_or_defaulting_nonfinite() {
        for params in [
            r#"null"#,
            r#"[]"#,
            r#"{"name":{"toString":null}}"#,
            r#"{"timeoutMs":1e400}"#,
        ] {
            let bytes = format!(r#"{{"id":"req","method":"agent.wait","params":{params}}}"#);
            let (id, parsed) = parse(bytes.as_bytes()).unwrap();
            assert_eq!(id, serde_json::json!("req"));
            let failure = parsed.err().unwrap();
            assert_eq!(failure.code, "invalid_params");
            assert_eq!(failure.message, "invalid wait parameters");
        }
    }

    #[test]
    fn wait_admission_is_immediate_bounded_and_recovers_on_drop() {
        let gate = Gate::default();
        let mut permits: Vec<_> = (0..GLOBAL)
            .map(|_| gate.admit().unwrap_or_else(|e| panic!("{}", e.code)))
            .collect();
        assert_eq!(gate.admit().err().unwrap().code, "capacity");
        drop(permits.pop());
        assert!(gate.admit().is_ok());
        drop(permits);
        assert_eq!(gate.0.available_permits(), GLOBAL);
    }
}
