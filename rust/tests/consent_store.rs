use chrono::{TimeZone, Utc};
use pult_core::{consent_store::ConsentStore, turn_snapshot::Provider};
use serde_json::json;
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
};

fn private_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700)).unwrap();
    home
}
fn now() -> chrono::DateTime<Utc> {
    Utc.timestamp_millis_opt(1_700_000_000_123).unwrap()
}
fn put(home: &std::path::Path, value: &[u8]) {
    let mut f = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(home.join("consent.json"))
        .unwrap();
    f.write_all(value).unwrap();
}
#[test]
fn missing_state_roundtrip_and_canonical_grant() {
    let home = private_home();
    let mut store = ConsentStore::open(home.path()).unwrap();
    assert_eq!(
        store.read().unwrap().value(),
        json!({"version":0,"rev":0,"providers":[]})
    );
    let granted = store
        .grant(
            &[Provider::Zcode, Provider::Claude, Provider::Claude],
            now(),
        )
        .unwrap();
    assert_eq!(
        granted.value(),
        json!({"version":1,"rev":1,"providers":["claude","zcode"],"grantedAt":"2023-11-14T22:13:20.123Z"})
    );
    assert_eq!(
        ConsentStore::open(home.path()).unwrap().read().unwrap(),
        granted
    );
    assert_eq!(
        fs::metadata(home.path().join("consent.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn node_wire_filters_and_deduplicates_without_reordering() {
    let home = private_home();
    put(home.path(),br#"{"version":2,"rev":4.0,"providers":["zcode",null,"claude","zcode","other",1e400],"grantedAt":"2024-01-01"}"#);
    let data = ConsentStore::open(home.path()).unwrap().read().unwrap();
    assert_eq!(data.providers, vec![Provider::Zcode, Provider::Claude]);
    assert_eq!(data.rev, 4);
    assert!(data.facts().covers(Provider::Zcode));
    assert!(!data.facts().covers(Provider::Codex));
}
#[test]
fn manual_revoke_is_immediate_and_grant_clears_it() {
    let home = private_home();
    let mut store = ConsentStore::open(home.path()).unwrap();
    store.grant(&[Provider::Claude], now()).unwrap();
    put(home.path(),br#"{"version":1,"rev":8,"providers":["claude"],"grantedAt":"2024-01-01","revokedAt":"2024-02-01"}"#);
    assert!(!store.read().unwrap().facts().covers(Provider::Claude));
    let data = store.grant(&[Provider::Claude], now()).unwrap();
    assert_eq!(data.rev, 9);
    assert!(data.revoked_at.is_none());
    assert!(data.facts().covers(Provider::Claude));
}
#[test]
fn delete_and_corrupt_keep_revision_high_water() {
    let home = private_home();
    put(home.path(), br#"{"version":1,"rev":42}"#);
    let mut store = ConsentStore::open(home.path()).unwrap();
    fs::remove_file(home.path().join("consent.json")).unwrap();
    assert_eq!(store.read().unwrap().rev, 0);
    put(home.path(), b"broken {");
    assert_eq!(store.read().unwrap().rev, 0);
    assert_eq!(store.grant(&[Provider::Codex], now()).unwrap().rev, 43);
}
#[test]
fn bad_fields_keep_valid_revision_and_negative_version() {
    let home = private_home();
    put(
        home.path(),
        br#"{"version":-12,"rev":51,"providers":"claude","grantedAt":5,"revokedAt":"bad"}"#,
    );
    let mut store = ConsentStore::open(home.path()).unwrap();
    let data = store.read().unwrap();
    assert_eq!(data.version, -12);
    assert_eq!(data.rev, 51);
    assert_eq!(data.facts().version, 0);
    assert!(data.granted_at.is_none());
    assert_eq!(store.revoke(now()).unwrap().version, -12);
}
#[test]
fn malformed_json_roots_and_fields_fail_closed() {
    let home = private_home();
    let mut store = ConsentStore::open(home.path()).unwrap();
    for input in [
        "null",
        "[]",
        "1",
        "{",
        "{\"rev\":9007199254740992,\"version\":true,\"providers\":{}}",
    ] {
        put(home.path(), input.as_bytes());
        assert_eq!(
            store.read().unwrap().value(),
            json!({"version":0,"rev":0,"providers":[]})
        );
    }
}
#[test]
fn date_grammar_retains_node_dates_and_rejects_invalid_clocks() {
    let home = private_home();
    let mut store = ConsentStore::open(home.path()).unwrap();
    for at in [
        "2024-01-01",
        "Mon, 01 Jan 2024 00:00:00 GMT",
        "2024-02-30T00:00:00Z",
    ] {
        put(
            home.path(),
            json!({"version":1,"providers":["claude"],"grantedAt":at})
                .to_string()
                .as_bytes(),
        );
        assert_eq!(store.read().unwrap().granted_at.as_deref(), Some(at));
    }
    for at in ["bad", "2024-01-01T00:00:60Z", "2024-01-01T25:00:00Z", ""] {
        put(
            home.path(),
            json!({"version":1,"providers":["claude"],"grantedAt":at})
                .to_string()
                .as_bytes(),
        );
        assert!(!store.read().unwrap().facts().covers(Provider::Claude));
    }
}
#[test]
fn revision_overflow_never_writes_even_after_delete() {
    let home = private_home();
    let original = br#"{"version":1,"rev":9007199254740991}"#;
    put(home.path(), original);
    let mut store = ConsentStore::open(home.path()).unwrap();
    assert!(store.revoke(now()).is_err());
    assert_eq!(
        fs::read(home.path().join("consent.json")).unwrap(),
        original
    );
    fs::remove_file(home.path().join("consent.json")).unwrap();
    assert!(store.grant(&[], now()).is_err());
    assert!(!home.path().join("consent.json").exists());
}
#[test]
fn public_permissions_are_rejected_without_repair() {
    let home = private_home();
    put(home.path(), b"{}");
    fs::set_permissions(
        home.path().join("consent.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(ConsentStore::open(home.path()).is_err());
    fs::remove_file(home.path().join("consent.json")).unwrap();
    fs::set_permissions(home.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ConsentStore::open(home.path()).is_err());
}
#[test]
fn symlinks_hardlinks_and_directories_are_rejected() {
    let home = private_home();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let path = home.path().join("consent.json");
    symlink(outside.path(), &path).unwrap();
    assert!(ConsentStore::open(home.path()).is_err());
    fs::remove_file(&path).unwrap();
    fs::hard_link(outside.path(), &path).unwrap();
    assert!(ConsentStore::open(home.path()).is_err());
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(ConsentStore::open(home.path()).is_err());
    let alias = home.path().with_extension("symlink");
    symlink(home.path(), &alias).unwrap();
    assert!(ConsentStore::open(&alias).is_err());
    fs::remove_file(alias).unwrap();
}
#[test]
fn oversized_files_are_bounded_and_never_overwritten() {
    let home = private_home();
    let mut store = ConsentStore::open(home.path()).unwrap();
    let original = vec![b' '; 65537];
    put(home.path(), &original);
    assert!(store.read().is_err());
    assert!(store.revoke(now()).is_err());
    assert_eq!(
        fs::read(home.path().join("consent.json")).unwrap(),
        original
    );
}
#[test]
fn independent_stores_refresh_each_others_writes() {
    let home = private_home();
    let mut first = ConsentStore::open(home.path()).unwrap();
    let mut second = ConsentStore::open(home.path()).unwrap();
    first.grant(&[Provider::Codex], now()).unwrap();
    assert!(second.read().unwrap().facts().covers(Provider::Codex));
    assert_eq!(second.revoke(now()).unwrap().rev, 2);
    assert!(!first.read().unwrap().facts().covers(Provider::Codex));
    assert_eq!(first.grant(&[], now()).unwrap().rev, 3);
}

#[test]
fn unrecognized_revocation_dates_never_restore_a_grant() {
    let home = private_home();
    let mut store = ConsentStore::open(home.path()).unwrap();
    // V8 accepts the two short-year dates; date_millis deliberately does not.
    // Other unrecognized strings conservatively block too, because this parser
    // cannot prove that a future/other Node dialect would reject them.
    for (index, at) in ["01/01/01", "12/31/99", "not a date", ""]
        .into_iter()
        .enumerate()
    {
        put(home.path(), json!({"version":1,"rev":90,"providers":["claude"],"grantedAt":"2024-01-01","revokedAt":at}).to_string().as_bytes());
        let data = store.read().unwrap();
        assert!(!data.facts().covers(Provider::Claude), "revokedAt={at}");
        assert!(data.value().get("grantedAt").is_none());
        assert_eq!(data.value()["providers"], json!([]));
        assert_eq!(data.value()["revokedAt"], at);
        let granted = store.grant(&[Provider::Claude], now()).unwrap();
        assert_eq!(granted.rev, 91 + index as u64);
        assert!(granted.facts().covers(Provider::Claude));
        assert!(granted.value().get("revokedAt").is_none());
    }
}

#[test]
fn debug_redacts_untrusted_revocation_and_other_raw_date_strings() {
    let home = private_home();
    let sentinel = "private-consent-revocation-secret";
    put(
        home.path(),
        json!({"version":1,"rev":9,"grantedAt":"2024-01-01","revokedAt":sentinel})
            .to_string()
            .as_bytes(),
    );
    let data = ConsentStore::open(home.path()).unwrap().read().unwrap();
    let debug = format!("{data:?}");
    assert!(!debug.contains(sentinel));
    assert!(!debug.contains("2024-01-01"));
    assert!(debug.contains("uncertain_revocation: true"));
}
