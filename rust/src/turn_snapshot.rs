//! Settings captured from a trusted session before an asynchronous turn starts.
use crate::session_model::{self, Record};
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SessionKey {
    pub name: String,
    pub created_at: String,
}

impl SessionKey {
    pub fn validate(&self) -> Result<()> {
        ensure!(session_model::is_name(&self.name), "invalid session name");
        ensure!(
            !self.created_at.is_empty()
                && self.created_at.len() <= 128
                && !self.created_at.chars().any(char::is_control),
            "session creation identity must be nonempty, control-free and at most 128 bytes"
        );
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Provider {
    Claude,
    Codex,
    Zcode,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Zcode => "zcode",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Approval {
    ReadOnly,
    #[default]
    Ask,
    Workspace,
    Full,
    Inherit,
}

impl Approval {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::Ask => "ask",
            Self::Workspace => "workspace",
            Self::Full => "full",
            Self::Inherit => "inherit",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ServiceTier {
    Default,
    Fast,
}

impl ServiceTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Fast => "fast",
        }
    }
}

/// Node treats an absent `headed` field and `headed: false` as headless.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BrowserSettings {
    #[serde(default)]
    pub headed: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TurnSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<ServiceTier>,
    pub approval: Approval,
    pub browser: Option<BrowserSettings>,
}

