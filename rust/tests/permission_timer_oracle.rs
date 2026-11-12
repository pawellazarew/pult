//! Actual Node 24 timer-list normalization, without waiting for long timers.
//! No account, provider, network connection or real credential is used.
use pult_core::permission_broker::{
    BrokerError, DEFAULT_TIMEOUT, MAX_PENDING, NODE_MAX_TIMEOUT_MS, Options,
};
use serde_json::Value;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

#[tokio::test]
async fn floating_millisecond_options_match_the_actual_node24_timer_list() {
    let corpus = vec![
        0.0,
        -0.0,
        0.125,
        0.999,
        1.0,
        1.75,
        2.999,
        600000.0,
        600001.0,
        NODE_MAX_TIMEOUT_MS as f64 - 0.5,
        NODE_MAX_TIMEOUT_MS as f64,
        NODE_MAX_TIMEOUT_MS as f64 + 0.5,
        1e100,
        f64::MAX,
    ];
    const SCRIPT: &str = r#"
const fs = require('node:fs');
if (!process.version.startsWith('v24.')) throw new Error('permission timer oracle requires Node 24');
const values = JSON.parse(fs.readFileSync(0, 'utf8'));
const timers = values.map(delay => {
  const timer = setTimeout(() => {}, delay);
  // Node's actual timer-list bucket reflects insert() truncation, unlike
  // _idleTimeout, which still retains an in-range fraction such as 1.75.
  const scheduledMs = timer._idleNext?.msecs;
  clearTimeout(timer);
  if (!Number.isInteger(scheduledMs)) throw new Error('Node 24 timer-list shape changed');
  return scheduledMs;
});
process.stdout.write(JSON.stringify({version: process.version, timers}));
"#;
    let mut child = Command::new("node")
        .arg("-e")
        .arg(SCRIPT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("Node 24 is required for permission timer parity");
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut input = child.stdin.take().unwrap();
        input
            .write_all(&serde_json::to_vec(&corpus).unwrap())
            .await
            .unwrap();
        input.shutdown().await.unwrap();
        drop(input);
        child.wait_with_output().await.unwrap()
    })
    .await
    .expect("Node timer oracle exceeded its 10s watchdog");
    assert!(
        output.status.success(),
        "Node 24 oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(expected["version"].as_str().unwrap().starts_with("v24."));
    for (index, milliseconds) in corpus.into_iter().enumerate() {
        let options = Options::from_timeout_ms(milliseconds).unwrap();
        assert_eq!(
            options.timeout.as_millis(),
            expected["timers"][index].as_u64().unwrap() as u128,
            "Node milliseconds case {index}"
        );
        assert_eq!(options.pending, MAX_PENDING);
    }
}
#[test]
fn invalid_float_milliseconds_are_rejected_and_default_is_unchanged() {
    for milliseconds in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.125, -1.0] {
        assert!(matches!(
            Options::from_timeout_ms(milliseconds),
            Err(BrokerError::Invalid)
        ));
    }
    assert_eq!(Options::default().timeout, DEFAULT_TIMEOUT);
    assert_eq!(
        Options::from_timeout_ms(600000.0).unwrap().timeout,
        DEFAULT_TIMEOUT
    );
    assert_eq!(
        Options::from_timeout_ms(600001.0).unwrap().timeout,
        Duration::from_millis(600001)
    );
    assert_eq!(
        Options::from_timeout_ms(NODE_MAX_TIMEOUT_MS as f64 + 0.5)
            .unwrap()
            .timeout,
        Duration::from_millis(1)
    );
}
