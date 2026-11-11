//! Child environment is constructed, never inherited and then blacklisted.
use anyhow::{Result, ensure};
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    os::unix::ffi::OsStrExt,
};
pub type Environment = BTreeMap<OsString, OsString>;
const BASE: &[&str] = &["HOME", "USER", "PATH", "LANG", "TERM", "TMPDIR"];
const EXPLICIT: &[&str] = &[
    "ALL_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "PULT_MEMORY_KEY",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "ZCODE_PRODUCTION_BASE_URL",
    "ZCODE_TEST_BASE_URL",
    "ZCODE_APP_VERSION",
];
const FALLBACK: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
pub fn from_parent(parent: &Environment, overrides: &Environment) -> Result<Environment> {
    let mut env = Environment::new();
    for key in BASE {
        if let Some(value) = parent.get(OsStr::new(key)).filter(|v| !v.is_empty()) {
            env.insert(OsString::from(key), value.clone());
        }
    }
    env.entry("PATH".into()).or_insert_with(|| FALLBACK.into());
    for (key, value) in overrides {
        env.insert(key.clone(), value.clone());
    }
    validate(&env)?;
    Ok(env)
}
pub fn validate(env: &Environment) -> Result<()> {
    let mut bytes = 0usize;
    ensure!(
        env.get(OsStr::new("PATH")).is_some_and(|v| !v.is_empty()),
        "worker environment requires PATH"
    );
    for (key, value) in env {
        let name = key
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("invalid environment key"))?;
        ensure!(
            BASE.contains(&name) || EXPLICIT.contains(&name),
            "environment key is not approved"
        );
        ensure!(
            !value.as_bytes().contains(&0),
            "environment value contains NUL"
        );
        bytes = bytes
            .checked_add(key.len() + value.len() + 2)
            .ok_or_else(|| anyhow::anyhow!("environment exceeds budget"))?;
        ensure!(bytes <= 65536, "environment exceeds budget");
        if name == "PULT_MEMORY_KEY" {
            let key = value.as_bytes();
            ensure!(
                key.len() == 68
                    && key.starts_with(b"mem_")
                    && key[4..]
                        .iter()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)),
                "invalid scoped memory key"
            );
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn map(values: &[(&str, &str)]) -> Environment {
        values
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }
    #[test]
    fn ambient_provider_tokens_loader_hooks_and_memory_authority_are_not_inherited() {
        let parent = map(&[
            ("HOME", "/tmp/home"),
            ("PATH", "/usr/bin:/bin"),
            ("ANTHROPIC_API_KEY", "SECRET"),
            ("ANTHROPIC_BASE_URL", "https://other"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "other"),
            ("PULT_MEMORY_KEY", "mem_ambient"),
            ("NODE_OPTIONS", "--require=other"),
            ("DYLD_INSERT_LIBRARIES", "other"),
            ("LD_PRELOAD", "other"),
            ("PYTHONPATH", "other"),
            ("HTTPS_PROXY", "ambient"),
            ("ALL_PROXY", "ambient-wss"),
        ]);
        assert_eq!(
            from_parent(&parent, &Environment::new()).unwrap(),
            map(&[("HOME", "/tmp/home"), ("PATH", "/usr/bin:/bin")])
        );
    }
    #[test]
    fn only_explicit_scoped_memory_and_network_profiles_are_added() {
        let key = format!("mem_{}", "a".repeat(64));
        let override_env = map(&[
            ("HTTPS_PROXY", "http://127.0.0.1:1234"),
            ("NO_PROXY", "localhost"),
            ("PULT_MEMORY_KEY", &key),
        ]);
        let env = from_parent(&Environment::new(), &override_env).unwrap();
        assert_eq!(env.get(OsStr::new("PATH")).unwrap(), FALLBACK);
        assert_eq!(
            env.get(OsStr::new("PULT_MEMORY_KEY")).unwrap(),
            &OsString::from(key)
        );
        assert!(from_parent(&Environment::new(), &map(&[("PULT_OWNER_TOKEN", "secret")])).is_err());
    }
    #[test]
    fn invalid_data_is_rejected_without_echoing_it() {
        for overrides in [
            map(&[("PULT_MEMORY_KEY", "secret")]),
            map(&[("PATH", "")]),
            map(&[("HOME", "secret\0value")]),
            map(&[("PATH", &"x".repeat(65537))]),
        ] {
            let error = from_parent(&Environment::new(), &overrides)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("secret"));
        }
    }
}
