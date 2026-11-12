//! Scoped permission stdio helper. Never reads owner-token/config files and never
//! starts a daemon or provider. Every question uses its own cancellable socket.
use crate::{
    mcp_stdio::{self, ToolError, Tools},
    turn_driver::Task,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{io::BufReader, net::UnixStream};
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const DECISION_TIMEOUT: Duration = Duration::from_secs(900);
fn deny() -> Value {
    json!({"behavior":"deny","message":"pult: permission service unavailable"})
}
struct Client {
    home: PathBuf,
    session: Option<String>,
    key: Option<String>,
}
impl Client {
    fn valid(&self) -> bool {
        self.home.is_absolute()
            && self.home.join("run/pultd.sock").as_os_str().len() < 104
            && self
                .session
                .as_deref()
                .is_some_and(crate::session_model::is_name)
            && self.key.as_deref().is_some_and(|k| {
                let raw = k.strip_prefix("pa_").unwrap_or(k);
                raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit())
            })
    }
    async fn ask(&self, args: Value) -> Option<Value> {
        if !self.valid() {
            return None;
        }
        let tool = args["tool_name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))?;
        let input = args.get("input").filter(|v| v.is_object())?;
        let use_id = match args.get("tool_use_id") {
            None | Some(Value::Null) => None,
            Some(Value::String(id))
                if !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control) =>
            {
                Some(id)
            }
            Some(_) => return None,
        };
        let socket = tokio::time::timeout(
            CONNECT_TIMEOUT,
            UnixStream::connect(self.home.join("run/pultd.sock")),
        )
        .await
        .ok()?
        .ok()?;
        let (input_socket, mut output) = socket.into_split();
        let mut reader = BufReader::new(input_socket);
        crate::write_value(&mut output,&json!({"type":"hello","ask":self.key.as_deref()?,"client":"mcp-ask","protocol":crate::PROTOCOL})).await.ok()?;
        let raw = tokio::time::timeout(CONNECT_TIMEOUT, crate::read_line(&mut reader))
            .await
            .ok()?
            .ok()??;
        let hello: Value = serde_json::from_slice(&raw).ok()?;
        if hello["type"] != "hello_ok" || hello["protocol"].as_u64() != Some(crate::PROTOCOL) {
            return None;
        }
        let mut params =
            json!({"sessionId":self.session.as_deref()?,"toolName":tool,"input":input});
        if let Some(id) = use_id {
            params["toolUseId"] = json!(id);
        }
        crate::write_value(
            &mut output,
            &json!({"id":1,"method":"perm.request","params":params}),
        )
        .await
        .ok()?;
        // Bound noise too: neither unrelated frames nor EOF mean permission.
        for _ in 0..32 {
            let raw = crate::read_line(&mut reader).await.ok()??;
            let reply: Value = serde_json::from_slice(&raw).ok()?;
            if reply["id"] != 1 {
                continue;
            }
            if reply.get("error").is_some() {
                return None;
            }
            let result = reply.get("result")?;
            let behavior = result["behavior"]
                .as_str()
                .filter(|s| matches!(*s, "allow" | "deny"))?;
            // Never drop a malformed restriction and then approve the original
            // potentially broader input. Presence must be a valid object.
            if result.get("updatedInput").is_some_and(|v| !v.is_object()) {
                return None;
            }
            let mut decision = json!({"behavior":behavior});
            // A daemon message is private provider data, never a diagnostic.
            if let Some(message) = result["message"].as_str() {
                decision["message"] = json!(message);
            }
            if behavior == "allow"
                && let Some(updated) = result.get("updatedInput").filter(|v| v.is_object())
            {
                decision["updatedInput"] = updated.clone();
            }
            return Some(decision);
        }
        None
    }
}
impl Tools for Client {
    fn list(&self) -> Value {
        json!([{"name":"ask","description":"Pult permission prompt. Returns an allow or deny decision.","inputSchema":{"type":"object","properties":{"tool_name":{"type":"string"},"input":{"type":"object"},"tool_use_id":{"type":"string"}},"required":["tool_name","input"],"additionalProperties":true}}])
    }
    fn call(&self, name: String, args: Value) -> Task<Result<Value, ToolError>> {
        let client = Self {
            home: self.home.clone(),
            session: self.session.clone(),
            key: self.key.clone(),
        };
        Box::pin(async move {
            if name != "ask" {
                return Err(ToolError::Invalid);
            }
            let decision = tokio::time::timeout(DECISION_TIMEOUT, client.ask(args))
                .await
                .ok()
                .flatten()
                .unwrap_or_else(deny);
            Ok(decision)
        })
    }
}
/// Invalid/missing credentials keep the helper fail-closed and usable: ask
/// returns deny. It never substitutes an owner credential or requests login.
pub async fn run(
    home: PathBuf,
    session: Option<String>,
    key: Option<String>,
) -> anyhow::Result<()> {
    let client = Arc::new(Client { home, session, key });
    mcp_stdio::serve(
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
        client,
        "pult",
    )
    .await
    .map_err(|_| anyhow::anyhow!("permission MCP is unavailable"))
}
