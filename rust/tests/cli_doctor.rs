//! Actual local CLI against isolated private fake binaries/files only.
use serde_json::{Value, json};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Output, Stdio},
    time::{Duration, Instant},
};
use tokio::process::Command;
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const KEYS: [&str; 5] = [
    "PULT_MEMORY_KEY",
    "PULT_CODEX_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
];
struct Fixture {
    _root: tempfile::TempDir,
    home: PathBuf,
    user: PathBuf,
    bin: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("r4doctor-")
            .tempdir_in("/tmp")
            .unwrap();
        let base = std::fs::canonicalize(root.path()).unwrap();
        let home = base.join("pult");
        let user = base.join("user");
        let bin = home.join("fakebin");
        for p in [
            &home,
            &user,
            &bin,
            &home.join("service"),
            &home.join("run"),
            &home.join("logs"),
            &home.join("events"),
        ] {
            std::fs::create_dir(p).unwrap();
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let f = Self {
            _root: root,
            home,
            user,
            bin,
        };
        f.file(".rust-core-scratch", "pult-rust-scratch-v1\n");
        f.file("config.json", "{}");
        for name in [
            "claude",
            "codex",
            "opencode",
            "zcode",
            "git",
            "gh",
            "node",
            "npm",
            "curl",
            "login-shell",
            "loginctl",
            "launchctl",
            "systemctl",
        ] {
            let p = f.bin.join(name);
            std::fs::write(&p, include_bytes!("fixtures/doctor_tool.py")).unwrap();
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        f
    }
    fn file(&self, name: &str, body: &str) {
        let path = self.home.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn scenario(&self, v: Value) {
        self.file("scenario.json", &v.to_string())
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.arg("--home")
            .arg(&self.home)
            .args(args)
            .env_clear()
            .env("HOME", &self.user)
            .env("USER", "fixture")
            .env("PATH", &self.bin)
            .env("LANG", "en_US.UTF-8")
            .env("PULT_LANG", "en")
            .env("PULT_TEST", "1")
            .env("PULT_TEST_DOCTOR_PATH", &self.bin)
            .env("PULT_TEST_DOCTOR_CURL", self.bin.join("curl"))
            .env("PULT_SERVICE_PLATFORM", "darwin")
            .env("PULT_SERVICE_DIR", self.home.join("service"))
            .env("PULT_LAUNCHCTL", self.bin.join("launchctl"))
            .env("PULT_SYSTEMCTL", self.bin.join("systemctl"))
            .env("PULT_TEST_DOCTOR_LOGINCTL", self.bin.join("loginctl"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        c
    }
    fn calls(&self) -> Vec<Value> {
        std::fs::read_to_string(self.home.join("doctor-calls.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}
async fn output(mut c: Command) -> Output {
    tokio::time::timeout(Duration::from_secs(95), c.output())
        .await
        .expect("private diagnostic CLI deadline")
        .unwrap()
}
fn report(out: &Output) -> Value {
    assert!(
        !out.stdout.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}
fn item<'a>(r: &'a Value, id: &str) -> &'a Value {
    r["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"] == id)
        .unwrap()
}
async fn wait_file(path: &Path) {
    let start = Instant::now();
    while !path.exists() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "private fake did not reach barrier"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn stopped(pid: i32) {
    let out = std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(
        s.trim().is_empty() || s.trim().starts_with('Z'),
        "known fake pid {pid} remains executing: {s}"
    );
}
fn descendants_stopped(f: &Fixture) {
    for e in std::fs::read_dir(&f.home).unwrap() {
        let e = e.unwrap();
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("leader-") || name.starts_with("child-") {
            stopped(std::fs::read_to_string(e.path()).unwrap().parse().unwrap())
        }
    }
}
#[tokio::test]
async fn paired_node_engine_and_file_schema_bindings_oracle() {
    let _serial = SERIAL.lock().await;
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = std::process::Command::new("node")
        .arg(project.join("rust/tests/cli-doctor-oracle.mjs"))
        .arg(project)
        .arg(env!("CARGO_BIN_EXE_pultd-rust"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("\"cases\":84"), "{s}");
    println!("{s}");
}
#[tokio::test]
async fn no_net_keeps_all_offline_checks_and_default_checks_four_providers() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.file("zcode-credentials.json", "{\"oauth:x:access_token\":null}");
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    let r = report(&out);
    for id in [
        "node.version",
        "login.claude",
        "subscription.claude",
        "login.codex",
        "subscription.codex",
        "codex.schema",
        "login.opencode",
        "login.zcode",
        "guard.rule",
        "home.permissions",
        "daemon",
        "version.current",
        "browser.mcp",
        "browser.chrome",
        "mcp.servers",
        "service",
    ] {
        item(&r, id);
    }
    assert_eq!(out.status.code(), Some(0));
    assert!(!f.calls().iter().any(|c| c["name"] == "curl"));
    for c in f.calls() {
        let names = c["env"].as_array().unwrap();
        assert!(
            !names
                .iter()
                .any(|n| n.as_str().is_some_and(|s| s.starts_with("CLAUDE_")
                    || s.starts_with("ANTHROPIC_")
                    || s == "PULT_TEST"))
        );
    }
    let out = output(f.command(&["doctor", "--json"])).await;
    let r = report(&out);
    for p in ["claude", "codex", "opencode", "zcode"] {
        assert_eq!(item(&r, &format!("net.{p}"))["status"], "ok");
    }
    let calls = f
        .calls()
        .into_iter()
        .filter(|c| c["name"] == "curl")
        .collect::<Vec<_>>();
    assert_eq!(calls.len(), 4);
}
#[tokio::test]
async fn purpose_guards_precede_all_files_and_test_mode_has_no_system_fallback() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    for key in KEYS {
        let mut c = f.command(&["doctor", "--json"]);
        c.env(key, "").arg("--no-net");
        let out = output(c).await;
        assert_eq!(out.status.code(), Some(1));
        assert_eq!(out.stderr, b"Error: doctor requires owner authentication\n");
    }
    assert!(f.calls().is_empty());
    let mut c = f.command(&["doctor", "--json", "--no-net"]);
    c.env_remove("PULT_TEST_DOCTOR_PATH");
    let out = output(c).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(f.calls().is_empty());
    let mut c = f.command(&["doctor", "--json"]);
    c.env_remove("PULT_TEST_DOCTOR_CURL");
    let out = output(c).await;
    assert_eq!(out.status.code(), Some(1));
    assert!(!f.calls().iter().any(|c| c["name"] == "curl"));
}
#[tokio::test]
async fn dotfile_symlinks_follow_source_and_project_only_selected_fields() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    let toml = f.user.join("settings.toml");
    std::fs::write(&toml, "[sandbox_workspace_write]\nnetwork_access=true").unwrap();
    symlink(&toml, f.home.join("codex-config.toml")).unwrap();
    let creds = f.user.join("creds.json");
    std::fs::write(&creds, "{\"oauth:x:access_token\":\"never-print-me\"}").unwrap();
    symlink(&creds, f.home.join("zcode-credentials.json")).unwrap();
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    let r = report(&out);
    assert_eq!(item(&r, "codex.network")["status"], "warn");
    assert_eq!(item(&r, "login.zcode")["status"], "ok");
    assert!(!String::from_utf8_lossy(&out.stdout).contains("never-print-me"));
}
#[tokio::test]
async fn deep_toml_path_and_large_array_are_bounded_warnings_not_abort() {
    let _serial = SERIAL.lock().await;
    for body in [
        format!("{}=true", vec!["a"; 100000].join(".")),
        format!("x=[{}]", vec!["true"; 70000].join(",")),
    ] {
        let f = Fixture::new();
        f.file("codex-config.toml", &body);
        let started = Instant::now();
        let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
        let r = report(&out);
        assert_eq!(item(&r, "codex.network")["data"]["parsed"], false);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
#[tokio::test]
async fn overflow_auth_never_projects_partial_logged_in_as_success() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.scenario(json!({"overflowAuth":true}));
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    let r = report(&out);
    assert_eq!(item(&r, "login.claude")["status"], "warn");
    assert_eq!(item(&r, "login.claude")["data"]["loggedIn"], Value::Null);
    assert_eq!(item(&r, "subscription.claude")["status"], "warn");
}
#[tokio::test]
async fn sigint_joins_parallel_auth_schema_groups_and_removes_only_confirmed_scratch() {
    let _serial = SERIAL.lock().await;
    for fault in [false, true] {
        let f = Fixture::new();
        f.scenario(json!({"hangPhase":"schema","hangAuth":true}));
        let mut c = f.command(&["doctor", "--json", "--no-net"]);
        if fault {
            c.env("PULT_TEST_DOCTOR_FAULT", "cleanup-schema");
        }
        let child = c.spawn().unwrap();
        let pid = child.id().unwrap();
        wait_file(&f.home.join("child-codex-schema")).await;
        wait_file(&f.home.join("child-claude-auth")).await;
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::Signal::SIGINT,
        )
        .unwrap();
        let out = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(if fault { 1 } else { 130 }),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.stdout.is_empty());
        descendants_stopped(&f);
        let retained = std::fs::read_dir(f.home.join("run")).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("codex-schema-")
        });
        assert_eq!(retained, fault);
        if fault {
            assert!(String::from_utf8_lossy(&out.stderr).contains("cleanup is unconfirmed"));
        }
    }
}
#[tokio::test]
async fn captured_shell_cache_is_private_bounded_and_never_rewrites_hardlinked_target() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    let mut c = f.command(&["doctor", "--json", "--no-net"]);
    c.env_remove("PULT_TEST_DOCTOR_PATH")
        .env("PULT_TEST_DOCTOR_SHELL", f.bin.join("login-shell"));
    let out = output(c).await;
    report(&out);
    let cache = std::fs::read_to_string(f.home.join("env.json")).unwrap();
    assert!(!cache.contains("not-cached-value"));
    assert!(cache.contains("FIXTURE_TOKEN"));
    assert_eq!(
        std::fs::metadata(f.home.join("env.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let external = f.user.join("external");
    std::fs::write(&external, "must remain unchanged").unwrap();
    std::fs::remove_file(f.home.join("env.json")).unwrap();
    std::fs::hard_link(&external, f.home.join("env.json")).unwrap();
    let mut c = f.command(&["doctor", "--json", "--no-net"]);
    c.env_remove("PULT_TEST_DOCTOR_PATH")
        .env("PULT_TEST_DOCTOR_SHELL", f.bin.join("login-shell"));
    let out = output(c).await;
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        std::fs::read_to_string(external).unwrap(),
        "must remain unchanged"
    );
}

#[tokio::test]
async fn thirty_second_version_deadline_runs_eight_jobs_together_and_joins_every_group() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.scenario(json!({"hangPhase":"version"}));
    let started = Instant::now();
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    assert!(started.elapsed() >= Duration::from_secs(29));
    assert!(started.elapsed() < Duration::from_secs(45));
    let r = report(&out);
    assert_eq!(item(&r, "node.version")["status"], "fail");
    for name in [
        "claude", "codex", "opencode", "zcode", "git", "gh", "node", "npm",
    ] {
        assert!(f.home.join(format!("child-{name}-version")).exists());
    }
    descendants_stopped(&f);
}
#[tokio::test]
async fn three_second_shell_deadline_never_falls_back_to_system_in_test_mode() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.scenario(json!({"hangPhase":"shell"}));
    let mut c = f.command(&["doctor", "--json", "--no-net"]);
    c.env_remove("PULT_TEST_DOCTOR_PATH")
        .env("PULT_TEST_DOCTOR_SHELL", f.bin.join("login-shell"));
    let started = Instant::now();
    let out = output(c).await;
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    descendants_stopped(&f);
    assert!(f.calls().iter().all(|c| c["name"] == "login-shell"));
}

#[tokio::test]
async fn new_codex_memory_purpose_presence_precedes_unsafe_home_and_fifo_reads() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    std::fs::remove_file(f.home.join("config.json")).unwrap();
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(f.home.join("config.json"))
            .status()
            .unwrap()
            .success()
    );
    for value in ["", "scoped-key"] {
        let mut c = f.command(&["doctor", "--json", "--no-net"]);
        c.env("PULT_CODEX_MEMORY_KEY", value)
            .env("PULT_ASK_KEY", "");
        let out = output(c).await;
        assert_eq!(out.status.code(), Some(1));
        assert_eq!(out.stderr, b"Error: doctor requires owner authentication\n");
        let mut c = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
        c.env_clear()
            .env("PULT_CODEX_MEMORY_KEY", value)
            .arg("--home")
            .arg("relative")
            .args(["doctor", "--json", "--no-net"]);
        let out = output(c).await;
        assert_eq!(out.stderr, b"Error: doctor requires owner authentication\n");
    }
    assert!(f.calls().is_empty());
}
#[tokio::test]
async fn cache_swapped_during_capture_never_follows_symlink_or_fifo_and_large_cache_never_writes() {
    let _serial = SERIAL.lock().await;
    for scenario in [
        json!({"cacheSwap":"symlink"}),
        json!({"cacheSwap":"fifo"}),
        json!({"hugeCache":true}),
    ] {
        let f = Fixture::new();
        f.scenario(scenario);
        f.file("env.json", "{}");
        let external = f.user.join("external");
        std::fs::write(&external, "must remain unchanged").unwrap();
        let mut c = f.command(&["doctor", "--json", "--no-net"]);
        c.env_remove("PULT_TEST_DOCTOR_PATH")
            .env("PULT_TEST_DOCTOR_SHELL", f.bin.join("login-shell"));
        let out = output(c).await;
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
        assert_eq!(
            std::fs::read_to_string(external).unwrap(),
            "must remain unchanged"
        );
        assert!(!std::fs::read_dir(&f.home).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".doctor-env-")
        }));
    }
}

