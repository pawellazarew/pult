//! Trusted owner services for the shared ordinary Codex host.
use crate::codex_events::{RedactionError, Redactor};
use crate::codex_worker::{
    ApprovalHandler, Services, ThreadPrepared, ThreadReceipt, ThreadStore, ThreadStoreError,
};
use crate::consent_store::ConsentStore;
use crate::owner_trust::OwnerTrust;
pub use crate::owner_trust::{OwnerError, RouteValidity};
use crate::registry::Registry;
use crate::turn_coordinator::Ticket;
use crate::turn_driver::{Driver, EventSink, Task};
use crate::turn_snapshot::{Provider, SessionKey, TurnSnapshot};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

pub struct CodexOwner {
    trust: OwnerTrust,
}
impl CodexOwner {
    /// Stores belong to this captured trusted home; route checks a host stamp.
    pub fn new(
        home: PathBuf,
        registry: Arc<Mutex<Registry>>,
        driver: Weak<Driver>,
        consent: Arc<Mutex<ConsentStore>>,
        route: RouteValidity,
    ) -> Result<Arc<Self>, OwnerError> {
        Ok(Arc::new(Self {
            trust: OwnerTrust::new(
                home,
                registry,
                driver,
                consent,
                route,
                Provider::Codex,
                None,
            )?,
        }))
    }
    pub fn snapshot(&self, key: &SessionKey) -> Result<TurnSnapshot, OwnerError> {
        self.trust.snapshot(key)
    }
    pub fn services(
        self: &Arc<Self>,
        sink: Arc<dyn EventSink>,
        approval: Option<Arc<dyn ApprovalHandler>>,
    ) -> Services {
        let gate = self.clone();
        let weak = self.trust.driver.clone();
        Services {
            sink,
            approval,
            redactors: Arc::new(|| Box::new(OwnerRedactor)),
            fresh_gate: Arc::new(move |ticket: &Ticket, snapshot: &TurnSnapshot| {
                gate.trust.gate(ticket, snapshot)
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
            .trust
            .live(request.ticket())
            .map_err(|_| ThreadStoreError::Rejected)?;
        if initial.key != *request.session()
            || initial.cwd != request.cwd()
            || initial.provider != Provider::Codex
            || !self.trust.route_ok(request.ticket(), &initial)
        {
            return Err(ThreadStoreError::Rejected);
        }
        if self.trust.live(request.ticket()).as_ref() != Ok(&initial) {
            return Err(ThreadStoreError::Rejected);
        }
        let current = self.trust.snapshot(request.session()).map_err(|error| {
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
            .trust
            .registry
            .lock()
            .map_err(|_| ThreadStoreError::Unknown)?;
        // Recheck the current record under the write serialization. Never carry
        // a record snapshot across the transaction or replace unrelated fields.
        let record = registry
            .find(&request.session().name)
            .ok_or(ThreadStoreError::Rejected)?;
        self.trust
            .incarnation(record, request.session())
            .map_err(|_| ThreadStoreError::Rejected)?;
        self.trust
            .transaction_scope(record, &initial)
            .map_err(|_| ThreadStoreError::Rejected)?;
        if self.trust.live(request.ticket()).as_ref() != Ok(&initial) {
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
