//! Memory-only credentials never fall back to the owner's token or configuration.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json, value::RawValue};
use std::{collections::HashMap, path::Path, time::Duration};
use tokio::{io::BufReader, net::UnixStream};

fn valid_key(key: &str) -> bool {
    key.len() == 68
        && key.starts_with("mem_")
        && key.as_bytes()[4..].iter().all(u8::is_ascii_hexdigit)
}

/// Connect using an explicitly supplied memory credential. No owner credential
/// or display configuration is read, including when this request is rejected.
pub async fn request(home: &Path, key: &str, method: &str, params: Value) -> Result<Box<RawValue>> {
    ensure!(
        valid_key(key),
        "PULT_MEMORY_KEY must be a memory credential"
    );
    let home = crate::checked_home(home)?;
    let socket = tokio::time::timeout(
        Duration::from_secs(3),
        UnixStream::connect(home.join("run/pultd.sock")),
    )
    .await
    .context("memory daemon connection deadline exceeded")??;
    let (input, mut output) = socket.into_split();
    let mut input = BufReader::new(input);
    crate::write_value(
        &mut output,
        &json!({"type":"hello","protocol":crate::PROTOCOL,"memory":key,"client":"memory-cli"}),
    )
    .await?;
    let hello = tokio::time::timeout(Duration::from_secs(3), crate::read_line(&mut input))
        .await??
        .context("memory daemon closed before hello")?;
    let hello: Value = serde_json::from_slice(&hello).context("invalid memory daemon handshake")?;
    // A failing or untrusted endpoint may echo input. Do not put the handshake,
    // which contains a credential at the other end, into an error message.
    ensure!(
        hello["type"] == "hello_ok" && hello["protocol"].as_u64() == Some(crate::PROTOCOL),
        "memory credential handshake rejected"
    );
    crate::write_value(
        &mut output,
        &json!({"id":1,"method":method,"params":params}),
    )
    .await?;
    let response = tokio::time::timeout(Duration::from_secs(3), crate::read_line(&mut input))
        .await??
        .context("memory daemon closed before response")?;
    let mut response: HashMap<String, Box<RawValue>> =
        serde_json::from_slice(&response).context("invalid memory daemon response")?;
    let id: Value =
        serde_json::from_str(response.get("id").context("response is missing id")?.get())?;
    ensure!(
        id.as_u64() == Some(1),
        "response does not match pending request"
    );
    if let Some(error) = response.get("error") {
        // Normalize JSON escapes before redacting: an endpoint can echo the
        // same ASCII credential using \u escapes in an otherwise valid error.
        let error = serde_json::from_str::<Value>(error.get())
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "invalid memory error response".to_owned());
        bail!("request failed: {}", error.replace(key, "<REDACTED>"));
    }
    response
        .remove("result")
        .context("response is missing result")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use tokio::net::UnixListener;

    fn scratch() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(home.path().join("run")).unwrap();
        // This cannot be read as an owner-token file. The scoped client still works.
        std::fs::create_dir(home.path().join("run/token")).unwrap();
        let mut marker = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(home.path().join(".rust-core-scratch"))
            .unwrap();
        std::io::Write::write_all(&mut marker, crate::SCRATCH_MARKER.as_bytes()).unwrap();
        std::fs::write(
            home.path().join("config.json"),
            b"not display configuration",
        )
        .unwrap();
        home
    }

    #[tokio::test]
    async fn scoped_wire_has_no_owner_authority_and_preserves_raw_result() {
        let home = scratch();
        let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        let key = format!("mem_{}", "a".repeat(64));
        let expected = key.clone();
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (input, mut output) = stream.into_split();
            let mut input = BufReader::new(input);
            let hello = crate::read_line(&mut input).await.unwrap().unwrap();
            let hello: Value = serde_json::from_slice(&hello).unwrap();
            assert_eq!(
                hello,
                json!({"type":"hello","protocol":crate::PROTOCOL,"memory":expected,"client":"memory-cli"})
            );
            crate::write_value(
                &mut output,
                &json!({"type":"hello_ok","protocol":crate::PROTOCOL}),
            )
            .await
            .unwrap();
            let request = crate::read_line(&mut input).await.unwrap().unwrap();
            let request: Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(
                request,
                json!({"id":1,"method":"memory.get","params":{"id":"note"}})
            );
            let raw =
                RawValue::from_string(r#"{"id":1,"result":{"text":"\ud800"}}"#.to_owned()).unwrap();
            crate::write_value(&mut output, &raw).await.unwrap();
        });
        let result = request(home.path(), &key, "memory.get", json!({"id":"note"}))
            .await
            .unwrap();
        assert_eq!(result.get(), r#"{"text":"\ud800"}"#);
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn rpc_error_redacts_a_json_escaped_credential() {
        let home = scratch();
        let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        let key = format!("mem_{}", "c".repeat(64));
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (input, mut output) = stream.into_split();
            let mut input = BufReader::new(input);
            crate::read_line(&mut input).await.unwrap().unwrap();
            crate::write_value(
                &mut output,
                &json!({"type":"hello_ok","protocol":crate::PROTOCOL}),
            )
            .await
            .unwrap();
            crate::read_line(&mut input).await.unwrap().unwrap();
            let escaped = format!("mem_{}", "\\u0063".repeat(64));
            let response = RawValue::from_string(format!(
                r#"{{"id":1,"error":{{"code":"forbidden","message":"{escaped}"}}}}"#
            ))
            .unwrap();
            crate::write_value(&mut output, &response).await.unwrap();
        });
        let error = request(home.path(), &key, "daemon.status", json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(!error.contains(&key));
        assert!(!error.contains("\\u0063"));
        assert!(error.contains("forbidden"));
        assert!(error.contains("<REDACTED>"));
        daemon.await.unwrap();
    }

    #[tokio::test]
    async fn rejected_handshake_does_not_echo_a_credential() {
        let home = scratch();
        let listener = UnixListener::bind(home.path().join("run/pultd.sock")).unwrap();
        let key = format!("mem_{}", "b".repeat(64));
        let echoed = key.clone();
        let daemon = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (input, mut output) = stream.into_split();
            let mut input = BufReader::new(input);
            crate::read_line(&mut input).await.unwrap().unwrap();
            crate::write_value(&mut output, &json!({"type":"error","memory":echoed}))
                .await
                .unwrap();
        });
        let error = request(home.path(), &key, "memory.list", json!({}))
            .await
            .unwrap_err();
        assert!(!error.to_string().contains(&key));
        assert!(error.to_string().contains("handshake rejected"));
        daemon.await.unwrap();
    }
}
