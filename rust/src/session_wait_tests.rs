//! Actual State/Driver/Registry and connection tests, with no native executable.
use super::*;
use crate::turn_driver::EventSink;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const BOUND: Duration = Duration::from_secs(3);
async fn fixture() -> (tempfile::TempDir, Arc<State>, Arc<dyn EventSink>) {
    fixture_provider("codex").await
}
async fn fixture_provider(kind: &str) -> (tempfile::TempDir, Arc<State>, Arc<dyn EventSink>) {
    let (home, state, sink) = crate::runtime_journal::tests::fixture();
    crate::session_runtime_api::execute(
        state.clone(),
        "agent.start",
        json!({"name":"alpha","kind":kind,"scope":"general","approval":"ask"}),
        crate::host_policy::ClientKind::Other,
        "wait-test",
    )
    .await
    .unwrap_or_else(|error| panic!("metadata: {}", error.code));
    assert!(state.native_runtime.get().is_none());
    assert!(state.claude_runtime.get().is_none());
    assert!(state.zcode_runtime.get().is_none());
    (home, state, sink)
}

#[tokio::test]
async fn pending_broker_card_overrides_stale_cache_without_starting_a_provider() {
    let (_home, state, sink) = fixture().await;
    sink.append(json!({"sessionId":"alpha","provider":"codex","kind":"status.changed","data":{"status":"idle"}})).await.unwrap();
    let broker = crate::permission_state::instance(&state).await.unwrap();
    let mut question = broker
        .request(crate::permission_broker::PermissionRequest {
            session_id: "alpha".into(),
            tool_name: "fixture".into(),
            tool_use_id: None,
            input: json!({"command":"fixture-only"}),
            offers: Default::default(),
            concealed: false,
        })
        .unwrap();
    tokio::time::timeout(BOUND, async {
        while broker.list(Some("alpha")).is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // Force a stale idle cache only after the broker's durable requested-card
    // publication barrier. The live pending card must still win this lookup.
    sink.append(json!({"sessionId":"alpha","provider":"codex","kind":"status.changed","data":{"status":"idle"}})).await.unwrap();
    let result = invoke(state.clone(), json!({"name":"alpha","timeoutMs":0}))
        .await
        .unwrap_or_else(|e| panic!("{}", e.code));
    assert_eq!(
        result,
        json!({"name":"alpha","status":"blocked_permission","reason":"matched"})
    );
    assert!(state.native_runtime.get().is_none());
    assert!(state.claude_runtime.get().is_none());
    assert!(state.zcode_runtime.get().is_none());
    broker.shutdown();
    assert!(matches!(
        tokio::time::timeout(BOUND, question.decision())
            .await
            .unwrap(),
        crate::permission_broker::Decision::Deny { .. }
    ));
    tokio::time::timeout(BOUND, question.drained())
        .await
        .unwrap();
    tokio::time::timeout(BOUND, broker.drain()).await.unwrap();
}
fn query(params: Value) -> Query {
    let wire = serde_json::to_vec(&json!({"id":1,"method":"agent.wait","params":params})).unwrap();
    parse(&wire)
        .unwrap()
        .1
        .unwrap_or_else(|error| panic!("{}", error.code))
}
async fn invoke(state: Arc<State>, params: Value) -> Result<Value, ApiError> {
    let permit = state.session_waits.admit()?;
    let result = wait(state, query(params), permit).await?;
    Ok(serde_json::from_str(result.get()).unwrap())
}
async fn line(reader: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    assert_ne!(
        tokio::time::timeout(BOUND, reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    serde_json::from_str(&line).unwrap()
}
async fn write(reader: &mut BufReader<UnixStream>, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    reader.get_mut().write_all(&bytes).await.unwrap();
}
async fn connection(
    state: Arc<State>,
) -> (
    BufReader<UnixStream>,
    tokio::task::JoinHandle<anyhow::Result<()>>,
) {
    let (client, server) = UnixStream::pair().unwrap();
    let shutdown = state.stop.subscribe();
    let task = tokio::spawn(crate::connection(server, state, shutdown));
    let mut reader = BufReader::new(client);
    write(
        &mut reader,
        json!({"type":"hello","protocol":1,"token":"fixture","client":"cli"}),
    )
    .await;
    assert_eq!(line(&mut reader).await["type"], "hello_ok");
    (reader, task)
}

#[tokio::test]
async fn recovered_status_matches_without_inventing_an_outcome_or_starting_a_provider() {
    let (_home, state, sink) = fixture().await;
    sink.append(json!({"sessionId":"alpha","provider":"codex","kind":"status.changed","data":{"status":"failed"}})).await.unwrap();
    let value = invoke(state.clone(), json!({"name":"alpha","timeoutMs":0}))
        .await
        .unwrap_or_else(|e| panic!("{}", e.code));
    assert_eq!(
        value,
        json!({"name":"alpha","status":"failed","reason":"matched"})
    );
    let key = SessionKey {
        name: "alpha".into(),
        created_at: state
            .registry
            .lock()
            .unwrap()
            .find("alpha")
            .unwrap()
            .scalar("createdAt")
            .unwrap(),
    };
    assert!(state.driver.get().unwrap().latest_progress(&key).is_none());
    assert!(state.native_runtime.get().is_none());
    state.driver.get().unwrap().report_storage_failure();
    assert_eq!(
        invoke(state, json!({"name":"alpha","timeoutMs":0}))
            .await
            .err()
            .unwrap()
            .code,
        "storage_unavailable"
    );
}

#[tokio::test]
async fn closed_driver_is_not_healthy_absence_even_when_cached_status_matches() {
    let (_home, state, sink) = fixture().await;
    sink.append(json!({"sessionId":"alpha","provider":"codex","kind":"status.changed","data":{"status":"idle"}})).await.unwrap();
    state.driver.get().unwrap().shutdown(BOUND).await.unwrap();
    assert_eq!(
        invoke(state, json!({"name":"alpha","timeoutMs":0}))
            .await
            .err()
            .unwrap()
            .code,
        "closed"
    );
}

struct HostWorker {
    turn_id: &'static str,
    done: std::sync::Mutex<
        Option<tokio::sync::oneshot::Receiver<crate::turn_completion::WorkerCompletion>>,
    >,
}

fn normalized(
    ticket: &crate::turn_coordinator::Ticket,
    key: &SessionKey,
    is_error: bool,
    text: &str,
) -> crate::turn_completion::WorkerCompletion {
    let mut normalizer = crate::claude_events::Normalizer::new(
        crate::claude_events::Binding {
            session: key.clone(),
            ticket: ticket.clone(),
            generation: 1,
            provider_session_id: "fixture-session".into(),
            public_turn_id: "normalizer-id-is-not-driver-authority".into(),
            user_message_uuid: "fixture-user".into(),
            session_started: true,
        },
        Default::default(),
        Box::new(crate::claude_events::LogRedactor),
    )
    .unwrap();
    let batch = normalizer.push(
        &crate::claude_events::TrustedCallback {
            generation: 1,
            ticket: ticket.clone(),
        },
        &json!({
            "type":"result", "session_id":"fixture-session",
            "user_message_uuids":["fixture-user"], "is_error":is_error,
            "terminal_reason":if is_error {"api_error"} else {"completed"},
            "result":text,
        }),
    );
    assert!(batch.fault.is_none());
    crate::turn_completion::WorkerCompletion::normalized(
        if is_error {
            crate::turn_coordinator::Outcome::Failure {
                code: "provider_unavailable".into(),
                message: text.into(),
            }
        } else {
            crate::turn_coordinator::Outcome::Success
        },
        batch.terminal.expect("controlled native terminal"),
    )
}

#[tokio::test]
async fn qualified_final_answer_is_exact_reusable_and_failure_bypasses_unknown_until() {
    for is_error in [false, true] {
        let (_home, state, sink) = fixture_provider("claude").await;
        // A prior durable assistant answer is deliberately unrelated to the
        // final result, so concatenating history cannot satisfy this test.
        sink.append(json!({"sessionId":"alpha","provider":"claude","kind":"message.done","data":{"role":"assistant","text":"old-unrelated-answer"}})).await.unwrap();
        let snapshot = {
            let registry = state.registry.lock().unwrap();
            crate::turn_snapshot::TurnSnapshot::try_from(registry.find("alpha").unwrap()).unwrap()
        };
        let (done, receiver) = tokio::sync::oneshot::channel();
        let mut handle = state
            .driver
            .get()
            .unwrap()
            .start(
                snapshot.clone(),
                "fixture".into(),
                Arc::new(HostWorker {
                    turn_id: "host-fixture-turn",
                    done: std::sync::Mutex::new(Some(receiver)),
                }),
            )
            .unwrap();
        handle.accepted().await.unwrap();
        assert!(
            done.send(normalized(
                handle.ticket(),
                &snapshot.key,
                is_error,
                "exact-final-answer"
            ))
            .is_ok()
        );
        handle.wait().await.unwrap();
        for _ in 0..2 {
            let result = invoke(state.clone(), json!({"name":"alpha","timeoutMs":-1,"until":if is_error {json!(["UNKNOWN"])} else {json!(["idle"])}}))
                .await.unwrap_or_else(|e|panic!("{}",e.code));
            let expected = if is_error {
                json!({"name":"alpha","status":"failed","reason":"matched","turnId":"host-fixture-turn","ok":false,"errorCode":"provider_unavailable","text":"exact-final-answer","message":"exact-final-answer"})
            } else {
                json!({"name":"alpha","status":"idle","reason":"matched","turnId":"host-fixture-turn","ok":true,"text":"exact-final-answer"})
            };
            assert_eq!(result, expected);
        }
        assert_eq!(state.host_jobs.active(), 0);
        assert!(state.native_runtime.get().is_none());
        assert!(state.claude_runtime.get().is_none());
    }
}
impl crate::turn_driver::Worker for HostWorker {
    fn start(
        &self,
        _ticket: crate::turn_coordinator::Ticket,
        _snapshot: crate::turn_snapshot::TurnSnapshot,
        _text: String,
    ) -> crate::turn_driver::Task<
        Result<crate::turn_driver::Started, crate::turn_driver::WorkerError>,
    > {
        let done = self.done.lock().unwrap().take().unwrap();
        let turn_id = self.turn_id;
        Box::pin(async move {
            Ok(crate::turn_driver::Started {
                turn_id: turn_id.into(),
                done: Box::pin(async move {
                    done.await.unwrap_or_else(|_| {
                        crate::turn_completion::WorkerCompletion::from(
                            crate::turn_coordinator::Outcome::Interrupted,
                        )
                    })
                }),
            })
        })
    }
    fn close(
        &self,
        _ticket: crate::turn_coordinator::Ticket,
    ) -> crate::turn_driver::Task<Result<(), crate::turn_driver::WorkerError>> {
        Box::pin(async { Ok(()) })
    }
}
#[tokio::test]
async fn pending_cache_cannot_complete_and_ineligible_host_completion_never_reads_answer() {
    let (_home, state, sink) = fixture().await;
    let snapshot = {
        let registry = state.registry.lock().unwrap();
        crate::turn_snapshot::TurnSnapshot::try_from(registry.find("alpha").unwrap()).unwrap()
    };
    let (done, receiver) = tokio::sync::oneshot::channel();
    let worker = Arc::new(HostWorker {
        turn_id: "host-fixture-turn",
        done: std::sync::Mutex::new(Some(receiver)),
    });
    let mut handle = state
        .driver
        .get()
        .unwrap()
        .start(snapshot, "fixture".into(), worker)
        .unwrap();
    handle.accepted().await.unwrap();
    sink.append(json!({"sessionId":"alpha","provider":"codex","kind":"status.changed","data":{"status":"idle"}})).await.unwrap();
    let pending = invoke(state.clone(), json!({"name":"alpha","timeoutMs":0}))
        .await
        .unwrap_or_else(|e| panic!("{}", e.code));
    assert_eq!(
        pending,
        json!({"name":"alpha","status":"idle","reason":"timeout"})
    );
    assert_eq!(state.driver.get().unwrap().active_count(), 1);
    assert!(
        done.send(crate::turn_completion::WorkerCompletion::from(
            crate::turn_coordinator::Outcome::Success
        ))
        .is_ok()
    );
    handle.wait().await.unwrap();
    // Host-only success has no qualified native answer. UNKNOWN + zero must
    // still time out without load/capacity/unqualified errors or a false success.
    let result = invoke(
        state.clone(),
        json!({"name":"alpha","until":["UNKNOWN"],"timeoutMs":0}),
    )
    .await
    .unwrap_or_else(|e| panic!("{}", e.code));
    assert_eq!(result["reason"], "timeout");
    assert!(result.get("ok").is_none());
    assert_eq!(state.host_jobs.active(), 0);
    assert_eq!(
        invoke(state, json!({"name":"alpha","timeoutMs":0}))
            .await
            .err()
            .unwrap()
            .code,
        "unavailable"
    );
}

enum HeldLock {
    Registry,
    Cache,
    Store,
}
struct Held {
    release: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Held {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
async fn hold(state: Arc<State>, which: HeldLock) -> Held {
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (release, released) = tokio::sync::oneshot::channel();
    let thread = std::thread::spawn(move || match which {
        HeldLock::Registry => {
            let _guard = state.registry.lock().unwrap();
            entered.send(()).unwrap();
            let _ = released.blocking_recv();
        }
        HeldLock::Cache => {
            let _guard = state.live_sessions.lock().unwrap();
            entered.send(()).unwrap();
            let _ = released.blocking_recv();
        }
        HeldLock::Store => {
            let _guard = state.store.lock().unwrap();
            entered.send(()).unwrap();
            let _ = released.blocking_recv();
        }
    });
    ready.await.unwrap();
    Held {
        release: Some(release),
        thread: Some(thread),
    }
}
#[tokio::test]
async fn a_blocked_answer_load_follows_replacing_ticket_instead_of_returning_old_answer() {
    let (_home, state, _sink) = fixture_provider("claude").await;
    let snapshot = {
        let registry = state.registry.lock().unwrap();
        crate::turn_snapshot::TurnSnapshot::try_from(registry.find("alpha").unwrap()).unwrap()
    };
    let driver = state.driver.get().unwrap().clone();
    let (done_a, receiver) = tokio::sync::oneshot::channel();
    let mut a = driver
        .start(
            snapshot.clone(),
            "A".into(),
            Arc::new(HostWorker {
                turn_id: "old-A",
                done: std::sync::Mutex::new(Some(receiver)),
            }),
        )
        .unwrap();
    tokio::time::timeout(BOUND, a.accepted())
        .await
        .unwrap()
        .unwrap();
    assert!(
        done_a
            .send(normalized(a.ticket(), &snapshot.key, false, "old-A-answer"))
            .is_ok()
    );
    tokio::time::timeout(BOUND, a.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.host_jobs.active(), 0);
    let held = hold(state.clone(), HeldLock::Store).await;
    let waiting = tokio::spawn(invoke(
        state.clone(),
        json!({"name":"alpha","timeoutMs":10000}),
    ));
    // HostSink registers the owned read before blocking on the held Store.
    // This barrier proves A's payload IO began before B's reservation.
    tokio::time::timeout(BOUND, async {
        while state.host_jobs.active() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let (done_b, receiver) = tokio::sync::oneshot::channel();
    let mut b = driver
        .start(
            snapshot.clone(),
            "B".into(),
            Arc::new(HostWorker {
                turn_id: "new-B",
                done: std::sync::Mutex::new(Some(receiver)),
            }),
        )
        .unwrap();
    assert_ne!(a.ticket(), b.ticket());
    let latest = driver.latest_progress(&snapshot.key).unwrap();
    assert_eq!(&latest.0, b.ticket());
    drop(held);
    tokio::time::timeout(BOUND, b.accepted())
        .await
        .unwrap()
        .unwrap();
    assert!(
        done_b
            .send(normalized(b.ticket(), &snapshot.key, false, "new-B-answer"))
            .is_ok()
    );
    tokio::time::timeout(BOUND, b.wait())
        .await
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(BOUND, waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap_or_else(|e| panic!("{}", e.code));
    assert_eq!(
        result,
        json!({"name":"alpha","status":"idle","reason":"matched","turnId":"new-B","ok":true,"text":"new-B-answer"})
    );
    tokio::time::timeout(BOUND, state.host_jobs.wait())
        .await
        .unwrap();
}

#[tokio::test]
async fn snapshot_contention_has_a_real_deadline_and_huge_timeout_does_not_block_shutdown() {
    for lock in [HeldLock::Registry, HeldLock::Cache] {
        let (_home, state, _sink) = fixture().await;
        let _held = hold(state.clone(), lock).await;
        let start = Instant::now();
        let error =
            tokio::time::timeout(BOUND, invoke(state, json!({"name":"alpha","timeoutMs":1})))
                .await
                .unwrap()
                .err()
                .unwrap();
        assert_eq!(error.code, "timeout");
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    let (_home, state, _sink) = fixture().await;
    let held = hold(state.clone(), HeldLock::Registry).await;
    let waiting = tokio::spawn(invoke(
        state.clone(),
        json!({"name":"alpha","timeoutMs":1e300}),
    ));
    tokio::task::yield_now().await;
    state.stop.send_replace(true);
    assert_eq!(
        tokio::time::timeout(BOUND, waiting)
            .await
            .unwrap()
            .unwrap()
            .err()
            .unwrap()
            .code,
        "closed"
    );
    drop(held);
}

#[tokio::test]
async fn a_wait_that_observed_one_incarnation_never_reads_its_recreated_neighbor() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};
    let (_home, state, _sink) = fixture().await;
    let old = {
        let registry = state.registry.lock().unwrap();
        SessionKey {
            name: "alpha".into(),
            created_at: registry.find("alpha").unwrap().scalar("createdAt").unwrap(),
        }
    };
    let permit = state
        .session_waits
        .admit()
        .unwrap_or_else(|e| panic!("{}", e.code));
    let mut waiting = Box::pin(wait(
        state.clone(),
        query(json!({"name":"alpha","timeoutMs":1e300})),
        permit,
    ));
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(waiting.as_mut().poll(&mut context), Poll::Pending));
    let next = SessionKey {
        name: "alpha".into(),
        created_at: "2030-01-01T00:00:00.000Z".into(),
    };
    {
        // No execution exists: this is the host-only quiesced remove/recreate
        // boundary, not public JSON authority or a shortcut around close.
        let mut registry = state.registry.lock().unwrap();
        let mut replacement = registry.remove_checked(&old).unwrap();
        replacement.set_string("createdAt", &next.created_at);
        registry.insert(replacement).unwrap();
    }
    {
        let mut cache = state.live_sessions.lock().unwrap();
        cache.remove(&old);
        cache.seed(next, Status::Idle, 0).unwrap();
    }
    state.committed.send_modify(|_| {});
    assert_eq!(
        tokio::time::timeout(BOUND, waiting)
            .await
            .unwrap()
            .err()
            .unwrap()
            .code,
        "not_found"
    );
}

#[tokio::test]
async fn wait_completion_does_not_cancel_a_partially_consumed_next_rpc_frame() {
    let (_home, state, _sink) = fixture().await;
    let (mut reader, server) = connection(state.clone()).await;
    let first =
        b"{\"id\":1,\"method\":\"agent.wait\",\"params\":{\"name\":\"alpha\",\"timeoutMs\":60}}\n";
    let next=b"{\"id\":2,\"method\":\"perm.resolve\",\"params\":{\"id\":\"missing\",\"decision\":\"allow\",\"scope\":\"once\"}}\n";
    // One write puts both the full wait and next frame's prefix in the socket.
    // The server consumes that prefix into read_line's local Vec before the
    // wait completes. A select join_next branch used to drop that Vec.
    let split = next.len() / 2;
    let mut bytes = first.to_vec();
    bytes.extend_from_slice(&next[..split]);
    reader.get_mut().write_all(&bytes).await.unwrap();
    let timed_out = line(&mut reader).await;
    assert_eq!(timed_out["id"], 1);
    assert_eq!(timed_out["result"]["reason"], "timeout");
    reader.get_mut().write_all(&next[split..]).await.unwrap();
    let resolved = line(&mut reader).await;
    assert_eq!(resolved["id"], 2);
    assert_eq!(resolved["error"]["code"], "not_found");
    write(
        &mut reader,
        json!({"id":3,"method":"agent.stop","params":{"name":"alpha"}}),
    )
    .await;
    let stopped = line(&mut reader).await;
    assert_eq!(stopped["id"], 3);
    assert_eq!(stopped["result"]["stopped"], true);
    drop(reader);
    tokio::time::timeout(BOUND, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(state.session_waits.0.available_permits(), GLOBAL);
    assert!(state.native_runtime.get().is_none());
}

#[tokio::test]
async fn per_connection_wait_capacity_does_not_starve_same_socket_stop_or_resolve() {
    let (_home, state, _sink) = fixture().await;
    let (mut reader, server) = connection(state.clone()).await;
    for id in 1..=9 {
        write(&mut reader,json!({"id":id,"method":"agent.wait","params":{"name":"alpha","until":["UNKNOWN"],"timeoutMs":1e300}})).await;
    }
    let capacity = line(&mut reader).await;
    assert_eq!(capacity["id"], 9);
    assert_eq!(capacity["error"]["code"], "capacity");
    tokio::time::timeout(BOUND, state.host_jobs.wait())
        .await
        .unwrap();
    write(
        &mut reader,
        json!({"id":10,"method":"agent.stop","params":{"name":"alpha"}}),
    )
    .await;
    let stop = line(&mut reader).await;
    assert_eq!(stop["id"], 10);
    assert_eq!(stop["result"]["stopped"], true);
    write(
        &mut reader,
        json!({"id":11,"method":"perm.resolve","params":{"id":"missing","decision":"deny"}}),
    )
    .await;
    let resolve = line(&mut reader).await;
    assert_eq!(resolve["id"], 11);
    assert_eq!(resolve["error"]["code"], "not_found");
    drop(reader);
    tokio::time::timeout(BOUND, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(state.session_waits.0.available_permits(), GLOBAL);
}

#[tokio::test]
async fn disconnect_retires_only_wait_and_leaves_the_accepted_execution_owned() {
    let (_home, state, _sink) = fixture().await;
    let snapshot = {
        let registry = state.registry.lock().unwrap();
        crate::turn_snapshot::TurnSnapshot::try_from(registry.find("alpha").unwrap()).unwrap()
    };
    let (done, receiver) = tokio::sync::oneshot::channel();
    let driver = state.driver.get().unwrap();
    let mut handle = driver
        .start(
            snapshot,
            "fixture".into(),
            Arc::new(HostWorker {
                turn_id: "host-fixture-turn",
                done: std::sync::Mutex::new(Some(receiver)),
            }),
        )
        .unwrap();
    tokio::time::timeout(BOUND, handle.accepted())
        .await
        .unwrap()
        .unwrap();
    let (mut client, server) = connection(state.clone()).await;
    write(&mut client,json!({"id":1,"method":"agent.wait","params":{"name":"alpha","until":["UNKNOWN"],"timeoutMs":1e300}})).await;
    write(
        &mut client,
        json!({"id":2,"method":"perm.list","params":{}}),
    )
    .await;
    assert_eq!(line(&mut client).await["id"], 2);
    assert_eq!(state.session_waits.0.available_permits(), GLOBAL - 1);
    assert_eq!(driver.active_count(), 1);
    drop(client);
    tokio::time::timeout(BOUND, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(state.session_waits.0.available_permits(), GLOBAL);
    assert_eq!(driver.active_count(), 1);
    assert!(
        done.send(crate::turn_completion::WorkerCompletion::from(
            crate::turn_coordinator::Outcome::Success
        ))
        .is_ok()
    );
    let terminal = tokio::time::timeout(BOUND, handle.wait())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        terminal.turn.outcome,
        crate::turn_coordinator::Outcome::Success
    );
}

#[tokio::test]
async fn a_qualified_answer_with_a_large_rpc_id_gets_capacity_without_partial_result() {
    let (_home, state, _sink) = fixture_provider("claude").await;
    let snapshot = {
        let registry = state.registry.lock().unwrap();
        crate::turn_snapshot::TurnSnapshot::try_from(registry.find("alpha").unwrap()).unwrap()
    };
    let (done, receiver) = tokio::sync::oneshot::channel();
    let driver = state.driver.get().unwrap();
    let mut handle = driver
        .start(
            snapshot.clone(),
            "fixture".into(),
            Arc::new(HostWorker {
                turn_id: "host-fixture-turn",
                done: std::sync::Mutex::new(Some(receiver)),
            }),
        )
        .unwrap();
    tokio::time::timeout(BOUND, handle.accepted())
        .await
        .unwrap()
        .unwrap();
    let text = "fixture final answer ".repeat(128);
    assert!(
        done.send(normalized(handle.ticket(), &snapshot.key, false, &text))
            .is_ok()
    );
    tokio::time::timeout(BOUND, handle.wait())
        .await
        .unwrap()
        .unwrap();
    let preview = invoke(state.clone(), json!({"name":"alpha","timeoutMs":0}))
        .await
        .unwrap_or_else(|e| panic!("{}", e.code));
    assert!(preview["text"].as_str() == Some(text.as_str()));
    assert!(text.len() > 1024);
    let (mut client, server) = connection(state.clone()).await;
    let id = "i".repeat(crate::MAX_LINE - 1024);
    let request = json!({"id":id,"method":"agent.wait","params":{"name":"alpha","timeoutMs":0}});
    assert!(serde_json::to_vec(&request).unwrap().len() < crate::MAX_LINE);
    write(&mut client, request).await;
    let response = line(&mut client).await;
    assert!(response["id"].as_str() == Some(id.as_str()));
    assert_eq!(response["error"]["code"], "capacity");
    assert!(response.get("result").is_none());
    drop(client);
    tokio::time::timeout(BOUND, server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(state.session_waits.0.available_permits(), GLOBAL);
}

#[tokio::test]
async fn global_wait_capacity_and_shutdown_recover_all_connection_owned_slots() {
    let (_home, state, _sink) = fixture().await;
    let mut clients = Vec::new();
    let mut servers = Vec::new();
    for _ in 0..GLOBAL / PER_CONNECTION {
        let (mut client, server) = connection(state.clone()).await;
        for id in 1..=PER_CONNECTION {
            write(&mut client,json!({"id":id,"method":"agent.wait","params":{"name":"alpha","until":["UNKNOWN"],"timeoutMs":1e300}})).await;
        }
        // This response is a same-socket frame-order barrier for all eight
        // admissions, not a guess based on sleeping until tasks probably ran.
        write(
            &mut client,
            json!({"id":99,"method":"perm.list","params":{}}),
        )
        .await;
        let barrier = line(&mut client).await;
        assert_eq!(barrier["id"], 99);
        assert_eq!(barrier["result"]["pending"], json!([]));
        clients.push(client);
        servers.push(server);
    }
    assert_eq!(state.session_waits.0.available_permits(), 0);
    tokio::time::timeout(BOUND, state.host_jobs.wait())
        .await
        .unwrap();
    let (mut control, server) = connection(state.clone()).await;
    write(&mut control,json!({"id":1,"method":"agent.wait","params":{"name":"alpha","until":["UNKNOWN"],"timeoutMs":1e300}})).await;
    assert_eq!(line(&mut control).await["error"]["code"], "capacity");
    write(
        &mut control,
        json!({"id":2,"method":"daemon.stop","params":{}}),
    )
    .await;
    let stopped = line(&mut control).await;
    assert_eq!(stopped["id"], 2);
    assert_eq!(stopped["result"]["stopping"], true);
    servers.push(server);
    for server in servers {
        tokio::time::timeout(BOUND, server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    assert_eq!(state.session_waits.0.available_permits(), GLOBAL);
    drop((clients, control));
    assert!(state.native_runtime.get().is_none());
}
