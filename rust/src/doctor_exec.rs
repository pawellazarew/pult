//! Closed diagnostic authority; children are joined even when cancelled.
use crate::cli_owned_query::{self, Kind};
use anyhow::{Result, anyhow, ensure};
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::Arc};
use tokio::{
    process::Command,
    sync::{Semaphore, watch},
};
#[derive(Clone)]
pub(super) struct Executor {
    pub cancel: watch::Receiver<bool>,
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
            slots: Arc::new(Semaphore::new(8)),
            env,
        })
    }
    pub async fn run(&self, diagnostic: DiagnosticCommand) -> Result<Output> {
        let _slot = self
            .slots
            .acquire()
            .await
            .map_err(|_| anyhow!("doctor executor unavailable"))?;
        ensure!(!*self.cancel.borrow(), "doctor interrupted");
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
        ensure!(!cleanup_failed, "doctor child cleanup is unconfirmed");
        ensure!(!was_cancelled, "doctor interrupted");
        Ok(match result {
            Ok(r) => Output {
                code: if r.failure.is_some() {
                    None
                } else {
                    r.status.code()
                },
                stdout: String::from_utf8_lossy(&r.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&r.stderr).into_owned(),
            },
            Err(e) => Output {
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
