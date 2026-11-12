use pult_core::codex_rpc::{
    self, Client, Event, Events, Limits, MemoryPeer, ResponseError, RpcError, WireError,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::task::JoinHandle;
const WAIT: Duration = Duration::from_secs(10);
macro_rules! case {
    ($name:ident, $body:block) => {
        #[tokio::test]
        async fn $name() { tokio::time::timeout(WAIT, async $body).await.expect("10 second watchdog"); }
    };
}
fn rig() -> (Client, Events, MemoryPeer) {
    let (wire, peer) = codex_rpc::memory_wire(1);
    let (client, events) = codex_rpc::spawn(wire, Limits::default()).unwrap();
    (client, events, peer)
}
fn request(
    client: &Client,
    method: &str,
    timeout: Duration,
) -> JoinHandle<Result<Value, RpcError>> {
    let client = client.clone();
    let method = method.to_owned();
    tokio::spawn(async move { client.request(method, json!({}), timeout).await })
}
async fn server_request(events: &mut Events) -> codex_rpc::ResponsePermit {
    match events.recv().await.unwrap() {
        Event::ServerRequest { permit, .. } => permit,
        _ => panic!("expected server request"),
    }
}
async fn stopped(client: &Client) -> RpcError {
    let mut signal = client.shutdown_signal();
    loop {
        if let Some(error) = signal.borrow().clone() {
            return error;
        }
        signal.changed().await.unwrap();
    }
}
case!(concurrent_out_of_order_and_notifications, {
    let (client, mut events, mut peer) = rig();
    let a = request(&client, "thread/read", WAIT);
    let first = peer.inbound.recv().await.unwrap();
    let b = request(&client, "turn/start", WAIT);
    let second = peer.inbound.recv().await.unwrap();
    assert_ne!(first["id"], second["id"]);
    assert!(second["id"].as_u64().unwrap() <= 9_007_199_254_740_991);
    assert!(first.get("jsonrpc").is_none());
    peer.outbound
        .send(Ok(json!({"id":second["id"],"result":[2]})))
        .await
        .unwrap();
    peer.outbound
        .send(Ok(
            json!({"method":"turn/completed","params":{"threadId":"t"}}),
        ))
        .await
        .unwrap();
    peer.outbound
        .send(Ok(json!({"id":first["id"],"result":"one"})))
        .await
        .unwrap();
    assert_eq!(a.await.unwrap().unwrap(), "one");
    assert_eq!(b.await.unwrap().unwrap(), json!([2]));
    assert!(
        matches!(events.recv().await, Some(Event::Notification { method, .. }) if method == "turn/completed")
    );
    client.shutdown();
});
case!(one_timeout_keeps_other_request_and_provider_alive, {
    let (client, _events, mut peer) = rig();
    let a = request(&client, "stalled", Duration::from_millis(100));
    let old = peer.inbound.recv().await.unwrap();
    let b = request(&client, "live", WAIT);
    let live = peer.inbound.recv().await.unwrap();
    assert_eq!(a.await.unwrap(), Err(RpcError::Timeout));
    peer.outbound
        .send(Ok(json!({"id":old["id"],"result":false})))
        .await
        .unwrap();
    peer.outbound
        .send(Ok(json!({"id":live["id"],"result":true})))
        .await
        .unwrap();
    assert_eq!(b.await.unwrap().unwrap(), true);
    assert!(client.shutdown_signal().borrow().is_none());
    client.shutdown();
});
case!(remote_error_is_typed_and_debug_redacted, {
    let (client, _events, mut peer) = rig();
    let job = request(&client, "failure", WAIT);
    let frame = peer.inbound.recv().await.unwrap();
    peer.outbound.send(Ok(json!({"id":frame["id"],"error":{"code":-42,"message":"secret-message","data":{"token":"secret-token"}}}))).await.unwrap();
    let error = job.await.unwrap().unwrap_err();
    assert!(!format!("{error:?}").contains("secret"));
    match error {
        RpcError::Remote(error) => {
            assert_eq!(error.code, -42);
            assert_eq!(error.data.unwrap()["token"], "secret-token");
        }
        _ => panic!("remote error"),
    }
    client.shutdown();
});
case!(string_and_signed_server_ids_preserve_shape_and_reuse, {
    let (client, mut events, mut peer) = rig();
    for id in [json!("same"), json!("same"), json!(-17)] {
        peer.outbound
            .send(Ok(json!({"id":id,"method":"item/approval","params":{}})))
            .await
            .unwrap();
        let permit = server_request(&mut events).await;
        assert_eq!(permit.id(), &id);
        assert_eq!(permit.method(), "item/approval");
        client
            .respond(permit, Ok(json!({"decision":"decline"})))
            .await
            .unwrap();
        let frame = peer.inbound.recv().await.unwrap();
        assert_eq!(frame["id"], id);
        assert_eq!(frame["result"]["decision"], "decline");
    }
    client.shutdown();
});
case!(dropped_permit_denies_and_releases_id, {
    let (client, mut events, mut peer) = rig();
    peer.outbound
        .send(Ok(json!({"id":8,"method":"permission"})))
        .await
        .unwrap();
    drop(server_request(&mut events).await);
    let frame = peer.inbound.recv().await.unwrap();
    assert_eq!(frame["id"], 8);
    assert_eq!(frame["error"]["code"], -32000);
    assert!(frame.get("result").is_none());
    peer.outbound
        .send(Ok(json!({"id":8,"method":"permission"})))
        .await
        .unwrap();
    client
        .respond(
            server_request(&mut events).await,
            Err(ResponseError::denied()),
        )
        .await
        .unwrap();
    assert_eq!(peer.inbound.recv().await.unwrap()["id"], 8);
    client.shutdown();
});
case!(foreign_generation_cannot_answer_permit, {
    let (a, mut events, mut peer) = rig();
    let (b, _other_events, mut other_peer) = rig();
    peer.outbound
        .send(Ok(json!({"id":"x","method":"permission"})))
        .await
        .unwrap();
    assert_eq!(
        b.respond(server_request(&mut events).await, Ok(json!(true)))
            .await,
        Err(RpcError::InvalidPermit)
    );
    assert!(peer.inbound.recv().await.unwrap().get("error").is_some());
    assert!(other_peer.inbound.try_recv().is_err());
    a.shutdown();
    b.shutdown();
});
case!(duplicate_live_server_id_fails_closed, {
    let (client, mut events, peer) = rig();
    peer.outbound
        .send(Ok(json!({"id":"x","method":"permission"})))
        .await
        .unwrap();
    let permit = server_request(&mut events).await;
    peer.outbound
        .send(Ok(json!({"id":"x","method":"permission"})))
        .await
        .unwrap();
    assert_eq!(stopped(&client).await, RpcError::InvalidPermit);
    assert!(client.respond(permit, Ok(json!(true))).await.is_err());
});
case!(wire_eof_and_fatal_error_fail_all_pending, {
    for fatal in [None, Some(WireError::Failed)] {
        let (client, _events, mut peer) = rig();
        let a = request(&client, "a", WAIT);
        peer.inbound.recv().await.unwrap();
        let b = request(&client, "b", WAIT);
        peer.inbound.recv().await.unwrap();
        if let Some(error) = fatal {
            peer.outbound.send(Err(error)).await.unwrap();
        }
        drop(peer.outbound);
        let expected = RpcError::Wire(fatal.unwrap_or(WireError::Eof));
        assert_eq!(a.await.unwrap(), Err(expected.clone()));
        assert_eq!(b.await.unwrap(), Err(expected.clone()));
        assert_eq!(stopped(&client).await, expected);
    }
});
case!(event_overflow_cannot_drop_permission_silently, {
    let (wire, peer) = codex_rpc::memory_wire(1);
    let (client, _events) = codex_rpc::spawn(
        wire,
        Limits {
            event_slots: 1,
            ..Limits::default()
        },
    )
    .unwrap();
    peer.outbound
        .send(Ok(json!({"method":"first"})))
        .await
        .unwrap();
    peer.outbound
        .send(Ok(json!({"id":1,"method":"permission"})))
        .await
        .unwrap();
    assert_eq!(stopped(&client).await, RpcError::Backpressure);
});
case!(bounded_command_overflow_closes_provider, {
    use std::future::Future;
    use std::task::Poll;
    let (client, _events, _peer) = rig();
    let mut queued: Vec<_> = (0..Limits::default().command_slots + 1)
        .map(|_| Box::pin(client.notify("queued", json!({}))))
        .collect();
    std::future::poll_fn(|cx| {
        for request in &mut queued {
            let _ = request.as_mut().poll(cx);
        }
        Poll::Ready(())
    })
    .await;
    assert_eq!(stopped(&client).await, RpcError::Backpressure);
});
case!(payload_and_wire_memory_limits, {
    for limits in [
        Limits {
            command_slots: usize::MAX,
            ..Limits::default()
        },
        Limits {
            event_slots: usize::MAX,
            ..Limits::default()
        },
        Limits {
            queued_bytes: usize::MAX,
            ..Limits::default()
        },
        Limits {
            server_ids: usize::MAX,
            ..Limits::default()
        },
    ] {
        let (wire, _peer) = codex_rpc::memory_wire(1);
        assert!(matches!(
            codex_rpc::spawn(wire, limits),
            Err(RpcError::Capacity)
        ));
    }

    let (wire, _peer) = codex_rpc::memory_wire(3);
    assert!(matches!(
        codex_rpc::spawn(wire, Limits::default()),
        Err(RpcError::Capacity)
    ));
    let (wire, mut peer) = codex_rpc::memory_wire(1);
    let (client, _events) = codex_rpc::spawn(
        wire,
        Limits {
            max_payload: 256,
            queued_bytes: 512,
            ..Limits::default()
        },
    )
    .unwrap();
    assert_eq!(
        client.notify("x", json!("x".repeat(256))).await,
        Err(RpcError::PayloadTooLarge)
    );
    assert!(client.shutdown_signal().borrow().is_none());
    peer.outbound
        .send(Ok(json!({"method":"x","params":"x".repeat(256)})))
        .await
        .unwrap();
    assert_eq!(stopped(&client).await, RpcError::PayloadTooLarge);
    assert!(peer.inbound.recv().await.is_none());
});
case!(pending_capacity_and_cancellation_cleanup, {
    let (client, _events, mut peer) = rig();
    let mut jobs = Vec::new();
    for _ in 0..codex_rpc::MAX_PENDING {
        jobs.push(request(&client, "stalled", WAIT));
        peer.inbound.recv().await.unwrap();
    }
    assert_eq!(
        client.request("overflow", json!({}), WAIT).await,
        Err(RpcError::Capacity)
    );
    let cancelled = jobs.pop().unwrap();
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    // The acknowledgement is a deterministic actor barrier; no sleeps required.
    client.notify("barrier", json!({})).await.unwrap();
    peer.inbound.recv().await.unwrap();
    let replacement = request(&client, "replacement", WAIT);
    let frame = peer.inbound.recv().await.unwrap();
    peer.outbound
        .send(Ok(json!({"id":frame["id"],"result":true})))
        .await
        .unwrap();
    assert_eq!(replacement.await.unwrap().unwrap(), true);
    client.shutdown();
    for job in jobs {
        assert!(job.await.unwrap().is_err());
    }
});
case!(unknown_response_does_not_match_string_to_numeric_id, {
    let (client, _events, mut peer) = rig();
    let job = request(&client, "read", WAIT);
    let frame = peer.inbound.recv().await.unwrap();
    peer.outbound
        .send(Ok(json!({"id":frame["id"].to_string(),"result":"wrong"})))
        .await
        .unwrap();
    peer.outbound
        .send(Ok(json!({"id":frame["id"],"result":"right"})))
        .await
        .unwrap();
    assert_eq!(job.await.unwrap().unwrap(), "right");
    client.shutdown();
});
case!(explicit_shutdown_and_malformed_frames, {
    let (client, _events, mut peer) = rig();
    let job = request(&client, "stalled", WAIT);
    peer.inbound.recv().await.unwrap();
    client.shutdown();
    assert_eq!(job.await.unwrap(), Err(RpcError::Shutdown));
    assert_eq!(
        client.notify("late", json!({})).await,
        Err(RpcError::Shutdown)
    );
    for bad in [
        json!([]),
        json!({"id":null,"method":"permission"}),
        json!({"id":2,"result":true,"error":{}}),
        json!({"jsonrpc":"1.0","method":"n"}),
    ] {
        let (client, _events, peer) = rig();
        peer.outbound.send(Ok(bad)).await.unwrap();
        assert_eq!(stopped(&client).await, RpcError::InvalidFrame);
    }
});

case!(held_long_method_permits_stay_in_byte_budget, {
    let (wire, peer) = codex_rpc::memory_wire(1);
    let (client, mut events) = codex_rpc::spawn(
        wire,
        Limits {
            max_payload: 1024,
            queued_bytes: 1024,
            ..Limits::default()
        },
    )
    .unwrap();
    let method = "m".repeat(codex_rpc::MAX_METHOD_BYTES);
    let mut held = Vec::new();
    for id in 1..=2 {
        peer.outbound
            .send(Ok(json!({"id":id,"method":method})))
            .await
            .unwrap();
        held.push(server_request(&mut events).await);
    }
    peer.outbound
        .send(Ok(json!({"id":3,"method":method})))
        .await
        .unwrap();
    assert_eq!(stopped(&client).await, RpcError::Backpressure);
    assert_eq!(held.len(), 2);
    let (client, _events, peer) = rig();
    peer.outbound
        .send(Ok(
            json!({"id":1,"method":"m".repeat(codex_rpc::MAX_METHOD_BYTES+1)}),
        ))
        .await
        .unwrap();
    assert_eq!(stopped(&client).await, RpcError::InvalidFrame);
});
case!(
    shutdown_before_actor_poll_never_dispatches_queued_command,
    {
        use std::future::Future;
        use std::task::Poll;
        let (client, _events, mut peer) = rig();
        let mut queued = Box::pin(client.notify("queued", json!({})));
        std::future::poll_fn(|cx| {
            assert!(matches!(queued.as_mut().poll(cx), Poll::Pending));
            Poll::Ready(())
        })
        .await;
        client.shutdown();
        assert_eq!(queued.await, Err(RpcError::Shutdown));
        assert!(peer.inbound.recv().await.is_none());
    }
);

case!(three_queued_requests_survive_two_slot_wire_burst, {
    use std::future::Future;
    use std::task::Poll;
    let (wire, mut peer) = codex_rpc::memory_wire(2);
    let (client, _events) = codex_rpc::spawn(wire, Limits::default()).unwrap();
    let mut requests: Vec<_> = (0..3)
        .map(|_| Box::pin(client.request("read", json!({}), WAIT)))
        .collect();
    std::future::poll_fn(|cx| {
        for request in &mut requests {
            assert!(matches!(request.as_mut().poll(cx), Poll::Pending));
        }
        Poll::Ready(())
    })
    .await;
    // Writer only starts draining after all three commands have been queued.
    for _ in 0..3 {
        let frame = peer
            .inbound
            .recv()
            .await
            .expect("burst must not close shared provider");
        peer.outbound
            .send(Ok(json!({"id":frame["id"],"result":true})))
            .await
            .unwrap();
    }
    for request in requests {
        assert_eq!(request.await.unwrap(), true);
    }
    assert!(client.shutdown_signal().borrow().is_none());
    client.shutdown();
});
case!(unsent_timeout_and_cancel_are_removed_before_wire_enqueue, {
    let (client, _events, mut peer) = rig();
    client.notify("occupy-wire", Value::Null).await.unwrap();
    let timed = request(&client, "must-not-send-timeout", Duration::from_millis(100));
    assert_eq!(timed.await.unwrap(), Err(RpcError::Timeout));
    let cancelled = request(&client, "must-not-send-cancel", WAIT);
    // Polling a current-thread task is not required: either cancellation happens
    // before its enqueue or the actor prunes the queued frame before wire space.
    tokio::task::yield_now().await;
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    let after = {
        let client = client.clone();
        tokio::spawn(async move { client.notify("after", Value::Null).await })
    };
    assert_eq!(peer.inbound.recv().await.unwrap()["method"], "occupy-wire");
    after.await.unwrap().unwrap();
    assert_eq!(peer.inbound.recv().await.unwrap()["method"], "after");
    assert!(peer.inbound.try_recv().is_err());
    assert!(client.shutdown_signal().borrow().is_none());
    client.shutdown();
});
case!(notify_ack_waits_for_actual_wire_enqueue, {
    let (client, mut events, mut peer) = rig();
    client.notify("occupy-wire", Value::Null).await.unwrap();
    let notify = {
        let client = client.clone();
        tokio::spawn(async move { client.notify("queued", Value::Null).await })
    };
    peer.outbound
        .send(Ok(json!({"method":"barrier"})))
        .await
        .unwrap();
    events.recv().await.unwrap();
    assert!(!notify.is_finished());
    assert_eq!(peer.inbound.recv().await.unwrap()["method"], "occupy-wire");
    notify.await.unwrap().unwrap();
    assert_eq!(peer.inbound.recv().await.unwrap()["method"], "queued");
    client.shutdown();
});
case!(inbound_response_progresses_while_outbound_writer_is_full, {
    use std::future::Future;
    use std::task::Poll;
    let (client, _events, mut peer) = rig();
    let pending = request(&client, "live", WAIT);
    let frame = peer.inbound.recv().await.unwrap();
    client.notify("occupy-wire", Value::Null).await.unwrap();
    let mut blocked = Box::pin(client.notify("queued", Value::Null));
    std::future::poll_fn(|cx| {
        assert!(matches!(blocked.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    peer.outbound
        .send(Ok(json!({"id":frame["id"],"result":true})))
        .await
        .unwrap();
    // No writer drains the full wire; inbound must still resolve independently.
    assert_eq!(pending.await.unwrap().unwrap(), true);
    std::future::poll_fn(|cx| {
        assert!(matches!(blocked.as_mut().poll(cx), Poll::Pending));
        Poll::Ready(())
    })
    .await;
    client.shutdown();
    assert_eq!(blocked.await, Err(RpcError::Shutdown));
});
