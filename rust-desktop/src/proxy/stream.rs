use axum::{body::Body, response::Response};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::{
    metrics::{push_log, tally_usage},
    types::AppState,
};

fn normalize_sse_event(
    raw_event: &str,
    tool_indexes: &mut HashMap<String, usize>,
) -> Result<Option<String>, String> {
    let data: Vec<&str> = raw_event
        .lines()
        .filter(|line| line.starts_with("data:"))
        .map(|line| line.strip_prefix("data:").unwrap_or_default().trim_start())
        .collect();
    if data.is_empty() {
        return Ok(None);
    }
    let payload = data.join("\n").trim().to_string();
    if payload.is_empty() {
        return Ok(None);
    }
    if payload == "[DONE]" {
        return Ok(Some("data: [DONE]\n\n".into()));
    }

    let mut parsed: Value =
        serde_json::from_str(&payload).map_err(|err| format!("invalid JSON payload: {err}"))?;
    let object = parsed
        .as_object_mut()
        .ok_or_else(|| "SSE payload is not a JSON object".to_string())?;
    let has_usage_object = object.get("usage").is_some_and(|usage| usage.is_object());
    let Some(choices) = object.get_mut("choices") else {
        if has_usage_object {
            return Ok(Some(format!("data: {}\n\n", parsed)));
        }
        return Err("SSE object has neither choices nor usage".into());
    };
    let choices = choices
        .as_array_mut()
        .ok_or_else(|| "SSE choices is not an array".to_string())?;
    if choices.is_empty() && !has_usage_object {
        return Ok(None);
    }

    for (choice_position, choice) in choices.iter_mut().enumerate() {
        let choice = choice
            .as_object_mut()
            .ok_or_else(|| "SSE choice is not an object".to_string())?;
        let choice_index = choice
            .get("index")
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .unwrap_or(choice_position);
        choice.insert("index".into(), serde_json::json!(choice_index));

        let delta = choice
            .entry("delta")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if delta.is_null() {
            *delta = Value::Object(serde_json::Map::new());
        }
        let delta = delta
            .as_object_mut()
            .ok_or_else(|| "SSE choice delta is not an object".to_string())?;
        let Some(tool_calls) = delta.get_mut("tool_calls") else {
            continue;
        };
        let tool_calls = tool_calls
            .as_array_mut()
            .ok_or_else(|| "SSE delta tool_calls is not an array".to_string())?;
        for (call_position, call) in tool_calls.iter_mut().enumerate() {
            let call = call
                .as_object_mut()
                .ok_or_else(|| "SSE tool call is not an object".to_string())?;
            let call_key = format!(
                "{}:{}",
                choice_index,
                call.get("id").and_then(Value::as_str).unwrap_or_default()
            );
            let call_index = call
                .get("index")
                .and_then(Value::as_u64)
                .map(|index| index as usize)
                .unwrap_or_else(|| *tool_indexes.entry(call_key).or_insert(call_position));
            call.insert("index".into(), serde_json::json!(call_index));
            if !call.get("type").is_some_and(Value::is_string)
                && call.get("function").is_some_and(Value::is_object)
            {
                call.insert("type".into(), Value::String("function".into()));
            }
        }
    }
    if object.get("usage").is_some_and(Value::is_null) {
        object.remove("usage");
    }
    Ok(Some(format!("data: {}\n\n", parsed)))
}

fn take_sse_events(buffer: &mut String, flush: bool) -> Vec<String> {
    *buffer = buffer.replace("\r\n", "\n").replace('\r', "\n");
    let mut events: Vec<String> = buffer.split("\n\n").map(str::to_string).collect();
    if flush {
        buffer.clear();
    } else {
        *buffer = events.pop().unwrap_or_default();
    }
    events
}

pub(super) async fn stream_upstream_response(
    response: reqwest::Response,
    state: AppState,
    exposed: String,
    provider: String,
    upstream_model: String,
) -> Response {
    let status = response.status();
    let headers = response.headers().clone();
    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    let usage_state = state.usage.clone();
    let is_sse = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    let mut upstream_stream = response.bytes_stream();
    tokio::spawn(async move {
        let mut tail = String::new();
        let mut buffer = String::new();
        let mut tool_indexes = HashMap::new();
        while let Some(item) = upstream_stream.next().await {
            match item {
                Ok(chunk) => {
                    let text = String::from_utf8_lossy(&chunk);
                    tail.push_str(&text);
                    if tail.len() > 8192 {
                        let keep_from = tail.len() - 8192;
                        tail = tail[keep_from..].to_string();
                    }
                    if !is_sse {
                        if tx.send(Ok(chunk)).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    buffer.push_str(&text);
                    for event in take_sse_events(&mut buffer, false) {
                        match normalize_sse_event(&event, &mut tool_indexes) {
                            Ok(Some(normalized)) => {
                                if tx.send(Ok(bytes::Bytes::from(normalized))).await.is_err() {
                                    return;
                                }
                            }
                            Ok(None) => {}
                            Err(reason) => push_log(
                                &state,
                                format!(
                                    "{exposed} → пропущен SSE кадр {provider}/{upstream_model}: {reason}"
                                ),
                            ),
                        }
                    }
                }
                Err(err) => {
                    let _ = tx.send(Err(std::io::Error::other(err.to_string()))).await;
                    return;
                }
            }
        }
        if is_sse {
            for event in take_sse_events(&mut buffer, true) {
                match normalize_sse_event(&event, &mut tool_indexes) {
                    Ok(Some(normalized)) => {
                        if tx.send(Ok(bytes::Bytes::from(normalized))).await.is_err() {
                            return;
                        }
                    }
                    Ok(None) => {}
                    Err(reason) => push_log(
                        &state,
                        format!(
                            "{exposed} → пропущен SSE кадр {provider}/{upstream_model}: {reason}"
                        ),
                    ),
                }
            }
        }
        let mut usage = usage_state.lock().unwrap();
        let mut provider_stat = usage.providers.remove(&provider).unwrap_or_default();
        let mut model_stat = usage.models.remove(&exposed).unwrap_or_default();
        tally_usage(&tail, &mut usage, &mut provider_stat, &mut model_stat);
        usage.providers.insert(provider, provider_stat);
        usage.models.insert(exposed, model_stat);
    });
    let mut builder = Response::builder().status(status);
    for (key, value) in headers {
        if let Some(key) = key {
            if matches!(
                key.as_str(),
                "content-encoding" | "content-length" | "transfer-encoding" | "connection"
            ) {
                continue;
            }
            builder = builder.header(key, value);
        }
    }
    builder
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}