#[tokio::test]
async fn node_dependency_selects_valid_managed_active_then_located_with_explicit_source() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    let managed = f.bin.join("managed-node");
    std::fs::write(&managed, "#!/bin/sh\nprintf 'v24.21.0\\n'\n").unwrap();
    std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o700)).unwrap();
    let pointer = f.user.join("node-pointer");
    std::fs::write(&pointer, format!("{}\n", managed.display())).unwrap();
    std::fs::create_dir(f.home.join("runtime")).unwrap();
    symlink(&pointer, f.home.join("runtime/active")).unwrap();
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    let r = report(&out);
    assert_eq!(
        item(&r, "node.version")["data"],
        json!({"path":managed,"source":"managed-active"})
    );
    std::fs::write(&managed, "#!/bin/sh\nprintf 'v18.0.0\\n'\n").unwrap();
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    let r = report(&out);
    assert_eq!(
        item(&r, "node.version")["data"],
        json!({"path":f.bin.join("node"),"source":"located"})
    );
    assert_eq!(item(&r, "node.version")["status"], "ok");
}

#[tokio::test]
async fn schema_generator_observes_real_file_depth_count_size_and_type_bounds() {
    let _serial = SERIAL.lock().await;
    for mode in ["depth32", "depth33", "files", "size", "total", "special"] {
        let mut f = Fixture::new();
        // Retain even on an early failure: the generator may still own writers.
        f._root.disable_cleanup(true);
        f.scenario(json!({"schemaMode":mode}));
        std::fs::write(f.user.join("secret.json"), "never hash through a symlink").unwrap();
        let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
        let r = report(&out);
        let schema = item(&r, "codex.schema");
        assert_eq!(
            schema["data"]["state"],
            if mode == "depth32" {
                "drift"
            } else {
                "unavailable"
            },
            "mode={mode}: {schema}"
        );
        if mode == "special" {
            assert_eq!(schema["data"]["files"], 0);
        }
        let retained = std::fs::read_dir(f.home.join("run")).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("codex-schema-")
        });
        assert_eq!(
            retained,
            ["depth33", "files", "size", "total"].contains(&mode),
            "mode={mode}"
        );
        if retained {
            assert_eq!(schema["data"]["scratchRetained"], true);
        }
        // Only a validated report after a successful owned CLI exit permits removal.
        if out.status.success() {
            f._root.disable_cleanup(false);
        }
    }
}
#[tokio::test]
async fn auth_twenty_second_timeout_keeps_only_source_qualified_partial_stdout_after_join() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.scenario(json!({"hangAuth":true,"partialAuth":true}));
    let started = Instant::now();
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    assert!(started.elapsed() >= Duration::from_secs(19));
    assert!(started.elapsed() < Duration::from_secs(32));
    let r = report(&out);
    assert_eq!(item(&r, "login.claude")["status"], "ok");
    assert_eq!(
        item(&r, "login.claude")["data"],
        json!({"exitCode":null,"loggedIn":true})
    );
    assert_eq!(item(&r, "login.codex")["status"], "fail");
    descendants_stopped(&f);
}

