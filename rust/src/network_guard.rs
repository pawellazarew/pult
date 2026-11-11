//! Network route facts for a trusted host, not authorization to reuse a worker.
//! The host must apply the selected route to the child environment and compare
//! the generation immediately before dispatch. No RPC or settings integration.
use crate::{
    turn_snapshot::Provider,
    worker_env::{self, Environment},
};
use serde_json::Value;
use std::{
    collections::VecDeque,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::{Notify, Semaphore, oneshot, watch},
};

pub const EGRESS_URLS: [&str; 2] = [
    "https://api.anthropic.com/cdn-cgi/trace",
    "https://cloudflare.com/cdn-cgi/trace",
];
pub const BASE_NO_PROXY: [&str; 3] = ["localhost", "127.0.0.1", "::1"];
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
pub const CACHE_TTL: Duration = Duration::from_secs(60);
pub const MAX_TRACE_BYTES: usize = 64 * 1024;
pub const MAX_CACHE_ENTRIES: usize = 64;
pub const COUNTRY_CODES: [&str; 250] = [
    "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
    "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
    "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
    "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
    "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
    "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
    "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
    "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
    "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
    "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
    "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
    "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
    "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
    "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
    "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
    "VN", "VU", "WF", "WS", "XK", "YE", "YT", "ZA", "ZM", "ZW",
];
pub const DEFAULT_GUARD_COUNTRIES: [&str; 7] = ["RU", "BY", "CN", "IR", "KP", "SY", "CU"];

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum Mode {
    Off,
    Auto,
    Required,
}
#[derive(Clone, Eq, PartialEq, Hash)]
pub struct Profile {
    pub mode: Mode,
    pub proxy: String,
    pub no_proxy: Vec<String>,
}
impl std::fmt::Debug for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Profile")
            .field("mode", &self.mode)
            .field("has_proxy", &!self.proxy.is_empty())
            .field("no_proxy_entries", &self.no_proxy.len())
            .finish()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum GuardMode {
    Deny,
    Allow,
}
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct GuardRule {
    pub mode: GuardMode,
    pub countries: Vec<String>,
}
impl Default for GuardRule {
    fn default() -> Self {
        Self {
            mode: GuardMode::Deny,
            countries: DEFAULT_GUARD_COUNTRIES
                .iter()
                .map(|s| (*s).into())
                .collect(),
        }
    }
}
impl GuardRule {
    pub fn closed() -> Self {
        Self {
            mode: GuardMode::Allow,
            countries: vec![],
        }
    }
    pub fn off(&self) -> bool {
        self.mode == GuardMode::Deny && self.countries.is_empty()
    }
    pub fn parse_shape(raw: &Value) -> Result<Self, GuardError> {
        let o = raw
            .as_object()
            .filter(|o| o.len() == 2 && o.contains_key("mode") && o.contains_key("countries"))
            .ok_or(GuardError::InvalidRule)?;
        let mode = match o["mode"].as_str() {
            Some("deny") => GuardMode::Deny,
            Some("allow") => GuardMode::Allow,
            _ => return Err(GuardError::InvalidRule),
        };
        let list = o["countries"]
            .as_array()
            .filter(|a| a.len() <= COUNTRY_CODES.len())
            .ok_or(GuardError::InvalidRule)?;
        let mut countries = Vec::new();
        for item in list {
            let c = item
                .as_str()
                .filter(|s| COUNTRY_CODES.contains(s))
                .ok_or(GuardError::InvalidRule)?;
            if !countries.iter().any(|x| x == c) {
                countries.push(c.into());
            }
        }
        Ok(Self { mode, countries })
    }
    pub fn parse_strict(raw: &Value) -> Result<Self, GuardError> {
        let rule = Self::parse_shape(raw)?;
        if rule.mode == GuardMode::Allow && rule.countries.is_empty() {
            Err(GuardError::InvalidRule)
        } else {
            Ok(rule)
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NetPath {
    Proxy,
    Direct,
    None,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reason {
    Ok,
    ProxyDead,
    BlockedCountry,
    NotAllowedCountry,
    UnknownLocation,
    NoProxy,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardError {
    InvalidRule,
    InvalidProbe,
    StaleGeneration,
    GenerationExhausted,
    StateUnavailable,
    NetworkDenied,
    InvalidRoute,
    InvalidEnvironment,
}
impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidRule => "invalid network guard rule",
            Self::InvalidProbe => "invalid network probe configuration",
            Self::StaleGeneration => "network guard changed during probe",
            Self::GenerationExhausted => "network guard generation exhausted",
            Self::StateUnavailable => "network guard state unavailable",
            Self::NetworkDenied => "network guard does not permit this route",
            Self::InvalidRoute => "invalid checked network route",
            Self::InvalidEnvironment => "invalid worker environment",
        })
    }
}
impl std::error::Error for GuardError {}
#[derive(Clone)]
pub struct Attempt {
    pub path: NetPath,
    pub url: &'static str,
    pub proxy: Option<String>,
    pub exit: Option<i32>,
    pub loc: Option<String>,
}
impl std::fmt::Debug for Attempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attempt")
            .field("path", &self.path)
            .field("has_proxy", &self.proxy.is_some())
            .field("exit", &self.exit)
            .field("loc", &self.loc)
            .finish()
    }
}
#[derive(Clone)]
pub struct Check {
    pub provider: Provider,
    pub mode: Mode,
    pub path: NetPath,
    pub proxy: Option<String>,
    pub loc: Option<String>,
    pub ok: bool,
    pub reason: Reason,
    pub fell_back: bool,
    pub no_proxy: Vec<String>,
    pub guard: GuardRule,
    pub attempts: Vec<Attempt>,
    pub elapsed: Duration,
    pub checked_at: String,
    pub cached: bool,
    pub generation: u64,
}
impl std::fmt::Debug for Check {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Check")
            .field("provider", &self.provider)
            .field("mode", &self.mode)
            .field("path", &self.path)
            .field("has_proxy", &self.proxy.is_some())
            .field("loc", &self.loc)
            .field("ok", &self.ok)
            .field("reason", &self.reason)
            .field("attempts", &self.attempts.len())
            .field("generation", &self.generation)
            .field("cached", &self.cached)
            .finish()
    }
}
#[derive(Clone)]
pub struct ProbeResult {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr_bytes: u64,
}
impl ProbeResult {
    fn failed(stderr_bytes: u64) -> Self {
        Self {
            status: None,
            stdout: vec![],
            stderr_bytes,
        }
    }
}
impl std::fmt::Debug for ProbeResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProbeResult")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr_bytes)
            .finish()
    }
}
pub type ProbeFuture<'a> = Pin<Box<dyn Future<Output = ProbeResult> + Send + 'a>>;
pub trait Probe: Send + Sync {
    fn probe<'a>(
        &'a self,
        url: &'a str,
        proxy: Option<&'a str>,
        timeout: Duration,
    ) -> ProbeFuture<'a>;
}
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}
struct SystemClock;
impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}
pub fn no_proxy_value(extra: &[String]) -> String {
    let mut list: Vec<&str> = BASE_NO_PROXY.to_vec();
    for value in extra {
        if !list.contains(&value.as_str()) {
            list.push(value);
        }
    }
    list.join(",")
}
pub fn curl_args(url: &str, proxy: Option<&str>, timeout: Duration) -> Vec<String> {
    vec![
        "-q".into(),
        "-s".into(),
        "-m".into(),
        timeout.as_secs_f64().ceil().max(1.0).to_string(),
        "-x".into(),
        proxy.unwrap_or("").into(),
        url.into(),
    ]
}
pub fn parse_loc(body: &[u8]) -> Option<String> {
    let body = std::str::from_utf8(body).ok()?;
    for line in body.split(['\n', '\r', '\u{2028}', '\u{2029}']) {
        if let Some(code) = line.strip_prefix("loc=") {
            let bytes = code.as_bytes();
            if bytes.len() >= 2
                && bytes[..2].iter().all(u8::is_ascii_alphabetic)
                && code[2..].chars().all(js_space)
            {
                return Some(code[..2].to_ascii_uppercase());
            }
        }
    }
    None
}
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
pub fn guard_verdict(rule: &GuardRule, loc: Option<&str>) -> (bool, Reason) {
    let Some(loc) = loc.filter(|s| !s.is_empty()) else {
        return (false, Reason::UnknownLocation);
    };
    let listed = rule.countries.contains(&loc.to_ascii_uppercase());
    match (rule.mode, listed) {
        (GuardMode::Allow, true) | (GuardMode::Deny, false) => (true, Reason::Ok),
        (GuardMode::Allow, false) => (false, Reason::NotAllowedCountry),
        (GuardMode::Deny, true) => (false, Reason::BlockedCountry),
    }
}

