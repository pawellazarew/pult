//! Owner-only read-only event subscription client. No daemon spawn/retry/provider access.
use serde_json::{Value, json, value::RawValue};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::fd::AsFd;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

const HANDSHAKE: Duration = Duration::from_secs(10);
const REPLAY_WAIT: Duration = Duration::from_secs(3);
const OUTPUT_WAIT: Duration = Duration::from_secs(2);
type Fields = HashMap<String, Box<RawValue>>;
#[derive(Debug)]
pub struct Error {
    pub exit: i32,
    message: &'static str,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Error {}
fn invalid() -> Error {
    Error {
        exit: 1,
        message: "invalid event subscription response",
    }
}
fn io_error() -> Error {
    Error {
        exit: 1,
        message: "event subscription IO failed",
    }
}
fn timed_out() -> Error {
    Error {
        exit: 2,
        message: "event subscription handshake timed out",
    }
}
fn fields(bytes: &[u8]) -> Result<Fields, Error> {
    serde_json::from_slice(bytes).map_err(|_| invalid())
}
fn value(v: &RawValue) -> Result<Value, Error> {
    serde_json::from_str(v.get()).map_err(|_| invalid())
}
fn integer(fields: &Fields, key: &str) -> Result<u64, Error> {
    value(fields.get(key).ok_or_else(invalid)?)?
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(invalid)
}
async fn line<R: AsyncBufRead + Unpin>(
    input: &mut R,
    disconnect_is_eof: bool,
) -> Result<Option<Vec<u8>>, Error> {
    let mut line = Vec::new();
    loop {
        let chunk = match input.fill_buf().await {
            Ok(chunk) => chunk,
            Err(_) if disconnect_is_eof => return Ok(None),
            Err(_) => return Err(io_error()),
        };
        if chunk.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(invalid())
            };
        }
        let count = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |i| i + 1);
        if line.len() + count > pult_core::MAX_LINE + 1 {
            return Err(Error {
                exit: 1,
                message: "event subscription frame exceeds limit",
            });
        }
        let end = chunk[count - 1] == b'\n';
        line.extend_from_slice(&chunk[..count]);
        input.consume(count);
        if end {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}
async fn bounded_line<R: AsyncBufRead + Unpin>(input: &mut R) -> Result<Vec<u8>, Error> {
    tokio::time::timeout(HANDSHAKE, line(input, false))
        .await
        .map_err(|_| timed_out())??
        .ok_or_else(io_error)
}
async fn write_request(socket: &mut UnixStream, v: Value) -> Result<(), Error> {
    let mut bytes = serde_json::to_vec(&v).map_err(|_| invalid())?;
    bytes.push(b'\n');
    if bytes.len() > pult_core::MAX_LINE {
        return Err(invalid());
    }
    tokio::time::timeout(HANDSHAKE, socket.write_all(&bytes))
        .await
        .map_err(|_| timed_out())?
        .map_err(|_| io_error())
}
fn display(fields: &Fields, key: &str) -> Result<String, Error> {
    pult_core::display_string(fields.get(key).ok_or_else(invalid)?).map_err(|_| invalid())
}
fn event_output(raw: &RawValue, json: bool) -> Result<(u64, String), Error> {
    let f = fields(raw.get().as_bytes())?;
    let id = integer(&f, "id")?;
    if json {
        return Ok((id, format!("{}\n", raw.get())));
    }
    let data = f.get("data").ok_or_else(invalid)?;
    // RawValue keeps lone JS UTF-16 code units and unknown extensions intact.
    // Server events are already normalized before subscription serialization;
    // retain that data representation without a scalar-only Value conversion.
    let data = data.get();
    Ok((
        id,
        format!(
            "#{id} {} {}/{} {}{}\n",
            display(&f, "ts")?,
            display(&f, "provider")?,
            display(&f, "kind")?,
            display(&f, "sessionId")?,
            if data == "{}" {
                String::new()
            } else {
                format!(" {data}")
            }
        ),
    ))
}
async fn output(text: String) -> Result<(), Error> {
    emit(text, false).await
}
pub(super) async fn emit(text: String, stderr: bool) -> Result<(), Error> {
    // A duplicated File does not hold Rust's global stdout lock. exit() can
    // perform its own stdio cleanup even if this OS write remains blocked.
    // Duplication changes no shared file status flags or parent TTY settings.
    let owned = if stderr {
        std::io::stderr().as_fd().try_clone_to_owned()
    } else {
        std::io::stdout().as_fd().try_clone_to_owned()
    }
    .map_err(|_| io_error())?;
    let task = tokio::task::spawn_blocking(move || {
        let mut out = std::fs::File::from(owned);
        out.write_all(text.as_bytes())?;
        out.flush()
    });
    match tokio::time::timeout(OUTPUT_WAIT, task).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) if error.kind() == std::io::ErrorKind::BrokenPipe => Err(Error {
            exit: 1,
            message: "event output pipe is closed",
        }),
        _ => Err(Error {
            exit: 1,
            message: "event output could not be completed",
        }),
    }
}