#[tokio::test]
async fn versions_schema_curl_use_base_allowlist_while_auth_uses_captured_login_path() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    let base = f.home.join("basebin");
    std::fs::create_dir(&base).unwrap();
    let mut c = f.command(&["doctor", "--json"]);
    c.env("PATH", &base);
    let out = output(c).await;
    report(&out);
    let mut schema = false;
    let mut auth = false;
    let mut curl = 0;
    for call in f.calls() {
        let args = call["args"].as_array().unwrap();
        let first = args.first().and_then(Value::as_str).unwrap_or_default();
        let captured = first == "auth" || first == "login";
        if captured {
            auth = true
        }
        if first == "app-server" {
            schema = true
        }
        if call["name"] == "curl" {
            curl += 1
        }
        assert_eq!(
            call["environmentPath"],
            json!(if captured { &f.bin } else { &base }),
            "{call}"
        );
    }
    assert!(auth && schema);
    assert_eq!(curl, 4);
}

#[tokio::test]
async fn actual_blocked_stdout_sigint_and_output_deadline_follow_confirmed_child_cleanup() {
    use tokio::io::AsyncReadExt;
    let _serial = SERIAL.lock().await;
    for sigint in [true, false] {
        let f = Fixture::new();
        f.scenario(json!({"longVersion":128*1024,"retainPhase":"schema"}));
        let mut child = f
            .command(&["doctor", "--json", "--no-net"])
            .spawn()
            .unwrap();
        let mut pipe = child.stdout.take().unwrap();
        let mut first = [0];
        tokio::time::timeout(Duration::from_secs(15), pipe.read_exact(&mut first))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first, [b'{']);
        // The first report byte is emitted after every provider/reader/group join.
        descendants_stopped(&f);
        if sigint {
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(child.id().unwrap() as i32),
                nix::sys::signal::Signal::SIGINT,
            )
            .unwrap();
        }
        let out = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            out.status.code(),
            Some(if sigint { 130 } else { 1 }),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        if sigint {
            assert_eq!(out.stderr, b"Error: doctor interrupted\n");
        } else {
            assert!(String::from_utf8_lossy(&out.stderr).contains("doctor output failed"));
        }
        drop(pipe);
        descendants_stopped(&f);
    }
}

