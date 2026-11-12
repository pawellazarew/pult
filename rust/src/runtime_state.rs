//! Daemon-lifetime ownership of the native runtime and current status projection.
use crate::{State, codex_runtime, consent_store, registry, runtime_bootstrap, session_live};
use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use std::sync::{Arc, Mutex, atomic::Ordering};

pub(crate) type Consent = Arc<Mutex<consent_store::ConsentStore>>;

pub(crate) fn seed_live(registry: &registry::Registry) -> Result<session_live::Cache> {
    let mut cache = session_live::Cache::new(65536).map_err(|_| anyhow!("invalid live cache"))?;
    for record in registry.records() {
        let Some(created_at) = record.scalar("createdAt") else {
            continue;
        };
        let key = crate::turn_snapshot::SessionKey {
            name: record.name().into(),
            created_at,
        };
        if key.validate().is_err() {
            continue;
        }
        let status = record
            .scalar("lastStatus")
            .as_deref()
            .and_then(session_live::Status::parse)
            .unwrap_or(session_live::Status::Cold);
        let id = record
            .get("lastEventId")
            .and_then(|v| serde_json::from_str::<u64>(v.get()).ok())
            .unwrap_or(0);
        cache
            .seed(key, status, id)
            .map_err(|_| anyhow!("session live cache capacity exceeded"))?;
    }
    Ok(cache)
}

pub(crate) fn consent(state: &State) -> Result<Consent> {
    let mut slot = state
        .consent
        .lock()
        .map_err(|_| anyhow!("consent controller unavailable"))?;
    if let Some(store) = &*slot {
        return Ok(store.clone());
    }
    let store = Arc::new(Mutex::new(
        consent_store::ConsentStore::open(&state.home)
            .map_err(|_| anyhow!("private consent store unavailable"))?,
    ));
    *slot = Some(store.clone());
    Ok(store)
}

pub(crate) async fn instance(state: &Arc<State>) -> Result<Arc<codex_runtime::CodexRuntime>> {
    if *state.stop.borrow() || unavailable(state) {
        bail!("native execution is unavailable");
    }
    if let Some(runtime) = state.native_runtime.get() {
        return Ok(runtime.clone());
    }
    let state = state.clone();
    let handle = tokio::runtime::Handle::current();
    let host_job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _host_job = host_job;
        let _runtime_context = handle.enter();
        let _initialization = state
            .runtime_init
            .lock()
            .map_err(|_| anyhow!("runtime initialization unavailable"))?;
        if *state.stop.borrow() || unavailable(&state) {
            bail!("native execution is unavailable");
        }
        if let Some(runtime) = state.native_runtime.get() {
            return Ok(runtime.clone());
        }
        let parent = std::env::vars_os().collect();
        let current =
            std::env::current_exe().map_err(|_| anyhow!("daemon executable unavailable"))?;
        let bootstrap = runtime_bootstrap::load(&state.home, &current, &parent)?;
        let curl = Arc::new(
            crate::network_guard::CurlProbe::with_program(&bootstrap.curl, &bootstrap.parent)
                .map_err(|_| anyhow!("network probe unavailable"))?,
        );
        let memory = state
            .memory_turns
            .get_or_init(|| {
                crate::memory_turn::Backend::new(
                    Arc::downgrade(&state),
                    current.with_file_name("pult-memory-mcp"),
                )
            })
            .clone();
        let runtime = codex_runtime::CodexRuntime::new_with_memory(
            codex_runtime::Dependencies {
                home: state.home.clone(),
                registry: state.registry.clone(),
                consent: consent(&state)?,
                driver: state
                    .driver
                    .get()
                    .ok_or_else(|| anyhow!("execution driver unavailable"))?
                    .clone(),
                sink: state.execution_sink(),
            },
            bootstrap.config,
            codex_runtime::TrustedCommand {
                holder: bootstrap.holder,
                program: bootstrap.codex,
                prefix_args: bootstrap.prefix_args,
            },
            bootstrap.parent,
            codex_runtime::Network::OwnedCurl(curl),
            Default::default(),
            Some(memory),
        )?;
        state
            .native_runtime
            .set(runtime.clone())
            .map_err(|_| anyhow!("runtime already initialized"))?;
        if *state.stop.borrow() || unavailable(&state) {
            drop(runtime.shutdown());
            bail!("daemon is stopping");
        }
        Ok(runtime)
    })
    .await
    .map_err(|_| anyhow!("runtime initialization failed"))?
}

/// Starts owned cleanup synchronously. Never waits while holding a controller lock.
pub(crate) fn begin_shutdown(state: &State) {
    // Seal admission and notify the owner before a response can stall/fail.
    // send_replace also seals fixtures with no current watch subscribers.
    {
        let _admission = state
            .execution_admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.stop.send_replace(true);
        if let Some(driver) = state.driver.get() {
            driver.begin_shutdown();
        }
    }
    if let Some(runtime) = state.native_runtime.get() {
        drop(runtime.shutdown());
    }
}

/// Wait for an initializer that may have started before stop. New initializers
/// check stop under this same mutex before doing IO. Poison is recovered only
/// for this quiescence barrier, never for authorization or creating a runtime.
pub(crate) async fn await_initialization(state: &Arc<State>) {
    loop {
        let state = state.clone();
        if tokio::task::spawn_blocking(move || {
            let _quiescent = state
                .runtime_init
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        })
        .await
        .is_ok()
        {
            return;
        }
        eprintln!("runtime initialization cleanup is unconfirmed; daemon ownership retained");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Called in global append order while the journal mutex is still held. The
/// cache holds no payload and its guard is released before registry storage IO.
pub(crate) fn project(state: &State, event: &Value) -> Result<()> {
    let Some(name) = event["sessionId"].as_str() else {
        bail!("invalid committed session");
    };
    let Some(id) = event["id"].as_u64() else {
        bail!("invalid committed cursor");
    };
    let Some(kind) = event["kind"].as_str() else {
        bail!("invalid committed kind");
    };
    let change = state
        .live_sessions
        .lock()
        .map_err(|_| anyhow!("live projection unavailable"))?
        .note(name, id, kind, &event["data"]);
    if let Some(change) = change {
        let mut registry = state
            .registry
            .lock()
            .map_err(|_| anyhow!("registry unavailable"))?;
        let current = registry.find(&change.key.name);
        // A removed/replaced incarnation cannot receive an old metadata patch.
        if current
            .and_then(|record| record.scalar("createdAt"))
            .as_deref()
            != Some(&change.key.created_at)
        {
            return Ok(());
        }
        registry
            .update_checked(&change.key, |record| {
                record.set_string("lastStatus", change.status.as_str());
                record.set_number("lastEventId", change.event_id as f64);
                Ok(())
            })
            .map_err(|_| anyhow!("live metadata persistence unconfirmed"))?;
    }
    Ok(())
}

pub(crate) fn unavailable(state: &State) -> bool {
    state.execution_storage_failed.load(Ordering::Acquire)
        || state
            .driver
            .get()
            .is_some_and(|driver| driver.storage_failed())
}
