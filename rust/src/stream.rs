//! Bounded connection output and lossless JavaScript-compatible event clipping.
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::value::{RawValue, to_raw_value};
use std::collections::HashMap;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch};
use tokio::task::JoinHandle;

pub const REPLAY_STALL: Duration = Duration::from_secs(30);
const RPC_STALL: Duration = Duration::from_secs(1);
const BACKLOG_BYTES: usize = 8 * 1024 * 1024;
const EVENT_BYTES: usize = 900 * 1024;

struct Frame {
    bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
    active: Option<Arc<AtomicBool>>,
    deadline: Duration,
    done: oneshot::Sender<Result<()>>,
}

#[derive(Clone)]
pub struct Writer {
    queue: mpsc::Sender<Frame>,
    budget: Arc<Semaphore>,
    closed: watch::Receiver<bool>,
}

pub struct WriterTask(JoinHandle<()>);
impl Drop for WriterTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Writer {
    pub fn start(mut output: OwnedWriteHalf) -> (Self, WriterTask) {
        let (queue, mut frames) = mpsc::channel::<Frame>(64);
        let budget = Arc::new(Semaphore::new(BACKLOG_BYTES));
        let (close, closed) = watch::channel(false);
        let task = tokio::spawn(async move {
            while let Some(frame) = frames.recv().await {
                if frame
                    .active
                    .as_ref()
                    .is_some_and(|active| !active.load(Ordering::Acquire))
                {
                    let _ = frame.done.send(Ok(()));
                    continue;
                }
                let result = async {
                    let mut offset = 0;
                    while offset < frame.bytes.len() {
                        let count = tokio::time::timeout(
                            frame.deadline,
                            output.write(&frame.bytes[offset..]),
                        )
                        .await
                        .context("client write stalled")??;
                        ensure!(count != 0, "client closed its output");
                        offset += count;
                    }
                    Ok(())
                }
                .await;
                let failed = result.is_err();
                let _ = frame.done.send(result);
                if failed {
                    break;
                }
            }
            let _ = output.shutdown().await;
            let _ = close.send(true);
        });
        (
            Self {
                queue,
                budget,
                closed,
            },
            WriterTask(task),
        )
    }

    pub fn closed(&self) -> watch::Receiver<bool> {
        self.closed.clone()
    }

    pub async fn response<T: Serialize>(&self, value: &T) -> Result<()> {
        self.send(value, None, RPC_STALL).await
    }

    pub async fn event<T: Serialize>(&self, value: &T, active: Arc<AtomicBool>) -> Result<()> {
        self.send(value, Some(active), REPLAY_STALL).await
    }

    async fn send<T: Serialize>(
        &self,
        value: &T,
        active: Option<Arc<AtomicBool>>,
        deadline: Duration,
    ) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        ensure!(
            bytes.len() <= crate::MAX_LINE,
            "response exceeds frame budget"
        );
        // Each producer retains at most one frame. The byte permit includes the
        // queued frame and the frame currently being written to the socket.
        let permit = tokio::time::timeout(
            deadline,
            self.budget.clone().acquire_many_owned(bytes.len() as u32),
        )
        .await
        .context("client output budget stalled")??;
        let (done, received) = oneshot::channel();
        tokio::time::timeout(
            deadline,
            self.queue.send(Frame {
                bytes,
                _permit: permit,
                active,
                deadline,
                done,
            }),
        )
        .await
        .context("client output queue stalled")?
        .map_err(|_| anyhow::anyhow!("client writer closed"))?;
        // The writer itself limits time without progress. Waiting for its result
        // must not turn a slowly progressing large frame into a fixed-time kill.
        received.await.context("client writer closed")?
    }
}

pub(crate) fn encode_units(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for character in char::decode_utf16(units.iter().copied()) {
        match character {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(ch) if ch < '\u{20}' => out.push_str(&format!("\\u{:04x}", u32::from(ch))),
            Ok(ch) => out.push(ch),
            Err(error) => out.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

/// The input is already validated JSON. Copy keys verbatim and shorten only
/// string values, preserving UTF-16 slices including an unpaired final unit.
fn clip_data(input: &RawValue, limit: usize) -> Result<Box<RawValue>> {
    let input = input.get();
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len().min(EVENT_BYTES));
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] != b'"' {
            output.push(char::from(bytes[cursor]));
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 1;
        while bytes[cursor] != b'"' {
            cursor += if bytes[cursor] == b'\\' { 2 } else { 1 };
        }
        cursor += 1;
        let literal = &input[start..cursor];
        let key = bytes[cursor..]
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace())
            == Some(b':');
        if key {
            output.push_str(literal);
            continue;
        }
        let raw = RawValue::from_string(literal.to_owned())?;
        let units = crate::journal::decode_js_string(&raw)?;
        if units.len() > limit {
            let mut units = units[..limit].to_vec();
            units.push(0x2026);
            output.push_str(&encode_units(&units));
        } else {
            output.push_str(literal);
        }
    }
    Ok(RawValue::from_string(output)?)
}

pub fn fit_event(event: Box<RawValue>) -> Result<Box<RawValue>> {
    if event.get().len() <= EVENT_BYTES {
        return Ok(event);
    }
    let mut fields: HashMap<String, Box<RawValue>> = serde_json::from_str(event.get())?;
    let original = fields
        .remove("data")
        .unwrap_or(RawValue::from_string("{}".into())?);
    for limit in [20_000, 5_000, 1_250, 312, 78, 19] {
        fields.insert("data".into(), clip_data(&original, limit)?);
        let candidate = to_raw_value(&fields)?;
        if candidate.get().len() <= EVENT_BYTES {
            return Ok(candidate);
        }
    }
    fields.insert(
        "data".into(),
        RawValue::from_string("{\"clipped\":true}".into())?,
    );
    Ok(to_raw_value(&fields)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_clipping_preserves_keys_and_unpaired_values() {
        let input = RawValue::from_string(
            r#"{"long-key":["🌊🌊x","\ud800abc"],"nested":{"text":"abcd"}}"#.into(),
        )
        .unwrap();
        let clipped = clip_data(&input, 3).unwrap();
        assert_eq!(
            clipped.get(),
            r#"{"long-key":["🌊\ud83c…","\ud800ab…"],"nested":{"text":"abc…"}}"#
        );
    }
    #[test]
    fn oversized_event_fits_without_changing_its_metadata() {
        let input = serde_json::json!({"id":9,"sessionId":"x","kind":"message.done","data":{"text":"🌊".repeat(300_000)}});
        let fit = fit_event(to_raw_value(&input).unwrap()).unwrap();
        assert!(fit.get().len() < EVENT_BYTES);
        let fit: serde_json::Value = serde_json::from_str(fit.get()).unwrap();
        assert_eq!(fit["id"], 9);
        assert_eq!(
            fit["data"]["text"].as_str().unwrap().encode_utf16().count(),
            20_001
        );
    }
}
