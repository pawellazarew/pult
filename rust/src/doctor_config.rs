//! Lenient diagnostic config, distinct from strict runtime admission.
use crate::{
    doctor_files as files,
    doctor_model::{Text, redact},
};
use anyhow::Result;
use pult_core::runtime_config::{self as cfg, RuntimeConfig, WarningCode as W};
use serde_json::Value;
use std::path::Path;
fn at<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    let mut v = v;
    for p in path.split('.') {
        v = v.get(p)?
    }
    Some(v)
}
fn encoded(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), Value::to_string)
}
fn original_at(
    original: Option<&serde_json::value::RawValue>,
    path: &str,
) -> Option<Box<serde_json::value::RawValue>> {
    let mut value = original?.to_owned();
    for name in path.split('.') {
        value = pult_core::raw_field(&value, name).ok()??;
    }
    Some(value)
}
fn original_encoded(
    original: Option<&serde_json::value::RawValue>,
    path: &str,
    fallback: Option<&Value>,
) -> String {
    original_at(original, path)
        .and_then(|raw| pult_core::stringify_js_value(&raw).ok())
        .unwrap_or_else(|| encoded(fallback))
}
fn array_spellings(original: Option<&serde_json::value::RawValue>, path: &str) -> Vec<String> {
    original_at(original, path)
        .and_then(|raw| {
            serde_json::from_str::<Vec<Box<serde_json::value::RawValue>>>(raw.get()).ok()
        })
        .unwrap_or_default()
        .iter()
        .map(|raw| pult_core::stringify_js_value(raw).unwrap_or_else(|_| "null".into()))
        .collect()
}
fn guard_warning(
    raw: &Value,
    original: Option<&serde_json::value::RawValue>,
    w: &cfg::Warning,
    t: Text,
) -> Vec<String> {
    let g = &raw["network"]["guard"];
    match w.code {
        W::GuardClosed=>{let why=if !g.is_object(){t.t("не объект {mode, countries}",&[])}else if !g["mode"].as_str().is_some_and(|s|["deny","allow"].contains(&s.trim().to_lowercase().as_str())){t.t(": mode = {0} — не deny|allow",&[&original_encoded(original,"network.guard.mode",g.get("mode"))])}else{t.t(": countries не список",&[])};vec![t.t("config.json: network.guard {0} — страж закрыт, все ходы запрещены, пока правило не поправят («Настройки» → «Страж сети» или pult net guard)",&[&why])]},
        W::GuardEmptyAllow=>vec![t.t("config.json: network.guard — режим allow без стран: все ходы запрещены, пока не добавишь страну («Настройки» → «Страж сети»)",&[])],
        W::Filtered=>{let source=array_spellings(original,"network.guard.countries");g["countries"].as_array().into_iter().flatten().enumerate().filter(|(_,v)|!v.as_str().is_some_and(|s|pult_core::network_guard::COUNTRY_CODES.contains(&s.trim().to_uppercase().as_str()))).map(|(i,v)|t.t("config.json: network.guard.countries: {0} — не код страны ISO 3166-1, пропущено",&[source.get(i).unwrap_or(&v.to_string())])).collect()},
        _=>vec![],
    }
}
fn warnings(
    raw: &Value,
    original: Option<&serde_json::value::RawValue>,
    parsed: &cfg::Parsed,
    t: Text,
) -> Vec<String> {
    let mut out = vec![];
    let mut filtered = std::collections::BTreeSet::new();
    for w in &parsed.warnings {
        if w.code == W::Filtered && !filtered.insert(w.field.clone()) {
            continue;
        }
        let f = w.field.as_str();
        if f.starts_with("network.guard") && w.code != W::LegacyGuardOverridden {
            out.extend(guard_warning(raw, original, w, t));
            continue;
        }
        let message = if f.starts_with("network.") {
            let parts = f.split('.').collect::<Vec<_>>();
            let p = parts[1];
            let profile = match p {
                "claude" => &parsed.config.network.claude,
                "codex" => &parsed.config.network.codex,
                "opencode" => &parsed.config.network.opencode,
                _ => &parsed.config.network.zcode,
            };
            match w.code{
 W::EmptyProxy=>format!("config.json: {f} не непустая строка — прокси нет, прямой путь"),W::AutoWithoutProxy=>format!("config.json: {f} = auto без proxy — прокси нет, взят off (прямой путь)"),W::RequiredProxyMissing=>format!("config.json: network.{p}.mode = required без proxy — ходы {p} запрещены, пока не задан network.{p}.proxy (или mode \"off\")"),W::InvalidValue=>format!("config.json: {f} = {} — не auto|required|off, взят {}",original_encoded(original,f,at(raw,f)),crate::doctor_net::mode(profile.mode)),W::Filtered=>{let Some(a)=at(raw,f).and_then(Value::as_array)else{out.push(format!("config.json: {f}: не список строк — пропущено"));continue};let source=array_spellings(original,f);for (index,v) in a.iter().enumerate(){if !v.as_str().is_some_and(|s|!s.trim().is_empty()&&!s.trim().chars().any(|c|cfg::js_space(c)||c==',')){out.push(format!("config.json: {f}: {} — пропущено",source.get(index).unwrap_or(&v.to_string())));}}continue},W::LegacyGuardOverridden=>"config.json: есть и guardCountries, и network.guard — действует network.guard, guardCountries не читается (его можно убрать)".into(),_=>format!("config.json: {f} не объект — профиль по умолчанию")}
        } else if f.starts_with("newSession") {
            let suffix = f.strip_prefix("newSession").unwrap();
            let path = suffix;
            let why = if w.code == W::BrowserBlocked {
                let approval = at(raw, &format!("{f}.approval"))
                    .and_then(Value::as_str)
                    .unwrap_or("ask");
                let word = match approval {
                    "workspace" => {
                        if t.0 {
                            "edit project files without asking".into()
                        } else {
                            "правки в папке без вопросов".into()
                        }
                    }
                    "read-only" => t.t("только чтение", &[]),
                    _ => t.t("спрашивать", &[]),
                };
                t.t("{0}: браузер с режимом «{1}» не включается — сними браузер или выбери режим тише",&[path,&word])
            } else if w.code == W::UnsafeDefault {
                t.t(if at(raw,f).and_then(Value::as_str)==Some("full"){"{0}.approval — полный доступ по умолчанию не ставится: только явно при заведении"}else{"{0}.approval — «как в настройках Claude» по умолчанию не ставится: только явно при заведении"},&[path.trim_end_matches(".approval")])
            } else if f.ends_with(".model") {
                t.t(
                    "{0}.model — имя модели без пробелов",
                    &[path.trim_end_matches(".model")],
                )
            } else if f.ends_with(".effort") {
                t.t(
                    "{0}.effort — слово латиницей",
                    &[path.trim_end_matches(".effort")],
                )
            } else if f.ends_with(".provider") {
                format!("{path} — claude | codex | zcode")
            } else if f.ends_with(".approval") {
                format!("{path} — read-only | ask | workspace")
            } else if f.ends_with(".mode") {
                format!("{path} — turn | warm")
            } else if [".rememberLast", ".browser", ".worktree"]
                .iter()
                .any(|s| f.ends_with(s))
            {
                format!("{path} — true | false")
            } else if path.is_empty() {
                t.t("— объект", &[])
            } else {
                t.t("{0} — объект", &[path])
            };
            format!(
                "config.json: newSession{}{why}",
                if why.starts_with(['.', ':']) { "" } else { " " }
            )
        } else {
            match f{
 ""=>"config.json: корень не объект — взяты значения по умолчанию".into(),"language"=>"config.json: language must be auto, ru or en; using auto".into(),"network"=>"config.json: network не объект — профиль по умолчанию".into(),"guardCountries"=>"config.json: guardCountries не список строк — взят список по умолчанию".into(),"autoTitle"=>"config.json: autoTitle не true/false — взято значение по умолчанию".into(),"notify"=>"config.json: notify не объект — правила уведомлений по умолчанию".into(),"notify.minTurnSeconds"=>"config.json: notify.minTurnSeconds не неотрицательное число — взято 20".into(),"notify.sound"=>"config.json: notify.sound не true/false — звук включён".into(),"notifyCommand"=>"config.json: notifyCommand не строка — своя команда уведомлений выключена".into(),"watchdog.silenceMinutes"=>"config.json: watchdog.silenceMinutes не неотрицательное число — взято 10".into(),"mcp.servers"=>if w.code==W::Filtered{"config.json: mcp.servers — часть имён отброшена (повтор, пусто или недопустимые знаки)"}else{"config.json: mcp.servers не список строк — свои MCP-серверы не подключаются"}.into(),"updates"=>"config.json: updates не объект — проверка обновлений по умолчанию".into(),"updates.check"=>"config.json: updates.check не true/false — проверка включена".into(),"updates.url"=>format!("config.json: updates.url не https-адрес — взят {}",cfg::DEFAULT_UPDATE_URL),"disk"=>"config.json: invalid disk settings; using defaults".into(),"attachments.retentionDays"=>"config.json: attachments.retentionDays — 7, 30, 90 или null; взято 30 дней".into(),_=>format!("config.json: {f} не неотрицательное число — взято значение по умолчанию")}
        };
        out.push(message)
    }
    out.into_iter().map(|s| redact(&s)).collect()
}
// Ignore opaque extension subtrees before decoding semantic values. A valid
// deep extension must never erase a known required route or guard as "malformed".
fn projection(raw: &serde_json::value::RawValue, at: &str) -> Result<Value> {
    let keys: &[&str] = match at {
        "" => &[
            "language",
            "network",
            "guardCountries",
            "autoTitle",
            "notify",
            "notifyCommand",
            "watchdog",
            "mcp",
            "updates",
            "disk",
            "attachments",
            "newSession",
            "warmTtlMs",
            "permTimeoutMs",
            "subagentGraceMs",
            "backgroundMaxMs",
        ],
        "network" => &["claude", "codex", "opencode", "zcode", "guard"],
        "network.claude" | "network.codex" | "network.opencode" | "network.zcode" => {
            &["mode", "proxy", "noProxy"]
        }
        "network.guard" => &["mode", "countries"],
        "notify" => &["minTurnSeconds", "sound"],
        "watchdog" => &["silenceMinutes"],
        "mcp" => &["servers"],
        "updates" => &["check", "url"],
        "attachments" => &["retentionDays"],
        "newSession" => &["rememberLast", "defaults"],
        "newSession.defaults" => &["provider", "claude", "codex", "zcode"],
        "newSession.defaults.claude"
        | "newSession.defaults.codex"
        | "newSession.defaults.zcode" => {
            &["model", "effort", "approval", "mode", "browser", "worktree"]
        }
        _ => {
            return files::json(raw.get()).map_err(|_| {
                anyhow::anyhow!("doctor known config value exceeds JSON decoding limits")
            });
        }
    };
    if raw.get().starts_with('[') {
        return Ok(Value::Array(vec![]));
    }
    if !raw.get().starts_with('{') {
        return files::json(raw.get());
    }
    let fields = pult_core::RawFields::parse(raw)?;
    let mut out = serde_json::Map::new();
    for name in keys {
        if let Some(raw) = fields.get(name) {
            let next = if at.is_empty() {
                (*name).to_owned()
            } else {
                format!("{at}.{name}")
            };
            out.insert((*name).into(), projection(raw, &next)?);
        }
    }
    Ok(Value::Object(out))
}
pub(super) fn load(root: &Path) -> Result<(RuntimeConfig, Text, Vec<String>)> {
    let source = files::private_read(root, "config.json", files::LIMIT)?;
    let syntax = source
        .as_deref()
        .map(serde_json::from_str::<Box<serde_json::value::RawValue>>);
    let malformed = syntax.as_ref().is_some_and(Result::is_err);
    let original = syntax.and_then(Result::ok);
    let raw = original
        .as_deref()
        .map(|raw| projection(raw, ""))
        .transpose()?
        .unwrap_or_else(|| serde_json::json!({}));
    let parsed = cfg::parse(&raw);
    let setting = std::env::var("PULT_LANG")
        .ok()
        .filter(|s| ["ru", "en", "auto"].contains(&s.as_str()))
        .unwrap_or_else(|| parsed.config.language.as_str().into());
    let english = match setting.as_str() {
        "ru" => false,
        "en" => true,
        _ => {
            let system = ["LC_ALL", "LC_MESSAGES", "LANG"]
                .iter()
                .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
                .unwrap_or_else(|| sys_locale::get_locale().unwrap_or_default());
            !regex::Regex::new(r"(?i)^ru(?:[-_.@]|$)")
                .unwrap()
                .is_match(&system)
        }
    };
    let t = Text(english);
    let mut warnings = warnings(&raw, original.as_deref(), &parsed, t);
    if malformed {
        warnings.insert(
            0,
            "config.json не разбирается (invalid JSON) — взяты значения по умолчанию".into(),
        )
    }
    Ok((parsed.config, t, warnings))
}
