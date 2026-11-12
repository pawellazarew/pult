//! Pure current Node status projection and bounded registered-session cache.
//! Feed note in global durable-journal order under the host Store mutex. IDs
//! reject stale/already-applied events; they cannot reconstruct a reordered stream.
//! Seed only from recovered Registry (busy recovery is already cold), never by
//! replaying old status events. Reseeding is an explicit trusted reset.
//! Null data makes Node throw for status.changed/limit.hit; this total typed API
//! conservatively keeps the previous status for that malformed envelope.
use crate::turn_snapshot::SessionKey;
use serde_json::Value;
use std::collections::HashMap;
const MAX_ID: u64 = 9_007_199_254_740_991;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Cold,
    Idle,
    Working,
    BlockedPermission,
    BlockedQuestion,
    Limited,
    Interrupted,
    Failed,
    Done,
}
impl Status {
    pub const ALL: [Self; 9] = [
        Self::Cold,
        Self::Idle,
        Self::Working,
        Self::BlockedPermission,
        Self::BlockedQuestion,
        Self::Limited,
        Self::Interrupted,
        Self::Failed,
        Self::Done,
    ];
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == value)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cold => "cold",
            Self::Idle => "idle",
            Self::Working => "working",
            Self::BlockedPermission => "blocked_permission",
            Self::BlockedQuestion => "blocked_question",
            Self::Limited => "limited",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
            Self::Done => "done",
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed)
    }
    pub fn needs_human(self) -> bool {
        matches!(self, Self::BlockedPermission | Self::BlockedQuestion)
    }
}
pub fn reduce(previous: Status, kind: &str, data: &Value) -> Status {
    let warning = data.get("rateLimitStatus").and_then(Value::as_str) == Some("allowed_warning")
        || (kind == "limit.hit"
            && data.get("status").and_then(Value::as_str) == Some("allowed_warning"));
    if kind == "status.changed"
        && !warning
        && let Some(forced) = data
            .get("status")
            .and_then(Value::as_str)
            .and_then(Status::parse)
    {
        return forced;
    }
    match kind {
        "session.started" if previous == Status::Working => Status::Working,
        "session.started" => Status::Idle,
        "session.ended" => Status::Done,
        "provider.blocked" | "net.blocked" => Status::Failed,
        "permission.requested" => Status::BlockedPermission,
        "permission.resolved" if previous == Status::BlockedPermission => Status::Working,
        "question.asked" => Status::BlockedQuestion,
        "limit.hit" if !warning && !data.is_null() => Status::Limited,
        _ => previous,
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Capacity,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct View {
    pub status: Status,
    pub status_event_id: u64,
}
// No derived Debug: even names/incarnation IDs are host-private metadata.
pub struct Change {
    pub key: SessionKey,
    pub status: Status,
    pub event_id: u64,
}
struct Entry {
    key: SessionKey,
    view: View,
    last_applied_id: u64,
}
pub struct Cache {
    entries: HashMap<String, Entry>,
    capacity: usize,
    last_event_id: u64,
}
impl std::fmt::Debug for Cache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionLiveCache")
            .field("sessions", &self.entries.len())
            .field("capacity", &self.capacity)
            .finish()
    }
}
impl Cache {
    pub fn new(capacity: usize) -> Result<Self, Error> {
        if capacity == 0 || capacity > 65536 {
            return Err(Error::Invalid);
        }
        Ok(Self {
            entries: HashMap::new(),
            capacity,
            last_event_id: 0,
        })
    }
    /// Whether another new incarnation name fits. A same-name trusted reseed
    /// can still replace its slot when full; this check does not reserve a slot.
    pub fn can_register(&self) -> bool {
        self.entries.len() < self.capacity
    }
    /// Explicit trusted initialization/reset, not an event. Same-name new
    /// incarnations replace their slot; recovery must already have cooled busy.
    pub fn seed(
        &mut self,
        key: SessionKey,
        status: Status,
        last_status_event_id: u64,
    ) -> Result<(), Error> {
        if key.validate().is_err() || last_status_event_id > MAX_ID {
            return Err(Error::Invalid);
        }
        if !self.entries.contains_key(&key.name) && self.entries.len() >= self.capacity {
            return Err(Error::Capacity);
        }
        self.last_event_id = self.last_event_id.max(last_status_event_id);
        self.entries.insert(
            key.name.clone(),
            Entry {
                key,
                view: View {
                    status,
                    status_event_id: last_status_event_id,
                },
                last_applied_id: last_status_event_id,
            },
        );
        Ok(())
    }
    pub fn remove(&mut self, key: &SessionKey) -> bool {
        if self
            .entries
            .get(&key.name)
            .is_some_and(|entry| &entry.key == key)
        {
            self.entries.remove(&key.name);
            true
        } else {
            false
        }
    }
    pub fn view(&self, key: &SessionKey) -> Option<View> {
        self.entries
            .get(&key.name)
            .filter(|entry| &entry.key == key)
            .map(|entry| entry.view)
    }
    /// A global monotonic cursor also rejects out-of-order events for different
    /// sessions. Unknown names consume no slots and retain no event payload.
    pub fn note(
        &mut self,
        session_name: &str,
        id: u64,
        kind: &str,
        data: &Value,
    ) -> Option<Change> {
        if id == 0 || id > MAX_ID || id <= self.last_event_id {
            return None;
        }
        self.last_event_id = id;
        let entry = self.entries.get_mut(session_name)?;
        if id <= entry.last_applied_id {
            return None;
        }
        entry.last_applied_id = id;
        let status = reduce(entry.view.status, kind, data);
        if status == entry.view.status {
            return None;
        }
        entry.view = View {
            status,
            status_event_id: id,
        };
        Some(Change {
            key: entry.key.clone(),
            status,
            event_id: id,
        })
    }
}
