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
    // The shared Inbox can start without discovering any provider executable.
    crate::permission_state::instance(state).await?;
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
        state
            .claude_asks
            .get_or_init(|| crate::claude_ask::Backend::new(Arc::downgrade(&state)));
        let broker = crate::permission_state::ensure_locked(&state, &bootstrap.config)?;
        let runtime = codex_runtime::CodexRuntime::new_daemon(
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
            broker,
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
    crate::permission_state::begin_shutdown(state);
    if let Some(slot) = state.claude_runtime.get() {
        drop(slot.runtime.shutdown());
    }
    if let Some(slot) = state.zcode_runtime.get() {
        drop(slot.runtime.shutdown());
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

/// The provider controller does not own a shared probe; State retains and joins
/// its selected probe together with the controller before releasing ownership.
pub(crate) struct Claude {
    pub(crate) runtime: Arc<crate::claude_runtime::ClaudeRuntime>,
    curl: Arc<crate::network_guard::CurlProbe>,
}
pub(crate) async fn claude_instance(
    state: &Arc<State>,
) -> Result<Arc<crate::claude_runtime::ClaudeRuntime>> {
    if *state.stop.borrow() || unavailable(state) {
        bail!("native execution is unavailable");
    }
    if let Some(slot) = state.claude_runtime.get() {
        return Ok(slot.runtime.clone());
    }
    crate::permission_state::instance(state).await?;
    let state = state.clone();
    let handle = tokio::runtime::Handle::current();
    let tracked = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        let _runtime = handle.enter();
        let _init = state
            .runtime_init
            .lock()
            .map_err(|_| anyhow!("runtime initialization unavailable"))?;
        if *state.stop.borrow() || unavailable(&state) {
            bail!("native execution is unavailable");
        }
        if let Some(slot) = state.claude_runtime.get() {
            return Ok(slot.runtime.clone());
        }
        let parent = std::env::vars_os().collect();
        let current =
            std::env::current_exe().map_err(|_| anyhow!("daemon executable unavailable"))?;
        let bootstrap = runtime_bootstrap::load_claude(&state.home, &current, &parent)?;
        let curl = Arc::new(
            crate::network_guard::CurlProbe::with_program(&bootstrap.curl, &bootstrap.parent)
                .map_err(|_| anyhow!("network probe unavailable"))?,
        );
        let guard = Arc::new(crate::network_guard::NetworkGuard::new(curl.clone()));
        let backend = state
            .claude_asks
            .get_or_init(|| crate::claude_ask::Backend::new(Arc::downgrade(&state)))
            .clone();
        let helper = current.clone();
        let factory: crate::claude_runtime::McpFactory = Arc::new(move |gate| {
            let factory = crate::claude_mcp::Factory::new(
                backend.clone(),
                gate,
                helper.clone(),
                Default::default(),
            )?;
            Ok(factory as Arc<dyn crate::claude_worker::ScopedMcp>)
        });
        let runtime = Arc::new(
            crate::claude_runtime::ClaudeRuntime::new(
                crate::claude_runtime::Dependencies {
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
                crate::claude_runtime::TrustedCommand {
                    holder: bootstrap.holder,
                    program: bootstrap.claude,
                    prefix_args: bootstrap.prefix_args,
                },
                bootstrap.config,
                bootstrap.parent,
                crate::claude_runtime::SettingsRoots {
                    child_home: bootstrap.child_home,
                    managed_directory: bootstrap.managed_directory,
                },
                guard,
                factory,
                Default::default(),
            )
            .map_err(|_| anyhow!("Claude runtime configuration unavailable"))?,
        );
        state
            .claude_runtime
            .set(Arc::new(Claude {
                runtime: runtime.clone(),
                curl,
            }))
            .map_err(|_| anyhow!("Claude runtime already initialized"))?;
        if *state.stop.borrow() || unavailable(&state) {
            drop(runtime.shutdown());
            bail!("daemon is stopping");
        }
        Ok(runtime)
    })
    .await
    .map_err(|_| anyhow!("Claude runtime initialization failed"))?
}
/// ZCode keeps its selected probe alive through every preparation and process
/// join. Initializing it never discovers a different provider or account.
pub(crate) struct Zcode {
    pub(crate) runtime: Arc<crate::zcode_runtime::ZcodeRuntime>,
    curl: Arc<crate::network_guard::CurlProbe>,
}
pub(crate) async fn zcode_instance(
    state: &Arc<State>,
) -> Result<Arc<crate::zcode_runtime::ZcodeRuntime>> {
    if *state.stop.borrow() || unavailable(state) {
        bail!("native execution is unavailable");
    }
    if let Some(slot) = state.zcode_runtime.get() {
        return Ok(slot.runtime.clone());
    }
    crate::permission_state::instance(state).await?;
    let state = state.clone();
    let handle = tokio::runtime::Handle::current();
    let tracked = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        let _runtime = handle.enter();
        let _init = state
            .runtime_init
            .lock()
            .map_err(|_| anyhow!("runtime initialization unavailable"))?;
        if *state.stop.borrow() || unavailable(&state) {
            bail!("native execution is unavailable");
        }
        if let Some(slot) = state.zcode_runtime.get() {
            return Ok(slot.runtime.clone());
        }
        let parent = std::env::vars_os().collect();
        let current =
            std::env::current_exe().map_err(|_| anyhow!("daemon executable unavailable"))?;
        let bootstrap = runtime_bootstrap::load_zcode(&state.home, &current, &parent)?;
        let curl = Arc::new(
            crate::network_guard::CurlProbe::with_program(&bootstrap.curl, &bootstrap.parent)
                .map_err(|_| anyhow!("network probe unavailable"))?,
        );
        let guard = Arc::new(crate::network_guard::NetworkGuard::new(curl.clone()));
        let runtime = Arc::new(
            crate::zcode_runtime::ZcodeRuntime::new(
                crate::zcode_runtime::Dependencies {
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
                crate::zcode_runtime::TrustedCommand {
                    holder: bootstrap.holder,
                    program: bootstrap.zcode,
                    prefix_args: bootstrap.prefix_args,
                },
                bootstrap.config,
                bootstrap.parent,
                bootstrap.extra_env,
                guard,
                Default::default(),
            )
            .map_err(|_| anyhow!("ZCode runtime configuration unavailable"))?,
        );
        state
            .zcode_runtime
            .set(Arc::new(Zcode {
                runtime: runtime.clone(),
                curl,
            }))
            .map_err(|_| anyhow!("ZCode runtime already initialized"))?;
        if *state.stop.borrow() || unavailable(&state) {
            drop(runtime.shutdown());
            bail!("daemon is stopping");
        }
        Ok(runtime)
    })
    .await
    .map_err(|_| anyhow!("ZCode runtime initialization failed"))?
}
/// Provider selection is read under the registry mutex in owned blocking work;
/// the controller repeats full identity/path/policy checks before dispatch.
pub(crate) async fn for_key(
    state: &Arc<State>,
    key: &crate::turn_snapshot::SessionKey,
) -> Result<crate::provider_runtime::Runtime> {
    let checking = state.clone();
    let key = key.clone();
    let tracked = state.host_jobs.track();
    let provider = tokio::task::spawn_blocking(move || {
        let _tracked = tracked;
        if *checking.stop.borrow() || unavailable(&checking) {
            bail!("native execution unavailable");
        }
        let registry = checking
            .registry
            .lock()
            .map_err(|_| anyhow!("registry unavailable"))?;
        let record = registry
            .find(&key.name)
            .ok_or_else(|| anyhow!("session unavailable"))?;
        if record.scalar("createdAt").as_deref() != Some(&key.created_at)
            || crate::owner_trust::yes(record, "archived")
        {
            bail!("session unavailable");
        }
        Ok::<_, anyhow::Error>(record.scalar("provider").unwrap_or_default())
    })
    .await
    .map_err(|_| anyhow!("provider selection unavailable"))??;
    match provider.as_str() {
        "codex" => Ok(crate::provider_runtime::Runtime::Codex(
            instance(state).await?,
        )),
        "claude" => Ok(crate::provider_runtime::Runtime::Claude(
            claude_instance(state).await?,
        )),
        "zcode" => Ok(crate::provider_runtime::Runtime::Zcode(
            zcode_instance(state).await?,
        )),
        _ => bail!("provider execution is unsupported"),
    }
}
fn existing(state: &State) -> Vec<crate::provider_runtime::Runtime> {
    let mut runtimes = Vec::new();
    if let Some(runtime) = state.native_runtime.get() {
        runtimes.push(crate::provider_runtime::Runtime::Codex(runtime.clone()));
    }
    if let Some(slot) = state.claude_runtime.get() {
        runtimes.push(crate::provider_runtime::Runtime::Claude(
            slot.runtime.clone(),
        ));
    }
    if let Some(slot) = state.zcode_runtime.get() {
        runtimes.push(crate::provider_runtime::Runtime::Zcode(
            slot.runtime.clone(),
        ));
    }
    runtimes
}
pub(crate) fn busy(state: &State, key: &crate::turn_snapshot::SessionKey) -> bool {
    existing(state).iter().any(|runtime| runtime.busy(key))
}
pub(crate) async fn wait_idle(state: &State, key: &crate::turn_snapshot::SessionKey) {
    loop {
        for runtime in existing(state) {
            runtime.wait_idle(key).await;
        }
        if !busy(state, key) {
            return;
        }
    }
}
pub(crate) fn stop(
    state: &State,
    key: &crate::turn_snapshot::SessionKey,
    turn: Option<&str>,
) -> Result<bool, crate::provider_runtime::Error> {
    let mut stopped = false;
    for runtime in existing(state) {
        stopped |= runtime.stop(key, turn)?;
    }
    Ok(stopped)
}
pub(crate) fn stop_name(state: &State, name: &str) -> Result<bool, crate::provider_runtime::Error> {
    let mut stopped = false;
    for runtime in existing(state) {
        stopped |= runtime.stop_name(name)?;
    }
    Ok(stopped)
}
pub(crate) async fn shutdown_providers(state: &State) {
    if let Some(slot) = state.claude_runtime.get() {
        while slot.runtime.shutdown().await.is_err() {
            eprintln!("Claude cleanup is unconfirmed; daemon ownership retained");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        slot.curl.shutdown().await;
    }
    if let Some(slot) = state.zcode_runtime.get() {
        while slot.runtime.shutdown().await.is_err() {
            eprintln!("ZCode cleanup is unconfirmed; daemon ownership retained");
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        slot.curl.shutdown().await;
    }
}
