//! Cursor-based subscriptions use the durable journal as their queue. Notifications
//! retain one committed ID, irrespective of how many events a slow client misses.
use crate::{
    State,
    journal::MAX_EVENT_ID,
    stream::{Writer, fit_event},
};
use anyhow::{Context, Result, ensure};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json, value::RawValue};
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::watch;
use tokio::task::JoinHandle;

pub const LIVE_BASE: u64 = 1 << 50;
const MAX_SUBSCRIPTIONS: usize = 32;

pub struct Pending {
    pub id: u64,
    pub cursor: u64,
    since: u64,
    session: Option<String>,
    live_id: Option<u64>,
    committed: watch::Receiver<u64>,
}

struct Handle {
    active: Arc<AtomicBool>,
    task: JoinHandle<()>,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.task.abort();
    }
}

pub struct Subscriptions {
    next: u64,
    handles: HashMap<u64, Handle>,
}

struct Count(Arc<State>);
impl Drop for Count {
    fn drop(&mut self) {
        self.0.subscriptions.fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
struct EventFrame {
    sub: u64,
    event: Box<RawValue>,
}

impl Subscriptions {
    pub fn new() -> Self {
        Self {
            next: 0,
            handles: HashMap::new(),
        }
    }

    pub fn prepare(&mut self, state: &Arc<State>, params: &Value) -> Result<Pending> {
        self.handles.retain(|_, handle| !handle.task.is_finished());
        ensure!(
            self.handles.len() < MAX_SUBSCRIPTIONS,
            "at most 32 active subscriptions per connection"
        );
        ensure!(self.next < MAX_EVENT_ID, "subscription id space exhausted");
        let number = params["since"].as_f64().unwrap_or(0.0);
        let since = number.floor().max(0.0) as u64;
        let live = params["live"] == true || number >= LIVE_BASE as f64;
        let live_id = if live {
            ensure!(
                since < MAX_EVENT_ID,
                "live cursor must be below the largest safe integer"
            );
            let previous = state
                .live_id
                .try_update(Ordering::AcqRel, Ordering::Acquire, |id| {
                    id.max(since)
                        .checked_add(1)
                        .filter(|next| *next <= MAX_EVENT_ID)
                })
                .map_err(|_| anyhow::anyhow!("live cursor space exhausted"))?;
            Some(previous.max(since) + 1)
        } else {
            None
        };
        // Register notification reception before capturing the replay boundary.
        // Appends publish the counter only after the durable write succeeds.
        let committed = state.committed.subscribe();
        let cursor = state.last_event_id.load(Ordering::Acquire);
        self.next += 1;
        Ok(Pending {
            id: self.next,
            cursor,
            since,
            live_id,
            committed,
            session: params["sessionId"].as_str().map(str::to_owned),
        })
    }

    /// Called only after the response containing the subscription ID is written.
    pub fn start(&mut self, pending: Pending, state: Arc<State>, writer: Writer) {
        state.subscriptions.fetch_add(1, Ordering::Relaxed);
        let count = Count(state.clone());
        let active = Arc::new(AtomicBool::new(true));
        let task_active = active.clone();
        let id = pending.id;
        let host_job = state.host_jobs.track();
        let task = tokio::spawn(async move {
            let _host_job = host_job;
            let _count = count;
            let result = if let Some(live_id) = pending.live_id {
                let event = json!({"id":live_id,"ts":Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),"sessionId":"daemon","provider":"pult","kind":"turn.phase","data":{"reset":true}});
                async {
                    writer
                        .event(&json!({"sub":id,"event":event}), task_active.clone())
                        .await?;
                    std::future::pending::<()>().await;
                    Ok(())
                }
                .await
            } else {
                replay(pending, state, writer.clone(), task_active.clone()).await
            };
            if result.is_err() && task_active.load(Ordering::Acquire) {
                let _ = writer.response(&json!({"sub":id,"end":{"code":"slow_consumer","message":"client cannot consume the event stream"}})).await;
            }
        });
        self.handles.insert(id, Handle { active, task });
    }

    pub async fn unsubscribe(&mut self, id: u64) -> bool {
        self.handles.retain(|_, handle| !handle.task.is_finished());
        let Some(mut handle) = self.handles.remove(&id) else {
            return false;
        };
        handle.active.store(false, Ordering::Release);
        handle.task.abort();
        let _ = (&mut handle.task).await;
        true
    }

    pub async fn shutdown(&mut self, writer: &Writer) {
        let ids: Vec<_> = self.handles.keys().copied().collect();
        for id in ids {
            if self.unsubscribe(id).await {
                let _ = writer.response(&json!({"sub":id,"end":{"code":"daemon_stopping","message":"daemon is stopping"}})).await;
            }
        }
    }
}

async fn replay(
    mut pending: Pending,
    state: Arc<State>,
    writer: Writer,
    active: Arc<AtomicBool>,
) -> Result<()> {
    // A future durable cursor suppresses history but still receives new appends,
    // matching Node's live listener once initial replay has completed.
    let mut cursor = pending.since.min(pending.cursor);
    let mut first = true;
    loop {
        let notified = *pending.committed.borrow_and_update();
        let until = if first {
            notified.max(pending.cursor)
        } else {
            notified
        };
        first = false;
        while cursor < until {
            let page_state = state.clone();
            let session = pending.session.clone();
            let host_job = page_state.host_jobs.track();
            let page = tokio::task::spawn_blocking(move || {
                let _host_job = host_job;
                page_state
                    .store
                    .lock()
                    .map_err(|_| anyhow::anyhow!("journal lock poisoned"))?
                    .read_from(cursor, session.as_deref(), 256, 1024 * 1024)
            })
            .await
            .context("replay task failed")??;
            let mut advanced = false;
            for event in page {
                if event.id > until {
                    break;
                }
                cursor = event.id;
                advanced = true;
                let frame = EventFrame {
                    sub: pending.id,
                    event: fit_event(event.json)?,
                };
                writer.event(&frame, active.clone()).await?;
            }
            if !advanced {
                break;
            }
            tokio::task::yield_now().await;
        }
        cursor = cursor.max(until);
        if pending.committed.changed().await.is_err() {
            return Ok(());
        }
    }
}
