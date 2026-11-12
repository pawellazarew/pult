//! Private real-filesystem metadata fixtures; no provider/network/process calls.
use pult_core::consent_store::ConsentStore;
use pult_core::journal::EventStore;
use pult_core::registry::{Record, Registry};
use pult_core::session_create::{ClientKind, CreateError, create};
use pult_core::turn_snapshot::{Approval, Provider, TurnSnapshot};
use serde_json::{Value, json};
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::PathBuf;
use std::sync::{Arc, Barrier, Mutex};
struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    project: PathBuf,
    registry: Arc<Mutex<Registry>>,
    consent: Arc<Mutex<ConsentStore>>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let home = root.join("home");
        let project = root.join("project");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir(&project).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut events = EventStore::open(&home.join("events")).unwrap();
        let registry = Arc::new(Mutex::new(Registry::open(&home, &mut events).unwrap()));
        let consent = Arc::new(Mutex::new(ConsentStore::open(&home).unwrap()));
        Self {
            _temp: temp,
            home,
            project,
            registry,
            consent,
        }
    }
    fn params(&self) -> Value {
        json!({"name":"chat","cwd":self.project})
    }
    fn create(&self, p: Value) -> Result<Record, CreateError> {
        create(
            &self.home,
            &self.registry,
            &self.consent,
            &p,
            ClientKind::Other,
            123,
        )
    }
}
#[test]
fn project_creation_is_cold_metadata_only_and_optional_settings_are_validated() {
    let f = Fixture::new();
    let mut p = f.params();
    p["kind"] = json!("codex");
    p["model"] = json!("vendor/gpt-5");
    p["effort"] = json!("xhigh");
    p["serviceTier"] = json!("fast");
    p["mode"] = json!("warm");
    let r = f.create(p).unwrap();
    assert_eq!(r.scalar("lastStatus").as_deref(), Some("cold"));
    assert_eq!(r.scalar("lastSeenEventId").as_deref(), None);
    assert_eq!(r.get("lastSeenEventId").unwrap().get(), "123");
    assert!(r.get("providerSessionId").is_none());
    assert!(r.get("grant").is_none());
    let s = TurnSnapshot::try_from(&r).unwrap();
    assert_eq!(s.provider, Provider::Codex);
    assert_eq!(s.cwd, f.project);
    assert_eq!(s.settings.approval, Approval::Ask);
    assert!(
        f.home
            .join("events/journal.jsonl")
            .metadata()
            .unwrap()
            .len()
            == 0
    );
}
#[test]
fn default_provider_and_generated_name_are_bounded_ascii_and_creation_ids_unique() {
    let f = Fixture::new();
    let a = f.create(json!({"cwd":f.project})).unwrap();
    let b = f.create(json!({"cwd":f.project})).unwrap();
    assert_eq!(a.scalar("provider").as_deref(), Some("claude"));
    assert_ne!(a.name(), b.name());
    assert!(a.name().len() <= 32);
    assert!(a.name().is_ascii());
    assert_ne!(a.scalar("createdAt"), b.scalar("createdAt"));
    assert!(chrono::DateTime::parse_from_rfc3339(&a.scalar("createdAt").unwrap()).is_ok());
}
#[test]
fn full_requires_confirmation_and_fresh_provider_consent_revision() {
    let f = Fixture::new();
    let mut p = f.params();
    p["kind"] = json!("codex");
    p["approval"] = json!("full");
    assert_eq!(f.create(p.clone()).unwrap_err(), CreateError::Invalid);
    p["confirm"] = json!(true);
    assert_eq!(
        f.create(p.clone()).unwrap_err(),
        CreateError::ConsentRequired
    );
    let c = f
        .consent
        .lock()
        .unwrap()
        .grant(&[Provider::Codex], chrono::Utc::now())
        .unwrap();
    p["consentRev"] = json!(c.rev);
    f.consent
        .lock()
        .unwrap()
        .revoke(chrono::Utc::now())
        .unwrap();
    assert_eq!(
        f.create(p.clone()).unwrap_err(),
        CreateError::ConsentChanged
    );
    let c = f
        .consent
        .lock()
        .unwrap()
        .grant(&[Provider::Codex], chrono::Utc::now())
        .unwrap();
    p["consentRev"] = json!(c.rev);
    let r = f.create(p).unwrap();
    assert_eq!(
        TurnSnapshot::try_from(&r).unwrap().settings.approval,
        Approval::Full
    );
    assert!(r.get("grant").is_none());
}
#[test]
fn cli_grant_needs_confirmation_and_shell_cannot_request_it_even_on_ask() {
    let f = Fixture::new();
    let mut p = f.params();
    p["grant"] = json!("cli-once");
    assert_eq!(
        create(&f.home, &f.registry, &f.consent, &p, ClientKind::Shell, 0).unwrap_err(),
        CreateError::Forbidden
    );
    let ask = f.create(p.clone()).unwrap();
    assert!(ask.get("grant").is_none());
    p["name"] = json!("full");
    p["approval"] = json!("full");
    assert_eq!(f.create(p.clone()).unwrap_err(), CreateError::Invalid);
    p["confirm"] = json!(true);
    assert_eq!(
        f.create(p).unwrap().scalar("grant").as_deref(),
        Some("cli-once")
    );
}
#[test]
fn wrong_provider_consent_never_implicitly_widens() {
    let f = Fixture::new();
    f.consent
        .lock()
        .unwrap()
        .grant(&[Provider::Claude], chrono::Utc::now())
        .unwrap();
    let mut p = f.params();
    p["kind"] = json!("codex");
    p["approval"] = json!("full");
    p["confirm"] = json!(true);
    assert_eq!(f.create(p).unwrap_err(), CreateError::ConsentRequired);
    assert_eq!(
        TurnSnapshot::try_from(&f.create(f.params()).unwrap())
            .unwrap()
            .settings
            .approval,
        Approval::Ask
    );
}
#[test]
fn duplicate_concurrent_creation_commits_exactly_one_record() {
    let f = Fixture::new();
    let barrier = Arc::new(Barrier::new(3));
    let results = std::thread::scope(|scope| {
        let mut joins = vec![];
        for _ in 0..2 {
            let barrier = barrier.clone();
            let f = &f;
            joins.push(scope.spawn(move || {
                barrier.wait();
                f.create(f.params())
            }));
        }
        barrier.wait();
        joins
            .into_iter()
            .map(|j| j.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(CreateError::Duplicate)))
            .count(),
        1
    );
    assert_eq!(f.registry.lock().unwrap().records().len(), 1);
}
#[test]
fn general_workspace_is_owned_private_distinct_and_valid() {
    let f = Fixture::new();
    let r = f.create(json!({"scope":"general","name":"chat"})).unwrap();
    let cwd = PathBuf::from(r.scalar("cwd").unwrap());
    pult_core::host_paths::validate_general(&f.home, "chat", &cwd).unwrap();
    for p in [&cwd, &f.home.join("conversations")] {
        assert_eq!(
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(r.scalar("scope").as_deref(), Some("general"));
    assert!(
        cwd.file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("chat-")
    );
    assert_eq!(cwd.file_name().unwrap().to_str().unwrap().len(), 11);
}
#[test]
fn general_symlink_or_nonprivate_root_is_rejected_without_outside_writes() {
    for link in [true, false] {
        let f = Fixture::new();
        let root = f.home.join("conversations");
        if link {
            symlink(&f.project, &root).unwrap();
        } else {
            std::fs::create_dir(&root).unwrap();
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            f.create(json!({"scope":"general","name":"chat"}))
                .unwrap_err(),
            CreateError::Invalid
        );
        assert_eq!(std::fs::read_dir(&f.project).unwrap().count(), 0);
        assert!(f.registry.lock().unwrap().records().is_empty());
    }
}
#[test]
fn home_ancestor_alias_rejected_except_read_only_and_project_alias_canonicalized() {
    let f = Fixture::new();
    let alias = f.home.parent().unwrap().join("alias");
    symlink(f.home.parent().unwrap(), &alias).unwrap();
    let mut p = f.params();
    p["cwd"] = json!(alias);
    assert_eq!(f.create(p.clone()).unwrap_err(), CreateError::Invalid);
    p["approval"] = json!("read-only");
    assert!(f.create(p).is_ok());
    let alias = f.home.join("project-alias");
    symlink(&f.project, &alias).unwrap();
    assert_eq!(
        f.create(json!({"name":"other","cwd":alias}))
            .unwrap()
            .scalar("cwd")
            .unwrap(),
        f.project.to_str().unwrap()
    );
}
#[test]
fn title_normalizes_controls_uses_codepoints_and_rejects_long_before_general_mkdir() {
    let f = Fixture::new();
    let r = f
        .create(json!({"scope":"general","name":"chat","title":"  hi\n\u{202e}🌊  "}))
        .unwrap();
    assert_eq!(r.scalar("title").as_deref(), Some("hi 🌊"));
    let f = Fixture::new();
    assert_eq!(
        f.create(json!({"scope":"general","name":"chat","title":"🌊".repeat(201)}))
            .unwrap_err(),
        CreateError::Invalid
    );
    assert!(!f.home.join("conversations").exists());
}
#[test]
fn unsupported_start_features_and_inherit_refuse_before_mutation() {
    for field in [
        "requestId",
        "draft",
        "prompt",
        "attachments",
        "worktree",
        "base",
        "folderRef",
        "folder",
        "remember",
        "rememberCwd",
        "origin",
        "link",
        "settingSources",
        "reserveOnly",
    ] {
        let f = Fixture::new();
        let mut p = json!({"scope":"general","name":"chat"});
        p[field] = Value::Null;
        assert_eq!(f.create(p).unwrap_err(), CreateError::Unsupported);
        assert!(!f.home.join("conversations").exists());
        assert!(f.registry.lock().unwrap().records().is_empty());
    }
    let f = Fixture::new();
    assert_eq!(
        f.create(json!({"scope":"general","approval":"inherit"}))
            .unwrap_err(),
        CreateError::Unsupported
    );
    assert!(!f.home.join("conversations").exists());
}
#[test]
fn malformed_settings_and_paths_leave_no_general_or_record() {
    for patch in [
        json!({"kind":"wrong"}),
        json!({"name":"../bad"}),
        json!({"model":"bad model"}),
        json!({"effort":"LOUD"}),
        json!({"serviceTier":"fast"}),
        json!({"mode":"wrong"}),
        json!({"title":null}),
        json!({"confirm":"true"}),
        json!({"consentRev":-1}),
        json!({"browser":{}}),
    ] {
        let f = Fixture::new();
        let mut p = json!({"scope":"general"});
        p.as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(f.create(p).is_err());
        assert!(!f.home.join("conversations").exists());
        assert!(f.registry.lock().unwrap().records().is_empty());
    }
    let f = Fixture::new();
    for cwd in ["relative", "/not-a-real-create-fixture-dir"] {
        assert_eq!(
            f.create(json!({"cwd":cwd})).unwrap_err(),
            CreateError::Invalid
        );
    }
}
#[test]
fn disabled_browser_is_accepted_without_persisting_browser() {
    for browser in [Value::Null, json!(false)] {
        let f = Fixture::new();
        let mut p = f.params();
        p["browser"] = browser;
        assert!(f.create(p).unwrap().get("browser").is_none());
    }
}
#[test]
fn failed_registry_commit_leaves_only_private_orphan_never_outside_cleanup() {
    let f = Fixture::new();
    std::fs::write(f.home.join("sessions.json"), "changed outside owner").unwrap();
    assert_eq!(
        f.create(json!({"scope":"general","name":"chat"}))
            .unwrap_err(),
        CreateError::Storage
    );
    assert!(f.registry.lock().unwrap().records().is_empty());
    let children = std::fs::read_dir(f.home.join("conversations"))
        .unwrap()
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 1);
    let child = children[0].as_ref().unwrap().path();
    pult_core::host_paths::validate_general(&f.home, "chat", &child).unwrap();
    assert_eq!(std::fs::read_dir(child).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&f.project).unwrap().count(), 0);
}
#[test]
fn safe_journal_id_and_static_errors_do_not_expose_private_input() {
    let f = Fixture::new();
    assert_eq!(
        create(
            &f.home,
            &f.registry,
            &f.consent,
            &f.params(),
            ClientKind::Other,
            u64::MAX
        )
        .unwrap_err(),
        CreateError::Invalid
    );
    let err = f
        .create(json!({"cwd":"/private/secret-not-real"}))
        .unwrap_err();
    assert_eq!(format!("{err:?}"), "Invalid");
    assert_eq!(err.to_string(), "invalid_params");
}
