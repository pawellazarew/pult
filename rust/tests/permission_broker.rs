//! Broker protocol fixtures, with explicit durable append acknowledgement gates.
use pult_core::permission_broker::*;
use pult_core::turn_driver::{EventSink, Receipt, SinkError, Task};
use serde_json::{Value, json};
use std::future::Future;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("broker watchdog")
}
struct Call {
    draft: Value,
    receipt: Receipt,
    reply: oneshot::Sender<Result<Receipt, SinkError>>,
}
impl Call {
    fn commit(self) {
        self.reply
            .send(Ok(self.receipt))
            .unwrap_or_else(|_| panic!("owned write lost"));
    }
    fn fail(self) {
        self.reply
            .send(Err(SinkError {
                message: "PRIVATE journal failure".into(),
            }))
            .unwrap_or_else(|_| panic!("owned write lost"));
    }
}
struct Sink {
    calls: mpsc::UnboundedSender<Call>,
    sequence: AtomicU64,
}
impl EventSink for Sink {
    fn append(&self, draft: Value) -> Task<Result<Receipt, SinkError>> {
        let (reply, rx) = oneshot::channel();
        self.calls
            .send(Call {
                draft,
                receipt: Receipt {
                    id: self.sequence.fetch_add(1, Ordering::SeqCst),
                    ts: "2026-11-11T00:00:00Z".into(),
                },
                reply,
            })
            .unwrap();
        Box::pin(async move {
            rx.await
                .expect("fixture must acknowledge durable operation")
        })
    }
}
struct Rig {
    broker: Broker,
    calls: mpsc::UnboundedReceiver<Call>,
}
fn redactors() -> Redactors {
    Redactors {
        value: Arc::new(|v| {
            serde_json::from_str(&v.to_string().replace("PRIVATE", "[redacted]")).unwrap()
        }),
        string: Arc::new(|s| s.replace("PRIVATE", "[redacted]")),
    }
}
fn rig(options: Options) -> Rig {
    let (calls, receiver) = mpsc::unbounded_channel();
    let broker = Broker::new(
        Arc::new(Sink {
            calls,
            sequence: AtomicU64::new(1),
        }),
        redactors(),
        options,
    )
    .unwrap();
    Rig {
        broker,
        calls: receiver,
    }
}
async fn next(rig: &mut Rig) -> Call {
    bounded(rig.calls.recv()).await.unwrap()
}
fn request(tool: &str, input: Value) -> PermissionRequest {
    PermissionRequest {
        session_id: "chat".into(),
        tool_name: tool.into(),
        tool_use_id: Some("tool-id".into()),
        input,
        offers: Offers::default(),
        concealed: false,
    }
}
async fn visible(broker: &Broker, n: usize) {
    bounded(async {
        while broker.pending_count() != n {
            tokio::task::yield_now().await;
        }
    })
    .await;
}
async fn publish(rig: &mut Rig, req: PermissionRequest) -> RequestHandle {
    let handle = rig.broker.request(req).unwrap();
    let call = next(rig).await;
    assert_eq!(call.draft["kind"], "permission.requested");
    call.commit();
    visible(&rig.broker, 1).await;
    handle
}
async fn decide(rig: &mut Rig, handle: &RequestHandle, decision: Decision) -> Resolution {
    let resolution = rig.broker.resolve(handle.id(), decision, "human").unwrap();
    let call = next(rig).await;
    assert_eq!(call.draft["kind"], "permission.resolved");
    call.commit();
    resolution
}
async fn deny_and_drain(rig: &mut Rig, mut handle: RequestHandle) {
    let done = decide(rig, &handle, Decision::deny()).await;
    assert!(bounded(done.wait()).await.unwrap());
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn durable_publication_and_resolution_preserve_raw_input_only_for_provider() {
    let mut rig = rig(Options::default());
    let raw = json!({"command":"PRIVATE echo","long":"input"});
    let mut handle = rig.broker.request(request("Bash", raw.clone())).unwrap();
    let call = next(&mut rig).await;
    assert!(rig.broker.list(None).is_empty());
    assert!(!call.draft.to_string().contains("PRIVATE"));
    assert_eq!(call.draft["data"]["concealed"], true);
    call.commit();
    visible(&rig.broker, 1).await;
    let card = &rig.broker.list(None)[0];
    assert_eq!(card["input"]["command"], "[redacted] echo");
    assert!(card["waitingMs"].is_number());
    assert!(card["createdAt"].is_string());
    let resolution = rig
        .broker
        .resolve(handle.id(), Decision::allow(Scope::Once), "PRIVATE human")
        .unwrap();
    let call = next(&mut rig).await;
    assert!(!call.draft.to_string().contains("PRIVATE"));
    assert_eq!(rig.broker.pending_count(), 0);
    let mut decision = Box::pin(handle.decision());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut decision)
            .await
            .is_err()
    );
    call.commit();
    let Decision::Allow { updated_input, .. } = bounded(decision).await else {
        panic!("expected allow")
    };
    assert_eq!(updated_input, Some(raw));
    assert!(bounded(resolution.wait()).await.unwrap());
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn resolution_from_stored_requested_event_waits_for_its_known_receipt() {
    let mut rig = rig(Options::default());
    let mut handle = rig
        .broker
        .request(request("Bash", json!({"command":"true"})))
        .unwrap();
    let pending = next(&mut rig).await;
    let id = pending.draft["data"]["id"].as_str().unwrap();
    let first = rig
        .broker
        .resolve(id, Decision::allow(Scope::Once), "first")
        .unwrap();
    // FIFO duplicate acknowledgement proves that the first command was consumed.
    let duplicate = rig
        .broker
        .resolve(id, Decision::deny(), "duplicate")
        .unwrap();
    assert!(!bounded(duplicate.wait()).await.unwrap());
    let mut waiting = Box::pin(first.wait());
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(
        waiting.as_mut().poll(&mut context).is_pending(),
        "early resolution must await requested receipt"
    );
    assert!(rig.calls.try_recv().is_err());
    pending.commit();
    let resolved = next(&mut rig).await;
    assert_eq!(resolved.draft["kind"], "permission.resolved");
    assert_eq!(resolved.draft["data"]["decision"], "allow");
    let mut decision = Box::pin(handle.decision());
    assert!(decision.as_mut().poll(&mut context).is_pending());
    resolved.commit();
    assert!(matches!(
        bounded(decision).await,
        Decision::Allow {
            scope: Scope::Once,
            ..
        }
    ));
    assert!(bounded(waiting).await.unwrap());
    bounded(rig.broker.drain()).await;
    assert!(rig.calls.try_recv().is_err());
}
#[tokio::test]
async fn deferred_resolution_fails_explicitly_when_requested_receipt_is_unknown() {
    let mut rig = rig(Options::default());
    let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
    let pending = next(&mut rig).await;
    let id = pending.draft["data"]["id"].as_str().unwrap();
    let resolution = rig
        .broker
        .resolve(id, Decision::allow(Scope::Once), "human")
        .unwrap();
    assert!(
        !bounded(
            rig.broker
                .resolve(id, Decision::deny(), "duplicate")
                .unwrap()
                .wait()
        )
        .await
        .unwrap()
    );
    pending.fail();
    assert_eq!(
        bounded(resolution.wait()).await,
        Err(BrokerError::StorageUnavailable)
    );
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    bounded(rig.broker.drain()).await;
    assert!(rig.broker.storage_failed());
    assert!(rig.calls.try_recv().is_err());
}
#[tokio::test]
async fn cancellation_shutdown_and_deadline_clear_deferred_choice_without_dropping_owned_io() {
    for reason in ["provider_gone", "shutdown", "timeout"] {
        let mut rig = rig(Options {
            timeout: if reason == "timeout" {
                Duration::from_secs(1)
            } else {
                DEFAULT_TIMEOUT
            },
            ..Default::default()
        });
        let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
        let pending = next(&mut rig).await;
        let id = pending.draft["data"]["id"].as_str().unwrap();
        let resolution = rig
            .broker
            .resolve(id, Decision::allow(Scope::Once), "human")
            .unwrap();
        assert!(
            !bounded(
                rig.broker
                    .resolve(id, Decision::deny(), "duplicate")
                    .unwrap()
                    .wait()
            )
            .await
            .unwrap()
        );
        match reason {
            "provider_gone" => {
                rig.broker.provider_gone("chat");
            }
            "shutdown" => {
                rig.broker.shutdown();
            }
            _ => {}
        }
        assert!(matches!(
            bounded(handle.decision()).await,
            Decision::Deny { .. }
        ));
        assert!(!bounded(resolution.wait()).await.unwrap());
        assert_eq!(rig.broker.reserved_count(), 1);
        assert!(rig.calls.try_recv().is_err());
        pending.commit();
        let denied = next(&mut rig).await;
        assert_eq!(denied.draft["data"]["decision"], "deny");
        assert_eq!(denied.draft["data"]["by"], reason);
        denied.commit();
        bounded(rig.broker.drain()).await;
        assert!(rig.calls.try_recv().is_err());
        assert!(!rig.broker.storage_failed());
    }
}
#[tokio::test]
async fn invalid_early_answers_leave_choice_open_and_only_first_valid_answer_is_kept() {
    let mut rig = rig(Options::default());
    let mut handle=rig.broker.request(request("requestUserInput",json!({"questions":[{"id":"q","question":"Pick","options":[{"label":"A"},{"label":"B"}]}]}))).unwrap();
    let pending = next(&mut rig).await;
    let id = pending.draft["data"]["id"].as_str().unwrap();
    let choose = |label: &str| Decision::Allow {
        scope: Scope::Once,
        updated_input: None,
        answers: Some(json!({"q":{"answers":[label]}})),
    };
    assert_eq!(
        bounded(
            rig.broker
                .resolve(id, choose("C"), "invalid")
                .unwrap()
                .wait()
        )
        .await,
        Err(BrokerError::InvalidAnswers)
    );
    let first = rig
        .broker
        .resolve(id, choose("A"), "PRIVATE human")
        .unwrap();
    assert!(
        !bounded(
            rig.broker
                .resolve(id, choose("B"), "second")
                .unwrap()
                .wait()
        )
        .await
        .unwrap()
    );
    assert!(rig.calls.try_recv().is_err());
    pending.commit();
    let resolved = next(&mut rig).await;
    assert_eq!(resolved.draft["data"]["by"], "[redacted] human");
    assert_eq!(resolved.draft["data"]["decision"], "allow");
    resolved.commit();
    let Decision::Allow {
        answers: Some(answers),
        ..
    } = bounded(handle.decision()).await
    else {
        panic!("expected first answer");
    };
    assert_eq!(answers["q"]["answers"], json!(["A"]));
    assert!(bounded(first.wait()).await.unwrap());
    bounded(rig.broker.drain()).await;
    assert!(rig.calls.try_recv().is_err());
}
#[tokio::test]
async fn secret_rule_is_removed_and_unoffered_scope_keeps_question_pending() {
    let mut rig = rig(Options::default());
    let mut req = request("Bash", json!({"command":"ok"}));
    req.offers = Offers {
        session: true,
        rule: Some(Rule {
            kind: RuleKind::Execpolicy,
            label: "curl PRIVATE".into(),
            note: "PRIVATE note".into(),
        }),
    };
    let handle = publish(&mut rig, req).await;
    assert_eq!(rig.broker.list(None)[0]["offers"], json!({"session":true}));
    let result = rig
        .broker
        .resolve(handle.id(), Decision::allow(Scope::Rule), "human")
        .unwrap();
    assert_eq!(bounded(result.wait()).await, Err(BrokerError::InvalidScope));
    assert_eq!(rig.broker.pending_count(), 1);
    assert!(rig.calls.try_recv().is_err());
    let resolution = decide(&mut rig, &handle, Decision::allow(Scope::Session)).await;
    assert!(bounded(resolution.wait()).await.unwrap());
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn clean_rule_offer_is_logged_and_rule_scope_is_returned() {
    let mut rig = rig(Options::default());
    let mut req = request("Bash", json!({}));
    req.offers.rule = Some(Rule {
        kind: RuleKind::Network,
        label: "example.com".into(),
        note: "PRIVATE note".into(),
    });
    let mut handle = publish(&mut rig, req).await;
    assert_eq!(
        rig.broker.list(None)[0]["offers"]["rule"]["note"],
        "[redacted] note"
    );
    let resolution = rig
        .broker
        .resolve(handle.id(), Decision::allow(Scope::Rule), "human")
        .unwrap();
    let call = next(&mut rig).await;
    assert_eq!(
        call.draft["data"]["rule"],
        json!({"kind":"network","label":"example.com"})
    );
    call.commit();
    assert!(bounded(resolution.wait()).await.unwrap());
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Allow {
            scope: Scope::Rule,
            ..
        }
    ));
}
#[tokio::test]
async fn timeout_and_shutdown_deny_before_blocked_requested_append_is_released() {
    for timeout in [true, false] {
        let mut rig = rig(Options {
            pending: 1,
            timeout: if timeout {
                Duration::from_millis(40)
            } else {
                DEFAULT_TIMEOUT
            },
        });
        let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
        let pending = next(&mut rig).await;
        if !timeout {
            assert_eq!(rig.broker.shutdown(), 1);
        }
        assert!(matches!(
            bounded(handle.decision()).await,
            Decision::Deny { .. }
        ));
        assert_eq!(rig.broker.reserved_count(), 1);
        assert!(rig.broker.list(None).is_empty());
        assert!(rig.calls.try_recv().is_err());
        pending.commit();
        let resolution = next(&mut rig).await;
        assert_eq!(resolution.draft["data"]["decision"], "deny");
        assert_eq!(
            resolution.draft["data"]["by"],
            if timeout { "timeout" } else { "shutdown" }
        );
        resolution.commit();
        bounded(rig.broker.drain()).await;
        assert!(rig.calls.try_recv().is_err());
    }
}
#[tokio::test]
async fn provider_gone_and_handle_drop_own_exactly_one_resolution() {
    for drop_handle in [true, false] {
        let mut rig = rig(Options::default());
        let mut handle = publish(&mut rig, request("Bash", json!({}))).await;
        let id = handle.id().to_owned();
        if drop_handle {
            drop(handle);
        } else {
            assert_eq!(rig.broker.provider_gone("other"), 0);
            assert_eq!(rig.broker.provider_gone("chat"), 1);
            assert!(matches!(
                bounded(handle.decision()).await,
                Decision::Deny { .. }
            ));
        }
        let call = next(&mut rig).await;
        assert_eq!(call.draft["data"]["id"], id);
        assert_eq!(call.draft["data"]["by"], "provider_gone");
        call.commit();
        bounded(rig.broker.drain()).await;
        assert!(
            !bounded(
                rig.broker
                    .resolve(&id, Decision::allow(Scope::Once), "human")
                    .unwrap()
                    .wait()
            )
            .await
            .unwrap()
        );
        assert!(rig.calls.try_recv().is_err());
    }
}
#[tokio::test]
async fn cancellation_of_decision_waiter_cancels_without_dropping_the_handle() {
    let mut rig = rig(Options::default());
    let mut handle = publish(&mut rig, request("Bash", json!({}))).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(10), handle.decision())
            .await
            .is_err()
    );
    let call = next(&mut rig).await;
    assert_eq!(call.draft["data"]["decision"], "deny");
    call.commit();
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn cancelling_or_timing_out_during_resolved_allow_never_grants() {
    for timeout in [false, true] {
        let mut rig = rig(Options {
            pending: 1,
            timeout: if timeout {
                Duration::from_millis(80)
            } else {
                DEFAULT_TIMEOUT
            },
        });
        let mut handle = publish(&mut rig, request("Bash", json!({"command":"PRIVATE"}))).await;
        let resolution = rig
            .broker
            .resolve(handle.id(), Decision::allow(Scope::Once), "human")
            .unwrap();
        let pending = next(&mut rig).await;
        assert_eq!(pending.draft["data"]["decision"], "allow");
        if !timeout {
            rig.broker.provider_gone("chat");
        }
        assert!(matches!(
            bounded(handle.decision()).await,
            Decision::Deny { .. }
        ));
        assert_eq!(rig.broker.reserved_count(), 1);
        pending.commit();
        assert!(!bounded(resolution.wait()).await.unwrap());
        bounded(rig.broker.drain()).await;
        assert!(rig.calls.try_recv().is_err());
    }
}
#[tokio::test]
async fn failed_requested_commit_has_no_ui_or_orphan_resolution_and_latches() {
    let mut rig = rig(Options::default());
    let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
    next(&mut rig).await.fail();
    let Decision::Deny { message } = bounded(handle.decision()).await else {
        panic!("must deny")
    };
    assert!(!message.contains("PRIVATE"));
    bounded(rig.broker.drain()).await;
    assert!(rig.broker.storage_failed());
    assert!(rig.broker.list(None).is_empty());
    assert!(matches!(
        rig.broker.request(request("Bash", json!({}))),
        Err(BrokerError::StorageUnavailable)
    ));
    assert!(rig.calls.try_recv().is_err());
}
#[tokio::test]
async fn failed_resolved_commit_denies_allow_and_latches_all_other_askers() {
    let mut rig = rig(Options::default());
    let mut first = publish(&mut rig, request("Bash", json!({}))).await;
    let mut second = rig.broker.request(request("Read", json!({}))).unwrap();
    next(&mut rig).await.commit();
    visible(&rig.broker, 2).await;
    let resolution = rig
        .broker
        .resolve(first.id(), Decision::allow(Scope::Once), "human")
        .unwrap();
    next(&mut rig).await.fail();
    assert_eq!(
        bounded(resolution.wait()).await,
        Err(BrokerError::StorageUnavailable)
    );
    assert!(matches!(
        bounded(first.decision()).await,
        Decision::Deny { .. }
    ));
    assert!(matches!(
        bounded(second.decision()).await,
        Decision::Deny { .. }
    ));
    bounded(rig.broker.drain()).await;
    assert!(rig.broker.storage_failed());
    assert!(rig.calls.try_recv().is_err());
}
#[tokio::test]
async fn dropped_resolution_future_cannot_abandon_an_owned_commit() {
    let mut rig = rig(Options::default());
    let mut handle = publish(&mut rig, request("Bash", json!({}))).await;
    drop(
        rig.broker
            .resolve(handle.id(), Decision::allow(Scope::Once), "human")
            .unwrap(),
    );
    next(&mut rig).await.commit();
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Allow { .. }
    ));
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn concurrent_human_resolutions_choose_exactly_one_durable_winner() {
    let mut rig = rig(Options::default());
    let mut handle = publish(&mut rig, request("Bash", json!({}))).await;
    let first = rig
        .broker
        .resolve(handle.id(), Decision::allow(Scope::Once), "one")
        .unwrap();
    let second = rig
        .broker
        .resolve(handle.id(), Decision::deny(), "two")
        .unwrap();
    let call = next(&mut rig).await;
    assert_eq!(call.draft["data"]["by"], "one");
    assert!(!bounded(second.wait()).await.unwrap());
    call.commit();
    assert!(bounded(first.wait()).await.unwrap());
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Allow { .. }
    ));
    bounded(rig.broker.drain()).await;
    assert!(rig.calls.try_recv().is_err());
}
#[tokio::test]
async fn request_user_input_answers_validate_options_ids_blanks_and_custom_answers() {
    let mut rig = rig(Options::default());
    let mut handle = publish(
        &mut rig,
        request(
            "requestUserInput",
            json!({"questions":[{"id":"q","options":[{"label":"A"}],"isOther":false}]}),
        ),
    )
    .await;
    for given in [
        None,
        Some(json!({})),
        Some(json!({"q":{"answers":[]}})),
        Some(json!({"q":{"answers":[" \u{feff}"]}})),
        Some(json!({"q":{"answers":["B"]}})),
        Some(json!({"q":{"answers":["A"]},"extra":{"answers":["A"]}})),
    ] {
        let result = rig
            .broker
            .resolve(
                handle.id(),
                Decision::Allow {
                    scope: Scope::Once,
                    updated_input: None,
                    answers: given,
                },
                "human",
            )
            .unwrap();
        assert_eq!(
            bounded(result.wait()).await,
            Err(BrokerError::InvalidAnswers)
        );
        assert_eq!(rig.broker.pending_count(), 1);
    }
    let given = json!({"q":{"answers":["A"]}});
    let done = decide(
        &mut rig,
        &handle,
        Decision::Allow {
            scope: Scope::Rule,
            updated_input: None,
            answers: Some(given.clone()),
        },
    )
    .await;
    assert!(bounded(done.wait()).await.unwrap());
    let Decision::Allow {
        answers,
        updated_input,
        ..
    } = bounded(handle.decision()).await
    else {
        panic!("expected answers")
    };
    assert_eq!(answers, Some(given));
    assert_eq!(updated_input, None);
}
#[tokio::test]
async fn request_user_input_allows_custom_answer_only_when_offered() {
    let mut rig = rig(Options::default());
    let handle = publish(
        &mut rig,
        request(
            "requestUserInput",
            json!({"questions":[{"id":"q","options":[{"label":"A"}],"isOther":true}]}),
        ),
    )
    .await;
    let done = decide(
        &mut rig,
        &handle,
        Decision::Allow {
            scope: Scope::Once,
            updated_input: None,
            answers: Some(json!({"q":{"answers":["custom"]}})),
        },
    )
    .await;
    assert!(bounded(done.wait()).await.unwrap());
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn claude_answers_are_trimmed_joined_and_merged_with_original_input() {
    let mut rig = rig(Options::default());
    let mut handle = publish(
        &mut rig,
        request(
            "AskUserQuestion",
            json!({"keep":"PRIVATE","questions":[{"question":"Pick","multiSelect":true}]}),
        ),
    )
    .await;
    let done = decide(
        &mut rig,
        &handle,
        Decision::Allow {
            scope: Scope::Once,
            updated_input: None,
            answers: Some(json!({"Pick":{"answers":[" A ","B\u{feff}"]}})),
        },
    )
    .await;
    assert!(bounded(done.wait()).await.unwrap());
    let Decision::Allow {
        updated_input: Some(input),
        ..
    } = bounded(handle.decision()).await
    else {
        panic!("expected input")
    };
    assert_eq!(input["answers"], json!({"Pick":"A, B"}));
    assert_eq!(input["keep"], "PRIVATE");
    let handle = publish(
        &mut rig,
        request(
            "AskUserQuestion",
            json!({"questions":[{"question":"Pick"}]}),
        ),
    )
    .await;
    let done = rig
        .broker
        .resolve(
            handle.id(),
            Decision::Allow {
                scope: Scope::Once,
                updated_input: None,
                answers: Some(json!({"Pick":{"answers":["A","B"]}})),
            },
            "human",
        )
        .unwrap();
    assert_eq!(bounded(done.wait()).await, Err(BrokerError::InvalidAnswers));
    deny_and_drain(&mut rig, handle).await;
}
#[tokio::test]
async fn generations_capacity_input_bounds_and_concealed_are_explicit() {
    let mut first = rig(Options {
        pending: 1,
        ..Options::default()
    });
    let mut second = rig(Options::default());
    let mut req = request("Bash", json!({}));
    req.concealed = true;
    let handle = first.broker.request(req).unwrap();
    let other = second.broker.request(request("Bash", json!({}))).unwrap();
    assert_ne!(handle.id(), other.id());
    assert!(matches!(
        first.broker.request(request("Bash", json!({}))),
        Err(BrokerError::Capacity)
    ));
    next(&mut first).await.commit();
    visible(&first.broker, 1).await;
    assert_eq!(first.broker.list(None)[0]["concealed"], true);
    deny_and_drain(&mut first, handle).await;
    assert!(matches!(
        first.broker.request(request(
            "Bash",
            json!({"large":"x".repeat(MAX_INPUT_BYTES)})
        )),
        Err(BrokerError::Invalid)
    ));
    assert!(matches!(
        first.broker.request(request("Bash", json!([]))),
        Err(BrokerError::Invalid)
    ));
    next(&mut second).await.commit();
    visible(&second.broker, 1).await;
    deny_and_drain(&mut second, other).await;
}
#[tokio::test]
async fn one_blocked_request_does_not_block_other_question_resolution() {
    let mut rig = rig(Options::default());
    let mut blocked = rig.broker.request(request("Bash", json!({}))).unwrap();
    let pending = next(&mut rig).await;
    let mut ready = publish(&mut rig, request("Read", json!({}))).await;
    let done = decide(&mut rig, &ready, Decision::allow(Scope::Once)).await;
    assert!(bounded(done.wait()).await.unwrap());
    assert!(matches!(
        bounded(ready.decision()).await,
        Decision::Allow { .. }
    ));
    rig.broker.provider_gone("chat");
    assert!(matches!(
        bounded(blocked.decision()).await,
        Decision::Deny { .. }
    ));
    pending.commit();
    next(&mut rig).await.commit();
    bounded(rig.broker.drain()).await;
}

#[tokio::test]
async fn real_event_store_contains_only_redacted_metadata_and_one_resolution() {
    use pult_core::{journal::EventStore, turn_journal::JournalSink};
    use std::sync::Mutex;
    let home = tempfile::tempdir().unwrap();
    let store = Arc::new(Mutex::new(
        EventStore::open(&home.path().join("events")).unwrap(),
    ));
    let sink = Arc::new(JournalSink::new(store.clone()).unwrap());
    let broker = Broker::new(sink, redactors(), Options::default()).unwrap();
    let mut handle = broker
        .request(request("Bash", json!({"command":"PRIVATE token"})))
        .unwrap();
    visible(&broker, 1).await;
    let done = broker
        .resolve(handle.id(), Decision::allow(Scope::Once), "human")
        .unwrap();
    assert!(bounded(done.wait()).await.unwrap());
    let Decision::Allow {
        updated_input: Some(input),
        ..
    } = bounded(handle.decision()).await
    else {
        panic!("expected input")
    };
    assert_eq!(input["command"], "PRIVATE token");
    bounded(broker.drain()).await;
    let rows = store
        .lock()
        .unwrap()
        .read_session(&"chat".encode_utf16().collect::<Vec<_>>())
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|row| !row.json.get().contains("PRIVATE")));
    assert!(rows[0].json.get().contains("permission.requested"));
    assert!(rows[1].json.get().contains("permission.resolved"));
}

