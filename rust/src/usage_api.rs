//! Owner-only epoch usage read. Admission survives disconnected RPC callers.
use crate::{State, session_usage};
use serde_json::value::RawValue;
use std::sync::Arc;
pub(crate) struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
}
fn unavailable() -> ApiError {
    ApiError {
        code: "unavailable",
        message: "usage is unavailable until daemon restart",
    }
}
pub(crate) fn parse(bytes: &[u8]) -> Option<(serde_json::Value, Result<(), ApiError>)> {
    let root: Box<RawValue> = serde_json::from_slice(bytes).ok()?;
    let fields = crate::history::Fields::parse(&root).ok()?;
    let method: String = serde_json::from_str(fields.get("method")?.get()).ok()?;
    if method != "usage.get" {
        return None;
    }
    let id = fields
        .get("id")
        .and_then(|v| serde_json::from_str::<serde_json::Value>(v.get()).ok())
        .unwrap_or(serde_json::Value::Null);
    let valid = (id.is_string() || id.is_number())
        && fields
            .get("params")
            .is_none_or(|v| v.get().starts_with('{'));
    Some((
        id,
        if valid {
            Ok(())
        } else {
            Err(ApiError {
                code: "invalid_params",
                message: "request needs id, method and object params",
            })
        },
    ))
}
pub(crate) async fn execute(state: Arc<State>) -> Result<Box<RawValue>, ApiError> {
    if *state.stop.borrow() {
        return Err(ApiError {
            code: "closed",
            message: "daemon is stopping",
        });
    }
    let permit = state
        .usage_reads
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError {
            code: "capacity",
            message: "too many usage reads",
        })?;
    let job = state.host_jobs.track();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let _job = job;
        if *state.stop.borrow() {
            return Err(ApiError {
                code: "closed",
                message: "daemon is stopping",
            });
        }
        let _store = state.store.lock().map_err(|_| unavailable())?;
        let registry = state.registry.lock().map_err(|_| unavailable())?;
        let cache = state.usage.lock().map_err(|_| unavailable())?;
        cache
            .render(registry.records(), crate::MAX_LINE - 256)
            .map_err(|error| match error {
                session_usage::Error::Unavailable => unavailable(),
                session_usage::Error::Capacity => ApiError {
                    code: "capacity",
                    message: "usage response exceeds frame budget",
                },
            })
    })
    .await
    .map_err(|_| unavailable())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{sync::atomic::Ordering, time::Duration};
    fn register(state: &State, name: &str, provider: &str) {
        let mut record = crate::registry::Record::default();
        for (key, value) in [
            ("name", name),
            ("provider", provider),
            ("cwd", state.home.to_str().unwrap()),
            ("createdAt", "2026-11-16T00:00:00Z"),
            ("approval", "ask"),
        ] {
            record.set_string(key, value);
        }
        state.registry.lock().unwrap().insert(record).unwrap();
    }
    async fn result(state: Arc<State>) -> Value {
        let raw = execute(state)
            .await
            .unwrap_or_else(|e| panic!("{}: {}", e.code, e.message));
        serde_json::from_str(raw.get()).unwrap()
    }
    #[tokio::test]
    async fn sink_only_commit_projection_and_optional_failure() {
        let (_home, state, sink) = crate::runtime_journal::tests::fixture();
        register(&state, "chat", "codex");
        let draft = json!({"sessionId":"chat","provider":"claude","kind":"usage.updated","data":{"source":"result","totalCostUsd":1.25,"usage":{"input_tokens":2}}});
        state.store.lock().unwrap().append(draft.clone()).unwrap();
        crate::journal_request(
            state.clone(),
            "events.emit".into(),
            json!({"sessionId":"chat","kind":"usage.updated","data":{"source":"result"}}),
        )
        .await
        .unwrap();
        assert_eq!(result(state.clone()).await["usage"][0]["turns"], 0);
        sink.append(draft).await.unwrap();
        let usage = result(state.clone()).await;
        assert_eq!(usage["usage"][0]["provider"], "codex");
        assert_eq!(usage["usage"][0]["turns"], 1);
        assert_eq!(usage["usage"][0]["inputTokens"], 2);
        let cursor = state.last_event_id.load(Ordering::Acquire);
        sink.append(json!({"sessionId":"chat","provider":"claude","kind":"usage.updated","data":{"source":"result","usage":{"input_tokens":"bad"}}})).await.unwrap();
        assert_eq!(state.last_event_id.load(Ordering::Acquire), cursor + 1);
        assert_eq!(
            execute(state.clone()).await.err().unwrap().code,
            "unavailable"
        );
        assert!(!state.execution_storage_failed.load(Ordering::Acquire));
        assert!(!state.driver.get().unwrap().storage_failed());
        sink.append(json!({"sessionId":"chat","provider":"claude","kind":"message.done","data":{"text":"still commits"}})).await.unwrap();
        assert_eq!(state.last_event_id.load(Ordering::Acquire), cursor + 2);
        assert!(state.native_runtime.get().is_none());
        assert!(state.claude_runtime.get().is_none());
        assert!(state.zcode_runtime.get().is_none());
    }
    #[tokio::test]
    async fn capacity_is_only_usage_unavailable_after_known_commit() {
        let (_home, state, sink) = crate::runtime_journal::tests::fixture();
        *state.usage.lock().unwrap() = session_usage::Cache::new(session_usage::Limits {
            entries: 0,
            retained_bytes: 0,
        });
        sink.append(
            json!({"sessionId":"ghost","provider":"codex","kind":"usage.updated","data":{}}),
        )
        .await
        .unwrap();
        assert_eq!(state.last_event_id.load(Ordering::Acquire), 1);
        assert_eq!(
            execute(state.clone()).await.err().unwrap().code,
            "unavailable"
        );
        assert!(!state.execution_storage_failed.load(Ordering::Acquire));
        // A restarted cache ignores the durable usage event.
        *state.usage.lock().unwrap() = session_usage::Cache::default();
        register(&state, "ghost", "codex");
        assert_eq!(result(state).await["usage"][0]["turns"], 0);
    }
    #[tokio::test]
    async fn actual_backend_json_normalizes_negative_zero_overflow_and_opaque_rate_limit() {
        let (_home, state, sink) = crate::runtime_journal::tests::fixture();
        register(&state, "chat", "zcode");
        sink.append(json!({"sessionId":"chat","provider":"zcode","kind":"usage.updated","data":{"source":"result","totalCostUsd":-0.0,"usage":{"input_tokens":-0.0,"output_tokens":-0.0,"cache_read_input_tokens":-0.0}}})).await.unwrap();
        let zero = execute(state.clone())
            .await
            .unwrap_or_else(|_| panic!("usage read"));
        assert!(!zero.get().contains("-0"));
        let zero: Value = serde_json::from_str(zero.get()).unwrap();
        assert_eq!(zero["usage"][0]["totalCostUsd"], 0);
        for _ in 0..2 {
            sink.append(json!({"sessionId":"chat","provider":"zcode","kind":"usage.updated","data":{"source":"result","usage":{"input_tokens":1e308,"output_tokens":1e308,"cache_read_input_tokens":1e308}}})).await.unwrap();
        }
        let windows = json!({"future":{"count":9007199254740993u64,"label":"🚀","array":[true,null,"opaque"]},"five_hour":{"utilization":-0.005,"extension":{"ok":true}},"seven_day":null});
        sink.append(json!({"sessionId":"chat","provider":"zcode","kind":"usage.updated","data":{"source":"rate_limit_event","windows":windows,"resetsAt":null,"ignored":"removed"}})).await.unwrap();
        let raw = execute(state.clone())
            .await
            .unwrap_or_else(|_| panic!("usage read"));
        let actual: Value = serde_json::from_str(raw.get()).unwrap();
        let row = &actual["usage"][0];
        assert_eq!(row["totalCostUsd"], 0);
        for key in ["inputTokens", "outputTokens", "cacheReadTokens"] {
            assert!(row[key].is_null());
        }
        assert_eq!(row["turns"], 3);
        assert_eq!(
            row["rateLimit"]["windows"]["future"]["count"],
            9007199254740992u64
        );
        assert_eq!(row["rateLimit"]["windows"]["future"]["label"], "🚀");
        assert_eq!(
            row["rateLimit"]["windows"]["five_hour"]["extension"]["ok"],
            true
        );
        assert!(row["rateLimit"].get("status").is_none());
        assert!(row["rateLimit"].get("ignored").is_none());
        assert!(row["rateLimit"]["resetsAt"].is_null());
        assert!(!state.execution_storage_failed.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn degraded_session_file_still_counts_but_failed_append_does_not_apply_preparation() {
        let (_home, state, sink) = crate::runtime_journal::tests::fixture();
        register(&state, "chat", "claude");
        std::os::unix::fs::symlink(
            state.home.join("absent"),
            state.home.join("events/chat.jsonl"),
        )
        .unwrap();
        sink.append(json!({"sessionId":"chat","provider":"claude","kind":"usage.updated","data":{"source":"result","totalCostUsd":2}})).await.unwrap();
        assert!(state.store.lock().unwrap().projection_error().is_some());
        assert_eq!(result(state.clone()).await["usage"][0]["turns"], 1);
        *state.usage.lock().unwrap() = session_usage::Cache::new(session_usage::Limits {
            entries: 0,
            retained_bytes: 0,
        });
        // Preparation would be unavailable, but this invalid authoritative draft
        // fails before committing; optional state is still the prior empty epoch.
        assert!(
            sink.append(json!({"sessionId":"chat","provider":3,"kind":"usage.updated","data":{}}))
                .await
                .is_err()
        );
        assert_eq!(result(state.clone()).await["usage"][0]["turns"], 0);
        assert_eq!(state.store.lock().unwrap().last_id(), 1);
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn four_blocked_cancelled_reads_retain_admission_and_host_jobs() {
        let (_home, state, _sink) = crate::runtime_journal::tests::fixture();
        let (entered, entered_rx) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let held = state.clone();
        let holder = std::thread::spawn(move || {
            let _guard = held.store.lock().unwrap();
            entered.send(()).unwrap();
            released.recv().unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let state = state.clone();
            tasks.push(tokio::spawn(async move { execute(state).await }));
        }
        tokio::time::timeout(Duration::from_secs(3), async {
            while state.host_jobs.active() != 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(execute(state.clone()).await.err().unwrap().code, "capacity");
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        assert_eq!(state.usage_reads.available_permits(), 0);
        assert_eq!(state.host_jobs.active(), 4);
        release.send(()).unwrap();
        holder.join().unwrap();
        tokio::time::timeout(Duration::from_secs(3), state.host_jobs.wait())
            .await
            .unwrap();
        assert_eq!(state.usage_reads.available_permits(), 4);
    }
}

#[cfg(test)]
mod parser_tests {
    #[test]
    fn unknown_object_params_are_ignored_losslessly() {
        assert!(super::parse(br#"{"id":1,"method":"usage.get","params":{"unknown":"\ud800","deep":[1,true,null]}}"#).unwrap().1.is_ok());
        for params in ["null", "[]", "false", "1", "\"x\""] {
            let frame = format!("{{\"id\":1,\"method\":\"usage.get\",\"params\":{params}}}");
            assert_eq!(
                super::parse(frame.as_bytes())
                    .unwrap()
                    .1
                    .err()
                    .unwrap()
                    .code,
                "invalid_params"
            );
        }
    }
}
