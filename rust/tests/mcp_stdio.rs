use pult_core::{
    mcp_stdio::{self, ToolError, Tools},
    turn_driver::Task,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

struct Handler {
    calls: AtomicUsize,
    active: Arc<AtomicUsize>,
    release: Arc<Notify>,
}
struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Tools for Handler {
    fn list(&self) -> Value {
        json!([{"name":"read","inputSchema":{"type":"object"}}])
    }
    fn call(&self, name: String, _: Value) -> Task<Result<Value, ToolError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if name == "construct-panic" {
            panic!("synthetic construction payload must not be published");
        }
        let active = self.active.clone();
        let release = self.release.clone();
        Box::pin(async move {
            active.fetch_add(1, Ordering::SeqCst);
            let _active = Active(active);
            match name.as_str() {
                "wait" => {
                    release.notified().await;
                    Ok(json!({"ready":true}))
                }
                "panic" => panic!("synthetic callback payload must not be published"),
                "large" => Ok(json!({"text":"x".repeat(mcp_stdio::OUTPUT_BYTES)})),
                _ => Ok(json!({"ok":true})),
            }
        })
    }
}
async fn reply(input: &mut BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>) -> Value {
    let mut line = String::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        input.read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    serde_json::from_str(&line).unwrap()
}
fn handler() -> Arc<Handler> {
    Arc::new(Handler {
        calls: AtomicUsize::new(0),
        active: Arc::new(AtomicUsize::new(0)),
        release: Arc::new(Notify::new()),
    })
}
async fn send(out: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    out.write_all(&bytes).await.unwrap();
}
#[tokio::test]
async fn actual_stdio_negotiates_lists_calls_and_ignores_notifications() {
    let tools = handler();
    let (client, server) = tokio::io::duplex(8192);
    let (read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let owner = tools.clone();
    let running = tokio::spawn(async move {
        mcp_stdio::serve(BufReader::new(input), output, owner, "fixture").await
    });
    let mut read = BufReader::new(read);
    send(
        &mut write,
        json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"read"}}),
    )
    .await;
    send(&mut write,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}})).await;
    assert_eq!(
        reply(&mut read).await["result"]["serverInfo"]["name"],
        "fixture"
    );
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
    )
    .await;
    assert_eq!(reply(&mut read).await["result"]["tools"][0]["name"], "read");
    send(&mut write,json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read","arguments":{}}})).await;
    let value = reply(&mut read).await;
    assert_eq!(
        serde_json::from_str::<Value>(value["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap(),
        json!({"ok":true})
    );
    assert_eq!(tools.calls.load(Ordering::SeqCst), 1);
    write.shutdown().await.unwrap();
    running.await.unwrap().unwrap();
}
#[tokio::test]
async fn callback_panic_and_oversize_output_never_publish_callback_payload() {
    pult_core::panic_guard::install();
    let (client, server) = tokio::io::duplex(8192);
    let (read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let tools = handler();
    let running = tokio::spawn(mcp_stdio::serve(
        BufReader::new(input),
        output,
        tools.clone(),
        "fixture",
    ));
    let mut read = BufReader::new(read);
    for name in ["panic", "construct-panic"] {
        send(
            &mut write,
            json!({"jsonrpc":"2.0","id":"p","method":"tools/call","params":{"name":name}}),
        )
        .await;
        let value = reply(&mut read).await;
        assert_eq!(value["result"]["isError"], true);
        assert!(!value.to_string().contains("synthetic"));
        assert_eq!(tools.active.load(Ordering::SeqCst), 0);
    }
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":"l","method":"tools/call","params":{"name":"large"}}),
    )
    .await;
    let value = reply(&mut read).await;
    assert_eq!(value["id"], "l");
    assert_eq!(value["error"]["code"], -32603);
    write.shutdown().await.unwrap();
    running.await.unwrap().unwrap();
}
#[tokio::test]
async fn capacity_is_bounded_and_eof_joins_all_cancelled_transport_jobs() {
    let tools = handler();
    let active = tools.active.clone();
    let (client, server) = tokio::io::duplex(8192);
    let (read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let running = tokio::spawn(mcp_stdio::serve(
        BufReader::new(input),
        output,
        tools,
        "fixture",
    ));
    let mut read = BufReader::new(read);
    for id in 0..=mcp_stdio::IN_FLIGHT {
        send(
            &mut write,
            json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"wait"}}),
        )
        .await;
    }
    assert_eq!(reply(&mut read).await["error"]["code"], -32000);
    assert!(active.load(Ordering::SeqCst) <= mcp_stdio::IN_FLIGHT);
    write.shutdown().await.unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(active.load(Ordering::SeqCst), 0);
}

