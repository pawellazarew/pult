//! Daemon-selected provider facade. Client JSON never selects an executable,
//! factory, authorization service or another session incarnation.
use crate::{
    claude_runtime, codex_runtime,
    turn_driver::{Handle, Input, Task, WorkerError},
    turn_snapshot::SessionKey,
};
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) enum Runtime {
    Codex(Arc<codex_runtime::CodexRuntime>),
    Claude(Arc<claude_runtime::ClaudeRuntime>),
}
#[derive(Clone, Copy)]
pub(crate) enum Error {
    Codex(codex_runtime::RuntimeError),
    Claude(claude_runtime::RuntimeError),
}
impl Error {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Codex(error) => error.code(),
            Self::Claude(error) => error.code(),
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Codex(error) => error.fmt(f),
            Self::Claude(error) => error.fmt(f),
        }
    }
}
impl Runtime {
    pub(crate) fn execute(&self, key: SessionKey, input: Input) -> Task<Result<Handle, Error>> {
        self.submit(key, input, false)
    }
    pub(crate) fn execute_queued(
        &self,
        key: SessionKey,
        input: Input,
    ) -> Task<Result<Handle, Error>> {
        self.submit(key, input, true)
    }
    fn submit(&self, key: SessionKey, input: Input, queued: bool) -> Task<Result<Handle, Error>> {
        match self {
            Self::Codex(runtime) => {
                let pending = if queued {
                    runtime.execute_queued(key, input)
                } else {
                    runtime.execute(key, input)
                };
                Box::pin(async { pending.await.map_err(Error::Codex) })
            }
            Self::Claude(runtime) => {
                let pending = if queued {
                    runtime.execute_queued(key, input)
                } else {
                    runtime.execute(key, input)
                };
                Box::pin(async { pending.await.map_err(Error::Claude) })
            }
        }
    }
    pub(crate) fn steer_guarded(
        &self,
        key: &SessionKey,
        input: Input,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Task<Result<String, WorkerError>> {
        match self {
            Self::Codex(runtime) => runtime.steer_guarded(key, input, cancel),
            Self::Claude(_) => Box::pin(async {
                Err(WorkerError {
                    code: "unsupported".into(),
                    message: "Claude live steering is not supported".into(),
                })
            }),
        }
    }
    pub(crate) fn busy(&self, key: &SessionKey) -> bool {
        match self {
            Self::Codex(runtime) => runtime.busy(key),
            Self::Claude(runtime) => runtime.busy(key),
        }
    }
    pub(crate) async fn wait_idle(&self, key: &SessionKey) {
        match self {
            Self::Codex(runtime) => runtime.wait_idle(key).await,
            Self::Claude(runtime) => runtime.wait_idle(key).await,
        }
    }
    pub(crate) fn stop(&self, key: &SessionKey, turn: Option<&str>) -> Result<bool, Error> {
        match self {
            Self::Codex(runtime) => runtime.stop(key, turn).map_err(Error::Codex),
            Self::Claude(runtime) => runtime.stop(key, turn).map_err(Error::Claude),
        }
    }
    pub(crate) fn stop_name(&self, name: &str) -> Result<bool, Error> {
        match self {
            Self::Codex(runtime) => runtime.stop_name(name).map_err(Error::Codex),
            Self::Claude(runtime) => runtime.stop_name(name).map_err(Error::Claude),
        }
    }
}
