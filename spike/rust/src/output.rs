use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::io::Write;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

struct Frame {
    bytes: Vec<u8>,
    written: oneshot::Sender<std::io::Result<()>>,
}

/// A blocked OS pipe must not pin a Tokio worker or its shutdown pool.
/// At most one queued frame and one writing frame are retained; replies fail
/// explicitly if the caller does not drain them within the deadline.
pub struct ControlOutput {
    sender: mpsc::Sender<Frame>,
}

impl ControlOutput {
    pub fn new() -> Self {
        let (sender, mut receiver) = mpsc::channel::<Frame>(1);
        std::thread::spawn(move || {
            let stdout = std::io::stdout();
            let mut writer = stdout.lock();
            while let Some(frame) = receiver.blocking_recv() {
                let result = writer.write_all(&frame.bytes).and_then(|_| writer.flush());
                let failed = result.is_err();
                let _ = frame.written.send(result);
                if failed {
                    break;
                }
            }
        });
        Self { sender }
    }

    pub async fn reply(&self, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        ensure!(
            bytes.len() <= pult_r1::MAX_LINE,
            "control reply exceeds 1 MiB"
        );
        let (written, acknowledgement) = oneshot::channel();
        tokio::time::timeout(Duration::from_secs(1), async {
            self.sender
                .send(Frame { bytes, written })
                .await
                .context("control stdout writer stopped")?;
            acknowledgement
                .await
                .context("control stdout writer stopped before acknowledgement")??;
            Ok::<(), anyhow::Error>(())
        })
        .await
        .context("control stdout did not drain within one second")?
    }
}
