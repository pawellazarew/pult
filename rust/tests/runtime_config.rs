//! Independent goldens from current config.ts, guard.ts, settings.ts and disk.ts.
use pult_core::runtime_config::*;
use pult_core::turn_snapshot::Provider;
use serde_json::{Value, json};
fn codes(parsed: &Parsed) -> Vec<WarningCode> {
    parsed.warnings.iter().map(|w| w.code).collect()
}
#[test]
fn default_config_file_is_the_complete_node_shape() {
    let expected = json!({"version":1,"language":"auto","network":{"claude":{"mode":"off","proxy":""},"codex":{"mode":"off","proxy":""},"opencode":{"mode":"off","proxy":""},"zcode":{"mode":"off","proxy":""},"guard":{"mode":"deny","countries":["RU","BY","CN","IR","KP","SY","CU"]}},"warmTtlMs":1200000,"permTimeoutMs":600000,"subagentGraceMs":30000,"backgroundMaxMs":10800000,"autoTitle":true,"notify":{"minTurnSeconds":20,"sound":true},"notifyCommand":null,"watchdog":{"silenceMinutes":10},"mcp":{"servers":[]},"updates":{"check":true,"url":DEFAULT_UPDATE_URL},"newSession":{"rememberLast":true,"defaults":{"claude":{},"codex":{},"zcode":{}}},"disk":{"thresholdGb":6,"prompt":null},"attachments":{"retentionDays":30}});
    assert_eq!(RuntimeConfig::default().to_file(), expected);
    let parsed = parse(&json!({}));
    assert!(parsed.warnings.is_empty());
    assert_eq!(parsed.config.to_file(), expected);
}
#[test]
fn nonobjects_default_but_node_object_arrays_are_not_invented_errors() {
    for root in [
        Value::Null,
        json!(false),
        json!(3),
        json!("PRIVATE invalid root"),
    ] {
        let parsed = parse(&root);
        assert_eq!(codes(&parsed), vec![WarningCode::InvalidRoot]);
        assert_eq!(parsed.config, RuntimeConfig::default());
        assert!(!format!("{:?}", parsed).contains("PRIVATE"));
    }
    for root in [
        json!([]),
        json!({"network":[]}),
        json!({"network":{"claude":[]}}),
    ] {
        let parsed = parse(&root);
        assert_eq!(parsed.config, RuntimeConfig::default());
        assert!(parsed.warnings.is_empty());
    }
}
#[test]
fn all_four_network_profiles_and_trim_only_proxy_contract_are_preserved() {
    let parsed = parse(
        &json!({"network":{"claude":{"proxy":" \u{feff}http://user:PRIVATE@proxy.invalid:8080\t"},"codex":{"mode":"required","proxy":"not even a URL"},"opencode":{"mode":"off","proxy":"https://legacy"},"zcode":{"mode":"auto","proxy":"socks5://zcode"}}}),
    );
    assert!(parsed.warnings.is_empty());
    assert_eq!(parsed.config.network.claude.mode, NetMode::Auto);
    assert_eq!(
        parsed.config.network.claude.proxy,
        "http://user:PRIVATE@proxy.invalid:8080"
    );
    assert_eq!(parsed.config.network.codex.mode, NetMode::Required);
    assert_eq!(parsed.config.network.codex.proxy, "not even a URL");
    assert_eq!(parsed.config.network.opencode.mode, NetMode::Off);
    assert_eq!(parsed.config.network.zcode.mode, NetMode::Auto);
    assert_eq!(
        parsed.config.network.for_provider(Provider::Codex),
        &parsed.config.network.codex
    );
}
#[test]
fn required_empty_proxy_never_becomes_off_and_auto_empty_does() {
    for proxy in [
        None,
        Some(json!("")),
        Some(Value::Null),
        Some(json!("\u{feff}\t")),
    ] {
        let mut required = json!({"network":{"codex":{"mode":"required"}}});
        if let Some(proxy) = proxy {
            required["network"]["codex"]["proxy"] = proxy;
        }
        let parsed = parse(&required);
        assert_eq!(parsed.config.network.codex.mode, NetMode::Required);
        assert!(parsed.config.network.codex.proxy.is_empty());
        assert!(codes(&parsed).contains(&WarningCode::RequiredProxyMissing));
        required["network"]["codex"]["mode"] = json!("auto");
        let parsed = parse(&required);
        assert_eq!(parsed.config.network.codex.mode, NetMode::Off);
        assert!(codes(&parsed).contains(&WarningCode::AutoWithoutProxy));
    }
}
#[test]
fn unknown_profile_mode_follows_proxy_presence_without_echoing_bad_value() {
    let parsed = parse(
        &json!({"network":{"claude":{"mode":"PRIVATE-mode","proxy":"proxy"},"codex":{"mode":"PRIVATE-mode"},"opencode":5,"zcode":{"proxy":false,"noProxy":null}}}),
    );
    assert_eq!(parsed.config.network.claude.mode, NetMode::Auto);
    assert_eq!(parsed.config.network.codex.mode, NetMode::Off);
    assert_eq!(parsed.warnings.len(), 5);
    assert!(!format!("{:?}", parsed.warnings).contains("PRIVATE"));
    assert_eq!(parsed.warnings[0].field, "network.claude.mode");
}
#[test]
fn no_proxy_normalizes_wildcards_deduplicates_and_uses_js_whitespace() {
    let parsed = parse_no_proxy(&json!([
        " *.company.test ",
        ".company.test",
        "10.0.0.0/8",
        "A",
        "a",
        "bad,host",
        "bad host",
        null,
        "",
        "\u{feff}host\u{feff}",
        "host\u{0085}name",
        "host\0name"
    ]));
    assert_eq!(
        parsed.entries,
        vec![
            ".company.test",
            "10.0.0.0/8",
            "A",
            "a",
            "host",
            "host\u{0085}name",
            "host\0name"
        ]
    );
    assert_eq!(parsed.rejected, 4);
    assert_eq!(parse_no_proxy(&json!("host")).rejected, 1);
    let parsed = parse(&json!({"network":{"claude":{"noProxy":["a",null,"bad host"]}}}));
    assert_eq!(
        parsed.config.to_file()["network"]["claude"]["noProxy"],
        json!(["a"])
    );
    assert_eq!(
        codes(&parsed),
        vec![WarningCode::Filtered, WarningCode::Filtered]
    );
}
#[test]
fn malformed_new_guard_is_closed_instead_of_legacy_or_default_fallback() {
    for guard in [
        Value::Null,
        json!([]),
        json!("off"),
        json!({"mode":"UNKNOWN","countries":["DE"]}),
        json!({"mode":"deny"}),
        json!({"mode":"deny","countries":"DE"}),
    ] {
        let parsed = parse(&json!({"guardCountries":[],"network":{"guard":guard}}));
        assert_eq!(parsed.config.guard, GuardRule::closed());
        assert_eq!(
            codes(&parsed),
            vec![WarningCode::GuardClosed, WarningCode::LegacyGuardOverridden]
        );
    }
}
#[test]
fn guard_country_filtering_and_empty_deny_match_node_exactly() {
    let parsed = parse_guard_lenient(
        &json!({"mode":" \u{feff}AlLoW\n","countries":[" de ","DE","xk","ZZ",5,"\u{feff}us"],"future":"ignored"}),
    );
    assert_eq!(parsed.rule.mode, GuardMode::Allow);
    assert_eq!(parsed.rule.countries, vec!["DE", "XK", "US"]);
    assert_eq!(parsed.warnings.len(), 2);
    let parsed = parse_guard_lenient(&json!({"mode":"deny","countries":["ZZ"]}));
    assert_eq!(parsed.rule.mode, GuardMode::Deny);
    assert!(parsed.rule.countries.is_empty());
    assert!(parsed.rule.as_network_rule().off());
    assert_eq!(parsed.warnings[0].code, WarningCode::Filtered);
    let parsed = parse_guard_lenient(&json!({"mode":"allow","countries":["ZZ"]}));
    assert_eq!(parsed.rule, GuardRule::closed());
    assert_eq!(
        parsed.warnings.iter().map(|w| w.code).collect::<Vec<_>>(),
        vec![WarningCode::Filtered, WarningCode::GuardEmptyAllow]
    );
}
#[test]
fn legacy_guard_keeps_historical_non_iso_strings_and_new_guard_takes_priority() {
    let parsed = parse(&json!({"guardCountries":[" ru ","RU","private-country","", "\u{feff}"]}));
    assert_eq!(parsed.config.guard.countries, vec!["RU", "PRIVATE-COUNTRY"]);
    assert!(parsed.warnings.is_empty());
    let parsed = parse(
        &json!({"guardCountries":["RU"],"network":{"guard":{"mode":"deny","countries":["DE"]}}}),
    );
    assert_eq!(parsed.config.guard.countries, vec!["DE"]);
    assert_eq!(codes(&parsed), vec![WarningCode::LegacyGuardOverridden]);
    let parsed = parse(&json!({"guardCountries":["RU",3]}));
    assert_eq!(parsed.config.guard, GuardRule::default());
    assert_eq!(codes(&parsed), vec![WarningCode::InvalidType]);
}
#[test]
fn times_remain_finite_f64_with_zero_fractional_and_huge_values() {
    let parsed = parse(
        &json!({"warmTtlMs":0,"permTimeoutMs":0.125,"subagentGraceMs":1e100,"backgroundMaxMs":2.75,"notify":{"minTurnSeconds":0.5},"watchdog":{"silenceMinutes":0}}),
    );
    assert!(parsed.warnings.is_empty());
    assert_eq!(parsed.config.warm_ttl_ms, 0.0);
    assert_eq!(parsed.config.perm_timeout_ms, 0.125);
    assert_eq!(parsed.config.subagent_grace_ms, 1e100);
    assert_eq!(parsed.config.background_max_ms, 2.75);
    let file = parsed.config.to_file();
    assert_eq!(file["warmTtlMs"], json!(0));
    assert_eq!(file["permTimeoutMs"], json!(0.125));
    assert_eq!(file["subagentGraceMs"], json!(1e100));
    assert_eq!(file["watchdog"]["silenceMinutes"], json!(0));
    let parsed = parse(
        &json!({"warmTtlMs":-1,"permTimeoutMs":"20","subagentGraceMs":null,"backgroundMaxMs":false}),
    );
    assert_eq!(parsed.config.warm_ttl_ms, 1_200_000.0);
    assert_eq!(parsed.warnings.len(), 4);
}
#[test]
fn notify_command_is_preserved_untrimmed_but_blank_and_invalid_are_disabled() {
    let parsed = parse(
        &json!({"autoTitle":false,"notify":{"minTurnSeconds":1.5,"sound":false},"notifyCommand":"  echo PRIVATE  ","watchdog":{}}),
    );
    assert!(parsed.warnings.is_empty());
    assert!(!parsed.config.auto_title);
    assert_eq!(
        parsed.config.notify_command.as_deref(),
        Some("  echo PRIVATE  ")
    );
    assert!(!parsed.config.notify.sound);
    assert_eq!(parsed.config.watchdog.silence_minutes, 10.0);
    for command in [Value::Null, json!(""), json!(" \u{feff}\n")] {
        let parsed = parse(&json!({"notifyCommand":command}));
        assert!(parsed.config.notify_command.is_none());
        assert!(parsed.warnings.is_empty());
    }
    let parsed = parse(&json!({"autoTitle":0,"notify":[],"notifyCommand":5,"watchdog":null}));
    assert_eq!(parsed.warnings.len(), 4);
    assert_eq!(parsed.config, RuntimeConfig::default());
    assert_eq!(
        parse(&json!({"notifyCommand":"\u{0085}"}))
            .config
            .notify_command
            .as_deref(),
        Some("\u{0085}")
    );
}
#[test]
fn mcp_names_are_all_strings_then_filtered_deduplicated_and_capped() {
    let names = parse_mcp_server_names(&json!([
        " Browser ",
        "Browser",
        "browser",
        "valid.name_1-2",
        "bad space",
        "_bad",
        "🌊",
        "\u{feff}Trimmed"
    ]))
    .unwrap();
    assert_eq!(
        names,
        vec!["Browser", "browser", "valid.name_1-2", "Trimmed"]
    );
    assert!(parse_mcp_server_names(&json!(["good", 5])).is_none());
    let values = (0..40).map(|n| format!("Server{n}")).collect::<Vec<_>>();
    let parsed = parse(&json!({"mcp":{"servers":values}}));
    assert_eq!(parsed.config.mcp.servers.len(), 32);
    assert_eq!(codes(&parsed), vec![WarningCode::Filtered]);
    assert_eq!(parsed.config.mcp.servers[31], "Server31");
    let parsed = parse(&json!({"mcp":{"servers":["good",false]}}));
    assert!(parsed.config.mcp.servers.is_empty());
    assert_eq!(codes(&parsed), vec![WarningCode::InvalidType]);
}
#[test]
fn update_url_uses_exact_lowercase_https_regex_without_url_parsing() {
    for url in [
        " https://host.invalid/a\u{feff} ",
        "https://not-a-url:???",
        "https://user:PRIVATE@host.invalid",
        "https://host\u{0085}name",
    ] {
        let parsed = parse(&json!({"updates":{"check":false,"url":url}}));
        assert!(parsed.warnings.is_empty());
        assert!(!parsed.config.updates.check);
        assert_eq!(parsed.config.updates.url, url.trim_matches(js_space));
    }
    for url in [
        "HTTPS://host.invalid",
        "http://host.invalid",
        "https://",
        "https://bad host",
    ] {
        let parsed = parse(&json!({"updates":{"url":url}}));
        assert_eq!(parsed.config.updates.url, DEFAULT_UPDATE_URL);
        assert_eq!(codes(&parsed), vec![WarningCode::InvalidValue]);
    }
}
#[test]
fn disk_settings_are_whole_shape_strict_and_enforce_safe_byte_threshold() {
    let parsed =
        parse_disk_settings(&json!({"thresholdGb":8,"prompt":" \u{feff}PRIVATE prompt\n "}))
            .unwrap();
    assert_eq!(parsed.threshold_gb, 8);
    assert_eq!(parsed.prompt.as_deref(), Some("PRIVATE prompt"));
    assert!(
        parse_disk_settings(&json!({"thresholdGb":6,"prompt":" \u{feff}"}))
            .unwrap()
            .prompt
            .is_none()
    );
    for raw in [
        json!({"thresholdGb":0,"prompt":null}),
        json!({"thresholdGb":1.5,"prompt":null}),
        json!({"thresholdGb":9007200,"prompt":null}),
        json!({"thresholdGb":6}),
        json!({"thresholdGb":6,"prompt":null,"future":1}),
        json!([]),
    ] {
        assert_eq!(parse_disk_settings(&raw), Err(InvalidDisk));
        let parsed = parse(&json!({"disk":raw}));
        assert_eq!(parsed.config.disk, DiskSettings::default());
        assert_eq!(codes(&parsed), vec![WarningCode::InvalidValue]);
    }
    assert_eq!(
        parse_disk_settings(&json!({"thresholdGb":9007199,"prompt":null}))
            .unwrap()
            .threshold_gb,
        9007199
    );
}
#[test]
fn attachment_retention_is_exactly_seven_thirty_ninety_or_null() {
    for (raw, expected) in [
        (json!(7), RetentionDays::Seven),
        (json!(30), RetentionDays::Thirty),
        (json!(90.0), RetentionDays::Ninety),
        (Value::Null, RetentionDays::Forever),
    ] {
        let parsed = parse(&json!({"attachments":{"retentionDays":raw}}));
        assert_eq!(parsed.config.attachments.retention_days, expected);
        assert!(parsed.warnings.is_empty());
    }
    for raw in [
        json!({}),
        json!([]),
        json!({"retentionDays":"30"}),
        json!({"retentionDays":0}),
    ] {
        let parsed = parse(&json!({"attachments":raw}));
        assert_eq!(
            parsed.config.attachments.retention_days,
            RetentionDays::Thirty
        );
        assert_eq!(codes(&parsed), vec![WarningCode::InvalidValue]);
    }
}
#[test]
fn new_session_defaults_keep_only_current_source_fields_and_types() {
    let raw = json!({"rememberLast":false,"future":"ignored","defaults":{"provider":"codex","claude":{"model":"sonnet[1m]","effort":"xhigh","approval":"workspace","mode":"warm","browser":true,"worktree":false,"serviceTier":"fast","source":"not a field"},"codex":{"model":"vendor/model:tag-1.0","effort":"ultra","approval":"ask","mode":"turn"},"zcode":{"model":"account-model","effort":"low"}}});
    let parsed = parse_new_session(Some(&raw));
    assert!(parsed.warnings.is_empty());
    assert!(!parsed.value.remember_last);
    assert_eq!(parsed.value.defaults.provider, Some(Provider::Codex));
    assert_eq!(
        parsed.value.defaults.claude.model.as_deref(),
        Some("sonnet[1m]")
    );
    assert_eq!(parsed.value.defaults.claude.browser, Some(true));
    assert_eq!(parsed.value.defaults.claude.worktree, Some(false));
    assert!(
        parsed.value.value()["defaults"]["claude"]
            .get("serviceTier")
            .is_none()
    );
    assert_eq!(
        parsed.value.defaults.zcode.model.as_deref(),
        Some("account-model")
    );
}
#[test]
fn new_session_full_and_inherit_are_never_defaults_for_any_provider() {
    for approval in ["full", "inherit"] {
        let parsed = parse(
            &json!({"newSession":{"defaults":{"claude":{"approval":approval},"codex":{"approval":approval},"zcode":{"approval":approval}}}}),
        );
        assert_eq!(parsed.config.new_session, NewSession::default());
        assert_eq!(codes(&parsed), vec![WarningCode::UnsafeDefault; 3]);
    }
    let parsed = parse(
        &json!({"newSession":{"rememberLast":"yes","defaults":{"provider":"opencode","claude":{"model":"bad space","effort":"UPPER","mode":"forever","browser":"yes","worktree":0},"codex":[],"zcode":null}}}),
    );
    assert_eq!(parsed.config.new_session, NewSession::default());
    assert_eq!(parsed.warnings.len(), 9);
}
#[test]
fn browser_defaults_follow_provider_and_approval_rules_without_fabricating_false() {
    let parsed = parse_new_session(Some(
        &json!({"defaults":{"claude":{"approval":"workspace","browser":true},"codex":{"approval":"workspace","browser":true},"zcode":{"browser":true}}}),
    ));
    assert_eq!(parsed.value.defaults.claude.browser, Some(true));
    assert_eq!(parsed.value.defaults.codex.browser, None);
    assert_eq!(parsed.value.defaults.zcode.browser, None);
    assert_eq!(parsed.warnings.len(), 2);
    let parsed = parse_new_session(Some(
        &json!({"defaults":{"claude":{"browser":false},"codex":{"browser":false},"zcode":{"browser":false}}}),
    ));
    assert!(parsed.warnings.is_empty());
    assert_eq!(parsed.value.defaults.zcode.browser, Some(false));
}
#[test]
fn normalized_serialization_roundtrips_and_never_mutates_future_raw_fields() {
    let raw = json!({"version":99,"future":{"PRIVATE":"retained by host"},"network":{"codex":{"mode":"required","proxy":" https://proxy ","future":true},"guard":{"mode":"allow","countries":["de","XK"]}},"newSession":{"defaults":{"provider":"claude","claude":{"model":"opus","effort":"high","approval":"ask"}}},"attachments":{"retentionDays":null},"disk":{"thresholdGb":8,"prompt":" custom "}});
    let original = raw.clone();
    let config = parse(&raw).config;
    let file = config.to_file();
    assert_eq!(file["version"], 1);
    assert!(file.get("guard").is_none());
    assert!(file.get("future").is_none());
    assert_eq!(
        file["network"]["guard"],
        json!({"mode":"allow","countries":["DE","XK"]})
    );
    assert_eq!(parse(&file).config, config);
    assert_eq!(raw, original);
    let parsed = parse(&RuntimeConfig::default().to_file());
    assert_eq!(parsed.config, RuntimeConfig::default());
    assert_eq!(codes(&parsed), vec![WarningCode::EmptyProxy; 4]);
}
#[test]
fn debug_and_warnings_never_echo_private_configuration_or_unknown_keys() {
    let parsed = parse(
        &json!({"network":{"claude":{"proxy":"https://user:PROXY_SECRET@host","mode":"INVALID_SECRET","noProxy":["PRIVATE_HOST"]}},"guardCountries":["COUNTRY_SECRET"],"notifyCommand":"echo COMMAND_SECRET","mcp":{"servers":["MCP_SECRET"]},"updates":{"url":"https://user:UPDATE_SECRET@host"},"disk":{"thresholdGb":6,"prompt":"PROMPT_SECRET"},"newSession":{"defaults":{"claude":{"model":"MODEL_SECRET"}}},"FUTURE_SECRET":"unknown"}),
    );
    let debug = format!(
        "{parsed:?} {:?} {:?} {:?} {:?} {:?} {:?}",
        parsed.config.network.claude,
        parsed.config.mcp,
        parsed.config.updates,
        parsed.config.disk,
        parsed.config.guard,
        parsed.config.new_session
    );
    for secret in [
        "PROXY_SECRET",
        "INVALID_SECRET",
        "PRIVATE_HOST",
        "COUNTRY_SECRET",
        "COMMAND_SECRET",
        "MCP_SECRET",
        "UPDATE_SECRET",
        "PROMPT_SECRET",
        "MODEL_SECRET",
        "FUTURE_SECRET",
    ] {
        assert!(!debug.contains(secret), "leaked {secret}");
    }
    assert_eq!(parsed.warnings[0].field, "network.claude.mode");
}