/// Returns only after the socket is dropped. main exits the CLI explicitly to
/// avoid a cancelled blocking stdout worker holding runtime shutdown forever.
pub async fn events_tail(
    home: &Path,
    since: f64,
    session: Option<String>,
    limit: f64,
    json: bool,
    no_follow: bool,
) -> Result<(), Error> {
    // Purpose separation before any owner home/config/token read.
    if std::env::var_os("PULT_MEMORY_KEY").is_some()
        || std::env::var_os("PULT_MEMORY_TURN_KEY").is_some()
    {
        return Err(Error {
            exit: 1,
            message: "event subscriptions require owner authentication",
        });
    }
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(|_| io_error())?;
    tokio::select! {
        _=interrupt.recv()=>Ok(()),
        result=tail_session(home,since,session,limit,json,no_follow)=>result,
    }
}
async fn tail_session(
    home: &Path,
    since: f64,
    session: Option<String>,
    limit: f64,
    json: bool,
    no_follow: bool,
) -> Result<(), Error> {
    let (mut reader, locale) = owner_connection(home).await?;
    let mut params = json!({"since":since});
    if let Some(session) = session {
        params["sessionId"] = json!(session);
    }
    write_request(
        reader.get_mut(),
        json!({"id":1,"method":"events.subscribe","locale":locale,"params":params}),
    )
    .await?;
    let ack = fields(&bounded_line(&mut reader).await?)?;
    if integer(&ack, "id")? != 1 || ack.contains_key("error") {
        return Err(Error {
            exit: 1,
            message: "event subscription was rejected",
        });
    }
    let result = fields(ack.get("result").ok_or_else(invalid)?.get().as_bytes())?;
    let sub = integer(&result, "sub")?;
    let cursor = integer(&result, "cursor")?;
    let replay_deadline = tokio::time::Instant::now() + REPLAY_WAIT;
    let mut shown = 0u64;
    let mut last_id = since;
    loop {
        if no_follow && last_id >= cursor as f64 {
            return Ok(());
        }
        let frame = tokio::select! {
            _=tokio::time::sleep_until(replay_deadline),if no_follow=>return Ok(()),
            frame=line(&mut reader, true)=>frame?,
        };
        let Some(frame) = frame else {
            return Ok(());
        };
        let frame = fields(&frame)?;
        if integer(&frame, "sub")? != sub {
            continue;
        }
        if frame.contains_key("end") {
            return Ok(());
        }
        let raw = frame.get("event").ok_or_else(invalid)?;
        let (event_id, text) = event_output(raw, json)?;
        output(text).await?;
        shown += 1;
        last_id = event_id as f64;
        if limit != 0.0 && shown as f64 >= limit {
            return Ok(());
        }
    }
}

// Shared owner handshake/framing for event tail and the private wait CLI policy.
// Callers must separate credential purposes BEFORE entering this filesystem path.
async fn owner_connection(home: &Path) -> Result<(BufReader<UnixStream>, &'static str), Error> {
    let home = pult_core::checked_home(home).map_err(|_| Error {
        exit: 1,
        message: "event subscription requires a private Rust scratch home",
    })?;
    let locale = pult_core::cli_locale(&home).map_err(|_| io_error())?;
    Ok((owner_connection_at(&home).await?, locale))
}
async fn owner_connection_at(home: &Path) -> Result<BufReader<UnixStream>, Error> {
    let mut token = String::new();
    std::fs::File::open(home.join("run/token"))
        .map_err(|_| io_error())?
        .take(65)
        .read_to_string(&mut token)
        .map_err(|_| io_error())?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io_error());
    }
    let mut socket =
        tokio::time::timeout(HANDSHAKE, UnixStream::connect(home.join("run/pultd.sock")))
            .await
            .map_err(|_| timed_out())?
            .map_err(|_| io_error())?;
    write_request(
        &mut socket,
        json!({"type":"hello","protocol":pult_core::PROTOCOL,"token":token,"client":"cli"}),
    )
    .await?;
    let mut reader = BufReader::new(socket);
    let hello = fields(&bounded_line(&mut reader).await?)?;
    if hello.get("type").map(|v| value(v)).transpose()? != Some(json!("hello_ok"))
        || integer(&hello, "protocol")? != pult_core::PROTOCOL
    {
        return Err(invalid());
    }
    Ok(reader)
}

