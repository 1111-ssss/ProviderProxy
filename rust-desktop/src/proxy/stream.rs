use axum::{body::Body, response::Response};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::{
    metrics::{push_log, tally_usage},
    types::AppState,
};

struct SseNormalizer {
    tool_indexes: HashMap<String, usize>,
    finish_reasons: HashMap<usize, String>,
    tool_choices: BTreeSet<usize>,
    choice_indexes: BTreeSet<usize>,
    last_meta: serde_json::Map<String, Value>,
    done_seen: bool,
}

impl SseNormalizer {
    // A few OpenAI-compatible gateways terminate with [DONE] but omit the
    // final choice object. Emit the missing terminal chunk so strict clients
    // do not try to read finish_reason from an absent choice.
    fn terminal_event(&mut self) -> Option<String> {
        let pending: Vec<usize> = self
            .choice_indexes
            .iter()
            .copied()
            .filter(|index| !self.finish_reasons.contains_key(index))
            .collect();
        if pending.is_empty() {
            return None;
        }
        let choices: Vec<Value> = pending
            .into_iter()
            .map(|index| {
                let reason = if self.tool_choices.contains(&index) {
                    "tool_calls"
                } else {
                    "stop"
                };
                self.finish_reasons.insert(index, reason.into());
                serde_json::json!({
                    "index": index,
                    "delta": {},
                    "finish_reason": reason,
                })
            })
            .collect();
        let mut terminal = serde_json::Map::new();
        for key in ["id", "object", "created", "model"] {
            if let Some(value) = self.last_meta.get(key) {
                terminal.insert(key.into(), value.clone());
            }
        }
        terminal
            .entry("object")
            .or_insert_with(|| Value::String("chat.completion.chunk".into()));
        terminal.insert("choices".into(), Value::Array(choices));
        Some(format!("data: {}\n\n", Value::Object(terminal)))
    }

    fn finish_at_end(&mut self) -> Option<String> {
        if self.done_seen {
            return None;
        }
        let terminal = self.terminal_event();
        if self.choice_indexes.is_empty() {
            return terminal;
        }
        Some(format!("{}data: [DONE]\n\n", terminal.unwrap_or_default()))
    }

    fn normalize_event(&mut self, raw_event: &str) -> Result<Option<String>, String> {
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
            self.done_seen = true;
            return Ok(Some(format!(
                "{}data: [DONE]\n\n",
                self.terminal_event().unwrap_or_default()
            )));
        }

        let mut parsed: Value =
            serde_json::from_str(&payload).map_err(|err| format!("invalid JSON payload: {err}"))?;
        let object = parsed
            .as_object_mut()
            .ok_or_else(|| "SSE payload is not a JSON object".to_string())?;
        for key in ["id", "object", "created", "model"] {
            if let Some(value) = object.get(key) {
                self.last_meta.insert(key.into(), value.clone());
            }
        }
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
            self.choice_indexes.insert(choice_index);
            match choice.get("finish_reason") {
                Some(reason) if !reason.is_null() => {
                    if let Some(reason) = reason.as_str() {
                        self.finish_reasons.insert(choice_index, reason.into());
                    }
                }
                _ => {
                    choice.insert("finish_reason".into(), Value::Null);
                }
            }

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
            self.tool_choices.insert(choice_index);
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
                    .unwrap_or_else(|| *self.tool_indexes.entry(call_key).or_insert(call_position));
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
        let mut normalizer = SseNormalizer {
            tool_indexes: HashMap::new(),
            finish_reasons: HashMap::new(),
            tool_choices: BTreeSet::new(),
            choice_indexes: BTreeSet::new(),
            last_meta: serde_json::Map::new(),
            done_seen: false,
        };
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
                        match normalizer.normalize_event(&event) {
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
                match normalizer.normalize_event(&event) {
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
        if let Some(final_event) = normalizer.finish_at_end() {
            let _ = tx.send(Ok(bytes::Bytes::from(final_event))).await;
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
