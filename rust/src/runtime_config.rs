//! Pure normalization of the current Node config validators. No IO, environment,
//! network probes, process launch or settings writes occur here. Preserve the
//! host's original raw document for future surgical writes: to_file normalizes
//! known fields and deliberately does not merge unknown user configuration.
//!
//! Input is an already-decoded serde Value. A file decoder MUST reject invalid
//! JSON/unpaired UTF-16 surrogates and refuse runtime admission on decode error;
//! do not turn decoding failure into defaults/off. Missing-file policy belongs
//! to the host. Warnings contain static codes/known field paths, never raw values.
//! New-session defaults exclude Full/Inherit for every provider; live settings,
//! serviceTier and the separate recent-choice file are outside this parser.
use crate::network_guard;
use crate::turn_snapshot::Provider;
use serde_json::{Value, json};
use std::fmt;

pub use network_guard::{GuardMode, Mode as NetMode, Profile as NetworkProfile};
pub const DEFAULT_UPDATE_URL: &str =
    "https://github.com/pawellazarew/pult/releases/latest/download/latest.json";
pub const MCP_SERVERS_MAX: usize = 32;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WarningCode {
    InvalidRoot,
    InvalidType,
    InvalidValue,
    EmptyProxy,
    AutoWithoutProxy,
    RequiredProxyMissing,
    Filtered,
    GuardClosed,
    GuardEmptyAllow,
    LegacyGuardOverridden,
    UnsafeDefault,
    BrowserBlocked,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Warning {
    pub code: WarningCode,
    pub field: String,
}
fn warn(out: &mut Vec<Warning>, code: WarningCode, field: impl Into<String>) {
    out.push(Warning {
        code,
        field: field.into(),
    });
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Language {
    Auto,
    Ru,
    En,
}
impl Language {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Ru => "ru",
            Self::En => "en",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NetworkProfiles {
    pub claude: NetworkProfile,
    pub codex: NetworkProfile,
    pub opencode: NetworkProfile,
    pub zcode: NetworkProfile,
}
impl Default for NetworkProfiles {
    fn default() -> Self {
        let profile = || NetworkProfile {
            mode: NetMode::Off,
            proxy: String::new(),
            no_proxy: vec![],
        };
        Self {
            claude: profile(),
            codex: profile(),
            opencode: profile(),
            zcode: profile(),
        }
    }
}
impl NetworkProfiles {
    pub fn for_provider(&self, provider: Provider) -> &NetworkProfile {
        match provider {
            Provider::Claude => &self.claude,
            Provider::Codex => &self.codex,
            Provider::Zcode => &self.zcode,
        }
    }
}
#[derive(Clone, Eq, PartialEq)]
pub struct GuardRule {
    pub mode: GuardMode,
    pub countries: Vec<String>,
}
impl fmt::Debug for GuardRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GuardRule")
            .field("mode", &self.mode)
            .field("country_count", &self.countries.len())
            .finish()
    }
}
impl Default for GuardRule {
    fn default() -> Self {
        Self {
            mode: GuardMode::Deny,
            countries: network_guard::DEFAULT_GUARD_COUNTRIES
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
    pub fn as_network_rule(&self) -> network_guard::GuardRule {
        network_guard::GuardRule {
            mode: self.mode,
            countries: self.countries.clone(),
        }
    }
    fn value(&self) -> Value {
        json!({"mode":match self.mode {GuardMode::Deny=>"deny",GuardMode::Allow=>"allow"},"countries":self.countries})
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefaultApproval {
    ReadOnly,
    Ask,
    Workspace,
}
impl DefaultApproval {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::Ask => "ask",
            Self::Workspace => "workspace",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionMode {
    Turn,
    Warm,
}
impl SessionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Warm => "warm",
        }
    }
}
#[derive(Clone, Default, Eq, PartialEq)]
pub struct ProviderDefaults {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub approval: Option<DefaultApproval>,
    pub mode: Option<SessionMode>,
    pub browser: Option<bool>,
    pub worktree: Option<bool>,
}
impl fmt::Debug for ProviderDefaults {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderDefaults")
            .field("has_model", &self.model.is_some())
            .field("has_effort", &self.effort.is_some())
            .field("approval", &self.approval)
            .field("mode", &self.mode)
            .field("browser", &self.browser)
            .field("worktree", &self.worktree)
            .finish()
    }
}
impl ProviderDefaults {
    pub fn value(&self) -> Value {
        let mut value = json!({});
        if let Some(model) = &self.model {
            value["model"] = json!(model);
        }
        if let Some(effort) = &self.effort {
            value["effort"] = json!(effort);
        }
        if let Some(approval) = self.approval {
            value["approval"] = json!(approval.as_str());
        }
        if let Some(mode) = self.mode {
            value["mode"] = json!(mode.as_str());
        }
        if let Some(browser) = self.browser {
            value["browser"] = json!(browser);
        }
        if let Some(worktree) = self.worktree {
            value["worktree"] = json!(worktree);
        }
        value
    }
}
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SessionDefaults {
    pub provider: Option<Provider>,
    pub claude: ProviderDefaults,
    pub codex: ProviderDefaults,
    pub zcode: ProviderDefaults,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NewSession {
    pub remember_last: bool,
    pub defaults: SessionDefaults,
}
impl Default for NewSession {
    fn default() -> Self {
        Self {
            remember_last: true,
            defaults: SessionDefaults::default(),
        }
    }
}
impl NewSession {
    pub fn value(&self) -> Value {
        let mut defaults = json!({"claude":self.defaults.claude.value(),"codex":self.defaults.codex.value(),"zcode":self.defaults.zcode.value()});
        if let Some(provider) = self.defaults.provider {
            defaults["provider"] = json!(provider.as_str());
        }
        json!({"rememberLast":self.remember_last,"defaults":defaults})
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct NotifySettings {
    pub min_turn_seconds: f64,
    pub sound: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub struct WatchdogSettings {
    pub silence_minutes: f64,
}
#[derive(Clone, Eq, PartialEq)]
pub struct McpSettings {
    pub servers: Vec<String>,
}
impl fmt::Debug for McpSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpSettings")
            .field("server_count", &self.servers.len())
            .finish()
    }
}
#[derive(Clone, Eq, PartialEq)]
pub struct UpdateSettings {
    pub check: bool,
    pub url: String,
}
impl fmt::Debug for UpdateSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UpdateSettings")
            .field("check", &self.check)
            .field("url_bytes", &self.url.len())
            .finish()
    }
}
#[derive(Clone, Eq, PartialEq)]
pub struct DiskSettings {
    pub threshold_gb: u64,
    pub prompt: Option<String>,
}
impl Default for DiskSettings {
    fn default() -> Self {
        Self {
            threshold_gb: 6,
            prompt: None,
        }
    }
}
impl fmt::Debug for DiskSettings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DiskSettings")
            .field("threshold_gb", &self.threshold_gb)
            .field("has_prompt", &self.prompt.is_some())
            .finish()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RetentionDays {
    Seven,
    Thirty,
    Ninety,
    Forever,
}
impl RetentionDays {
    fn value(self) -> Value {
        match self {
            Self::Seven => json!(7),
            Self::Thirty => json!(30),
            Self::Ninety => json!(90),
            Self::Forever => Value::Null,
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttachmentSettings {
    pub retention_days: RetentionDays,
}
#[derive(Clone, PartialEq)]
pub struct RuntimeConfig {
    pub language: Language,
    pub network: NetworkProfiles,
    pub guard: GuardRule,
    pub warm_ttl_ms: f64,
    pub perm_timeout_ms: f64,
    pub subagent_grace_ms: f64,
    pub background_max_ms: f64,
    pub auto_title: bool,
    pub notify: NotifySettings,
    pub notify_command: Option<String>,
    pub watchdog: WatchdogSettings,
    pub mcp: McpSettings,
    pub updates: UpdateSettings,
    pub new_session: NewSession,
    pub disk: DiskSettings,
    pub attachments: AttachmentSettings,
}
impl fmt::Debug for RuntimeConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RuntimeConfig")
            .field("language", &self.language)
            .field("network", &self.network)
            .field("guard", &self.guard)
            .field("new_session", &self.new_session)
            .field("has_notify_command", &self.notify_command.is_some())
            .field("mcp", &self.mcp)
            .field("updates", &self.updates)
            .field("disk", &self.disk)
            .finish()
    }
}
impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            language: Language::Auto,
            network: NetworkProfiles::default(),
            guard: GuardRule::default(),
            warm_ttl_ms: 1_200_000.0,
            perm_timeout_ms: 600_000.0,
            subagent_grace_ms: 30_000.0,
            background_max_ms: 10_800_000.0,
            auto_title: true,
            notify: NotifySettings {
                min_turn_seconds: 20.0,
                sound: true,
            },
            notify_command: None,
            watchdog: WatchdogSettings {
                silence_minutes: 10.0,
            },
            mcp: McpSettings { servers: vec![] },
            updates: UpdateSettings {
                check: true,
                url: DEFAULT_UPDATE_URL.into(),
            },
            new_session: NewSession::default(),
            disk: DiskSettings::default(),
            attachments: AttachmentSettings {
                retention_days: RetentionDays::Thirty,
            },
        }
    }
}
fn jsnum(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    serde_json::from_str(ryu_js::Buffer::new().format_finite(value)).unwrap_or(Value::Null)
}
fn profile_value(profile: &NetworkProfile) -> Value {
    let mut value = json!({"mode":match profile.mode {NetMode::Off=>"off",NetMode::Auto=>"auto",NetMode::Required=>"required"},"proxy":profile.proxy});
    if !profile.no_proxy.is_empty() {
        value["noProxy"] = json!(profile.no_proxy);
    }
    value
}
impl RuntimeConfig {
    /// Node configToFile shape. This is not a surgical update of a raw document.
    pub fn to_file(&self) -> Value {
        json!({"version":1,"language":self.language.as_str(),"network":{"claude":profile_value(&self.network.claude),"codex":profile_value(&self.network.codex),"opencode":profile_value(&self.network.opencode),"zcode":profile_value(&self.network.zcode),"guard":self.guard.value()},"warmTtlMs":jsnum(self.warm_ttl_ms),"permTimeoutMs":jsnum(self.perm_timeout_ms),"subagentGraceMs":jsnum(self.subagent_grace_ms),"backgroundMaxMs":jsnum(self.background_max_ms),"autoTitle":self.auto_title,"notify":{"minTurnSeconds":jsnum(self.notify.min_turn_seconds),"sound":self.notify.sound},"notifyCommand":self.notify_command,"watchdog":{"silenceMinutes":jsnum(self.watchdog.silence_minutes)},"mcp":{"servers":self.mcp.servers},"updates":{"check":self.updates.check,"url":self.updates.url},"newSession":self.new_session.value(),"disk":{"thresholdGb":self.disk.threshold_gb,"prompt":self.disk.prompt},"attachments":{"retentionDays":self.attachments.retention_days.value()}})
    }
}
#[derive(Clone, Debug)]
pub struct Parsed {
    pub config: RuntimeConfig,
    pub warnings: Vec<Warning>,
}
pub fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
fn objectish(value: &Value) -> bool {
    value.is_object() || value.is_array()
}
fn nonnegative(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
#[derive(Clone)]
pub struct NoProxy {
    pub entries: Vec<String>,
    pub rejected: usize,
}
impl fmt::Debug for NoProxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NoProxy")
            .field("entries", &self.entries.len())
            .field("rejected", &self.rejected)
            .finish()
    }
}
pub fn parse_no_proxy(raw: &Value) -> NoProxy {
    let Some(list) = raw.as_array() else {
        return NoProxy {
            entries: vec![],
            rejected: 1,
        };
    };
    let mut out = NoProxy {
        entries: vec![],
        rejected: 0,
    };
    for value in list {
        let s = value.as_str().map(trim).unwrap_or("");
        if s.is_empty() || s.chars().any(|c| js_space(c) || c == ',') {
            out.rejected += 1;
            continue;
        }
        let entry = s
            .strip_prefix("*.")
            .map(|s| format!(".{s}"))
            .unwrap_or_else(|| s.into());
        if !out.entries.contains(&entry) {
            out.entries.push(entry);
        }
    }
    out
}
pub fn parse_mcp_server_names(raw: &Value) -> Option<Vec<String>> {
    let list = raw.as_array()?;
    if list.iter().any(|v| !v.is_string()) {
        return None;
    }
    let mut out = Vec::new();
    for value in list {
        let name = trim(value.as_str()?);
        let b = name.as_bytes();
        if !b.is_empty()
            && b.len() <= 64
            && b[0].is_ascii_alphanumeric()
            && b.iter()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(c))
            && !out.iter().any(|v| v == name)
        {
            out.push(name.into());
            if out.len() == MCP_SERVERS_MAX {
                break;
            }
        }
    }
    Some(out)
}
#[derive(Clone, Debug)]
pub struct ParsedGuard {
    pub rule: GuardRule,
    pub warnings: Vec<Warning>,
}
pub fn parse_guard_lenient(raw: &Value) -> ParsedGuard {
    let mut warnings = vec![];
    let mode = raw
        .get("mode")
        .and_then(Value::as_str)
        .map(|s| trim(s).to_lowercase());
    let mode = match mode.as_deref() {
        Some("deny") => GuardMode::Deny,
        Some("allow") => GuardMode::Allow,
        _ => {
            warn(&mut warnings, WarningCode::GuardClosed, "network.guard");
            return ParsedGuard {
                rule: GuardRule::closed(),
                warnings,
            };
        }
    };
    let Some(countries) = raw
        .as_object()
        .and_then(|o| o.get("countries"))
        .and_then(Value::as_array)
    else {
        warn(&mut warnings, WarningCode::GuardClosed, "network.guard");
        return ParsedGuard {
            rule: GuardRule::closed(),
            warnings,
        };
    };
    let mut out = vec![];
    for country in countries {
        let code = country
            .as_str()
            .map(|s| trim(s).to_uppercase())
            .unwrap_or_default();
        if !network_guard::COUNTRY_CODES.contains(&code.as_str()) {
            warn(
                &mut warnings,
                WarningCode::Filtered,
                "network.guard.countries",
            );
            continue;
        }
        if !out.contains(&code) {
            out.push(code);
        }
    }
    if mode == GuardMode::Allow && out.is_empty() {
        warn(&mut warnings, WarningCode::GuardEmptyAllow, "network.guard");
    }
    ParsedGuard {
        rule: GuardRule {
            mode,
            countries: out,
        },
        warnings,
    }
}
fn model_name(raw: &str) -> bool {
    let b = raw.as_bytes();
    !b.is_empty()
        && b.len() <= 100
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/[]-".contains(c))
}
fn effort_name(raw: &str) -> bool {
    let b = raw.as_bytes();
    !b.is_empty()
        && b.len() <= 16
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}
fn provider_defaults(
    provider: Provider,
    raw: Option<&Value>,
    path: &str,
    warnings: &mut Vec<Warning>,
) -> ProviderDefaults {
    let mut out = ProviderDefaults::default();
    let Some(raw) = raw else {
        return out;
    };
    let Some(values) = raw.as_object() else {
        warn(warnings, WarningCode::InvalidType, path);
        return out;
    };
    for (key, valid, target) in [
        ("model", model_name as fn(&str) -> bool, &mut out.model),
        ("effort", effort_name as fn(&str) -> bool, &mut out.effort),
    ] {
        if let Some(value) = values.get(key) {
            if let Some(text) = value.as_str().filter(|s| valid(s)) {
                *target = Some(text.into());
            } else {
                warn(warnings, WarningCode::InvalidValue, format!("{path}.{key}"));
            }
        }
    }
    if let Some(value) = values.get("approval") {
        out.approval = match value.as_str() {
            Some("read-only") => Some(DefaultApproval::ReadOnly),
            Some("ask") => Some(DefaultApproval::Ask),
            Some("workspace") => Some(DefaultApproval::Workspace),
            Some("full" | "inherit") => {
                warn(
                    warnings,
                    WarningCode::UnsafeDefault,
                    format!("{path}.approval"),
                );
                None
            }
            _ => {
                warn(
                    warnings,
                    WarningCode::InvalidValue,
                    format!("{path}.approval"),
                );
                None
            }
        };
    }
    if let Some(value) = values.get("mode") {
        out.mode = match value.as_str() {
            Some("turn") => Some(SessionMode::Turn),
            Some("warm") => Some(SessionMode::Warm),
            _ => {
                warn(warnings, WarningCode::InvalidValue, format!("{path}.mode"));
                None
            }
        };
    }
    for (key, target) in [
        ("browser", &mut out.browser),
        ("worktree", &mut out.worktree),
    ] {
        if let Some(value) = values.get(key) {
            if let Some(value) = value.as_bool() {
                *target = Some(value);
            } else {
                warn(warnings, WarningCode::InvalidType, format!("{path}.{key}"));
            }
        }
    }
    if out.browser == Some(true)
        && (provider == Provider::Zcode
            || (provider == Provider::Codex && out.approval == Some(DefaultApproval::Workspace)))
    {
        out.browser = None;
        warn(warnings, WarningCode::BrowserBlocked, path);
    }
    out
}
#[derive(Clone, Debug)]
pub struct ParsedNewSession {
    pub value: NewSession,
    pub warnings: Vec<Warning>,
}
/// Lenient config-file parse only. Unknown fields are ignored, as in Node's
/// parseNewSession(..., false); this is not strict settings.set validation.
pub fn parse_new_session(raw: Option<&Value>) -> ParsedNewSession {
    let mut value = NewSession::default();
    let mut warnings = vec![];
    let Some(raw) = raw else {
        return ParsedNewSession { value, warnings };
    };
    let Some(values) = raw.as_object() else {
        warn(&mut warnings, WarningCode::InvalidType, "newSession");
        return ParsedNewSession { value, warnings };
    };
    if let Some(v) = values.get("rememberLast") {
        if let Some(v) = v.as_bool() {
            value.remember_last = v;
        } else {
            warn(
                &mut warnings,
                WarningCode::InvalidType,
                "newSession.rememberLast",
            );
        }
    }
    if let Some(v) = values.get("defaults") {
        if let Some(defaults) = v.as_object() {
            if let Some(p) = defaults.get("provider") {
                value.defaults.provider = match p.as_str() {
                    Some("claude") => Some(Provider::Claude),
                    Some("codex") => Some(Provider::Codex),
                    Some("zcode") => Some(Provider::Zcode),
                    _ => {
                        warn(
                            &mut warnings,
                            WarningCode::InvalidValue,
                            "newSession.defaults.provider",
                        );
                        None
                    }
                };
            }
            value.defaults.claude = provider_defaults(
                Provider::Claude,
                defaults.get("claude"),
                "newSession.defaults.claude",
                &mut warnings,
            );
            value.defaults.codex = provider_defaults(
                Provider::Codex,
                defaults.get("codex"),
                "newSession.defaults.codex",
                &mut warnings,
            );
            value.defaults.zcode = provider_defaults(
                Provider::Zcode,
                defaults.get("zcode"),
                "newSession.defaults.zcode",
                &mut warnings,
            );
        } else {
            warn(
                &mut warnings,
                WarningCode::InvalidType,
                "newSession.defaults",
            );
        }
    }
    ParsedNewSession { value, warnings }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidDisk;
impl fmt::Display for InvalidDisk {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid disk settings")
    }
}
impl std::error::Error for InvalidDisk {}
pub fn parse_disk_settings(raw: &Value) -> Result<DiskSettings, InvalidDisk> {
    let values = raw.as_object().ok_or(InvalidDisk)?;
    if values
        .keys()
        .any(|key| key != "thresholdGb" && key != "prompt")
    {
        return Err(InvalidDisk);
    }
    let threshold = values
        .get("thresholdGb")
        .and_then(Value::as_f64)
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && *n >= 1.0
                && *n <= MAX_SAFE
                && *n * 1e9 <= MAX_SAFE
                && (*n * 1e9).fract() == 0.0
        })
        .ok_or(InvalidDisk)?;
    let prompt = match values.get("prompt") {
        Some(Value::Null) => None,
        Some(Value::String(text)) => {
            let text = trim(text);
            (!text.is_empty()).then(|| text.into())
        }
        _ => return Err(InvalidDisk),
    };
    Ok(DiskSettings {
        threshold_gb: threshold as u64,
        prompt,
    })
}
fn profile(raw: &Value, path: &str, warnings: &mut Vec<Warning>) -> NetworkProfile {
    let mut out = NetworkProfile {
        mode: NetMode::Off,
        proxy: String::new(),
        no_proxy: vec![],
    };
    if !objectish(raw) {
        warn(warnings, WarningCode::InvalidType, path);
        return out;
    }
    if let Some(proxy) = raw.get("proxy") {
        if let Some(text) = proxy.as_str().map(trim).filter(|s| !s.is_empty()) {
            out.proxy = text.into();
        } else {
            warn(warnings, WarningCode::EmptyProxy, format!("{path}.proxy"));
        }
    }
    let has_proxy = !out.proxy.is_empty();
    out.mode = match raw.get("mode").and_then(Value::as_str) {
        Some("off") => NetMode::Off,
        Some("auto") => NetMode::Auto,
        Some("required") => NetMode::Required,
        _ => {
            if raw.get("mode").is_some() {
                warn(warnings, WarningCode::InvalidValue, format!("{path}.mode"));
            }
            if has_proxy {
                NetMode::Auto
            } else {
                NetMode::Off
            }
        }
    };
    if out.mode == NetMode::Auto && !has_proxy {
        warn(
            warnings,
            WarningCode::AutoWithoutProxy,
            format!("{path}.mode"),
        );
        out.mode = NetMode::Off;
    } else if out.mode == NetMode::Required && !has_proxy {
        warn(
            warnings,
            WarningCode::RequiredProxyMissing,
            format!("{path}.proxy"),
        );
    }
    if let Some(raw) = raw.get("noProxy") {
        let parsed = parse_no_proxy(raw);
        out.no_proxy = parsed.entries;
        for _ in 0..parsed.rejected {
            warn(warnings, WarningCode::Filtered, format!("{path}.noProxy"));
        }
    }
    out
}
pub fn parse(raw: &Value) -> Parsed {
    let mut cfg = RuntimeConfig::default();
    let mut warnings = vec![];
    // Node's root/network typeof-object tests also accept arrays. Known named
    // fields are absent on a decoded JSON array, so it remains the defaults.
    if !objectish(raw) {
        warn(&mut warnings, WarningCode::InvalidRoot, "");
        return Parsed {
            config: cfg,
            warnings,
        };
    }
    if let Some(value) = raw.get("language") {
        cfg.language = match value.as_str() {
            Some("auto") => Language::Auto,
            Some("ru") => Language::Ru,
            Some("en") => Language::En,
            _ => {
                warn(&mut warnings, WarningCode::InvalidValue, "language");
                Language::Auto
            }
        };
    }
    let network = raw.get("network");
    if let Some(network) = network {
        if !objectish(network) {
            warn(&mut warnings, WarningCode::InvalidType, "network");
        } else {
            for (name, target) in [
                ("claude", &mut cfg.network.claude),
                ("codex", &mut cfg.network.codex),
                ("opencode", &mut cfg.network.opencode),
                ("zcode", &mut cfg.network.zcode),
            ] {
                if let Some(value) = network.get(name) {
                    *target = profile(value, &format!("network.{name}"), &mut warnings);
                }
            }
        }
    }
    let legacy = raw.get("guardCountries");
    if let Some(legacy) = legacy {
        if let Some(values) = legacy
            .as_array()
            .filter(|values| values.iter().all(Value::is_string))
        {
            let mut countries = vec![];
            for value in values {
                let country = trim(value.as_str().unwrap()).to_uppercase();
                if !country.is_empty() && !countries.contains(&country) {
                    countries.push(country);
                }
            }
            cfg.guard = GuardRule {
                mode: GuardMode::Deny,
                countries,
            };
        } else {
            warn(&mut warnings, WarningCode::InvalidType, "guardCountries");
        }
    }
    if let Some(guard) = network
        .and_then(Value::as_object)
        .and_then(|o| o.get("guard"))
    {
        let parsed = parse_guard_lenient(guard);
        cfg.guard = parsed.rule;
        warnings.extend(parsed.warnings);
        if legacy.is_some() {
            warn(
                &mut warnings,
                WarningCode::LegacyGuardOverridden,
                "network.guard",
            );
        }
    }
    if let Some(value) = raw.get("autoTitle") {
        if let Some(value) = value.as_bool() {
            cfg.auto_title = value;
        } else {
            warn(&mut warnings, WarningCode::InvalidType, "autoTitle");
        }
    }
    if let Some(notify) = raw.get("notify") {
        if notify.is_object() {
            if let Some(value) = notify.get("minTurnSeconds") {
                if let Some(value) = nonnegative(value) {
                    cfg.notify.min_turn_seconds = value;
                } else {
                    warn(
                        &mut warnings,
                        WarningCode::InvalidValue,
                        "notify.minTurnSeconds",
                    );
                }
            }
            if let Some(value) = notify.get("sound") {
                if let Some(value) = value.as_bool() {
                    cfg.notify.sound = value;
                } else {
                    warn(&mut warnings, WarningCode::InvalidType, "notify.sound");
                }
            }
        } else {
            warn(&mut warnings, WarningCode::InvalidType, "notify");
        }
    }
    if let Some(command) = raw.get("notifyCommand").filter(|v| !v.is_null()) {
        if let Some(text) = command.as_str() {
            if !trim(text).is_empty() {
                cfg.notify_command = Some(text.into());
            }
        } else {
            warn(&mut warnings, WarningCode::InvalidType, "notifyCommand");
        }
    }
    if let Some(watchdog) = raw.get("watchdog") {
        if watchdog.is_object() {
            if let Some(minutes) = watchdog.get("silenceMinutes") {
                if let Some(minutes) = nonnegative(minutes) {
                    cfg.watchdog.silence_minutes = minutes;
                } else {
                    warn(
                        &mut warnings,
                        WarningCode::InvalidValue,
                        "watchdog.silenceMinutes",
                    );
                }
            }
        } else {
            warn(
                &mut warnings,
                WarningCode::InvalidValue,
                "watchdog.silenceMinutes",
            );
        }
    }
    if let Some(mcp) = raw.get("mcp") {
        match mcp
            .as_object()
            .and_then(|o| o.get("servers"))
            .and_then(parse_mcp_server_names)
        {
            Some(names) => {
                if mcp["servers"]
                    .as_array()
                    .is_some_and(|raw| raw.len() != names.len())
                {
                    warn(&mut warnings, WarningCode::Filtered, "mcp.servers");
                }
                cfg.mcp.servers = names;
            }
            None => warn(&mut warnings, WarningCode::InvalidType, "mcp.servers"),
        }
    }
    if let Some(updates) = raw.get("updates") {
        if updates.is_object() {
            if let Some(check) = updates.get("check") {
                if let Some(check) = check.as_bool() {
                    cfg.updates.check = check;
                } else {
                    warn(&mut warnings, WarningCode::InvalidType, "updates.check");
                }
            }
            if let Some(url) = updates.get("url") {
                if let Some(url) = url.as_str().map(trim).filter(|u| {
                    u.starts_with("https://") && u.len() > 8 && !u.chars().any(js_space)
                }) {
                    cfg.updates.url = url.into();
                } else {
                    warn(&mut warnings, WarningCode::InvalidValue, "updates.url");
                }
            }
        } else {
            warn(&mut warnings, WarningCode::InvalidType, "updates");
        }
    }
    if let Some(disk) = raw.get("disk") {
        match parse_disk_settings(disk) {
            Ok(disk) => cfg.disk = disk,
            Err(_) => warn(&mut warnings, WarningCode::InvalidValue, "disk"),
        }
    }
    if let Some(attachments) = raw.get("attachments") {
        match attachments.as_object().and_then(|o| o.get("retentionDays")) {
            Some(Value::Null) => cfg.attachments.retention_days = RetentionDays::Forever,
            Some(value) if value.as_f64() == Some(7.0) => {
                cfg.attachments.retention_days = RetentionDays::Seven
            }
            Some(value) if value.as_f64() == Some(30.0) => {
                cfg.attachments.retention_days = RetentionDays::Thirty
            }
            Some(value) if value.as_f64() == Some(90.0) => {
                cfg.attachments.retention_days = RetentionDays::Ninety
            }
            _ => warn(
                &mut warnings,
                WarningCode::InvalidValue,
                "attachments.retentionDays",
            ),
        }
    }
    if let Some(new_session) = raw.get("newSession") {
        let parsed = parse_new_session(Some(new_session));
        cfg.new_session = parsed.value;
        warnings.extend(parsed.warnings);
    }
    for (key, target) in [
        ("warmTtlMs", &mut cfg.warm_ttl_ms),
        ("permTimeoutMs", &mut cfg.perm_timeout_ms),
        ("subagentGraceMs", &mut cfg.subagent_grace_ms),
        ("backgroundMaxMs", &mut cfg.background_max_ms),
    ] {
        if let Some(value) = raw.get(key) {
            if let Some(value) = nonnegative(value) {
                *target = value;
            } else {
                warn(&mut warnings, WarningCode::InvalidValue, key);
            }
        }
    }
    Parsed {
        config: cfg,
        warnings,
    }
}