#[tokio::test]
async fn invalid_config_warning_uses_actual_node_numeric_object_key_order() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.file(
        "config.json",
        r#"{"network":{"claude":{"mode":{"2":"b","10":"j","1":"a"}}}}"#,
    );
    let source = r#"import {pathToFileURL} from 'node:url';const {loadConfig}=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(loadConfig(process.argv[2]).warnings))"#;
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let expected = std::process::Command::new("node")
        .args(["--input-type=module", "-e", source])
        .arg(project.join("dist/core/config.js"))
        .arg(f.home.join("config.json"))
        .output()
        .unwrap();
    assert!(expected.status.success());
    let warnings: Vec<String> = serde_json::from_slice(&expected.stdout).unwrap();
    assert!(warnings[0].contains(r#"{"1":"a","2":"b","10":"j"}"#));
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    report(&out);
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        warnings
            .iter()
            .map(|s| format!("config: {s}\n"))
            .collect::<String>()
    );
}

#[tokio::test]
async fn version_output_capacity_is_explicit_warning_even_for_an_existing_cli() {
    let _serial = SERIAL.lock().await;
    for scenario in [json!({"overflow":"git"}), json!({"overflowStderr":"git"})] {
        let f = Fixture::new();
        f.scenario(scenario);
        let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
        let r = report(&out);
        let git = item(&r, "cli.git");
        assert_eq!(git["status"], "warn");
        assert_eq!(git["data"]["state"], "output_limit");
        assert_eq!(git["data"]["version"], Value::Null);
        assert!(git["detail"].as_str().unwrap().contains("4 MiB"));
    }
}