pub(super) struct RpcError {
    pub code: String,
    pub message: String,
}
impl RpcError {
    pub fn local(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<Error> for RpcError {
    fn from(error: Error) -> Self {
        Self::local(
            if error.exit == 2 {
                "timeout"
            } else {
                "connection_closed"
            },
            "daemon connection or response failed",
        )
    }
}
pub(super) enum ResponsePolicy {
    Ordinary,
    Wait,
}
pub(super) struct OwnerClient {
    reader: BufReader<UnixStream>,
    pub locale: &'static str,
    next_id: u64,
}
impl OwnerClient {
    fn owner_purpose() -> Result<(), RpcError> {
        if [
            "PULT_MEMORY_KEY",
            "PULT_MEMORY_TURN_KEY",
            "PULT_ASK_KEY",
            "PULT_RUNTIME_KEY",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
        {
            return Err(RpcError::local(
                "forbidden",
                "agent wait requires owner authentication",
            ));
        }
        Ok(())
    }
    pub async fn connect(home: &Path) -> Result<Self, RpcError> {
        Self::owner_purpose()?;
        let (reader, locale) = owner_connection(home).await?;
        Ok(Self {
            reader,
            locale,
            next_id: 1,
        })
    }
    /// Status-only observation: local validation stays fatal; only the
    /// token/socket/handshake/ordinary RPC stage can be an offline result.
    pub async fn status(
        home: &Path,
    ) -> Result<(std::path::PathBuf, &'static str, Option<Box<RawValue>>), RpcError> {
        Self::owner_purpose()?;
        let home = pult_core::checked_home(home).map_err(|_| {
            RpcError::local(
                "invalid_home",
                "service status requires a private Rust scratch home",
            )
        })?;
        let locale = pult_core::cli_locale(&home).map_err(|_| {
            RpcError::local("invalid_config", "service status locale is unavailable")
        })?;
        let reply = match owner_connection_at(&home).await {
            Ok(reader) => {
                let mut client = Self {
                    reader,
                    locale,
                    next_id: 1,
                };
                client
                    .request("daemon.status", json!({}), ResponsePolicy::Ordinary)
                    .await
                    .ok()
            }
            Err(_) => None,
        };
        Ok((home, locale, reply))
    }
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        policy: ResponsePolicy,
    ) -> Result<Box<RawValue>, RpcError> {
        if matches!(policy, ResponsePolicy::Wait) && method != "agent.wait" {
            return Err(RpcError::local(
                "invalid_params",
                "long response policy is reserved for agent.wait",
            ));
        }
        let id = self.next_id;
        self.next_id += 1;
        write_request(
            self.reader.get_mut(),
            json!({"id":id,"method":method,"params":params,"locale":self.locale}),
        )
        .await?;
        let response = match policy {
            ResponsePolicy::Ordinary => {
                tokio::time::timeout(Duration::from_secs(3), line(&mut self.reader, false))
                    .await
                    .map_err(|_| RpcError::local("timeout", "daemon response timed out"))??
            }
            ResponsePolicy::Wait => line(&mut self.reader, false).await?,
        }
        .ok_or_else(|| RpcError::local("connection_closed", "connection to daemon closed"))?;
        let mut response = fields(&response)?;
        if integer(&response, "id")? != id
            || response.contains_key("result") == response.contains_key("error")
        {
            return Err(RpcError::local(
                "invalid_response",
                "invalid daemon response",
            ));
        }
        if let Some(raw) = response.remove("error") {
            let error = fields(raw.get().as_bytes())?;
            return Err(RpcError {
                code: display(&error, "code")?,
                message: display(&error, "message")?,
            });
        }
        response
            .remove("result")
            .ok_or_else(|| RpcError::local("invalid_response", "missing daemon result"))
    }
}