#[tokio::test]
async fn sink_panic_and_invalid_receipt_are_unknown_commits_that_deny() {
    struct BadSink {
        panic: bool,
    }
    impl EventSink for BadSink {
        fn append(&self, _: Value) -> Task<Result<Receipt, SinkError>> {
            if self.panic {
                panic!("PRIVATE panic payload");
            }
            Box::pin(async {
                Ok(Receipt {
                    id: 0,
                    ts: "bad receipt".into(),
                })
            })
        }
    }
    pult_core::panic_guard::install();
    for panic in [true, false] {
        let broker =
            Broker::new(Arc::new(BadSink { panic }), redactors(), Options::default()).unwrap();
        let mut handle = broker.request(request("Bash", json!({}))).unwrap();
        let Decision::Deny { message } = bounded(handle.decision()).await else {
            panic!("must deny")
        };
        assert!(!message.contains("PRIVATE"));
        bounded(broker.drain()).await;
        assert!(broker.storage_failed());
        assert!(broker.list(None).is_empty());
    }
}

#[tokio::test]
async fn global_fault_cannot_be_followed_by_allow_from_another_pending_commit() {
    let mut rig = rig(Options::default());
    let mut allowed = publish(&mut rig, request("Bash", json!({"command":"PRIVATE"}))).await;
    let resolution = rig
        .broker
        .resolve(allowed.id(), Decision::allow(Scope::Once), "human")
        .unwrap();
    let allow_write = next(&mut rig).await;
    let mut other = rig.broker.request(request("Read", json!({}))).unwrap();
    next(&mut rig).await.fail();
    assert!(matches!(
        bounded(other.decision()).await,
        Decision::Deny { .. }
    ));
    assert!(rig.broker.storage_failed());
    assert!(matches!(
        bounded(allowed.decision()).await,
        Decision::Deny { .. }
    ));
    assert_eq!(rig.broker.reserved_count(), 1);
    allow_write.commit();
    assert_eq!(
        bounded(resolution.wait()).await,
        Err(BrokerError::StorageUnavailable)
    );
    bounded(rig.broker.drain()).await;
    assert!(rig.calls.try_recv().is_err());
}

