//! Actual executable and a controlled private owner socket. All keys are synthetic.
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::process::Command;

const BOUND: Duration = Duration::from_secs(6);
const KEYS: [&str; 4] = [
    "PULT_MEMORY_KEY",
    "PULT_MEMORY_TURN_KEY",
    "PULT_ASK_KEY",
    "PULT_RUNTIME_KEY",
];
const DENIED: &str = "permission/runtime credentials cannot use owner CLI commands";
struct Fake {
    home: tempfile::TempDir,
    listener: UnixListener,
}
impl Fake {
    fn new() -> Self {
        let home = tempfile::Builder::new()
            .prefix("psguard-")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.path().join("run")).unwrap();
        std::fs::set_permissions(
            home.path().join("run"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::write(
            home.path().join(".rust-core-scratch"),
            "pult-rust-scratch-v1\n",
        )
        .unwrap();
        std::fs::write(home.path().join("config.json"), "{\"language\":\"en\"}").unwrap();
        std::fs::write(home.path().join("run/token"), "a".repeat(64)).unwrap();
        for file in [".rust-core-scratch", "config.json", "run/token"] {
            std::fs::set_permissions(
                home.path().join(file),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        Self { home, listener }
    }
    fn command(&self, args: &[&str]) -> Command {
        let mut command = command(&[]);
        command.arg("--home").arg(self.home.path()).args(args);
        command
    }
}
fn command(args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pultd-rust"));
    command
        .args(args)
        .env_remove("PULT_HOME")
        .env_remove("PULT_TEST")
        .env("PULT_LANG", "en")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    for key in KEYS {
        command.env_remove(key);
    }
    command
}
async fn output(mut command: Command) -> Output {
    tokio::time::timeout(BOUND, command.output())
        .await
        .expect("scoped CLI must not block on owner IO")
        .unwrap()
}
async fn frame(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    assert_ne!(
        tokio::time::timeout(BOUND, reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    serde_json::from_str(&line).unwrap()
}
async fn send(reader: &mut BufReader<UnixStream>, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await.unwrap();
}
fn denied(out: &Output) {
    assert_eq!(out.status.code(), Some(1));
    assert!(out.stdout.is_empty());
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        format!("Error: {DENIED}\n")
    );
}
fn denied_for_command(out: &Output, args: &[&str]) {
    // The independently qualified bare-prompt slice routes this one command
    // through the preexisting OwnerClient gate. Both exact static errors have
    // the same required authority/IO boundary; accept no other error text.
    if args.starts_with(&["agent", "prompt"])
        && !args.contains(&"--wait")
        && out.stderr
            == "pult agent: forbidden — agent wait requires owner authentication\n".as_bytes()
    {
        assert_eq!(out.status.code(), Some(1));
        assert!(out.stdout.is_empty());
    } else {
        denied(out);
    }
}
async fn cannot_use_owner(key: &str) {
    let fake = Fake::new();
    let mut cmd = fake.command(&["daemon", "status"]);
    cmd.env(key, "synthetic-helper-credential");
    let (done, finished) = tokio::sync::oneshot::channel();
    let peer = tokio::spawn(async move {
        let accepted = tokio::select! {biased; accepted=fake.listener.accept()=>Some(accepted.unwrap()),_=finished=>None};
        if let Some((socket, _)) = accepted {
            let mut reader = BufReader::new(socket);
            let hello = frame(&mut reader).await;
            assert_eq!(hello["type"], "hello");
            assert_eq!(hello["protocol"], 1);
            assert_eq!(hello["token"], "a".repeat(64));
            assert!(hello.get("ask").is_none() && hello.get("runtime").is_none());
            send(&mut reader, json!({"type":"hello_ok","protocol":1})).await;
            let request = frame(&mut reader).await;
            assert_eq!(request["method"], "daemon.status");
            send(
                &mut reader,
                json!({"id":request["id"],"result":{"syntheticOwnerOnly":true}}),
            )
            .await;
            true
        } else {
            false
        }
    });
    let out = output(cmd).await;
    let _ = done.send(());
    let used_owner = tokio::time::timeout(BOUND, peer).await.unwrap().unwrap();
    // Baseline RED is an observed owner HELLO + successful owner RPC, not a
    // socket timeout or an inference from a local error message.
    assert!(
        !used_owner,
        "{key} used the synthetic owner token in HELLO and daemon.status"
    );
    denied(&out);
}
#[tokio::test]
async fn ask_key_never_authenticates_with_the_owner_token() {
    cannot_use_owner("PULT_ASK_KEY").await;
}
#[tokio::test]
async fn runtime_key_never_authenticates_with_the_owner_token() {
    cannot_use_owner("PULT_RUNTIME_KEY").await;
}

const OWNER_COMMANDS: &[&[&str]] = &[
    &["daemon", "status"],
    &["catalog"],
    &["agent", "read", "chat"],
    &["agent", "tree", "chat"],
    &["agent", "prompt", "chat", "fixture"],
    &["daemon", "serve"],
    &["events", "tail", "--no-follow"],
];

#[tokio::test]
async fn helper_presence_precedes_invalid_home_and_mixed_memory_purposes() {
    for helper in ["PULT_ASK_KEY", "PULT_RUNTIME_KEY"] {
        for value in ["", "synthetic-helper-credential"] {
            for memory in [
                None,
                Some("PULT_MEMORY_KEY"),
                Some("PULT_MEMORY_TURN_KEY"),
                Some("both"),
            ] {
                for args in OWNER_COMMANDS {
                    let mut c = command(&["--home", "relative-invalid-home"]);
                    c.args(*args).env(helper, value);
                    if let Some(memory) = memory {
                        if memory == "both" {
                            c.env("PULT_MEMORY_KEY", "invalid-read")
                                .env("PULT_MEMORY_TURN_KEY", "invalid-turn");
                        } else {
                            c.env(memory, "invalid-memory-credential");
                        }
                    }
                    denied_for_command(&output(c).await, args);
                }
            }
        }
    }
}
fn poison(fake: &Fake, file: &str) {
    let path = fake.home.path().join(file);
    std::fs::remove_file(&path).unwrap();
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(path)
            .status()
            .unwrap()
            .success()
    );
}
#[tokio::test]
async fn helper_presence_never_opens_owner_fifo_or_connects_even_when_empty() {
    for helper in ["PULT_ASK_KEY", "PULT_RUNTIME_KEY"] {
        for value in ["", "synthetic-helper-credential"] {
            for file in ["config.json", "run/token", ".rust-core-scratch"] {
                let fake = Fake::new();
                poison(&fake, file);
                for args in OWNER_COMMANDS {
                    let mut c = fake.command(args);
                    c.env(helper, value);
                    denied_for_command(&output(c).await, args);
                }
                assert!(
                    tokio::time::timeout(Duration::from_millis(30), fake.listener.accept())
                        .await
                        .is_err(),
                    "scoped CLI reached socket"
                );
            }
        }
    }
}

#[tokio::test]
async fn ordinary_owner_and_both_scoped_memory_routes_keep_their_authentication() {
    for (credential, field, key, method, args) in [
        (
            None,
            "token",
            "a".repeat(64),
            "protocol.catalog",
            vec!["catalog"],
        ),
        (
            Some("PULT_MEMORY_KEY"),
            "memory",
            format!("mem_{}", "b".repeat(64)),
            "memory.list",
            vec!["memory", "list"],
        ),
        (
            Some("PULT_MEMORY_TURN_KEY"),
            "memoryTurn",
            format!("mt_{}", "c".repeat(64)),
            "memory.list",
            vec!["memory", "list"],
        ),
    ] {
        let fake = Fake::new();
        if credential.is_some() {
            poison(&fake, "config.json");
            poison(&fake, "run/token");
        }
        let mut c = fake.command(&args);
        if let Some(credential) = credential {
            c.env(credential, &key);
        }
        let peer = tokio::spawn(async move {
            let (socket, _) = fake.listener.accept().await.unwrap();
            let mut reader = BufReader::new(socket);
            let hello = frame(&mut reader).await;
            assert_eq!(hello[field], key);
            for forbidden in ["token", "memory", "memoryTurn", "ask", "runtime"] {
                if forbidden != field {
                    assert!(hello.get(forbidden).is_none());
                }
            }
            send(
                &mut reader,
                json!({"type":"hello_ok","protocol":1,"capabilities":{"memoryWrite":false}}),
            )
            .await;
            let request = frame(&mut reader).await;
            assert_eq!(request["method"], method);
            send(
                &mut reader,
                json!({"id":request["id"],"result":{"controlled":true}}),
            )
            .await;
        });
        let out = output(c).await;
        tokio::time::timeout(BOUND, peer).await.unwrap().unwrap();
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stderr.is_empty());
        assert_eq!(out.stdout, b"{\"controlled\":true}\n");
    }
}

#[tokio::test]
async fn harmless_version_help_and_skill_keep_working_with_empty_helper_keys() {
    for arg in ["version", "--version", "-v", "--help", "--skill"] {
        let mut c = command(&["--home", "relative-invalid-home", arg]);
        for key in KEYS {
            c.env(key, "");
        }
        let out = output(c).await;
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stderr.is_empty());
        assert!(!out.stdout.is_empty());
    }
}