#[tokio::test]
async fn zcode_presence_matches_actual_node_token_key_regex_without_overlap_or_newlines() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = r#"import {pathToFileURL} from 'node:url';const {zcodeLoginState}=await import(pathToFileURL(process.argv[1]));console.log(zcodeLoginState(process.argv[2]))"#;
    for key in [
        "oauth:access_token",
        "oauth::access_token",
        "oauth:x\n:access_token",
        "oauth:x:access_token",
        "zcodejwttoken",
    ] {
        f.file("zcode-credentials.json", &json!({key:null}).to_string());
        let expected = std::process::Command::new("node")
            .args(["--input-type=module", "-e", source])
            .arg(project.join("dist/env/zcodeLogin.js"))
            .arg(f.home.join("zcode-credentials.json"))
            .output()
            .unwrap();
        assert!(expected.status.success());
        let expected = String::from_utf8(expected.stdout).unwrap();
        let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
        let r = report(&out);
        assert_eq!(
            item(&r, "login.zcode")["data"]["login"],
            expected.trim(),
            "key={key:?}"
        );
    }
}

#[tokio::test]
async fn schema_empty_directories_count_toward_inventory_budget_and_are_retained() {
    let _serial = SERIAL.lock().await;
    let f = Fixture::new();
    f.scenario(json!({"schemaMode":"entries"}));
    let out = output(f.command(&["doctor", "--json", "--no-net"])).await;
    let r = report(&out);
    let schema = item(&r, "codex.schema");
    assert_eq!(schema["data"]["state"], "unavailable");
    assert_eq!(schema["data"]["scratchRetained"], true);
    assert_eq!(schema["data"]["retainedReason"], "entry_limit");
    assert!(std::fs::read_dir(f.home.join("run")).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("codex-schema-")
    }));
}