#[tokio::test]
async fn node_zero_submillisecond_and_overflow_timers_deny_while_requested_append_is_blocked() {
    for timeout in [
        Duration::ZERO,
        Duration::from_nanos(125_000),
        Duration::from_millis(NODE_MAX_TIMEOUT_MS) + Duration::from_micros(500),
        Duration::MAX,
    ] {
        let mut rig = rig(Options {
            pending: 1,
            timeout,
        });
        let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
        let pending = next(&mut rig).await;
        assert!(matches!(
            bounded(handle.decision()).await,
            Decision::Deny { .. }
        ));
        assert_eq!(rig.broker.reserved_count(), 1);
        assert!(rig.broker.list(None).is_empty());
        assert!(rig.calls.try_recv().is_err());
        pending.commit();
        let resolved = next(&mut rig).await;
        assert_eq!(resolved.draft["data"]["decision"], "deny");
        assert_eq!(resolved.draft["data"]["by"], "timeout");
        resolved.commit();
        bounded(rig.broker.drain()).await;
        assert!(rig.calls.try_recv().is_err());
    }
}
#[tokio::test]
async fn finite_float_factory_zero_and_huge_timeouts_keep_fail_closed_owned_io() {
    for milliseconds in [0.0, 0.125, 1.75, NODE_MAX_TIMEOUT_MS as f64 + 0.5, 1e100] {
        let mut rig = rig(Options {
            pending: 1,
            ..Options::from_timeout_ms(milliseconds).unwrap()
        });
        let mut handle = rig.broker.request(request("Read", json!({}))).unwrap();
        let pending = next(&mut rig).await;
        assert!(matches!(
            bounded(handle.decision()).await,
            Decision::Deny { .. }
        ));
        pending.commit();
        next(&mut rig).await.commit();
        bounded(rig.broker.drain()).await;
        assert!(!rig.broker.storage_failed());
    }
}
#[tokio::test]
async fn timers_longer_than_default_are_accepted_then_provider_gone_cleans_them_up() {
    for timeout in [
        Duration::from_millis(600001),
        Duration::from_millis(NODE_MAX_TIMEOUT_MS),
    ] {
        let mut rig = rig(Options {
            pending: 1,
            timeout,
        });
        let mut handle = publish(&mut rig, request("Bash", json!({}))).await;
        assert_eq!(rig.broker.pending_count(), 1);
        assert_eq!(rig.broker.provider_gone("chat"), 1);
        assert!(matches!(
            bounded(handle.decision()).await,
            Decision::Deny { .. }
        ));
        let resolved = next(&mut rig).await;
        assert_eq!(resolved.draft["data"]["by"], "provider_gone");
        resolved.commit();
        bounded(rig.broker.drain()).await;
        assert!(rig.calls.try_recv().is_err());
    }
}

