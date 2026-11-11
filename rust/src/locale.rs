//! Node-compatible request/config/system locale selection. PULT_LANG belongs to CLI only.
use serde_json::value::RawValue;

#[derive(Clone, Copy)]
pub(crate) enum Setting {
    Auto,
    Ru,
    En,
}
pub(crate) fn explicit_text(text: &str) -> Option<Setting> {
    match text {
        "ru" => Some(Setting::Ru),
        "en" => Some(Setting::En),
        _ => None,
    }
}
pub(crate) fn explicit(raw: Option<&RawValue>) -> Option<Setting> {
    raw.and_then(|r| serde_json::from_str::<String>(r.get()).ok())
        .and_then(|s| explicit_text(&s))
}
pub(crate) fn cli_setting(text: &str) -> Option<Setting> {
    if text == "auto" {
        Some(Setting::Auto)
    } else {
        explicit_text(text)
    }
}

pub(crate) fn setting(raw: Option<&RawValue>) -> Setting {
    explicit(raw).unwrap_or(Setting::Auto)
}
fn system_locale() -> String {
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(name)
            && !value.is_empty()
        {
            return value;
        }
    }
    sys_locale::get_locale().unwrap_or_default()
}
pub(crate) fn english(setting: Setting, system: Option<&str>) -> bool {
    match setting {
        Setting::En => true,
        Setting::Ru => false,
        Setting::Auto => {
            let owned;
            let text = match system {
                Some(text) => text,
                None => {
                    owned = system_locale();
                    &owned
                }
            };
            let bytes = text.as_bytes();
            !(bytes.len() >= 2
                && bytes[..2].eq_ignore_ascii_case(b"ru")
                && (bytes.len() == 2 || b"-_.@".contains(&bytes[2])))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_auto_override_is_distinct_from_request_locale() {
        assert!(matches!(cli_setting("auto"), Some(Setting::Auto)));
        assert!(explicit_text("auto").is_none());
        assert!(cli_setting("unknown").is_none());
    }
    #[test]
    fn node_locale_detection() {
        for ru in ["ru", "RU_ru.UTF-8", "ru-RU", "ru@custom"] {
            assert!(!english(Setting::Auto, Some(ru)));
        }
        for en in ["", "C", "russian", "en-US"] {
            assert!(english(Setting::Auto, Some(en)));
        }
        assert!(!english(Setting::Ru, Some("en")));
        assert!(english(Setting::En, Some("ru")));
    }
}