#[derive(Clone, Eq, PartialEq)]
struct Key {
    provider: &'static str,
    profile: Profile,
    guard: GuardRule,
}
struct Entry {
    key: Key,
    at: Instant,
    check: Check,
}
struct State {
    generation: u64,
    poisoned: bool,
    entries: VecDeque<Entry>,
}
pub struct NetworkGuard {
    probe: Arc<dyn Probe>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
}
impl NetworkGuard {
    pub fn new(probe: Arc<dyn Probe>) -> Self {
        Self::with_clock(probe, Arc::new(SystemClock))
    }
    pub fn with_clock(probe: Arc<dyn Probe>, clock: Arc<dyn Clock>) -> Self {
        Self {
            probe,
            clock,
            state: Mutex::new(State {
                generation: 0,
                poisoned: false,
                entries: VecDeque::new(),
            }),
        }
    }
    pub fn generation(&self) -> Result<u64, GuardError> {
        let state = self
            .state
            .lock()
            .map_err(|_| GuardError::StateUnavailable)?;
        if state.poisoned {
            return Err(GuardError::GenerationExhausted);
        }
        Ok(state.generation)
    }
    pub fn is_current(&self, check: &Check) -> bool {
        self.generation().is_ok_and(|g| g == check.generation)
    }
    /// Apply the checked route to a general worker's allowlisted environment.
    /// Check is trusted host data, not an unforgeable authorization token. The
    /// host must refresh configuration/generation immediately before dispatch.
    /// Shared Codex app-server processes must not receive a session memory key
    /// through this global environment; bind that authority per session instead.
    pub fn worker_environment(
        &self,
        check: &Check,
        parent: &Environment,
        explicit: &Environment,
    ) -> Result<Environment, GuardError> {
        let state = self
            .state
            .lock()
            .map_err(|_| GuardError::StateUnavailable)?;
        if state.poisoned || state.generation != check.generation {
            return Err(GuardError::StaleGeneration);
        }
        if !check.ok {
            return Err(GuardError::NetworkDenied);
        }
        let mut adjusted = explicit.clone();
        adjusted.remove(std::ffi::OsStr::new("HTTPS_PROXY"));
        adjusted.remove(std::ffi::OsStr::new("ALL_PROXY"));
        match check.path {
            NetPath::Proxy => {
                let proxy = check
                    .proxy
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or(GuardError::InvalidRoute)?;
                adjusted.insert("HTTPS_PROXY".into(), proxy.into());
                if check.provider == Provider::Codex {
                    // Codex's websocket transport uses ALL_PROXY, while its
                    // HTTPS requests and the other providers use HTTPS_PROXY.
                    adjusted.insert("ALL_PROXY".into(), proxy.into());
                }
            }
            NetPath::Direct => {}
            NetPath::None => return Err(GuardError::NetworkDenied),
        }
        adjusted.insert("NO_PROXY".into(), no_proxy_value(&check.no_proxy).into());
        let env = worker_env::from_parent(parent, &adjusted)
            .map_err(|_| GuardError::InvalidEnvironment)?;
        // Keep the generation lock through construction and the final check.
        if state.poisoned || state.generation != check.generation {
            return Err(GuardError::StaleGeneration);
        }
        Ok(env)
    }
    pub fn cache_len(&self) -> usize {
        self.state.lock().map_or(0, |s| s.entries.len())
    }
    pub fn clear_cache(&self) -> Result<u64, GuardError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| GuardError::StateUnavailable)?;
        state.entries.clear();
        let Some(next) = state.generation.checked_add(1) else {
            state.poisoned = true;
            return Err(GuardError::GenerationExhausted);
        };
        state.generation = next;
        Ok(next)
    }
    pub async fn check(
        &self,
        provider: Provider,
        profile: &Profile,
        guard: &GuardRule,
        fresh: bool,
    ) -> Result<Check, GuardError> {
        let rule = GuardRule {
            mode: guard.mode,
            countries: guard.countries.iter().map(|s| s.to_uppercase()).collect(),
        };
        let key = Key {
            provider: provider.as_str(),
            profile: profile.clone(),
            guard: rule.clone(),
        };
        let t0 = self.clock.now();
        let generation = {
            let state = self
                .state
                .lock()
                .map_err(|_| GuardError::StateUnavailable)?;
            if state.poisoned {
                return Err(GuardError::GenerationExhausted);
            }
            if !fresh
                && let Some(hit) = state.entries.iter().find(|e| {
                    e.key == key
                        && t0
                            .checked_duration_since(e.at)
                            .is_some_and(|age| age < CACHE_TTL)
                })
            {
                let mut hit = hit.check.clone();
                hit.cached = true;
                return Ok(hit);
            }
            state.generation
        };
        let mut attempts = Vec::new();
        let mut fell_back = false;
        let mut proxy = None;
        let mut path = NetPath::None;
        let mut loc = None;
        let mut early = None;
        if profile.mode == Mode::Off || (profile.mode == Mode::Auto && profile.proxy.is_empty()) {
            path = NetPath::Direct;
            loc = self.trace(NetPath::Direct, None, &mut attempts).await;
        } else if profile.proxy.is_empty() {
            early = Some(Reason::NoProxy);
        } else {
            proxy = Some(profile.proxy.clone());
            loc = self
                .trace(NetPath::Proxy, Some(&profile.proxy), &mut attempts)
                .await;
            if loc.is_some() {
                path = NetPath::Proxy;
            } else if profile.mode == Mode::Required {
                early = Some(Reason::ProxyDead);
            } else {
                fell_back = true;
                path = NetPath::Direct;
                proxy = None;
                loc = self.trace(NetPath::Direct, None, &mut attempts).await;
            }
        }
        let (ok, reason) =
            early.map_or_else(|| guard_verdict(&rule, loc.as_deref()), |r| (false, r));
        let check = Check {
            provider,
            mode: profile.mode,
            path: if ok { path } else { NetPath::None },
            proxy,
            loc,
            ok,
            reason,
            fell_back,
            no_proxy: profile.no_proxy.clone(),
            guard: rule,
            attempts,
            elapsed: self
                .clock
                .now()
                .checked_duration_since(t0)
                .unwrap_or_default(),
            checked_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            cached: false,
            generation,
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| GuardError::StateUnavailable)?;
        if state.poisoned || state.generation != generation {
            return Err(GuardError::StaleGeneration);
        }
        state.entries.retain(|e| e.key != key);
        if state.entries.len() == MAX_CACHE_ENTRIES {
            state.entries.pop_front();
        }
        state.entries.push_back(Entry {
            key,
            at: self.clock.now(),
            check: check.clone(),
        });
        Ok(check)
    }
    async fn trace(
        &self,
        path: NetPath,
        proxy: Option<&str>,
        attempts: &mut Vec<Attempt>,
    ) -> Option<String> {
        for url in EGRESS_URLS {
            let result = self.probe.probe(url, proxy, PROBE_TIMEOUT).await;
            let loc = if result.status == Some(0) && result.stdout.len() <= MAX_TRACE_BYTES {
                parse_loc(&result.stdout)
            } else {
                None
            };
            attempts.push(Attempt {
                path,
                url,
                proxy: proxy.map(str::to_owned),
                exit: result.status,
                loc: loc.clone(),
            });
            if loc.is_some() {
                return loc;
            }
        }
        None
    }
}

