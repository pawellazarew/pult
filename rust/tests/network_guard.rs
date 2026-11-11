use pult_core::{network_guard::*, turn_snapshot::Provider, worker_env::Environment};
use serde_json::json;
use std::{
    collections::VecDeque,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

struct FakeProbe {
    responses: Mutex<VecDeque<ProbeResult>>,
    calls: Mutex<Vec<(String, Option<String>, Duration)>>,
}
impl FakeProbe {
    fn new(responses: Vec<ProbeResult>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into()),
            calls: Mutex::new(vec![]),
        })
    }
    fn count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}
impl Probe for FakeProbe {
    fn probe<'a>(
        &'a self,
        url: &'a str,
        proxy: Option<&'a str>,
        timeout: Duration,
    ) -> ProbeFuture<'a> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((url.into(), proxy.map(str::to_owned), timeout));
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| result(0, "loc=DE\n"))
        })
    }
}
fn result(status: i32, text: &str) -> ProbeResult {
    ProbeResult {
        status: Some(status),
        stdout: text.as_bytes().to_vec(),
        stderr_bytes: 0,
    }
}
fn profile(mode: Mode, proxy: &str) -> Profile {
    Profile {
        mode,
        proxy: proxy.into(),
        no_proxy: vec![],
    }
}
struct TestClock {
    base: Instant,
    millis: AtomicU64,
}
impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.base + Duration::from_millis(self.millis.load(Ordering::Relaxed))
    }
}
#[test]
fn country_rules_are_complete_strict_and_fail_closed() {
    assert_eq!(COUNTRY_CODES.len(), 250);
    assert_eq!(
        COUNTRY_CODES
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        250
    );
    assert!(COUNTRY_CODES.contains(&"XK"));
    let rule =
        GuardRule::parse_strict(&json!({"mode":"allow","countries":["DE","DE","XK"]})).unwrap();
    assert_eq!(rule.countries, vec!["DE", "XK"]);
    assert!(GuardRule::parse_shape(&json!({"mode":"allow","countries":[]})).is_ok());
    for invalid in [
        json!(null),
        json!({"mode":"allow","countries":[]}),
        json!({"mode":"deny","countries":["de"]}),
        json!({"mode":"deny","countries":["ZZ"]}),
        json!({"mode":"deny","countries":[],"extra":true}),
    ] {
        assert!(GuardRule::parse_strict(&invalid).is_err());
    }
    assert_eq!(
        guard_verdict(&GuardRule::default(), Some("ru")),
        (false, Reason::BlockedCountry)
    );
    assert_eq!(
        guard_verdict(&GuardRule::closed(), Some("DE")),
        (false, Reason::NotAllowedCountry)
    );
    assert_eq!(
        guard_verdict(&GuardRule::default(), None),
        (false, Reason::UnknownLocation)
    );
    assert_eq!(guard_verdict(&rule, Some("DE")), (true, Reason::Ok));
}
#[test]
fn trace_location_is_two_ascii_letters_without_trailing_payload() {
    assert_eq!(
        parse_loc("junk\u{2028}loc=RU\nloc=DE".as_bytes()).as_deref(),
        Some("RU")
    );
    assert_eq!(
        parse_loc("junk\u{2029}loc=RU\nloc=DE".as_bytes()).as_deref(),
        Some("RU")
    );
    for (body, want) in [
        ("ip=1\nloc=de\r\n", Some("DE")),
        ("loc=XK", Some("XK")),
        ("loc=ZZ\t ", Some("ZZ")),
        ("loc=DEfoo", None),
        (" loc=DE", None),
        ("loc=ДЕ", None),
        ("loc=D", None),
        ("loc=DE x", None),
    ] {
        assert_eq!(parse_loc(body.as_bytes()).as_deref(), want);
    }
    assert_eq!(parse_loc(&[0xff]), None);
}
#[test]
fn curl_route_arguments_and_no_proxy_match_node() {
    assert_eq!(
        curl_args(EGRESS_URLS[0], None, PROBE_TIMEOUT),
        vec!["-q", "-s", "-m", "8", "-x", "", EGRESS_URLS[0]]
    );
    assert_eq!(
        curl_args(
            "https://example.test",
            Some("http://user:secret@proxy:80"),
            Duration::from_millis(1200)
        )[5],
        "http://user:secret@proxy:80"
    );
    assert_eq!(
        no_proxy_value(&[
            "localhost".into(),
            "example.test".into(),
            "example.test".into()
        ]),
        "localhost,127.0.0.1,::1,example.test"
    );
}
#[tokio::test]
async fn required_without_proxy_never_probes_or_goes_direct() {
    let probe = FakeProbe::new(vec![]);
    let guard = NetworkGuard::new(probe.clone());
    let check = guard
        .check(
            Provider::Claude,
            &profile(Mode::Required, ""),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    assert!(!check.ok);
    assert_eq!(check.reason, Reason::NoProxy);
    assert_eq!(check.path, NetPath::None);
    assert_eq!(probe.count(), 0);
}
#[tokio::test]
async fn required_dead_proxy_ignores_partial_loc_and_never_falls_back() {
    let probe = FakeProbe::new(vec![result(28, "loc=DE\n"), result(56, "loc=DE\n")]);
    let guard = NetworkGuard::new(probe.clone());
    let check = guard
        .check(
            Provider::Codex,
            &profile(Mode::Required, "http://proxy"),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(check.reason, Reason::ProxyDead);
    assert!(!check.fell_back);
    assert_eq!(check.path, NetPath::None);
    assert_eq!(check.attempts.len(), 2);
    assert!(
        check
            .attempts
            .iter()
            .all(|a| a.path == NetPath::Proxy && a.loc.is_none())
    );
    assert!(
        probe
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(_, p, t)| p.as_deref() == Some("http://proxy") && *t == PROBE_TIMEOUT)
    );
}
#[tokio::test]
async fn auto_fallback_is_still_country_guarded_and_uses_real_route_probes() {
    let probe = FakeProbe::new(vec![
        result(7, ""),
        result(28, "loc=DE"),
        result(0, "loc=RU"),
    ]);
    let guard = NetworkGuard::new(probe.clone());
    let check = guard
        .check(
            Provider::Zcode,
            &profile(Mode::Auto, "http://proxy"),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(check.reason, Reason::BlockedCountry);
    assert!(check.fell_back);
    assert_eq!(check.path, NetPath::None);
    assert!(check.proxy.is_none());
    assert_eq!(check.attempts.len(), 3);
    assert_eq!(check.attempts[2].path, NetPath::Direct);
    assert!(probe.calls.lock().unwrap()[2].1.is_none());
}
#[tokio::test]
async fn healthy_proxy_and_direct_modes_choose_only_the_checked_route() {
    let probe = FakeProbe::new(vec![]);
    let guard = NetworkGuard::new(probe.clone());
    let proxy = guard
        .check(
            Provider::Claude,
            &profile(Mode::Auto, "http://proxy"),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    assert!(proxy.ok);
    assert_eq!(proxy.path, NetPath::Proxy);
    assert_eq!(proxy.proxy.as_deref(), Some("http://proxy"));
    assert!(!proxy.fell_back);
    for p in [
        profile(Mode::Off, "http://ignored"),
        profile(Mode::Auto, ""),
    ] {
        let direct = guard
            .check(Provider::Claude, &p, &GuardRule::default(), false)
            .await
            .unwrap();
        assert!(direct.ok);
        assert_eq!(direct.path, NetPath::Direct);
        assert!(direct.proxy.is_none());
        assert!(!direct.fell_back);
    }
}
#[tokio::test]
async fn unknown_locations_and_oversized_injected_results_cannot_grant() {
    let huge = ProbeResult {
        status: Some(0),
        stdout: format!("loc=DE\n{}", "x".repeat(MAX_TRACE_BYTES)).into_bytes(),
        stderr_bytes: 0,
    };
    let probe = FakeProbe::new(vec![huge, result(0, "loc=DEbad")]);
    let guard = NetworkGuard::new(probe);
    let check = guard
        .check(
            Provider::Claude,
            &profile(Mode::Off, ""),
            &GuardRule {
                mode: GuardMode::Deny,
                countries: vec![],
            },
            false,
        )
        .await
        .unwrap();
    assert_eq!(check.reason, Reason::UnknownLocation);
    assert!(!check.ok);
}
#[tokio::test]
async fn cache_ttl_fresh_complete_keys_and_entry_bound() {
    let probe = FakeProbe::new(vec![]);
    let clock = Arc::new(TestClock {
        base: Instant::now(),
        millis: AtomicU64::new(0),
    });
    let guard = NetworkGuard::with_clock(probe.clone(), clock.clone());
    let p = profile(Mode::Off, "");
    let rule = GuardRule::default();
    assert!(
        !guard
            .check(Provider::Claude, &p, &rule, false)
            .await
            .unwrap()
            .cached
    );
    assert!(
        guard
            .check(Provider::Claude, &p, &rule, false)
            .await
            .unwrap()
            .cached
    );
    assert_eq!(probe.count(), 1);
    clock.millis.store(59_999, Ordering::Relaxed);
    assert!(
        guard
            .check(Provider::Claude, &p, &rule, false)
            .await
            .unwrap()
            .cached
    );
    clock.millis.store(60_000, Ordering::Relaxed);
    assert!(
        !guard
            .check(Provider::Claude, &p, &rule, false)
            .await
            .unwrap()
            .cached
    );
    assert!(
        !guard
            .check(Provider::Claude, &p, &rule, true)
            .await
            .unwrap()
            .cached
    );
    assert!(
        !guard
            .check(Provider::Codex, &p, &rule, false)
            .await
            .unwrap()
            .cached
    );
    let mut p1 = p.clone();
    p1.no_proxy = vec!["a,b".into()];
    let mut p2 = p.clone();
    p2.no_proxy = vec!["a".into(), "b".into()];
    assert!(
        !guard
            .check(Provider::Claude, &p1, &rule, false)
            .await
            .unwrap()
            .cached
    );
    assert!(
        !guard
            .check(Provider::Claude, &p2, &rule, false)
            .await
            .unwrap()
            .cached
    );
    for n in 0..MAX_CACHE_ENTRIES + 10 {
        let p = profile(Mode::Off, &format!("proxy{n}"));
        guard
            .check(Provider::Claude, &p, &rule, false)
            .await
            .unwrap();
    }
    assert_eq!(guard.cache_len(), MAX_CACHE_ENTRIES);
    let old = guard
        .check(Provider::Claude, &p, &rule, false)
        .await
        .unwrap();
    let next = guard.clear_cache().unwrap();
    assert_eq!(next, 1);
    assert!(!guard.is_current(&old));
    assert_eq!(guard.cache_len(), 0);
}
struct BlockingProbe {
    started: AtomicUsize,
    release: Notify,
}
impl Probe for BlockingProbe {
    fn probe<'a>(
        &'a self,
        _url: &'a str,
        _proxy: Option<&'a str>,
        _timeout: Duration,
    ) -> ProbeFuture<'a> {
        Box::pin(async move {
            self.started.fetch_add(1, Ordering::Release);
            self.release.notified().await;
            result(0, "loc=DE")
        })
    }
}
#[tokio::test]
async fn cleared_generation_rejects_inflight_and_never_repopulates_cache() {
    let probe = Arc::new(BlockingProbe {
        started: AtomicUsize::new(0),
        release: Notify::new(),
    });
    let guard = Arc::new(NetworkGuard::new(probe.clone()));
    let running = guard.clone();
    let task = tokio::spawn(async move {
        running
            .check(
                Provider::Claude,
                &profile(Mode::Off, ""),
                &GuardRule::default(),
                false,
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while probe.started.load(Ordering::Acquire) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    guard.clear_cache().unwrap();
    probe.release.notify_one();
    assert!(matches!(
        task.await.unwrap(),
        Err(GuardError::StaleGeneration)
    ));
    assert_eq!(guard.cache_len(), 0);
}
#[test]
fn public_debug_never_contains_proxy_credentials_or_trace_content() {
    let p = profile(Mode::Auto, "http://USER_SECRET:PASSWORD_SECRET@proxy");
    let r = result(0, "loc=DE\nPRIVATE_TRACE_SECRET");
    let a = Attempt {
        path: NetPath::Proxy,
        url: EGRESS_URLS[0],
        proxy: Some(p.proxy.clone()),
        exit: Some(0),
        loc: Some("DE".into()),
    };
    let debug = format!("{p:?} {r:?} {a:?}");
    for secret in ["USER_SECRET", "PASSWORD_SECRET", "PRIVATE_TRACE_SECRET"] {
        assert!(!debug.contains(secret));
    }
}
fn fake_curl(home: &Path, script: &str) -> PathBuf {
    let path = home.join("fake-curl");
    fs::write(&path, format!("#!/usr/bin/python3\n{script}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}
fn probe_program(home: &Path, script: &str) -> CurlProbe {
    CurlProbe::with_program(&fake_curl(home, script), &Environment::new()).unwrap()
}
fn pid_script(path: &Path) -> String {
    format!(
        "import os,time\nopen({},'w').write(str(os.getpid()))\nprint('loc=DE',flush=True)\ntime.sleep(30)",
        serde_json::to_string(path.to_str().unwrap()).unwrap()
    )
}
fn gone(pid: i32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None)
        .is_err_and(|e| e == nix::errno::Errno::ESRCH)
}
async fn wait_pid(path: &Path) -> i32 {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(text) = fs::read_to_string(path)
                && let Ok(pid) = text.parse::<i32>()
            {
                break pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn fake_curl_uses_base_environment_only_and_drains_stderr_without_retaining_it() {
    let home = tempfile::tempdir().unwrap();
    let path = fake_curl(
        home.path(),
        "import os,sys,json\nassert sys.argv[1]=='-q'\nassert sys.argv[6]==''\nassert not any(k in os.environ for k in ['HTTPS_PROXY','NO_PROXY','PULT_MEMORY_KEY','ANTHROPIC_API_KEY','NODE_OPTIONS'])\nos.write(2,b'e'*200000)\nprint('loc=de',flush=True)",
    );
    let parent: Environment = [
        ("PATH", "/usr/bin:/bin"),
        ("PULT_MEMORY_KEY", "memory-secret"),
        ("ANTHROPIC_API_KEY", "provider-secret"),
        ("HTTPS_PROXY", "proxy-secret"),
        ("NODE_OPTIONS", "loader-secret"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    let probe = CurlProbe::with_program(&path, &parent).unwrap();
    let result = probe
        .probe(EGRESS_URLS[0], None, Duration::from_secs(3))
        .await;
    assert_eq!(result.status, Some(0));
    assert_eq!(parse_loc(&result.stdout).as_deref(), Some("DE"));
    assert_eq!(result.stderr_bytes, 200000);
    probe.drain().await;
    assert_eq!(probe.active_jobs(), 0);
}
#[tokio::test]
async fn timeout_and_overflow_kill_and_reap_even_with_valid_partial_location() {
    for overflow in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let pid_path = home.path().join("pid");
        // Shell builtins publish the PID before the short deadline without
        // depending on Python's startup cost under parallel process tests.
        // The busy loop spawns no descendants and terminates with the probe.
        let program = home.path().join("fake-curl");
        let quoted_pid = format!("'{}'", pid_path.to_str().unwrap().replace('\'', "'\\''"));
        let extra = if overflow {
            format!("printf '%s' '{}'\n", "x".repeat(MAX_TRACE_BYTES))
        } else {
            String::new()
        };
        fs::write(&program,format!("#!/bin/sh\nprintf '%s' \"$$\" > {quoted_pid}\nprintf 'loc=DE\\n'\n{extra}while :; do :; done\n")).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let probe = CurlProbe::with_program(&program, &Environment::new()).unwrap();
        let result = probe
            .probe(
                EGRESS_URLS[0],
                None,
                if overflow {
                    Duration::from_secs(3)
                } else {
                    Duration::from_millis(200)
                },
            )
            .await;
        assert_eq!(result.status, None);
        assert!(result.stdout.is_empty());
        probe.drain().await;
        assert_eq!(probe.active_jobs(), 0);
        if overflow {
            // Overflow requires the script to have emitted its output, which
            // happens only after publishing the PID.
            assert!(gone(wait_pid(&pid_path).await));
        } else if let Ok(pid) = fs::read_to_string(&pid_path) {
            assert!(gone(pid.parse().unwrap()));
        }
        // A timeout may kill the owned child before the interpreter starts;
        // that path has no script-level PID file. The cancellation test waits
        // for a started child and independently proves kill+wait reaping.
    }
}
#[tokio::test]
async fn caller_cancellation_owns_cleanup_until_child_is_reaped() {
    let home = tempfile::tempdir().unwrap();
    let pid_path = home.path().join("pid");
    let probe = probe_program(home.path(), &pid_script(&pid_path));
    let running = probe.clone();
    let task = tokio::spawn(async move {
        running
            .probe(EGRESS_URLS[0], None, Duration::from_secs(30))
            .await
    });
    let pid = wait_pid(&pid_path).await;
    assert_eq!(probe.active_jobs(), 1);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(3), probe.drain())
        .await
        .unwrap();
    assert!(gone(pid));
    assert_eq!(probe.active_jobs(), 0);
}
#[tokio::test]
async fn bounded_jobs_shutdown_cancels_active_and_queued_probes() {
    let home = tempfile::tempdir().unwrap();
    let probe = probe_program(home.path(), "import time\ntime.sleep(30)");
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let running = probe.clone();
        tasks.push(tokio::spawn(async move {
            running
                .probe(EGRESS_URLS[0], None, Duration::from_secs(30))
                .await
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while probe.active_jobs() < 8 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(probe.active_jobs(), 8);
    tokio::time::timeout(Duration::from_secs(3), probe.shutdown())
        .await
        .unwrap();
    for task in tasks {
        assert_eq!(task.await.unwrap().status, None);
    }
    assert_eq!(probe.active_jobs(), 0);
    assert_eq!(
        probe
            .probe(EGRESS_URLS[0], None, PROBE_TIMEOUT)
            .await
            .status,
        None
    );
}

fn env(values: &[(&str, &str)]) -> Environment {
    values
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect()
}
#[tokio::test]
async fn worker_environment_uses_checked_proxy_and_deduplicated_no_proxy() {
    let guard = NetworkGuard::new(FakeProbe::new(vec![]));
    let mut p = profile(Mode::Required, "http://checked-proxy");
    p.no_proxy = vec![
        "localhost".into(),
        "project.test".into(),
        "project.test".into(),
        "::1".into(),
    ];
    let check = guard
        .check(Provider::Claude, &p, &GuardRule::default(), false)
        .await
        .unwrap();
    let parent = env(&[
        ("HOME", "/tmp/test-home"),
        ("PATH", "/usr/bin"),
        ("HTTPS_PROXY", "http://ambient"),
        ("ANTHROPIC_API_KEY", "SECRET"),
    ]);
    let explicit = env(&[("HTTPS_PROXY", "http://stale"), ("NO_PROXY", "stale.test")]);
    let actual = guard
        .worker_environment(&check, &parent, &explicit)
        .unwrap();
    assert_eq!(
        actual.get(std::ffi::OsStr::new("HTTPS_PROXY")).unwrap(),
        "http://checked-proxy"
    );
    assert_eq!(
        actual.get(std::ffi::OsStr::new("NO_PROXY")).unwrap(),
        "localhost,127.0.0.1,::1,project.test"
    );
    assert!(!actual.contains_key(std::ffi::OsStr::new("ANTHROPIC_API_KEY")));
    assert_eq!(
        explicit.get(std::ffi::OsStr::new("HTTPS_PROXY")).unwrap(),
        "http://stale"
    );
}
#[tokio::test]
async fn worker_environment_direct_clears_ambient_and_explicit_proxy() {
    let guard = NetworkGuard::new(FakeProbe::new(vec![]));
    let check = guard
        .check(
            Provider::Codex,
            &profile(Mode::Off, "http://ignored"),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    let key = format!("mem_{}", "a".repeat(64));
    let parent = env(&[
        ("HTTPS_PROXY", "http://ambient"),
        ("PULT_MEMORY_KEY", "ambient-secret"),
    ]);
    let explicit = env(&[
        ("HTTPS_PROXY", "http://old-route"),
        ("NO_PROXY", "old.test"),
        ("PULT_MEMORY_KEY", &key),
    ]);
    let actual = guard
        .worker_environment(&check, &parent, &explicit)
        .unwrap();
    assert!(!actual.contains_key(std::ffi::OsStr::new("HTTPS_PROXY")));
    assert_eq!(
        actual.get(std::ffi::OsStr::new("NO_PROXY")).unwrap(),
        "localhost,127.0.0.1,::1"
    );
    assert_eq!(
        actual.get(std::ffi::OsStr::new("PULT_MEMORY_KEY")).unwrap(),
        key.as_str()
    );
}
#[tokio::test]
async fn worker_environment_rejects_stale_blocked_and_incomplete_routes() {
    let guard = NetworkGuard::new(FakeProbe::new(vec![]));
    let good = guard
        .check(
            Provider::Claude,
            &profile(Mode::Off, ""),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    let mut bad = good.clone();
    bad.ok = false;
    assert_eq!(
        guard.worker_environment(&bad, &Environment::new(), &Environment::new()),
        Err(GuardError::NetworkDenied)
    );
    bad = good.clone();
    bad.path = NetPath::None;
    assert_eq!(
        guard.worker_environment(&bad, &Environment::new(), &Environment::new()),
        Err(GuardError::NetworkDenied)
    );
    bad = good.clone();
    bad.path = NetPath::Proxy;
    bad.proxy = Some(String::new());
    assert_eq!(
        guard.worker_environment(&bad, &Environment::new(), &Environment::new()),
        Err(GuardError::InvalidRoute)
    );
    bad.proxy = None;
    assert_eq!(
        guard.worker_environment(&bad, &Environment::new(), &Environment::new()),
        Err(GuardError::InvalidRoute)
    );
    guard.clear_cache().unwrap();
    assert_eq!(
        guard.worker_environment(&good, &Environment::new(), &Environment::new()),
        Err(GuardError::StaleGeneration)
    );
}
#[tokio::test]
async fn worker_environment_rejects_unapproved_explicit_authority_without_echoing_it() {
    let guard = NetworkGuard::new(FakeProbe::new(vec![]));
    let check = guard
        .check(
            Provider::Claude,
            &profile(Mode::Off, ""),
            &GuardRule::default(),
            false,
        )
        .await
        .unwrap();
    let error = guard
        .worker_environment(
            &check,
            &Environment::new(),
            &env(&[("SECRET_KEY", "SECRET_VALUE")]),
        )
        .unwrap_err();
    assert_eq!(error, GuardError::InvalidEnvironment);
    assert!(!error.to_string().contains("SECRET"));
}

#[tokio::test]
async fn codex_proxy_sets_both_proxy_variables_while_other_providers_only_use_https() {
    let guard = NetworkGuard::new(FakeProbe::new(vec![]));
    let parent = env(&[
        ("ALL_PROXY", "http://ambient"),
        ("HTTPS_PROXY", "http://ambient"),
    ]);
    let explicit = env(&[
        ("ALL_PROXY", "http://stale"),
        ("HTTPS_PROXY", "http://stale"),
    ]);
    for provider in [Provider::Codex, Provider::Claude, Provider::Zcode] {
        let check = guard
            .check(
                provider,
                &profile(Mode::Required, "http://checked"),
                &GuardRule::default(),
                false,
            )
            .await
            .unwrap();
        let actual = guard
            .worker_environment(&check, &parent, &explicit)
            .unwrap();
        assert_eq!(
            actual.get(std::ffi::OsStr::new("HTTPS_PROXY")).unwrap(),
            "http://checked"
        );
        if provider == Provider::Codex {
            assert_eq!(
                actual.get(std::ffi::OsStr::new("ALL_PROXY")).unwrap(),
                "http://checked"
            );
        } else {
            assert!(!actual.contains_key(std::ffi::OsStr::new("ALL_PROXY")));
        }
        let direct = guard
            .check(
                provider,
                &profile(Mode::Off, "http://ignored"),
                &GuardRule::default(),
                false,
            )
            .await
            .unwrap();
        let actual = guard
            .worker_environment(&direct, &parent, &explicit)
            .unwrap();
        assert!(!actual.contains_key(std::ffi::OsStr::new("ALL_PROXY")));
        assert!(!actual.contains_key(std::ffi::OsStr::new("HTTPS_PROXY")));
    }
}

#[test]
fn guard_debug_hides_unvalidated_legacy_country_strings() {
    let guard = GuardRule {
        mode: GuardMode::Deny,
        countries: vec!["PRIVATE_CONFIG_SECRET".into()],
    };
    let diagnostic = format!("{guard:?}");
    assert!(!diagnostic.contains("PRIVATE"));
    assert!(diagnostic.contains("country_count: 1"));
}
