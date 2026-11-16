//! Four diagnostic profiles, independent of the three execution providers.
use crate::{
    doctor_exec::{DiagnosticCommand, Executor},
    doctor_model::{Item, Text, now, redact},
};
use anyhow::{Result, anyhow, ensure};
use pult_core::{
    network_guard as net,
    runtime_config::{GuardMode, NetMode, NetworkProfile, RuntimeConfig},
};
use serde_json::json;
use std::path::{Path, PathBuf};
#[derive(Clone, Copy)]
pub(super) enum DiagnosticProvider {
    Claude,
    Codex,
    Opencode,
    Zcode,
}
impl DiagnosticProvider {
    pub const ALL: [Self; 4] = [Self::Claude, Self::Codex, Self::Opencode, Self::Zcode];
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Zcode => "zcode",
        }
    }
    pub fn profile(self, c: &RuntimeConfig) -> &NetworkProfile {
        match self {
            Self::Claude => &c.network.claude,
            Self::Codex => &c.network.codex,
            Self::Opencode => &c.network.opencode,
            Self::Zcode => &c.network.zcode,
        }
    }
}
pub(super) fn mode(mode: NetMode) -> &'static str {
    match mode {
        NetMode::Off => "off",
        NetMode::Auto => "auto",
        NetMode::Required => "required",
    }
}
pub(super) fn guard(config: &RuntimeConfig, t: Text) -> Item {
    let r = &config.guard;
    let mode = if r.mode == GuardMode::Allow {
        "allow"
    } else {
        "deny"
    };
    let empty = r.countries.is_empty();
    let list = if empty {
        t.t("(пусто)", &[])
    } else {
        r.countries.join(", ")
    };
    let line = t.t(
        if mode == "allow" {
            "разрешать только: {0}"
        } else {
            "запрещать: {0}"
        },
        &[&list],
    );
    let key = if mode == "allow" && empty {
        "{0} — все ходы запрещены: в режиме allow нет ни одной страны (config.json → network.guard)"
    } else if empty {
        "{0} — страж выключен: ходы идут из любой известной страны (неизвестная — по-прежнему отказ)"
    } else {
        "{0} — для claude, codex и opencode; неизвестная страна — отказ"
    };
    let mut item = t
        .item(
            "guard.rule",
            "Страж сети",
            if mode == "allow" && empty {
                "fail"
            } else if empty {
                "warn"
            } else {
                "ok"
            },
            t.t(key, &[&line]),
        )
        .data(json!({"mode":mode,"countries":r.countries}));
    if empty {
        item = item.fix(t.t(
            if mode == "allow" {
                "добавь страну в «Настройки» (⌘,) → «Страж сети» или: pult net guard --allow DE"
            } else {
                "верни страны в «Настройки» (⌘,) → «Страж сети» или: pult net guard --deny RU,BY"
            },
            &[],
        ))
    }
    item
}
async fn trace(
    bin: &Path,
    provider: &'static str,
    proxy: Option<&str>,
    exec: &Executor,
) -> Result<Option<String>> {
    for url in net::EGRESS_URLS {
        let r = exec
            .run(DiagnosticCommand::Trace {
                bin: bin.to_owned(),
                proxy: proxy.map(str::to_owned),
                url,
                provider,
            })
            .await?;
        if r.code == Some(0)
            && let Some(loc) = net::parse_loc(r.stdout.as_bytes())
        {
            return Ok(Some(loc));
        }
    }
    Ok(None)
}
pub(super) async fn check(
    root: &Path,
    display: &Path,
    provider: DiagnosticProvider,
    config: &RuntimeConfig,
    test: bool,
    exec: &Executor,
    t: Text,
) -> Result<Item> {
    let bin = if test {
        let p = std::env::var_os("PULT_TEST_DOCTOR_CURL")
            .map(PathBuf::from)
            .ok_or_else(|| anyhow!("test doctor requires an explicit fake curl"))?;
        ensure!(
            p.is_absolute() && std::fs::canonicalize(&p)?.starts_with(root),
            "test doctor curl must stay in scratch home"
        );
        p
    } else {
        PathBuf::from("curl")
    };
    let start = std::time::Instant::now();
    let profile = provider.profile(config);
    let mode = mode(profile.mode);
    let provider = provider.name();
    let mut proxy = None;
    let mut loc = None;
    let mut fell_back = false;
    let mut path = "none";
    let mut reason = "ok";
    if profile.mode == NetMode::Required && profile.proxy.is_empty() {
        reason = "no_proxy"
    } else if profile.mode == NetMode::Off
        || (profile.mode == NetMode::Auto && profile.proxy.is_empty())
    {
        path = "direct";
        loc = trace(&bin, provider, None, exec).await?
    } else {
        loc = trace(&bin, provider, Some(&profile.proxy), exec).await?;
        proxy = Some(profile.proxy.as_str());
        if loc.is_some() {
            path = "proxy"
        } else if profile.mode == NetMode::Required {
            reason = "proxy_dead"
        } else {
            fell_back = true;
            proxy = None;
            path = "direct";
            loc = trace(&bin, provider, None, exec).await?
        }
    }
    let mut ok = false;
    if reason == "ok" {
        let (allow, r) = net::guard_verdict(&config.guard.as_network_rule(), loc.as_deref());
        ok = allow;
        reason = match r {
            net::Reason::Ok => "ok",
            net::Reason::UnknownLocation => "unknown_location",
            net::Reason::BlockedCountry => "blocked_country",
            net::Reason::NotAllowedCountry => "not_allowed_country",
            _ => "unknown_location",
        };
        if !ok {
            path = "none"
        }
    }
    let ms = start.elapsed().as_millis();
    let via = match path {
        "proxy" => format!("прокси {}", proxy.unwrap_or("")),
        "direct" => "прямой".into(),
        _ => "ход запрещён".into(),
    };
    let detail = redact(&format!(
        "{provider}: {mode} → {via}, loc={}, {ms} мс{}{}",
        loc.as_deref().unwrap_or("unknown"),
        if fell_back {
            " (откат с прокси)"
        } else {
            ""
        },
        if ok {
            String::new()
        } else {
            format!(" — {reason}")
        }
    ));
    let mut item = t
        .item(
            &format!("net.{provider}"),
            "",
            if ok {
                if fell_back { "warn" } else { "ok" }
            } else {
                "fail"
            },
            detail,
        )
        .data(json!({"mode":mode,"path":path,"loc":loc,"reason":reason,"ms":ms,"checkedAt":now()}));
    item.title = t.t("Сеть {0}", &[provider]);
    if !ok {
        let countries = config.guard.countries.join(",");
        let location = loc.clone().unwrap_or_else(|| t.t("неизвестен", &[]));
        let config_path = display.join("config.json").display().to_string();
        item.fix=Some(match reason{"no_proxy"=>t.t("network.{0}.mode = \"required\" без proxy — ходы запрещены: укажи network.{1}.proxy или поставь mode = \"off\" в {2}",&[provider,provider,&config_path]),"proxy_dead"=>if let Some(proxy)=proxy.filter(|s|!s.is_empty()){t.t("подними прокси {0} или поставь network.{1}.mode = \"auto\" в {2}",&[&redact(proxy),provider,&config_path])}else{t.t("укажи network.{0}.proxy или поставь network.{1}.mode = \"off\" в {2}",&[provider,provider,&config_path])},"not_allowed_country"=>t.t("выход {0} не в списке разрешённых ({1}): смени выход VPN или правило — «Настройки» → «Страж сети», pult net guard",&[&location,&countries]),_=>t.t("подними VPN: выход {0}, список-страж {1}",&[&location,&countries])});
    }
    Ok(item)
}