struct CurlInner {
    program: PathBuf,
    env: Environment,
    slots: Arc<Semaphore>,
    active: AtomicUsize,
    notify: Notify,
    shutdown: watch::Sender<bool>,
}
#[derive(Clone)]
pub struct CurlProbe {
    inner: Arc<CurlInner>,
}
impl CurlProbe {
    pub fn new(parent: &Environment) -> Result<Self, GuardError> {
        Self::with_program(Path::new("/usr/bin/curl"), parent)
    }
    /// Trusted host/test configuration, never an RPC-provided executable.
    pub fn with_program(program: &Path, parent: &Environment) -> Result<Self, GuardError> {
        if !program.is_absolute() {
            return Err(GuardError::InvalidProbe);
        }
        let env = worker_env::from_parent(parent, &Environment::new())
            .map_err(|_| GuardError::InvalidProbe)?;
        let (shutdown, _) = watch::channel(false);
        Ok(Self {
            inner: Arc::new(CurlInner {
                program: program.to_path_buf(),
                env,
                slots: Arc::new(Semaphore::new(8)),
                active: AtomicUsize::new(0),
                notify: Notify::new(),
                shutdown,
            }),
        })
    }
    pub fn active_jobs(&self) -> usize {
        self.inner.active.load(Ordering::Acquire)
    }
    pub async fn drain(&self) {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active_jobs() == 0 {
                return;
            }
            notified.await;
        }
    }
    pub async fn shutdown(&self) {
        self.inner.shutdown.send_replace(true);
        self.inner.slots.close();
        self.drain().await;
    }
}
struct ActiveJob {
    inner: Arc<CurlInner>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for ActiveJob {
    fn drop(&mut self) {
        self.inner.active.fetch_sub(1, Ordering::AcqRel);
        self.inner.notify.notify_waiters();
    }
}
struct CancelOnDrop(Option<oneshot::Sender<()>>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}
impl Probe for CurlProbe {
    fn probe<'a>(
        &'a self,
        url: &'a str,
        proxy: Option<&'a str>,
        timeout: Duration,
    ) -> ProbeFuture<'a> {
        Box::pin(async move {
            let Ok(permit) = self.inner.slots.clone().acquire_owned().await else {
                return ProbeResult::failed(0);
            };
            if *self.inner.shutdown.borrow() {
                return ProbeResult::failed(0);
            }
            let (cancel_tx, cancel_rx) = oneshot::channel();
            let mut cancel = CancelOnDrop(Some(cancel_tx));
            let (result_tx, result_rx) = oneshot::channel();
            self.inner.active.fetch_add(1, Ordering::AcqRel);
            let active = ActiveJob {
                inner: self.inner.clone(),
                _permit: permit,
            };
            let args = curl_args(url, proxy, timeout);
            let inner = self.inner.clone();
            tokio::spawn(async move {
                let _active = active;
                let result = run_curl(&inner, args, timeout, cancel_rx).await;
                let _ = result_tx.send(result);
            });
            let result = result_rx.await.unwrap_or_else(|_| ProbeResult::failed(0));
            cancel.0.take();
            result
        })
    }
}
async fn kill_wait(child: &mut Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}
async fn run_curl(
    inner: &CurlInner,
    args: Vec<String>,
    timeout: Duration,
    mut cancel: oneshot::Receiver<()>,
) -> ProbeResult {
    let mut shutdown = inner.shutdown.subscribe();
    if *shutdown.borrow() {
        return ProbeResult::failed(0);
    }
    let mut command = Command::new(&inner.program);
    command
        .args(args)
        .env_clear()
        .envs(&inner.env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let Ok(mut child) = command.spawn() else {
        return ProbeResult::failed(0);
    };
    let Some(mut stdout) = child.stdout.take() else {
        kill_wait(&mut child).await;
        return ProbeResult::failed(0);
    };
    let Some(mut stderr) = child.stderr.take() else {
        kill_wait(&mut child).await;
        return ProbeResult::failed(0);
    };
    let mut out = Vec::new();
    let mut errors = 0u64;
    let mut ob = [0u8; 8192];
    let mut eb = [0u8; 8192];
    let mut out_done = false;
    let mut err_done = false;
    let mut status = None;
    let mut exited = false;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        if exited && out_done && err_done {
            return ProbeResult {
                status,
                stdout: out,
                stderr_bytes: errors,
            };
        }
        tokio::select! {
            biased;
            _=&mut cancel=>{kill_wait(&mut child).await;return ProbeResult::failed(errors);}
            _=shutdown.changed()=>{kill_wait(&mut child).await;return ProbeResult::failed(errors);}
            _=&mut deadline=>{kill_wait(&mut child).await;return ProbeResult::failed(errors);}
            result=stdout.read(&mut ob),if !out_done=>match result {Ok(0)=>out_done=true,Ok(n)=>{if out.len()+n>MAX_TRACE_BYTES{kill_wait(&mut child).await;return ProbeResult::failed(errors);}out.extend_from_slice(&ob[..n]);},Err(_)=>{kill_wait(&mut child).await;return ProbeResult::failed(errors);}},
            result=stderr.read(&mut eb),if !err_done=>match result {Ok(0)=>err_done=true,Ok(n)=>errors=errors.saturating_add(n as u64),Err(_)=>{kill_wait(&mut child).await;return ProbeResult::failed(errors);}},
            result=child.wait(),if !exited=>{exited=true;status=result.ok().and_then(|s|s.code());}
        }
    }
}
