//! Immutable private Claude MCP configuration, owned by exact Ticket/generation.
//! Trusted-host API; private directory contents are not a malicious same-UID sandbox.
use crate::{
    claude_ask::Backend,
    claude_worker::{McpContext, ScopedMcp},
    turn_coordinator::Ticket,
    turn_driver::{DispatchGate, Task, WorkerError},
};
use rustix::fs::{self, AtFlags, FileType, Mode, OFlags, RenameFlags};
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    os::fd::OwnedFd,
    path::PathBuf,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::{Notify, Semaphore};
const MAX_SCOPES: usize = 64;
fn failure() -> WorkerError {
    WorkerError {
        code: "cleanup_unconfirmed".into(),
        message: "Claude MCP configuration is unavailable".into(),
    }
}
fn random_name() -> Result<String, WorkerError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| failure())?;
    Ok(format!(
        "claude-mcp-{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}
struct Entry {
    context: McpContext,
    cancelled: AtomicBool,
    done: AtomicBool,
    changed: Notify,
    files: Mutex<Option<Files>>,
    cleanup: tokio::sync::Mutex<()>,
}
struct Wait {
    entry: Option<Arc<Entry>>,
    backend: Arc<Backend>,
}
impl Drop for Wait {
    fn drop(&mut self) {
        if let Some(entry) = &self.entry {
            entry.cancelled.store(true, Ordering::Release);
            self.backend
                .revoke(&entry.context.ticket, entry.context.generation);
        }
    }
}
struct Files {
    run: OwnedFd,
    scope: Option<OwnedFd>,
    scope_name: String,
    file: Option<File>,
    retired: Option<String>,
    file_removed: bool,
    dir_removed: bool,
}
fn identity(a: &fs::Stat, b: &fs::Stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
}
fn private_directory(fd: &OwnedFd) -> Result<(), WorkerError> {
    let stat = fs::fstat(fd).map_err(|_| failure())?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::Directory
        || stat.st_mode & 0o777 != 0o700
        || stat.st_uid != rustix::process::geteuid().as_raw()
    {
        return Err(failure());
    }
    Ok(())
}
/// The extra server map is host-selected, immutable and retained verbatim.
/// `pult` is reserved; no provider/model JSON can select paths or credentials.
pub struct Factory {
    myself: Weak<Factory>,
    backend: Arc<Backend>,
    gate: Arc<dyn DispatchGate>,
    helper: PathBuf,
    home: PathBuf,
    jobs: Arc<crate::host_jobs::Tracker>,
    extras: Map<String, Value>,
    entries: Mutex<HashMap<(Ticket, u64), Arc<Entry>>>,
    cleanup_slots: Arc<Semaphore>,
    #[cfg(test)]
    hooks: tests::Hooks,
}
impl Factory {
    pub fn new(
        backend: Arc<Backend>,
        gate: Arc<dyn DispatchGate>,
        helper: PathBuf,
        extras: Map<String, Value>,
    ) -> Result<Arc<Self>, WorkerError> {
        let (home, jobs) = backend.host_resources().ok_or_else(failure)?;
        if !helper.is_absolute()
            || !home.is_absolute()
            || extras.contains_key("pult")
            || serde_json::to_vec(&extras).map_err(|_| failure())?.len() > 512 * 1024
        {
            return Err(failure());
        }
        Ok(Arc::new_cyclic(|myself| Self {
            myself: myself.clone(),
            backend,
            gate,
            helper,
            home,
            jobs,
            extras,
            entries: Mutex::new(HashMap::new()),
            cleanup_slots: Arc::new(Semaphore::new(MAX_SCOPES)),
            #[cfg(test)]
            hooks: Default::default(),
        }))
    }
    fn cancel(&self, entry: &Entry) {
        entry.cancelled.store(true, Ordering::Release);
        self.backend
            .revoke(&entry.context.ticket, entry.context.generation);
    }
    fn write_config(&self, entry: &Entry, key: &str) -> Result<PathBuf, WorkerError> {
        #[cfg(test)]
        self.hooks.before_io();
        if entry.cancelled.load(Ordering::Acquire) {
            return Err(failure());
        }
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let home = fs::open(&self.home, flags, Mode::empty()).map_err(|_| failure())?;
        private_directory(&home)?;
        let run = fs::openat(&home, "run", flags, Mode::empty()).map_err(|_| failure())?;
        private_directory(&run)?;
        let scope_name = random_name()?;
        let mut files = entry.files.lock().map_err(|_| failure())?;
        fs::mkdirat(
            &run,
            scope_name.as_str(),
            Mode::RUSR | Mode::WUSR | Mode::XUSR,
        )
        .map_err(|_| failure())?;
        *files = Some(Files {
            run,
            scope: None,
            scope_name,
            file: None,
            retired: None,
            file_removed: false,
            dir_removed: false,
        });
        let files = files.as_mut().ok_or_else(failure)?;
        files.scope = Some(
            fs::openat(&files.run, files.scope_name.as_str(), flags, Mode::empty())
                .map_err(|_| failure())?,
        );
        let scope = files.scope.as_ref().ok_or_else(failure)?;
        fs::fchmod(scope, Mode::RUSR | Mode::WUSR | Mode::XUSR).map_err(|_| failure())?;
        private_directory(scope)?;
        let fd = fs::openat(
            scope,
            "config.json",
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| failure())?;
        files.file = Some(File::from(fd));
        fs::fchmod(
            files.file.as_ref().ok_or_else(failure)?,
            Mode::RUSR | Mode::WUSR,
        )
        .map_err(|_| failure())?;
        let config = crate::claude_launch::mcp_ask_config(
            self.helper.to_str().ok_or_else(failure)?,
            self.home.to_str().ok_or_else(failure)?,
            &entry.context.ticket.session().name,
            key,
            self.extras.clone(),
        )
        .map_err(|_| failure())?;
        let bytes = serde_json::to_vec(&config).map_err(|_| failure())?;
        let file = files.file.as_mut().ok_or_else(failure)?;
        file.write_all(&bytes).map_err(|_| failure())?;
        file.sync_all().map_err(|_| failure())?;
        fs::fsync(scope).map_err(|_| failure())?;
        fs::fsync(&files.run).map_err(|_| failure())?;
        #[cfg(test)]
        self.hooks.before_publish();
        // Pinning FD traversal protects cleanup; also refuse static pathname
        // replacement before handing a filename to the native process.
        let current_home = fs::open(&self.home, flags, Mode::empty()).map_err(|_| failure())?;
        if !identity(
            &fs::fstat(&current_home).map_err(|_| failure())?,
            &fs::fstat(&home).map_err(|_| failure())?,
        ) {
            return Err(failure());
        }
        let current_run =
            fs::openat(&current_home, "run", flags, Mode::empty()).map_err(|_| failure())?;
        let current_scope = fs::openat(
            &current_run,
            files.scope_name.as_str(),
            flags,
            Mode::empty(),
        )
        .map_err(|_| failure())?;
        if !identity(
            &fs::fstat(&current_run).map_err(|_| failure())?,
            &fs::fstat(&files.run).map_err(|_| failure())?,
        ) || !identity(
            &fs::fstat(&current_scope).map_err(|_| failure())?,
            &fs::fstat(scope).map_err(|_| failure())?,
        ) || entry.cancelled.load(Ordering::Acquire)
        {
            return Err(failure());
        }
        Ok(self
            .home
            .join("run")
            .join(&files.scope_name)
            .join("config.json"))
    }
    fn remove_files(&self, entry: &Entry) -> Result<(), WorkerError> {
        #[cfg(test)]
        self.hooks.before_cleanup();
        let mut state = entry.files.lock().map_err(|_| failure())?;
        let Some(files) = state.as_mut() else {
            return Ok(());
        };
        let scope = files.scope.as_ref().ok_or_else(failure)?;
        if !files.file_removed {
            if let Some(file) = &files.file {
                if files.retired.is_none() {
                    let name = random_name()?;
                    fs::renameat_with(
                        scope,
                        "config.json",
                        scope,
                        name.as_str(),
                        RenameFlags::NOREPLACE,
                    )
                    .map_err(|_| failure())?;
                    files.retired = Some(name);
                }
                let name = files.retired.as_ref().ok_or_else(failure)?;
                let stat = fs::statat(scope, name.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(|_| failure())?;
                if !identity(&stat, &fs::fstat(file).map_err(|_| failure())?)
                    || FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile
                {
                    return Err(failure());
                }
                fs::unlinkat(scope, name.as_str(), AtFlags::empty()).map_err(|_| failure())?;
            }
            files.file_removed = true;
        }
        fs::fsync(scope).map_err(|_| failure())?;
        if !files.dir_removed {
            let stat = fs::statat(
                &files.run,
                files.scope_name.as_str(),
                AtFlags::SYMLINK_NOFOLLOW,
            )
            .map_err(|_| failure())?;
            if !identity(&stat, &fs::fstat(scope).map_err(|_| failure())?) {
                return Err(failure());
            }
            fs::unlinkat(&files.run, files.scope_name.as_str(), AtFlags::REMOVEDIR)
                .map_err(|_| failure())?;
            files.dir_removed = true;
        }
        fs::fsync(&files.run).map_err(|_| failure())?;
        *state = None;
        Ok(())
    }
}
// Arc is the factory ownership handle: async operations capture it instead of
// retaining State. The backend itself contains only Weak<State>.
impl ScopedMcp for Factory {
    fn prepare(&self, context: McpContext) -> Task<Result<PathBuf, WorkerError>> {
        let Some(factory) = self.myself.upgrade() else {
            return Box::pin(async { Err(failure()) });
        };
        let entry = Arc::new(Entry {
            context,
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            changed: Notify::new(),
            files: Mutex::new(None),
            cleanup: tokio::sync::Mutex::new(()),
        });
        {
            let Ok(mut entries) = self.entries.lock() else {
                return Box::pin(async { Err(failure()) });
            };
            if entries.len() >= MAX_SCOPES
                || entries.contains_key(&(entry.context.ticket.clone(), entry.context.generation))
            {
                return Box::pin(async { Err(failure()) });
            }
            entries.insert(
                (entry.context.ticket.clone(), entry.context.generation),
                entry.clone(),
            );
        }
        // Backend reserves synchronously, so revoke cannot miss pending issuance.
        let preparation = self.backend.prepare(
            McpContext {
                session: entry.context.session.clone(),
                ticket: entry.context.ticket.clone(),
                generation: entry.context.generation,
                approval: entry.context.approval,
            },
            self.gate.clone(),
        );
        let wait = Wait {
            entry: Some(entry.clone()),
            backend: self.backend.clone(),
        };
        let tracked = self.jobs.track();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _tracked = tracked;
            let result = match preparation.await {
                Ok(prepared) => {
                    let writing = factory.clone();
                    let writing_entry = entry.clone();
                    tokio::task::spawn_blocking(move || {
                        writing.write_config(&writing_entry, prepared.key())
                    })
                    .await
                    .unwrap_or_else(|_| Err(failure()))
                }
                Err(error) => Err(error),
            };
            if result.is_err() || entry.cancelled.load(Ordering::Acquire) {
                factory.cancel(&entry);
            }
            let result = if entry.cancelled.load(Ordering::Acquire) {
                Err(failure())
            } else {
                result
            };
            if send.send(result).is_err() {
                factory.cancel(&entry);
            }
            entry.done.store(true, Ordering::Release);
            entry.changed.notify_waiters();
        });
        Box::pin(async move {
            let mut wait = wait;
            let result = receive.await.unwrap_or_else(|_| Err(failure()));
            if result.is_ok() {
                wait.entry = None;
            }
            result
        })
    }
    fn revoke(&self, ticket: &Ticket, generation: u64) {
        if let Some(entry) = self
            .entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(&(ticket.clone(), generation)).cloned())
        {
            self.cancel(&entry);
        }
        self.backend.revoke(ticket, generation);
    }
    fn cleanup(&self, ticket: Ticket, generation: u64) -> Task<Result<(), WorkerError>> {
        let Some(factory) = self.myself.upgrade() else {
            return Box::pin(async { Err(failure()) });
        };
        let entry = match self.entries.lock() {
            Ok(entries) => entries.get(&(ticket.clone(), generation)).cloned(),
            Err(_) => return Box::pin(async { Err(failure()) }),
        };
        let permit = match self.cleanup_slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => return Box::pin(async { Err(failure()) }),
        };
        let tracked = self.jobs.track();
        let (send, receive) = tokio::sync::oneshot::channel();
        if let Some(entry) = &entry {
            self.cancel(entry);
        }
        tokio::spawn(async move {
            let _permit = permit;
            let _tracked = tracked;
            let result = async {
                let Some(entry) = entry else {
                    return factory.backend.drain(ticket, generation).await;
                };
                let _cleanup = entry.cleanup.lock().await;
                loop {
                    let changed = entry.changed.notified();
                    tokio::pin!(changed);
                    changed.as_mut().enable();
                    if entry.done.load(Ordering::Acquire) {
                        break;
                    }
                    changed.await;
                }
                factory.backend.drain(ticket.clone(), generation).await?;
                let removing = factory.clone();
                let removing_entry = entry.clone();
                tokio::task::spawn_blocking(move || removing.remove_files(&removing_entry))
                    .await
                    .unwrap_or_else(|_| Err(failure()))?;
                let mut entries = factory.entries.lock().map_err(|_| failure())?;
                if entries
                    .get(&(ticket.clone(), generation))
                    .is_some_and(|current| Arc::ptr_eq(current, &entry))
                {
                    entries.remove(&(ticket, generation));
                }
                Ok(())
            }
            .await;
            let _ = send.send(result);
        });
        Box::pin(async { receive.await.unwrap_or_else(|_| Err(failure())) })
    }
}
#[cfg(test)]
#[path = "claude_mcp_tests.rs"]
mod tests;
