use pult_core::session_live::{Cache, Error, Status, reduce};
use pult_core::turn_snapshot::SessionKey;
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
fn key(name: &str, created: &str) -> SessionKey {
    SessionKey {
        name: name.into(),
        created_at: created.into(),
    }
}
fn cache() -> (Cache, SessionKey) {
    let mut c = Cache::new(2).unwrap();
    let k = key("chat", "first");
    c.seed(k.clone(), Status::Cold, 0).unwrap();
    (c, k)
}
#[test]
fn all_statuses_parse_and_helpers_match_current_nine_node_states() {
    for s in Status::ALL {
        assert_eq!(Status::parse(s.as_str()), Some(s));
        assert_eq!(s.is_terminal(), matches!(s, Status::Done | Status::Failed));
        assert_eq!(
            s.needs_human(),
            matches!(s, Status::BlockedPermission | Status::BlockedQuestion)
        );
    }
    for invalid in ["", "Working", "stopped", "ready", " working"] {
        assert_eq!(Status::parse(invalid), None);
    }
}
#[test]
fn every_state_kind_warning_and_malformed_shape_matches_actual_node24_reducer() {
    let kinds = [
        "session.started",
        "session.ended",
        "provider.blocked",
        "net.blocked",
        "permission.requested",
        "permission.resolved",
        "question.asked",
        "limit.hit",
        "message.delta",
        "message.done",
        "tool.called",
        "tool.finished",
        "agent.spawned",
        "agent.finished",
        "usage.updated",
        "context.updated",
        "message.user",
        "background.changed",
        "unknown",
        "status.changed",
    ];
    let mut data = vec![
        json!({}),
        json!({"status":"allowed_warning"}),
        json!({"rateLimitStatus":"allowed_warning"}),
        json!({"status":"limited","rateLimitStatus":"allowed_warning"}),
        json!({"status":"working","parentId":"child"}),
        json!({"status":"not-a-status"}),
        json!({"status":false}),
        json!({"status":null}),
        json!({"status":["done"]}),
        json!([]),
        json!(2),
        json!(false),
        json!("working"),
        Value::Null,
    ];
    data.extend(Status::ALL.map(|s| json!({"status":s.as_str()})));
    let cases: Vec<Value> = Status::ALL
        .into_iter()
        .flat_map(|s| {
            kinds
                .into_iter()
                .flat_map(|k| data.iter().map(move |d| json!([s.as_str(), k, d])))
                .collect::<Vec<_>>()
        })
        .collect();
    let corpus = serde_json::to_vec(&cases).unwrap();
    assert!(corpus.len() < 2 * 1024 * 1024);
    const SCRIPT: &str = r#"
const fs=require('node:fs');const{pathToFileURL}=require('node:url');
(async()=>{if(!process.version.startsWith('v24.'))throw Error('Node24');
const{reduceStatusEvent}=await import(pathToFileURL(process.argv[1]).href);
const rows=JSON.parse(fs.readFileSync(0,'utf8')).map(([s,kind,data])=>{try{return reduceStatusEvent(s,{kind,data})}catch{return null}});
const out=JSON.stringify(rows);if(Buffer.byteLength(out)>1048576)throw Error('budget');process.stdout.write(out);
})().catch(()=>{process.stderr.write('Build actual Node24 dist/sessions/status.js with tsc -p tsconfig.json');process.exitCode=1});
"#;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/sessions/status.js");
    let output = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let mut child = tokio::process::Command::new("node")
                .arg("-e")
                .arg(SCRIPT)
                .arg(path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(&corpus).await.unwrap();
                stdin.shutdown().await.unwrap();
                drop(stdin);
                child.wait_with_output().await.unwrap()
            })
            .await
            .expect("Node reducer watchdog")
        });
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(expected.len(), cases.len());
    let mut exceptions = 0;
    for (case, expected) in cases.iter().zip(expected) {
        let previous = Status::parse(case[0].as_str().unwrap()).unwrap();
        let kind = case[1].as_str().unwrap();
        let actual = reduce(previous, kind, &case[2]);
        if expected.is_null() {
            exceptions += 1;
            assert!(case[2].is_null());
            assert_eq!(actual, previous);
        } else {
            assert_eq!(json!(actual.as_str()), expected, "{case}");
        }
    }
    assert_eq!(exceptions, Status::ALL.len() * 2); // null status.changed/limit.hit are Node-invalid
}
#[test]
fn background_activity_never_resurrects_ended_or_waiting_statuses() {
    for s in Status::ALL {
        for kind in [
            "message.delta",
            "tool.finished",
            "agent.finished",
            "context.updated",
            "message.user",
        ] {
            assert_eq!(reduce(s, kind, &json!({})), s);
        }
    }
}
#[test]
fn init_preserves_working_but_other_states_become_idle() {
    for s in Status::ALL {
        assert_eq!(
            reduce(s, "session.started", &json!({})),
            if s == Status::Working {
                Status::Working
            } else {
                Status::Idle
            }
        );
    }
}
#[test]
fn cache_changes_only_on_status_change_with_receipt_of_that_change() {
    let (mut c, k) = cache();
    let change = c
        .note("chat", 1, "status.changed", &json!({"status":"working"}))
        .unwrap();
    assert_eq!(change.key, k);
    assert_eq!(change.status, Status::Working);
    assert_eq!(change.event_id, 1);
    assert!(
        c.note("chat", 2, "message.delta", &json!({"text":"not retained"}))
            .is_none()
    );
    assert!(
        c.note("chat", 3, "status.changed", &json!({"status":"working"}))
            .is_none()
    );
    assert_eq!(c.view(&k).unwrap().status_event_id, 1);
}
#[test]
fn stale_duplicate_and_globally_out_of_order_events_are_rejected() {
    let (mut c, k) = cache();
    let other = key("other", "first");
    c.seed(other.clone(), Status::Cold, 0).unwrap();
    c.note("chat", 5, "session.ended", &json!({})).unwrap();
    for id in [0, 3, 5, u64::MAX] {
        assert!(
            c.note("chat", id, "status.changed", &json!({"status":"working"}))
                .is_none()
        );
    }
    assert!(c.note("other", 4, "session.ended", &json!({})).is_none());
    assert_eq!(c.view(&other).unwrap().status, Status::Cold);
    assert_eq!(c.view(&k).unwrap().status, Status::Done);
    assert!(c.note("other", 6, "session.ended", &json!({})).is_some());
}
#[test]
fn metadata_only_events_advance_order_guard_without_changing_status_receipt() {
    let (mut c, k) = cache();
    assert!(
        c.note("chat", 10, "usage.updated", &json!({"input_tokens":1}))
            .is_none()
    );
    assert!(c.note("chat", 9, "session.ended", &json!({})).is_none());
    assert_eq!(c.view(&k).unwrap().status_event_id, 0);
}
#[test]
fn unknown_sessions_do_not_allocate_slots_or_retain_payloads() {
    let (mut c, k) = cache();
    assert!(c.can_register());
    for id in 1..1000 {
        assert!(
            c.note(
                &format!("unknown{id}"),
                id,
                "session.ended",
                &json!({"text":"private"})
            )
            .is_none()
        );
    }
    assert!(c.seed(key("second", "created"), Status::Idle, 0).is_ok());
    assert!(!c.can_register());
    assert_eq!(
        c.seed(key("third", "created"), Status::Cold, 0),
        Err(Error::Capacity)
    );
    assert!(c.seed(key("second", "replacement"), Status::Idle, 0).is_ok());
    assert!(!c.can_register());
    assert!(c.remove(&key("second", "replacement")));
    assert!(c.can_register());
    assert_eq!(c.view(&k).unwrap().status, Status::Cold);
    assert!(!format!("{c:?}").contains("private"));
    assert!(!format!("{c:?}").contains("chat"));
}
#[test]
fn reseed_replaces_incarnation_and_old_cleanup_cannot_remove_it() {
    let (mut c, old) = cache();
    c.note("chat", 1, "session.ended", &json!({}));
    let new = key("chat", "second");
    c.seed(new.clone(), Status::Cold, 1).unwrap();
    assert!(c.view(&old).is_none());
    assert!(!c.remove(&old));
    assert_eq!(c.view(&new).unwrap().status, Status::Cold);
    assert!(
        c.note("chat", 2, "status.changed", &json!({"status":"working"}))
            .is_some()
    );
    assert!(c.remove(&new));
    assert!(!c.remove(&new));
}
#[test]
fn seed_uses_recovered_registry_status_without_replaying_historical_working() {
    let (mut c, k) = cache();
    c.seed(k.clone(), Status::Cold, 100).unwrap();
    assert!(
        c.note("chat", 99, "status.changed", &json!({"status":"working"}))
            .is_none()
    );
    assert_eq!(c.view(&k).unwrap().status, Status::Cold);
    c.seed(k.clone(), Status::Failed, 101).unwrap();
    assert_eq!(c.view(&k).unwrap().status, Status::Failed);
}
#[test]
fn invalid_seed_is_atomic_and_capacity_is_bounded() {
    assert!(matches!(Cache::new(0), Err(Error::Invalid)));
    assert!(matches!(Cache::new(65537), Err(Error::Invalid)));
    let (mut c, k) = cache();
    assert_eq!(
        c.seed(key("../bad", "x"), Status::Done, 0),
        Err(Error::Invalid)
    );
    assert_eq!(
        c.seed(k.clone(), Status::Done, u64::MAX),
        Err(Error::Invalid)
    );
    assert_eq!(c.view(&k).unwrap().status, Status::Cold);
}
#[test]
fn terminal_and_human_events_follow_source_even_from_terminal_states() {
    assert_eq!(
        reduce(Status::Done, "permission.requested", &json!({})),
        Status::BlockedPermission
    );
    assert_eq!(
        reduce(Status::Failed, "question.asked", &json!({})),
        Status::BlockedQuestion
    );
    assert_eq!(
        reduce(Status::BlockedQuestion, "session.ended", &json!({})),
        Status::Done
    );
    assert_eq!(
        reduce(Status::BlockedPermission, "permission.resolved", &json!({})),
        Status::Working
    );
    assert_eq!(
        reduce(Status::Failed, "permission.resolved", &json!({})),
        Status::Failed
    );
}