impl TurnSettings {
    pub fn validate(&self, provider: Provider) -> Result<()> {
        ensure!(
            self.approval != Approval::Inherit || provider == Provider::Claude,
            "inherit approval is supported only by Claude"
        );
        ensure!(
            self.service_tier.is_none() || provider == Provider::Codex,
            "service tier is supported only by Codex"
        );
        if let Some(model) = &self.model {
            ensure!(valid_model(model), "invalid turn model");
        }
        if let Some(effort) = &self.effort {
            ensure!(valid_effort(effort), "invalid turn effort");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnSnapshot {
    pub key: SessionKey,
    pub provider: Provider,
    pub cwd: PathBuf,
    pub settings: TurnSettings,
}

impl TurnSnapshot {
    pub fn validate(&self) -> Result<()> {
        self.key.validate()?;
        ensure!(self.cwd.is_absolute(), "turn directory must be absolute");
        let cwd = self
            .cwd
            .to_str()
            .context("turn directory must be valid UTF-8")?;
        ensure!(cwd.len() <= 4096, "turn directory exceeds 4096 bytes");
        ensure!(!cwd.as_bytes().contains(&0), "turn directory contains NUL");
        self.settings.validate(self.provider)
    }
}

impl TryFrom<&Record> for TurnSnapshot {
    type Error = anyhow::Error;

    fn try_from(record: &Record) -> Result<Self> {
        let provider = match required_string(record, "provider")?.as_str() {
            "claude" => Provider::Claude,
            "codex" => Provider::Codex,
            "zcode" => Provider::Zcode,
            _ => bail!("invalid turn provider"),
        };
        let approval = match optional_string(record, "approval")?.as_deref() {
            None | Some("ask") => Approval::Ask,
            Some("read-only") => Approval::ReadOnly,
            Some("workspace") => Approval::Workspace,
            Some("full") => Approval::Full,
            Some("inherit") => Approval::Inherit,
            _ => bail!("invalid turn approval"),
        };
        let service_tier = match optional_string(record, "serviceTier")?.as_deref() {
            None => None,
            Some("default") => Some(ServiceTier::Default),
            Some("fast") => Some(ServiceTier::Fast),
            _ => bail!("invalid turn service tier"),
        };
        let browser = match record.get("browser") {
            None => None,
            Some(raw) => {
                let text = raw.get().trim();
                if text == "null" {
                    None
                } else {
                    ensure!(
                        text.starts_with('{'),
                        "turn browser must be an object or null"
                    );
                    Some(
                        serde_json::from_str::<BrowserSettings>(text)
                            .context("invalid turn browser settings")?,
                    )
                }
            }
        };
        let snapshot = Self {
            key: SessionKey {
                name: required_string(record, "name")?,
                created_at: required_string(record, "createdAt")?,
            },
            provider,
            cwd: PathBuf::from(required_string(record, "cwd")?),
            settings: TurnSettings {
                model: optional_string(record, "model")?,
                effort: optional_string(record, "effort")?,
                service_tier,
                approval,
                browser,
            },
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
}

fn optional_string(record: &Record, field: &str) -> Result<Option<String>> {
    record
        .get(field)
        .map(|raw| serde_json::from_str::<String>(raw.get()))
        .transpose()
        .with_context(|| format!("turn {field} must be a valid Unicode string"))
}

fn required_string(record: &Record, field: &str) -> Result<String> {
    optional_string(record, field)?
        .filter(|value| !value.is_empty())
        .with_context(|| format!("turn {field} is required"))
}

// Match MODEL_RE and EFFORT_RE in src/sessions/settings.ts using ASCII bytes.
fn valid_model(model: &str) -> bool {
    let bytes = model.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/[]-".contains(byte))
}

fn valid_effort(effort: &str) -> bool {
    let bytes = effort.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 16
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, value::to_raw_value};

    fn record() -> Record {
        let mut record = Record::default();
        record.set_string("name", "chat");
        record.set_string("createdAt", "2026-11-11T17:00:00.000Z");
        record.set_string("provider", "codex");
        record.set_string("cwd", "/projects/пульт");
        record
    }

    #[test]
    fn captures_owned_settings_and_preserves_record_metadata() {
        let mut record = record();
        record.set_string("model", "vendor/gpt-model[fast]:latest");
        record.set_string("effort", "xhigh");
        record.set_string("approval", "full");
        record.set_string("serviceTier", "fast");
        record.set_raw("browser", to_raw_value(&json!({"headed":true})).unwrap());
        record.set_raw(
            "futureMetadata",
            to_raw_value(&json!({"keep":"🌊"})).unwrap(),
        );
        let original = record.raw().unwrap();
        let snapshot = TurnSnapshot::try_from(&record).unwrap();
        assert_eq!(record.raw().unwrap().get(), original.get());
        assert_eq!(snapshot.provider, Provider::Codex);
        assert_eq!(snapshot.cwd, PathBuf::from("/projects/пульт"));
        assert_eq!(
            snapshot.settings.model.as_deref(),
            Some("vendor/gpt-model[fast]:latest")
        );
        assert_eq!(snapshot.settings.effort.as_deref(), Some("xhigh"));
        assert_eq!(snapshot.settings.approval, Approval::Full);
        assert_eq!(snapshot.settings.service_tier, Some(ServiceTier::Fast));
        assert_eq!(
            snapshot.settings.browser,
            Some(BrowserSettings { headed: true })
        );
        record.set_string("model", "next-model");
        record.set_string("approval", "read-only");
        assert_eq!(snapshot.settings.approval, Approval::Full);
        assert_eq!(
            snapshot.settings.model.as_deref(),
            Some("vendor/gpt-model[fast]:latest")
        );
        assert_ne!(snapshot, TurnSnapshot::try_from(&record).unwrap());
    }

    #[test]
    fn missing_optional_settings_use_explicit_ask_and_no_browser() {
        let snapshot = TurnSnapshot::try_from(&record()).unwrap();
        assert_eq!(snapshot.settings, TurnSettings::default());
        assert_eq!(snapshot.settings.approval.as_str(), "ask");
        assert_eq!(snapshot.provider.as_str(), "codex");
    }

    #[test]
    fn browser_absent_false_headed_and_null_match_normalized_node_meaning() {
        let mut record = record();
        for input in [json!({}), json!({"headed":false})] {
            record.set_raw("browser", to_raw_value(&input).unwrap());
            assert_eq!(
                TurnSnapshot::try_from(&record).unwrap().settings.browser,
                Some(BrowserSettings { headed: false })
            );
        }
        record.set_raw("browser", to_raw_value(&json!(null)).unwrap());
        assert_eq!(
            TurnSnapshot::try_from(&record).unwrap().settings.browser,
            None
        );
        for input in [
            json!(true),
            json!(false),
            json!([]),
            json!({"headed":"yes"}),
            json!({"headed":null}),
            json!({"command":"unsafe"}),
        ] {
            record.set_raw("browser", to_raw_value(&input).unwrap());
            assert!(TurnSnapshot::try_from(&record).is_err(), "{input}");
        }
    }

    #[test]
    fn malformed_required_identity_or_directory_never_becomes_a_snapshot() {
        for field in ["name", "createdAt", "provider", "cwd"] {
            let mut record = record();
            record.remove(field);
            assert!(TurnSnapshot::try_from(&record).is_err(), "missing {field}");
        }
        for (field, value) in [
            ("name", "BAD"),
            ("createdAt", ""),
            ("createdAt", "time\n"),
            ("provider", "future"),
            ("cwd", "relative"),
            ("cwd", "/path\0tail"),
        ] {
            let mut record = record();
            record.set_string(field, value);
            assert!(TurnSnapshot::try_from(&record).is_err(), "invalid {field}");
        }
    }

    #[test]
    fn invalid_unicode_and_wrong_types_fail_in_optional_and_required_fields() {
        for field in [
            "name",
            "createdAt",
            "provider",
            "cwd",
            "model",
            "effort",
            "approval",
            "serviceTier",
        ] {
            for raw in [r#""\ud800""#, "null", "false", "17", "{}"] {
                let mut record = record();
                record.set_raw(
                    field,
                    serde_json::value::RawValue::from_string(raw.into()).unwrap(),
                );
                assert!(TurnSnapshot::try_from(&record).is_err(), "{field}={raw}");
            }
        }
    }

    #[test]
    fn approval_and_service_tier_obey_provider_contract() {
        for provider in ["claude", "codex", "zcode"] {
            for approval in ["read-only", "ask", "workspace", "full", "inherit"] {
                let mut record = record();
                record.set_string("provider", provider);
                record.set_string("approval", approval);
                assert_eq!(
                    TurnSnapshot::try_from(&record).is_ok(),
                    approval != "inherit" || provider == "claude"
                );
            }
            for tier in ["default", "fast"] {
                let mut record = record();
                record.set_string("provider", provider);
                record.set_string("serviceTier", tier);
                let result = TurnSnapshot::try_from(&record);
                assert_eq!(result.is_ok(), provider == "codex");
                if let Ok(snapshot) = result {
                    assert_eq!(snapshot.settings.service_tier.unwrap().as_str(), tier);
                }
            }
        }
        for (field, value) in [("approval", "future"), ("serviceTier", "priority")] {
            let mut record = record();
            record.set_string(field, value);
            assert!(TurnSnapshot::try_from(&record).is_err());
        }
    }

    #[test]
    fn model_and_effort_follow_node_ascii_grammar_and_lengths() {
        for valid in [
            "gpt-6.1",
            "vendor/model:version[fast]",
            "A",
            &"x".repeat(100),
        ] {
            assert!(valid_model(valid), "{valid}");
        }
        for invalid in [
            "",
            "-model",
            "model name",
            "model\n",
            "модель",
            "model\\name",
            "model\"",
            &"x".repeat(101),
        ] {
            assert!(!valid_model(invalid), "{invalid}");
        }
        for valid in ["low", "xhigh", "effort-2", &"x".repeat(16)] {
            assert!(valid_effort(valid), "{valid}");
        }
        for invalid in [
            "",
            "1high",
            "High",
            "x_high",
            "high\n",
            "усилие",
            &"x".repeat(17),
        ] {
            assert!(!valid_effort(invalid), "{invalid}");
        }
        for (field, value) in [("model", "model with spaces"), ("effort", "HIGH")] {
            let mut record = record();
            record.set_string(field, value);
            assert!(TurnSnapshot::try_from(&record).is_err());
        }
    }

    #[test]
    fn identity_and_directory_limits_count_utf8_bytes() {
        let mut record = record();
        record.set_string("createdAt", &"я".repeat(64));
        record.set_string("cwd", &format!("/{}x", "я".repeat(2047)));
        assert!(TurnSnapshot::try_from(&record).is_ok());
        record.set_string("createdAt", &"я".repeat(65));
        assert!(TurnSnapshot::try_from(&record).is_err());
        record.set_string("createdAt", "time");
        record.set_string("cwd", &format!("/{}", "я".repeat(2048)));
        assert!(TurnSnapshot::try_from(&record).is_err());
        let mut snapshot = TurnSnapshot::try_from(&self::record()).unwrap();
        use std::os::unix::ffi::OsStringExt;
        snapshot.cwd = std::ffi::OsString::from_vec(vec![b'/', 0xff]).into();
        assert!(snapshot.validate().is_err());
    }

    #[test]
    fn direct_construction_is_validated_before_a_turn_can_reserve_it() {
        let mut snapshot = TurnSnapshot::try_from(&record()).unwrap();
        snapshot.key.name = "bad/name".into();
        assert!(snapshot.validate().is_err());
        snapshot.key.name = "chat".into();
        snapshot.settings.model = Some("invalid model".into());
        assert!(snapshot.validate().is_err());
        snapshot.settings.model = None;
        snapshot.cwd = "relative".into();
        assert!(snapshot.validate().is_err());
    }
}
