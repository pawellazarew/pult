//! Usage presentation shares the bounded JS coercion used by agent CLI.
use crate::cli_agent::{display, number, numeric, push, round};
use crate::cli_client::{self, OwnerClient, ResponsePolicy, RpcError};
use serde_json::{json, value::RawValue};
use std::path::Path;

fn invalid() -> RpcError {
    RpcError::local("invalid_response", "invalid usage response")
}
fn field(raw: &RawValue, key: &str) -> Result<Option<Box<RawValue>>, RpcError> {
    pult_core::raw_field(raw, key).map_err(|_| invalid())
}
fn object_field(raw: Option<&RawValue>, key: &str) -> Result<Option<Box<RawValue>>, RpcError> {
    match raw.filter(|value| value.get().starts_with('{')) {
        Some(value) => field(value, key),
        None => Ok(None),
    }
}
fn fixed4(value: f64) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return ryu_js::Buffer::new().format(value).to_owned();
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
    let power = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    let numerator = u128::from(mantissa) * 10000;
    let rounded = if power >= 0 {
        numerator << (power as u32)
    } else if -power >= 128 {
        0
    } else {
        let shift = (-power) as u32;
        (numerator >> shift)
            + u128::from(numerator & ((1u128 << shift) - 1) >= (1u128 << (shift - 1)))
    };
    format!(
        "{}{}.{:04}",
        if value < 0.0 { "-" } else { "" },
        rounded / 10000,
        rounded % 10000
    )
}
fn pct(raw: Option<&RawValue>) -> String {
    numeric(raw)
        .map(|n| format!("{} %", ryu_js::Buffer::new().format(round(n * 100.0))))
        .unwrap_or_else(|| "—".into())
}
fn render(raw: &RawValue, ru: bool, json_output: bool) -> Result<String, RpcError> {
    if json_output {
        return Ok(format!("{}\n", raw.get()));
    }
    let rows = field(raw, "usage")?.ok_or_else(invalid)?;
    let rows: Vec<Box<RawValue>> = serde_json::from_str(rows.get()).map_err(|_| invalid())?;
    if rows.is_empty() {
        return Ok(if ru {
            "расхода пока нет\n"
        } else {
            "No usage yet\n"
        }
        .into());
    }
    let mut out = String::new();
    for row in rows {
        let session = display(field(&row, "session")?.as_deref())?;
        let session = format!(
            "{session}{}",
            " ".repeat(16usize.saturating_sub(session.encode_utf16().count()))
        );
        let turns = display(field(&row, "turns")?.as_deref())?;
        let turns = format!(
            "{}{turns}",
            " ".repeat(3usize.saturating_sub(turns.encode_utf16().count()))
        );
        let cost = fixed4(number(field(&row, "totalCostUsd")?.as_deref())?);
        let input = display(field(&row, "inputTokens")?.as_deref())?;
        let output = display(field(&row, "outputTokens")?.as_deref())?;
        let cache = display(field(&row, "cacheReadTokens")?.as_deref())?;
        push(
            &mut out,
            &if ru {
                format!(
                    "{session} ходов {turns} · ${cost} · вход {input} / выход {output} / кэш {cache}\n"
                )
            } else {
                format!(
                    "{session} turns {turns} · ${cost} · input {input} / output {output} / cache {cache}\n"
                )
            },
        )?;
        let limit = field(&row, "rateLimit")?;
        let windows = object_field(limit.as_deref(), "windows")?;
        let util = |key| -> Result<String, RpcError> {
            let window = object_field(windows.as_deref(), key)?;
            let utilization = object_field(window.as_deref(), "utilization")?;
            Ok(pct(utilization.as_deref()))
        };
        let five = util("five_hour")?;
        let seven = util("seven_day")?;
        push(
            &mut out,
            &if ru {
                format!("    окна лимита: 5 часов {five} · 7 дней {seven}\n")
            } else {
                format!("    rate-limit windows: 5 hours {five} · 7 days {seven}\n")
            },
        )?;
    }
    Ok(out)
}
async fn exchange(home: &Path, json_output: bool) -> Result<String, RpcError> {
    let mut client = OwnerClient::connect(home).await?;
    let raw = client
        .request("usage.get", json!({}), ResponsePolicy::Ordinary)
        .await?;
    render(&raw, client.locale == "ru", json_output)
}
pub(super) async fn run(home: &Path, json_output: bool) -> i32 {
    if [
        "PULT_MEMORY_KEY",
        "PULT_MEMORY_TURN_KEY",
        "PULT_ASK_KEY",
        "PULT_RUNTIME_KEY",
        "PULT_CODEX_MEMORY_KEY",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some())
    {
        let _ = cli_client::emit(
            "pult usage: forbidden — usage requires owner authentication\n".into(),
            true,
        )
        .await;
        return 1;
    }
    let Ok(mut interrupt) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
    else {
        return 1;
    };
    let result = tokio::select! {biased;_=interrupt.recv()=>return 130,result=exchange(home,json_output)=>result};
    let (text, stderr, code) = match result {
        Ok(text) => (text, false, 0),
        Err(error) => (
            format!("pult: {} — {}\n", error.code, error.message),
            true,
            if error.code == "timeout" { 2 } else { 1 },
        ),
    };
    tokio::select! {biased;_=interrupt.recv()=>130,result=cli_client::emit(text,stderr)=>if result.is_ok(){code}else{1}}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary64_rounding_and_negative_zero() {
        for (n, want) in [
            (1.00005, "1.0001"),
            (1.23445, "1.2345"),
            (0.00005, "0.0001"),
            (-0.0, "0.0000"),
            (-0.000001, "-0.0000"),
            (1e21, "1e+21"),
            (f64::MIN_POSITIVE, "0.0000"),
        ] {
            assert_eq!(fixed4(n), want);
        }
    }
}