// Observe actual consumption of a fragment, rather than depending on scheduler
// timing to assume that the transport has started assembling the next frame.
struct Observed<R> {
    inner: R,
    consumed: Arc<AtomicUsize>,
}
impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Observed<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.inner).poll_read(cx, buffer)
    }
}
impl<R: tokio::io::AsyncBufRead + Unpin> tokio::io::AsyncBufRead for Observed<R> {
    fn poll_fill_buf(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<&[u8]>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_fill_buf(cx)
    }
    fn consume(mut self: std::pin::Pin<&mut Self>, amount: usize) {
        self.consumed.fetch_add(amount, Ordering::SeqCst);
        std::pin::Pin::new(&mut self.inner).consume(amount);
    }
}
async fn until(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !condition() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn completing_other_call_preserves_consumed_partial_frame() {
    let tools = handler();
    let consumed = Arc::new(AtomicUsize::new(0));
    let (client, server) = tokio::io::duplex(8192);
    let (read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let running = tokio::spawn(mcp_stdio::serve(
        Observed {
            inner: BufReader::new(input),
            consumed: consumed.clone(),
        },
        output,
        tools.clone(),
        "fixture",
    ));
    let mut read = BufReader::new(read);
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait"}}),
    )
    .await;
    until(|| tools.active.load(Ordering::SeqCst) == 1).await;
    let before = consumed.load(Ordering::SeqCst);
    let fragment = b"{\"jsonrpc\":\"2.0\",\"id\":2,";
    write.write_all(fragment).await.unwrap();
    until(|| consumed.load(Ordering::SeqCst) == before + fragment.len()).await;
    tools.release.notify_one();
    assert_eq!(reply(&mut read).await["id"], 1);
    write.write_all(b"\"method\":\"ping\"}\n").await.unwrap();
    assert_eq!(
        reply(&mut read).await,
        json!({"jsonrpc":"2.0","id":2,"result":{}})
    );
    write.shutdown().await.unwrap();
    running.await.unwrap().unwrap();
}
#[tokio::test]
async fn invalid_requests_and_notifications_never_invoke_tools() {
    let tools = handler();
    let (client, server) = tokio::io::duplex(8192);
    let (read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let running = tokio::spawn(mcp_stdio::serve(
        BufReader::new(input),
        output,
        tools.clone(),
        "fixture",
    ));
    let mut read = BufReader::new(read);
    for request in [
        json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"read"}}),
        json!({"jsonrpc":"2.0","method":"unknown"}),
    ] {
        send(&mut write, request).await;
    }
    for (request, code) in [
        (json!([]), -32600),
        (json!({"jsonrpc":"1.0","id":1,"method":"ping"}), -32600),
        (json!({"jsonrpc":"2.0","id":{},"method":"ping"}), -32600),
        (json!({"jsonrpc":"2.0","id":null,"method":"ping"}), -32600),
        (json!({"jsonrpc":"2.0","id":1.5,"method":"ping"}), -32600),
        (json!({"jsonrpc":"2.0","id":1,"method":4}), -32600),
        (
            json!({"jsonrpc":"2.0","id":1,"method":"ping","params":[]}),
            -32602,
        ),
        (
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call"}),
            -32602,
        ),
        (
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read","arguments":[]}}),
            -32602,
        ),
        (
            json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":""}}),
            -32602,
        ),
        (json!({"jsonrpc":"2.0","id":1,"method":"unknown"}), -32601),
    ] {
        send(&mut write, request).await;
        assert_eq!(reply(&mut read).await["error"]["code"], code);
    }
    write.write_all(b"invalid json\n").await.unwrap();
    assert_eq!(reply(&mut read).await["error"]["code"], -32700);
    assert_eq!(tools.calls.load(Ordering::SeqCst), 0);
    write.shutdown().await.unwrap();
    running.await.unwrap().unwrap();
}
#[tokio::test]
async fn oversized_input_closes_transport_and_joins_pending_call() {
    let tools = handler();
    let (client, server) = tokio::io::duplex(8192);
    let (_read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let running = tokio::spawn(mcp_stdio::serve(
        BufReader::new(input),
        output,
        tools.clone(),
        "fixture",
    ));
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait"}}),
    )
    .await;
    until(|| tools.active.load(Ordering::SeqCst) == 1).await;
    // Keep the writer's error immaterial: the server may close as soon as the
    // first excess byte arrives, before the writer observes successful delivery.
    let _ = write
        .write_all(&vec![b' '; mcp_stdio::INPUT_BYTES + 1])
        .await;
    let error = running.await.unwrap().unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(tools.calls.load(Ordering::SeqCst), 1);
    assert_eq!(tools.active.load(Ordering::SeqCst), 0);
}

struct CatalogPanics;
impl Tools for CatalogPanics {
    fn list(&self) -> Value {
        panic!("synthetic catalog payload must not be published")
    }
    fn call(&self, _: String, _: Value) -> Task<Result<Value, ToolError>> {
        Box::pin(async { Err(ToolError::Unavailable) })
    }
}
#[tokio::test]
async fn catalog_panic_returns_sanitized_error_and_transport_stays_usable() {
    pult_core::panic_guard::install();
    let (client, server) = tokio::io::duplex(8192);
    let (read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let running = tokio::spawn(mcp_stdio::serve(
        BufReader::new(input),
        output,
        Arc::new(CatalogPanics),
        "fixture",
    ));
    let mut read = BufReader::new(read);
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}),
    )
    .await;
    let value = reply(&mut read).await;
    assert_eq!(value["error"]["code"], -32603);
    assert!(!value.to_string().contains("synthetic"));
    send(&mut write, json!({"jsonrpc":"2.0","id":2,"method":"ping"})).await;
    assert_eq!(reply(&mut read).await["result"], json!({}));
    write.shutdown().await.unwrap();
    running.await.unwrap().unwrap();
}
#[tokio::test]
async fn stalled_output_deadline_cancels_active_transport_calls() {
    let tools = handler();
    // A reply cannot fit, so write_all stays pending even if it writes a prefix.
    let (client, server) = tokio::io::duplex(1);
    let (_read, mut write) = tokio::io::split(client);
    let (input, output) = tokio::io::split(server);
    let running = tokio::spawn(mcp_stdio::serve(
        BufReader::new(input),
        output,
        tools.clone(),
        "fixture",
    ));
    send(
        &mut write,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait"}}),
    )
    .await;
    until(|| tools.active.load(Ordering::SeqCst) == 1).await;
    send(&mut write, json!({"jsonrpc":"2.0","id":2,"method":"ping"})).await;
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert_eq!(tools.active.load(Ordering::SeqCst), 0);
}