#[tokio::test]
async fn nonzero_and_cancelled_schema_generators_retain_overbudget_trees_without_recursive_cleanup()
{
    let _serial = SERIAL.lock().await;
    for mode in ["entries-nonzero", "entries-cancel"] {
        let f = Fixture::new();
        f.scenario(json!({"schemaMode":mode}));
        let out = if mode == "entries-cancel" {
            let child = f
                .command(&["doctor", "--json", "--no-net"])
                .spawn()
                .unwrap();
            let pid = child.id().unwrap();
            wait_file(&f.home.join("schema-entries-ready")).await;
            wait_file(&f.home.join("child-codex-schema")).await;
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid as i32),
                nix::sys::signal::Signal::SIGINT,
            )
            .unwrap();
            tokio::time::timeout(Duration::from_secs(12), child.wait_with_output())
                .await
                .unwrap()
                .unwrap()
        } else {
            output(f.command(&["doctor", "--json", "--no-net"])).await
        };
        assert!(std::fs::read_dir(f.home.join("run")).unwrap().any(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("codex-schema-")
        }));
        if mode == "entries-cancel" {
            assert_eq!(out.status.code(), Some(130));
            assert!(out.stdout.is_empty());
            assert!(String::from_utf8_lossy(&out.stderr).contains("schema scratch retained"));
            descendants_stopped(&f);
        } else {
            let r = report(&out);
            let schema = item(&r, "codex.schema");
            assert_eq!(schema["data"]["state"], "unavailable");
            assert_eq!(schema["data"]["scratchRetained"], true);
            assert_eq!(schema["data"]["retainedReason"], "entry_limit");
        }
    }
}
