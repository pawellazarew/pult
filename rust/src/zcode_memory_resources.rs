//! Private, single-use Route B shared-memory resources. No Runtime activation.
//! Native private MCP config is delivered only through the frozen Worker's wire.
use crate::{
    memory_turn::{Backend, InputScope, InputScopePermit, TurnMemory},
    turn_coordinator::Ticket,
    turn_driver::{Task, WorkerError},
    turn_snapshot::{Provider, SessionKey},
    zcode_appserver_protocol::StdioMcpServer,
    zcode_appserver_worker::{PreparedResources, ResourceContext, ResourcePermit, ScopedResources},
    zcode_host_services::AppServerInputFrontier,
};
use serde_json::Value;
use std::sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinHandle,
};

const MAX_EARLY_REVOKES: usize = 8;
fn unavailable() -> WorkerError {
    WorkerError {
        code: "provider_unavailable".into(),
        message: "ZCode shared memory resources are unavailable".into(),
    }
}
fn unconfirmed() -> WorkerError {
    WorkerError {
        code: "cleanup_unconfirmed".into(),
        message: "ZCode shared memory cleanup is unconfirmed".into(),
    }
}
fn valid_turn(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}
#[derive(Clone, Copy)]
enum Closed {
    Pending,
    Confirmed,
    Unconfirmed,
}
#[derive(Default)]
struct Installation {
    early: Vec<(Ticket, u64)>,
    exhausted: bool,
}
struct Data {
    catalog: String,
}
struct Entry {
    context: ResourceContext,
    valid: AtomicBool,
    ready: AtomicBool,
    uncertain: AtomicBool,
    scope: OnceLock<InputScope>,
    data: OnceLock<Data>,
    #[cfg(test)]
    server: OnceLock<Value>,
    preparation: Mutex<Option<JoinHandle<()>>>,
    draining: AtomicBool,
    closed: watch::Sender<Closed>,
    drain_job: Mutex<Option<JoinHandle<()>>>,
}
/// The immutable Entry lives directly in Factory: a borrowed Core permit may
/// legally retain its InputScope without an owned/self-referential guard.
pub(crate) struct Factory {
    myself: Weak<Factory>,
    memory: Arc<Backend>,
    session: SessionKey,
    install: Mutex<Installation>,
    entry: OnceLock<Entry>,
    #[cfg(test)]
    hooks: tests::Hooks,
}
struct HeldMemory<'a> {
    _permit: InputScopePermit<'a>,
}
impl ResourcePermit for HeldMemory<'_> {}
struct Wait {
    factory: Option<Arc<Factory>>,
    ticket: Ticket,
    generation: u64,
}
impl Wait {
    fn disarm(&mut self) {
        self.factory = None;
    }
}
impl Drop for Wait {
    fn drop(&mut self) {
        if let Some(factory) = self.factory.take() {
            factory.revoke(&self.ticket, self.generation);
        }
    }
}
/// Unwinding an owned preparation cannot silently leave a reusable local entry.
/// Backend work may still start later; only drain's retained join decides whether
/// cleanup is known. This Drop is best-effort revocation, never cleanup evidence.
struct Preparing {
    factory: Arc<Factory>,
    completed: bool,
}
impl Drop for Preparing {
    fn drop(&mut self) {
        // Async task futures may be dropped after the executor has caught an
        // unwind. A completion flag, not thread::panicking(), owns this fact.
        if !self.completed
            && let Some(entry) = self.factory.entry.get()
        {
            entry.uncertain.store(true, Ordering::Release);
            entry.valid.store(false, Ordering::Release);
            self.factory.memory.revoke(&entry.context.ticket);
        }
    }
}
struct Completion {
    factory: Arc<Factory>,
    published: bool,
}
impl Drop for Completion {
    fn drop(&mut self) {
        if !self.published
            && let Some(entry) = self.factory.entry.get()
        {
            entry.uncertain.store(true, Ordering::Release);
            entry.closed.send_replace(Closed::Unconfirmed);
        }
    }
}
impl Factory {
    #[cfg_attr(not(test), allow(dead_code))] // Future Runtime adapter; production activation is separate.
    pub(crate) fn new(memory: Arc<Backend>, session: SessionKey) -> Result<Arc<Self>, WorkerError> {
        session.validate().map_err(|_| unavailable())?;
        Ok(Arc::new_cyclic(|myself| Self {
            myself: myself.clone(),
            memory,
            session,
            install: Mutex::new(Installation::default()),
            entry: OnceLock::new(),
            #[cfg(test)]
            hooks: tests::Hooks::default(),
        }))
    }
    fn matches(entry: &Entry, ticket: &Ticket, generation: u64) -> bool {
        entry.context.ticket == *ticket && entry.context.generation == generation
    }
    fn usable(entry: &Entry) -> bool {
        entry.valid.load(Ordering::Acquire) && !entry.uncertain.load(Ordering::Acquire)
    }
    fn tombstone(&self, install: &mut Installation, ticket: &Ticket, generation: u64) {
        if ticket.session() != &self.session || generation == 0 || install.exhausted {
            return;
        }
        if install
            .early
            .iter()
            .any(|(t, g)| t == ticket && *g == generation)
        {
            return;
        }
        if install.early.len() >= MAX_EARLY_REVOKES {
            install.exhausted = true;
        } else {
            install.early.push((ticket.clone(), generation));
        }
    }
    fn validate(&self, context: &ResourceContext) -> Result<(), WorkerError> {
        if context.ticket.session() != &self.session
            || context.snapshot.key != self.session
            || context.snapshot.provider != Provider::Zcode
            || context.generation == 0
            || !valid_turn(&context.public_turn)
            || context.snapshot.validate().is_err()
        {
            return Err(unavailable());
        }
        Ok(())
    }
    async fn run_prepare(self: &Arc<Self>) -> Result<PreparedResources, WorkerError> {
        let entry = self.entry.get().ok_or_else(unavailable)?;
        if !Self::usable(entry) {
            return Err(unavailable());
        }
        if !self
            .memory
            .enabled(entry.context.snapshot.key.clone())
            .await?
        {
            return Err(unavailable());
        }
        if !Self::usable(entry) {
            return Err(unavailable());
        }
        #[cfg(test)]
        self.hooks.before_backend().await;
        let preparation = self.memory.prepare(
            entry.context.ticket.clone(),
            entry.context.snapshot.clone(),
            entry.context.public_turn.clone(),
        );
        #[cfg(test)]
        self.hooks.after_backend_construct();
        let prepared = preparation.await?;
        // No permission-purpose or owner key is added to this native config.
        let server = prepared.server().clone();
        let typed = native_server(&server, &entry.context)?;
        #[cfg(test)]
        entry
            .server
            .set(server.clone())
            .map_err(|_| unconfirmed())?;
        #[cfg(test)]
        self.hooks.before_catalog().await;
        let catalog = self.memory.catalog(entry.context.ticket.clone()).await?;
        if catalog.len() > 16_000 || catalog.chars().count() > 4_000 {
            return Err(unavailable());
        }
        let memory = self.memory.clone();
        let ticket = entry.context.ticket.clone();
        let scope = match tokio::task::spawn_blocking(move || memory.input_scope(&ticket)).await {
            Ok(result) => result?,
            Err(_) => {
                entry.uncertain.store(true, Ordering::Release);
                return Err(unconfirmed());
            }
        };
        entry.scope.set(scope).map_err(|_| unconfirmed())?;
        entry
            .data
            .set(Data { catalog })
            .map_err(|_| unconfirmed())?;
        if !Self::usable(entry) {
            return Err(unavailable());
        }
        entry.ready.store(true, Ordering::Release);
        PreparedResources::new(entry.context.clone(), vec![typed])
    }
    async fn run_drain(self: &Arc<Self>) -> Result<(), WorkerError> {
        let entry = self.entry.get().ok_or_else(unconfirmed)?;
        let handle = entry
            .preparation
            .lock()
            .map_err(|_| unconfirmed())?
            .take()
            .ok_or_else(unconfirmed)?;
        if handle.await.is_err() {
            entry.uncertain.store(true, Ordering::Release);
        }
        // The preparation join is essential: an earlier revoke can precede the
        // actual Backend Control issuance. Never infer quiescence from absence.
        self.memory.revoke(&entry.context.ticket);
        let result = self.memory.drain(entry.context.ticket.clone()).await;
        if result.is_err() || entry.uncertain.load(Ordering::Acquire) {
            Err(unconfirmed())
        } else {
            Ok(())
        }
    }
}
impl ScopedResources for Factory {
    fn prepare(&self, context: ResourceContext) -> Task<Result<PreparedResources, WorkerError>> {
        let setup = (|| {
            self.validate(&context)?;
            let factory = self.myself.upgrade().ok_or_else(unavailable)?;
            tokio::runtime::Handle::try_current().map_err(|_| unavailable())?;
            let install = self.install.lock().map_err(|_| unconfirmed())?;
            if self.entry.get().is_some()
                || install.exhausted
                || install
                    .early
                    .iter()
                    .any(|(t, g)| *t == context.ticket && *g == context.generation)
            {
                return Err(unavailable());
            }
            let (start, begin) = oneshot::channel();
            let (send, receive) = oneshot::channel();
            let preparing = factory.clone();
            let handle = tokio::spawn(async move {
                if begin.await.is_err() {
                    return;
                }
                let mut owned = Preparing {
                    factory: preparing.clone(),
                    completed: false,
                };
                let result = preparing.run_prepare().await;
                if result.is_err()
                    && let Some(entry) = preparing.entry.get()
                {
                    preparing.revoke(&entry.context.ticket, entry.context.generation);
                }
                if send.send(result).is_err()
                    && let Some(entry) = preparing.entry.get()
                {
                    preparing.revoke(&entry.context.ticket, entry.context.generation);
                }
                owned.completed = true;
            });
            let (closed, _) = watch::channel(Closed::Pending);
            // install mutex + private start barrier prohibit a drain/issuance
            // handoff gap. The task owns no capability before this publication.
            self.entry
                .set(Entry {
                    context: context.clone(),
                    valid: AtomicBool::new(true),
                    ready: AtomicBool::new(false),
                    uncertain: AtomicBool::new(false),
                    scope: OnceLock::new(),
                    data: OnceLock::new(),
                    #[cfg(test)]
                    server: OnceLock::new(),
                    preparation: Mutex::new(Some(handle)),
                    draining: AtomicBool::new(false),
                    closed,
                    drain_job: Mutex::new(None),
                })
                .map_err(|_| unconfirmed())?;
            drop(install);
            let _ = start.send(());
            let wait = Wait {
                factory: Some(factory),
                ticket: context.ticket,
                generation: context.generation,
            };
            Ok((receive, wait))
        })();
        match setup {
            Err(error) => Box::pin(async move { Err(error) }),
            Ok((receive, wait)) => Box::pin(async move {
                // Move the whole Drop guard into the future, including when
                // its result waiter is never polled.
                let mut wait = wait;
                let result = receive.await.unwrap_or_else(|_| Err(unconfirmed()));
                if result.is_ok() {
                    wait.disarm();
                }
                result
            }),
        }
    }
    fn catalog(
        &self,
        ticket: Ticket,
        generation: u64,
    ) -> Task<Result<Option<String>, WorkerError>> {
        // Catalog is a bounded snapshot loaded through the shared Backend in
        // the retained preparation job. No new IO starts after that join.
        let result = self
            .entry
            .get()
            .filter(|entry| {
                !self.install.is_poisoned()
                    && Self::matches(entry, &ticket, generation)
                    && Self::usable(entry)
                    && entry.ready.load(Ordering::Acquire)
            })
            .and_then(|entry| entry.data.get())
            .map(|data| Some(data.catalog.clone()))
            .ok_or_else(unavailable);
        Box::pin(async move { result })
    }
    fn check<'a>(
        &'a self,
        frontier: &'a AppServerInputFrontier<'_>,
        ticket: &Ticket,
        generation: u64,
    ) -> Result<Box<dyn ResourcePermit + 'a>, WorkerError> {
        if self.install.is_poisoned() {
            return Err(unavailable());
        }
        let entry = self
            .entry
            .get()
            .filter(|entry| {
                Self::matches(entry, ticket, generation)
                    && Self::usable(entry)
                    && entry.ready.load(Ordering::Acquire)
            })
            .ok_or_else(unavailable)?;
        let scope = entry.scope.get().ok_or_else(unavailable)?;
        let permit = scope.enter_current(frontier.current_record())?;
        if !Self::usable(entry) {
            return Err(unavailable());
        }
        Ok(Box::new(HeldMemory { _permit: permit }))
    }
    fn check_reply<'a>(
        &'a self,
        frontier: &'a crate::zcode_host_services::AppServerReplyFrontier<'_>,
        ticket: &Ticket,
        generation: u64,
    ) -> Result<Box<dyn ResourcePermit + 'a>, WorkerError> {
        if self.install.is_poisoned() {
            return Err(unavailable());
        }
        let entry = self
            .entry
            .get()
            .filter(|entry| {
                Self::matches(entry, ticket, generation)
                    && Self::usable(entry)
                    && entry.ready.load(Ordering::Acquire)
            })
            .ok_or_else(unavailable)?;
        let scope = entry.scope.get().ok_or_else(unavailable)?;
        let permit = scope.enter_current(frontier.current_record())?;
        if !Self::usable(entry) {
            return Err(unavailable());
        }
        Ok(Box::new(HeldMemory { _permit: permit }))
    }
    fn revoke(&self, ticket: &Ticket, generation: u64) {
        let exact = {
            let mut install = self
                .install
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match self.entry.get() {
                Some(entry) if Self::matches(entry, ticket, generation) => {
                    entry.valid.store(false, Ordering::Release);
                    true
                }
                Some(_) => false,
                None => {
                    self.tombstone(&mut install, ticket, generation);
                    false
                }
            }
        };
        if exact {
            self.memory.revoke(ticket);
        }
    }
    fn drain(&self, ticket: Ticket, generation: u64) -> Task<Result<(), WorkerError>> {
        // Revocation may recover poison only to deny access. It is outside the
        // installation lock and never claims that cleanup is already known.
        self.revoke(&ticket, generation);
        let setup = (|| {
            let factory = self.myself.upgrade().ok_or_else(unconfirmed)?;
            let mut install = self.install.lock().map_err(|_| unconfirmed())?;
            let Some(entry) = self.entry.get() else {
                self.tombstone(&mut install, &ticket, generation);
                return Ok(None);
            };
            if !Self::matches(entry, &ticket, generation) {
                return Ok(None);
            }
            entry.valid.store(false, Ordering::Release);
            let watching = entry.closed.subscribe();
            if !entry.draining.load(Ordering::Acquire) {
                tokio::runtime::Handle::try_current().map_err(|_| unconfirmed())?;
            }
            if !entry.draining.swap(true, Ordering::AcqRel) {
                let (start, begin) = oneshot::channel();
                let draining = factory.clone();
                // Capture before spawn: aborting an unpolled owned task must
                // publish uncertainty too, rather than strand a Pending watch.
                let completion = Completion {
                    factory: draining.clone(),
                    published: false,
                };
                let handle = tokio::spawn(async move {
                    let mut completion = completion;
                    if begin.await.is_err() {
                        return;
                    }
                    let result = draining.run_drain().await;
                    if let Some(entry) = draining.entry.get() {
                        entry.closed.send_replace(if result.is_ok() {
                            Closed::Confirmed
                        } else {
                            Closed::Unconfirmed
                        });
                    }
                    completion.published = true;
                });
                *entry.drain_job.lock().map_err(|_| unconfirmed())? = Some(handle);
                let _ = start.send(());
            }
            drop(install);
            self.memory.revoke(&ticket);
            Ok(Some((factory, watching)))
        })();
        match setup {
            Err(error) => Box::pin(async move { Err(error) }),
            Ok(None) => Box::pin(async { Ok(()) }),
            Ok(Some((factory, mut watching))) => Box::pin(async move {
                let _owned = factory;
                loop {
                    match *watching.borrow_and_update() {
                        Closed::Confirmed => return Ok(()),
                        Closed::Unconfirmed => return Err(unconfirmed()),
                        Closed::Pending => {}
                    }
                    watching.changed().await.map_err(|_| unconfirmed())?;
                }
            }),
        }
    }
}
/// Convert only the fixed memory-purpose stdio profile. The native codec owns
/// env ARRAY encoding and `isolation:session`; default_tools_approval_mode is
/// deliberately never transmitted to ZCode.
fn native_server(server: &Value, context: &ResourceContext) -> Result<StdioMcpServer, WorkerError> {
    let object = server.as_object().ok_or_else(unavailable)?;
    if object.keys().any(|k| {
        !matches!(
            k.as_str(),
            "command" | "args" | "env" | "default_tools_approval_mode"
        )
    }) {
        return Err(unavailable());
    }
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| s.starts_with('/'))
        .ok_or_else(unavailable)?;
    let args: Vec<String> = object
        .get("args")
        .and_then(Value::as_array)
        .ok_or_else(unavailable)?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(unavailable))
        .collect::<Result<_, _>>()?;
    if args.len() != 2 || args[0] != "--home" || !args[1].starts_with('/') {
        return Err(unavailable());
    }
    let environment = object
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(unavailable)?;
    if environment.len() != 1 {
        return Err(unavailable());
    }
    let key = environment
        .get("PULT_MEMORY_TURN_KEY")
        .and_then(Value::as_str)
        .filter(|key| crate::memory_turn::valid_key(key))
        .ok_or_else(unavailable)?;
    let env = vec![("PULT_MEMORY_TURN_KEY".into(), key.to_owned())];
    let cwd = context.snapshot.cwd.to_str().ok_or_else(unavailable)?;
    StdioMcpServer::new("pult-memory", command, cwd, &args, &env).map_err(|_| unavailable())
}

#[cfg(test)]
#[path = "zcode_memory_resources_tests.rs"]
mod tests;
