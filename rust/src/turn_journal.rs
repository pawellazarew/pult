//! Durable driver events backed by the existing global journal. Commit notices
//! are published inside the blocking append, so dropping a caller's future does
//! not turn an already-started write into an unreported or cancelled operation.
use crate::journal::EventStore;
use crate::turn_driver::{EventSink, Receipt, SinkError, Task};
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Commit {
    pub last_event_id: u64,
    pub projection_degraded: bool,
}

#[derive(Clone)]
pub struct JournalSink {
    store: Arc<Mutex<EventStore>>,
    committed: watch::Sender<Commit>,
}

fn failure(message: impl ToString) -> SinkError {
    SinkError {
        message: message.to_string(),
    }
}

impl JournalSink {
    pub fn new(store: Arc<Mutex<EventStore>>) -> Result<Self, SinkError> {
        let initial = {
            let guard = store.lock().map_err(failure)?;
            Commit {
                last_event_id: guard.last_id(),
                projection_degraded: guard.projection_error().is_some(),
            }
        };
        let (committed, _) = watch::channel(initial);
        Ok(Self { store, committed })
    }

    pub fn subscribe(&self) -> watch::Receiver<Commit> {
        self.committed.subscribe()
    }
}

impl EventSink for JournalSink {
    fn read_completion(
        &self,
        reference: crate::turn_completion::CompletionRef,
    ) -> Task<
        Result<
            crate::turn_completion::CompletedAnswer,
            crate::turn_completion::CompletionReadError,
        >,
    > {
        let store = self.store.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut store = store
                    .lock()
                    .map_err(|_| crate::turn_completion::CompletionReadError::Storage)?;
                crate::turn_completion_store::read(&mut store, &reference)
            })
            .await
            .map_err(|_| crate::turn_completion::CompletionReadError::Storage)?
        })
    }

    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let store = self.store.clone();
        let committed = self.committed.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let (event, update) = {
                    let mut guard = store.lock().map_err(failure)?;
                    let event = guard.append(draft).map_err(failure)?;
                    let update = Commit {
                        last_event_id: guard.last_id(),
                        projection_degraded: guard.projection_error().is_some(),
                    };
                    (event, update)
                };
                let receipt = Receipt {
                    id: event["id"]
                        .as_u64()
                        .ok_or_else(|| failure("durable event has no valid id"))?,
                    ts: event["ts"]
                        .as_str()
                        .ok_or_else(|| failure("durable event has no valid timestamp"))?
                        .to_owned(),
                };
                // Do not nest the store lock with watch's internal lock. A
                // delayed older append must not overwrite a newer notice.
                committed.send_if_modified(|current| {
                    if update.last_event_id > current.last_event_id {
                        *current = update;
                        true
                    } else {
                        false
                    }
                });
                Ok(receipt)
            })
            .await
            .map_err(failure)?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::task::{Context, Waker};
    use std::time::Duration;

    fn store() -> (tempfile::TempDir, Arc<Mutex<EventStore>>) {
        let home = tempfile::tempdir().unwrap();
        let store = EventStore::open(&home.path().join("events")).unwrap();
        (home, Arc::new(Mutex::new(store)))
    }

    fn draft(text: &str) -> Value {
        json!({"sessionId":"chat","provider":"codex","kind":"message.user","data":{"text":text}})
    }

    #[tokio::test]
    async fn initializes_from_existing_journal_and_acknowledges_durable_records() {
        let (home, store) = store();
        store.lock().unwrap().append(draft("existing")).unwrap();
        let sink = JournalSink::new(store.clone()).unwrap();
        let mut commits = sink.subscribe();
        assert_eq!(
            *commits.borrow(),
            Commit {
                last_event_id: 1,
                projection_degraded: false
            }
        );
        let receipt = sink.append(draft("🌊 acknowledged")).await.unwrap();
        assert_eq!(receipt.id, 2);
        assert!(!receipt.ts.is_empty());
        assert!(commits.has_changed().unwrap());
        assert_eq!(commits.borrow_and_update().last_event_id, receipt.id);
        drop(sink);
        drop(store);
        let mut reopened = EventStore::open(&home.path().join("events")).unwrap();
        let records = reopened.read_from(0, Some("chat"), 10, 65536).unwrap();
        assert_eq!(records.len(), 2);
        let recorded: Value = serde_json::from_str(records[1].json.get()).unwrap();
        assert_eq!(recorded["id"], receipt.id);
        assert_eq!(recorded["ts"], receipt.ts);
        assert_eq!(recorded["data"]["text"], "🌊 acknowledged");
    }

    #[tokio::test]
    async fn invalid_draft_returns_no_receipt_and_does_not_publish_a_commit() {
        let (_home, store) = store();
        let sink = JournalSink::new(store.clone()).unwrap();
        let commits = sink.subscribe();
        let rejected = sink.append(json!({"sessionId":"chat"})).await;
        assert!(rejected.is_err());
        assert!(!commits.has_changed().unwrap());
        assert_eq!(commits.borrow().last_event_id, 0);
        assert_eq!(store.lock().unwrap().last_id(), 0);
        assert_eq!(sink.append(draft("valid")).await.unwrap().id, 1);
    }

    #[tokio::test]
    async fn poisoned_mutex_is_an_error_for_constructor_and_append() {
        let (_home, store) = store();
        let sink = JournalSink::new(store.clone()).unwrap();
        let commits = sink.subscribe();
        let poisoned = store.clone();
        let result = std::panic::catch_unwind(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("fixture poison");
        });
        assert!(result.is_err());
        assert!(JournalSink::new(store).is_err());
        assert!(sink.append(draft("not written")).await.is_err());
        assert!(!commits.has_changed().unwrap());
    }

    #[tokio::test]
    async fn concurrent_appends_keep_the_commit_notice_at_the_latest_record() {
        let (_home, store) = store();
        let sink = JournalSink::new(store.clone()).unwrap();
        let commits = sink.subscribe();
        let tasks: Vec<_> = (0..12)
            .map(|n| {
                let sink = sink.clone();
                tokio::spawn(async move { sink.append(draft(&n.to_string())).await.unwrap().id })
            })
            .collect();
        let mut ids = tokio::time::timeout(Duration::from_secs(10), async {
            let mut ids = Vec::new();
            for task in tasks {
                ids.push(task.await.unwrap());
            }
            ids
        })
        .await
        .expect("journal append watchdog");
        ids.sort_unstable();
        assert_eq!(ids, (1..=12).collect::<Vec<_>>());
        assert_eq!(commits.borrow().last_event_id, 12);
        assert_eq!(store.lock().unwrap().last_id(), 12);
    }

    #[tokio::test]
    async fn dropping_polled_caller_does_not_cancel_write_or_commit_notice() {
        let (_home, store) = store();
        let sink = JournalSink::new(store.clone()).unwrap();
        let mut commits = sink.subscribe();
        // Lock the store so the first poll must suspend after spawning its
        // blocking writer. No scheduler delay is used to guess that boundary.
        {
            let guard = store.lock().unwrap();
            let mut append = sink.append(draft("caller disconnected"));
            let mut context = Context::from_waker(Waker::noop());
            assert!(append.as_mut().poll(&mut context).is_pending());
            drop(append);
            drop(guard);
        }
        tokio::time::timeout(Duration::from_secs(10), commits.changed())
            .await
            .expect("detached journal write watchdog")
            .unwrap();
        assert_eq!(commits.borrow().last_event_id, 1);
        assert_eq!(store.lock().unwrap().last_id(), 1);
    }
}