async fn assert_drain_pending(handle: &RequestHandle) {
    let drain = handle.drained();
    tokio::pin!(drain);
    assert!(
        std::future::poll_fn(|cx| std::task::Poll::Ready(drain.as_mut().poll(cx).is_pending()))
            .await
    );
}
#[tokio::test]
async fn scoped_drain_cancel_during_requested_retains_both_owned_writes() {
    let mut rig = rig(Options::default());
    let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
    let requested = next(&mut rig).await;
    handle.cancel();
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    assert_drain_pending(&handle).await;
    requested.commit();
    let resolved = next(&mut rig).await;
    assert_eq!(resolved.draft["kind"], "permission.resolved");
    assert_drain_pending(&handle).await;
    resolved.commit();
    bounded(handle.drained()).await;
    assert_eq!(rig.broker.reserved_count(), 0);
    rig.broker.shutdown();
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn scoped_drain_cancellation_during_resolved_cannot_grant_or_finish_early() {
    let mut rig = rig(Options::default());
    let mut handle = publish(&mut rig, request("Bash", json!({}))).await;
    let resolution = rig
        .broker
        .resolve(handle.id(), Decision::allow(Scope::Once), "human")
        .unwrap();
    let resolved = next(&mut rig).await;
    handle.cancel();
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    assert_drain_pending(&handle).await;
    resolved.commit();
    assert!(!bounded(resolution.wait()).await.unwrap());
    bounded(handle.drained()).await;
    rig.broker.shutdown();
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn scoped_drain_timeout_during_requested_waits_for_known_journal_outcome() {
    let mut rig = rig(Options::from_timeout_ms(1.0).unwrap());
    let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
    let requested = next(&mut rig).await;
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    assert_drain_pending(&handle).await;
    requested.commit();
    let resolved = next(&mut rig).await;
    assert_eq!(resolved.draft["data"]["by"], "timeout");
    assert_drain_pending(&handle).await;
    resolved.commit();
    bounded(handle.drained()).await;
    rig.broker.shutdown();
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn scoped_drain_is_independent_and_dropping_waiter_does_not_abort_journal() {
    let mut rig = rig(Options::default());
    let mut first = publish(&mut rig, request("Bash", json!({}))).await;
    first.cancel();
    let held = next(&mut rig).await;
    assert!(matches!(
        bounded(first.decision()).await,
        Decision::Deny { .. }
    ));
    // assert_drain_pending drops the join future. The owned write survives.
    assert_drain_pending(&first).await;
    let mut req = request("Read", json!({}));
    req.session_id = "neighbor".into();
    let second = publish(&mut rig, req).await;
    let resolution = rig
        .broker
        .resolve(second.id(), Decision::allow(Scope::Once), "human")
        .unwrap();
    next(&mut rig).await.commit();
    assert!(bounded(resolution.wait()).await.unwrap());
    bounded(second.drained()).await;
    assert_eq!(rig.broker.reserved_count(), 1);
    assert_drain_pending(&first).await;
    held.commit();
    bounded(first.drained()).await;
    rig.broker.shutdown();
    bounded(rig.broker.drain()).await;
}
#[tokio::test]
async fn scoped_drain_proves_failed_append_finished_without_grant() {
    let mut rig = rig(Options::default());
    let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
    let requested = next(&mut rig).await;
    assert_drain_pending(&handle).await;
    requested.fail();
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    bounded(handle.drained()).await;
    assert!(rig.broker.storage_failed());
    rig.broker.shutdown();
    bounded(rig.broker.drain()).await;
}

#[tokio::test]
async fn scoped_drain_closed_admission_before_actor_publication_needs_no_journal() {
    let mut rig = rig(Options::default());
    let mut handle = rig.broker.request(request("Bash", json!({}))).unwrap();
    // No await: close before the actor can consume the queued admission.
    rig.broker.shutdown();
    assert!(matches!(
        bounded(handle.decision()).await,
        Decision::Deny { .. }
    ));
    bounded(handle.drained()).await;
    assert_eq!(rig.broker.reserved_count(), 0);
    assert!(rig.calls.try_recv().is_err());
}
