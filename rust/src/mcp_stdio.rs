//! Bounded line-delimited stdio JSON-RPC transport. Tool authority belongs to the injected host.
//! Implements initialize, ping, tools/list, and tools/call; this is not a full MCP implementation.
//! Hosts install `panic_guard` before serving to suppress callback panic payloads on stderr.
use crate::turn_driver::Task;
use serde_json::{Value, json};
use std::{
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::task::JoinSet;

pub const INPUT_BYTES: usize = 256 * 1024;
pub const OUTPUT_BYTES: usize = 512 * 1024;
pub const IN_FLIGHT: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolError {
    Invalid,
    Forbidden,
    Unavailable,
    Capacity,
}
impl ToolError {
    fn message(self) -> &'static str {
        match self {
            Self::Invalid => "invalid tool arguments",
            Self::Forbidden => "tool operation is not permitted",
            Self::Unavailable => "tool service is unavailable",
            Self::Capacity => "tool operation capacity reached",
        }
    }
}
pub trait Tools: Send + Sync + 'static {
    fn list(&self) -> Value;
    fn call(&self, name: String, arguments: Value) -> Task<Result<Value, ToolError>>;
}

struct Protected(Task<Result<Value, ToolError>>);
impl Future for Protected {
    type Output = Result<Value, ToolError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        std::panic::catch_unwind(AssertUnwindSafe(|| self.get_mut().0.as_mut().poll(cx)))
            .unwrap_or(Poll::Ready(Err(ToolError::Unavailable)))
    }
}
fn error(id: Value, code: i32, message: &'static str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn result(id: Value, value: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":value})
}
fn valid_id(id: &Value) -> bool {
    id.as_str().is_some_and(|v| v.len() <= 512) || id.as_i64().is_some() || id.as_u64().is_some()
}
async fn frame<R: AsyncBufRead + Unpin>(
    input: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<Option<Vec<u8>>> {
    loop {
        let bytes = input.fill_buf().await?;
        if bytes.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(std::io::ErrorKind::UnexpectedEof.into())
            };
        }
        let end = bytes.iter().position(|byte| *byte == b'\n');
        let count = end.map_or(bytes.len(), |at| at + 1);
        if line.len().saturating_add(count) > INPUT_BYTES {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        line.extend_from_slice(&bytes[..count]);
        input.consume(count);
        if end.is_some() {
            return Ok(Some(std::mem::take(line)));
        }
    }
}
// Reserve one byte for the newline and stop serialization before allocating
// an arbitrarily large buffer supplied by a tool callback.
fn bounded_json(value: &Value) -> std::io::Result<Vec<u8>> {
    struct Buffer(Vec<u8>);
    impl std::io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) >= OUTPUT_BYTES {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut buffer = Buffer(Vec::new());
    serde_json::to_writer(&mut buffer, value)?;
    Ok(buffer.0)
}
async fn write<W: AsyncWrite + Unpin>(out: &mut W, reply: Value) -> std::io::Result<()> {
    let mut encoded = bounded_json(&reply).unwrap_or_else(|_| {
        serde_json::to_vec(&error(
            reply["id"].clone(),
            -32603,
            "tool output exceeds budget",
        ))
        .expect("bounded JSON-RPC error is serializable")
    });
    encoded.push(b'\n');
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        out.write_all(&encoded).await?;
        out.flush().await
    })
    .await
    .map_err(|_| std::io::ErrorKind::TimedOut)?
}

/// EOF/error aborts and joins transport jobs. A host must separately retain any
/// admitted database/journal operation until its own commit outcome is known.
pub async fn serve<R, W>(
    mut input: R,
    mut output: W,
    tools: Arc<dyn Tools>,
    name: &'static str,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut jobs = JoinSet::new();
    let mut incoming = Vec::new();
    let outcome = loop {
        tokio::select! {
            completed = jobs.join_next(), if !jobs.is_empty() => {
                if let Some(Ok(reply)) = completed
                    && let Err(error) = write(&mut output, reply).await
                {
                    break Err(error);
                }
            }
            next = frame(&mut input, &mut incoming) => {
                let raw = match next { Ok(Some(raw)) => raw, Ok(None) => break Ok(()), Err(error) => break Err(error) };
                let request: Value = match serde_json::from_slice(&raw) {
                    Ok(value) => value,
                    Err(_) => {
                        if let Err(error) = write(&mut output, error(Value::Null, -32700, "invalid JSON-RPC frame")).await { break Err(error); }
                        continue;
                    }
                };
                if !request.is_object() || request["jsonrpc"] != "2.0" {
                    if let Err(error) = write(&mut output, error(Value::Null, -32600, "invalid JSON-RPC request")).await { break Err(error); }
                    continue;
                }
                let Some(id) = request.get("id").cloned() else { continue; };
                if !valid_id(&id) {
                    if let Err(error) = write(&mut output, error(Value::Null, -32600, "invalid JSON-RPC id")).await { break Err(error); }
                    continue;
                }
                let Some(method) = request["method"].as_str().filter(|method| !method.is_empty()) else {
                    if let Err(error) = write(&mut output, error(id, -32600, "invalid JSON-RPC method")).await { break Err(error); }
                    continue;
                };
                if request.get("params").is_some_and(|params| !params.is_object()) {
                    if let Err(error) = write(&mut output, error(id, -32602, "invalid method parameters")).await { break Err(error); }
                    continue;
                }
                let reply = match method {
                    "initialize" => result(id, json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":name,"version":env!("CARGO_PKG_VERSION")}})),
                    "ping" => result(id, json!({})),
                    "tools/list" => match std::panic::catch_unwind(AssertUnwindSafe(|| tools.list())) {
                        Ok(list) => result(id, json!({"tools":list})),
                        Err(_) => error(id, -32603, "tool catalog unavailable"),
                    },
                    "tools/call" => {
                        let params = &request["params"];
                        let tool = params["name"].as_str().filter(|name| !name.is_empty() && name.len() <= 128);
                        let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
                        match tool {
                            Some(tool) if params.is_object() && arguments.is_object() => {
                                if jobs.len() >= IN_FLIGHT {
                                    error(id, -32000, "tool operation capacity reached")
                                } else {
                                    let owner = tools.clone();
                                    let tool = tool.to_owned();
                                    let future = std::panic::catch_unwind(AssertUnwindSafe(|| owner.call(tool, arguments)))
                                        .unwrap_or_else(|_| Box::pin(async { Err(ToolError::Unavailable) }));
                                    jobs.spawn(async move {
                                        let payload = match Protected(future).await {
                                            Ok(value) => match bounded_json(&value) {
                                                Ok(text) => json!({"content":[{"type":"text","text":String::from_utf8(text).expect("JSON is UTF-8")}]}),
                                                Err(_) => return error(id, -32603, "tool output exceeds budget"),
                                            },
                                            Err(failure) => json!({"isError":true,"content":[{"type":"text","text":failure.message()}]}),
                                        };
                                        result(id, payload)
                                    });
                                    continue;
                                }
                            }
                            _ => error(id, -32602, "invalid tool call"),
                        }
                    }
                    _ => error(id, -32601, "method not found"),
                };
                if let Err(error) = write(&mut output, reply).await { break Err(error); }
            }
        }
    };
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    outcome
}
