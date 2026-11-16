//! Closed diagnostic authority; reports require confirmed child/reader cleanup.
use crate::cli_owned_query::{self, Kind};
use anyhow::{Result, anyhow, ensure};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    process::Command,
    sync::{Semaphore, watch},
};
#[derive(Clone)]
pub(super) struct Executor {
    pub cancel: watch::Receiver<bool>,
    cleanup_fault: Arc<AtomicBool>,
    schema_retained: Arc<AtomicBool>,
    slots: Arc<Semaphore>,
    pub env: BTreeMap<OsString, OsString>,
}
pub(super) enum DiagnosticCommand {
    Shell {
        shell: PathBuf,
        home: PathBuf,
        user: String,
    },
    Version {
        bin: PathBuf,
        node: bool,
    },
    ClaudeAuth(PathBuf),
    CodexLogin(PathBuf),
    Schema {
        bin: PathBuf,
        out: PathBuf,
    },
    SavedNode(PathBuf),
    Linger {
        bin: PathBuf,
        user: String,
    },
    Trace {
        bin: PathBuf,
        proxy: Option<String>,
        url: &'static str,
        provider: &'static str,
    },
}
pub(super) struct Output {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub limited: bool,
}
pub(super) async fn cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}
impl Executor {
    pub fn new(cancel: watch::Receiver<bool>) -> Result<Self> {
        let mut env = BTreeMap::new();
        for name in ["HOME", "USER", "PATH", "LANG", "TERM", "TMPDIR"] {
            if let Some(v) = std::env::var_os(name).filter(|v| !v.is_empty()) {
                env.insert(name.into(), v);
            }
        }
        env.entry("PATH".into()).or_insert_with(|| {
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()
        });
        ensure!(
            env.iter()
                .map(|(k, v): (&OsString, &OsString)| k.len() + v.len() + 2)
                .sum::<usize>()
                <= 65536,
            "doctor environment exceeds limit"
        );
        Ok(Self {
            cancel,
            cleanup_fault: Arc::new(AtomicBool::new(false)),
            schema_retained: Arc::new(AtomicBool::new(false)),
            slots: Arc::new(Semaphore::new(8)),
            env,
        })
    }
    pub fn mark_cleanup_fault(&self) {
        self.cleanup_fault.store(true, Ordering::Release);
    }
    pub fn mark_schema_retained(&self) {
        self.schema_retained.store(true, Ordering::Release);
    }
    pub fn schema_retained(&self) -> bool {
        self.schema_retained.load(Ordering::Acquire)
    }
    pub fn cleanup_failed(&self) -> bool {
        self.cleanup_fault.load(Ordering::Acquire)
    }
    pub async fn run(&self, diagnostic: DiagnosticCommand) -> Result<Output> {
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| anyhow!("doctor executor unavailable"))?;
        ensure!(
            !self.cleanup_failed(),
            "doctor child cleanup is unconfirmed"
        );
        ensure!(!*self.cancel.borrow(), "doctor interrupted");
        // Closed fault selector for private actual-CLI lifecycle tests. The real
        // owner still joins first; this injects uncertainty classification only.
        let injected_cleanup_fault = std::env::var("PULT_TEST").as_deref() == Ok("1")
            && std::env::var("PULT_TEST_DOCTOR_FAULT").as_deref() == Ok("cleanup-schema")
            && matches!(&diagnostic, DiagnosticCommand::Schema { .. });
        let (bin, args, kind, provider) = match diagnostic {
            DiagnosticCommand::Shell { shell, home, user } => (
                PathBuf::from("/usr/bin/env"),
                vec![
                    "-i".into(),
                    format!("HOME={}", home.display()),
                    format!("USER={user}"),
                    "PATH=/usr/bin:/bin:/usr/sbin:/sbin".into(),
                    shell.display().to_string(),
                    "-ilc".into(),
                    "env -0".into(),
                ],
                Kind::DoctorShell,
                None,
            ),
            DiagnosticCommand::Version { bin, node } => (
                bin,
                vec![if node { "-v" } else { "--version" }.into()],
                Kind::DoctorVersion,
                None,
            ),
            DiagnosticCommand::ClaudeAuth(bin) => (
                bin,
                vec!["auth".into(), "status".into(), "--json".into()],
                Kind::DoctorAuth,
                None,
            ),
            DiagnosticCommand::CodexLogin(bin) => (
                bin,
                vec!["login".into(), "status".into()],
                Kind::DoctorAuth,
                None,
            ),
            DiagnosticCommand::Schema { bin, out } => (
                bin,
                vec![
                    "app-server".into(),
                    "generate-json-schema".into(),
                    "--out".into(),
                    out.display().to_string(),
                ],
                Kind::DoctorSchema,
                None,
            ),
            DiagnosticCommand::SavedNode(bin) => {
                (bin, vec!["-v".into()], Kind::DoctorSavedNode, None)
            }
            DiagnosticCommand::Linger { bin, user } => (
                bin,
                vec!["show-user".into(), user, "-p".into(), "Linger".into()],
                Kind::Service,
                None,
            ),
            DiagnosticCommand::Trace {
                bin,
                proxy,
                url,
                provider,
            } => (
                bin,
                vec![
                    "-q".into(),
                    "-s".into(),
                    "-m".into(),
                    "8".into(),
                    "-x".into(),
                    proxy.unwrap_or_default(),
                    url.into(),
                ],
                Kind::DoctorNetwork,
                Some(provider),
            ),
        };
        let mut command = Command::new(bin);
        command.args(args).env_clear().envs(&self.env);
        if let Some(provider) = provider
            && std::env::var("PULT_TEST").as_deref() == Ok("1")
        {
            command.env("PULT_DIAGNOSTIC_PROVIDER", provider);
        }
        let mut was_cancelled = false;
        let mut cleanup_failed = false;
        let mut rx = self.cancel.clone();
        let result = cli_owned_query::run_with_cancel(
            &mut command,
            kind,
            &mut was_cancelled,
            &mut cleanup_failed,
            cancelled(&mut rx),
        )
        .await;
        if cleanup_failed || injected_cleanup_fault {
            self.mark_cleanup_fault();
        }
        ensure!(
            !cleanup_failed && !injected_cleanup_fault,
            "doctor child cleanup is unconfirmed"
        );
        ensure!(!was_cancelled, "doctor interrupted");
        Ok(match result {
            Ok(r) => project(r),
            Err(e) => Output {
                limited: matches!(e, cli_owned_query::Error::Overflow),
                code: None,
                stdout: String::new(),
                stderr: match e {
                    cli_owned_query::Error::Timeout => "diagnostic command timed out",
                    cli_owned_query::Error::Overflow => "diagnostic output exceeds 4 MiB limit",
                    _ => "diagnostic command unavailable",
                }
                .into(),
            },
        })
    }
}

pub(super) fn project(r: cli_owned_query::Output) -> Output {
    Output {
        limited: matches!(r.failure, Some(cli_owned_query::Error::Overflow)),
        code: if r.failure.is_some() {
            None
        } else {
            r.status.code()
        },
        stdout: if r
            .failure
            .is_some_and(|e| !matches!(e, cli_owned_query::Error::Timeout))
        {
            String::new()
        } else {
            String::from_utf8_lossy(&r.stdout).into_owned()
        },
        stderr: String::from_utf8_lossy(&r.stderr).into_owned(),
    }
}
