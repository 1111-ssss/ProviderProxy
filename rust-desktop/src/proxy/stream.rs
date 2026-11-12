use axum::{body::Body, response::Response};
use futures_util::StreamExt;
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use super::{
    metrics::{hour_stat, push_log, session_stat, tally_usage},
    types::AppState,
};

#[derive(Default)]
struct SseNormalizer {
    tool_indexes: HashMap<String, usize>,
    open_tool_index: HashMap<usize, usize>,
    /// The id every fragment of a tool call must repeat. Gateways that omit it
    /// leave the client to fall back to the response id (`chatcmpl-…`), so two
    /// calls in one answer collide on one id and the client rejects the stream
    /// with "Duplicate tool input start".
    tool_ids: HashMap<(usize, usize), String>,
    /// Which slot owns each id handed to the client. A gateway that repeats one
    /// id for two different calls (or reuses the response id) makes the client
    /// reject the whole answer with "Duplicate tool input start".
    assigned_ids: HashMap<String, (usize, usize)>,
    finish_reasons: HashMap<usize, String>,
    tool_choices: BTreeSet<usize>,
    choice_indexes: BTreeSet<usize>,
    last_meta: serde_json::Map<String, Value>,
    done_seen: bool,
}

impl SseNormalizer {
    fn next_tool_index(&self, choice_index: usize) -> usize {
        self.open_tool_index
            .get(&choice_index)
            .map_or(0, |index| index + 1)
    }

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
        let indexes = if !pending.is_empty() {
            pending
        } else if self.choice_indexes.is_empty() {
            vec![0]
        } else {
            Vec::new()
        };
        if indexes.is_empty() {
            return None;
        }
        let choices: Vec<Value> = indexes
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
        Some(format!("{}data: [DONE]\n\n", terminal.unwrap_or_default()))
    }

    fn is_incomplete(&self) -> bool {
        self.choice_indexes.is_empty()
            || self
                .choice_indexes
                .iter()
                .any(|index| !self.finish_reasons.contains_key(index))
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
            // Frames without choices are keep-alives or metadata pings some
            // gateways send mid-stream. They used to abort normalization with
            // an error, which could cut an otherwise healthy answer short.
            // Usage-only frames are forwarded because clients tally them;
            // everything else is dropped silently.
            if has_usage_object {
                return Ok(Some(format!("data: {}\n\n", parsed)));
            }
            return Ok(None);
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
            // A gateway may reuse one index for two calls in the same frame.
            // Only argument fragments are allowed to share a slot: they continue
            // the call that is already open.
            let mut frame_slots: std::collections::HashSet<usize> =
                std::collections::HashSet::new();
            for (call_position, call) in tool_calls.iter_mut().enumerate() {
                let call = call
                    .as_object_mut()
                    .ok_or_else(|| "SSE tool call is not an object".to_string())?;
                let call_id = call.get("id").and_then(Value::as_str).unwrap_or_default();
                let call_key = format!("{choice_index}:{call_id}");
                let declared = call.get("index").and_then(Value::as_u64).map(|i| i as usize);
                let starts_call = declared.is_some() || !call_id.is_empty();
                let mut call_index = match (declared, call_id.is_empty()) {
                    (Some(index), _) => index,
                    // A well-formed first fragment opens a call by id.
                    (None, false) => {
                        let next = self.next_tool_index(choice_index);
                        *self.tool_indexes.entry(call_key).or_insert(next)
                    }
                    // Argument fragments repeat neither id nor index. They belong
                    // to the call that is still open, not to slot 0: mapping them
                    // by array position merged the arguments of the second tool
                    // call into the first one, so the client saw duplicated calls.
                    (None, true) => self
                        .open_tool_index
                        .get(&choice_index)
                        .copied()
                        .unwrap_or(call_position),
                };
                if starts_call && !frame_slots.insert(call_index) {
                    call_index = self.next_tool_index(choice_index);
                    while !frame_slots.insert(call_index) {
                        call_index += 1;
                    }
                }
                self.open_tool_index.insert(choice_index, call_index);
                let slot = (choice_index, call_index);
                let response_id = self
                    .last_meta
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut id = if call_id.is_empty() {
                    self.tool_ids.get(&slot).cloned().unwrap_or_default()
                } else {
                    call_id.to_string()
                };
                // Reuse is fine only for the slot that already owns the id.
                let taken = !id.is_empty()
                    && (id == response_id
                        || self
                            .assigned_ids
                            .get(&id)
                            .is_some_and(|owner| *owner != slot));
                if id.is_empty() || taken {
                    let base = format!("call_{choice_index}_{call_index}");
                    id = base.clone();
                    let mut suffix = 1;
                    while self
                        .assigned_ids
                        .get(&id)
                        .is_some_and(|owner| *owner != slot)
                    {
                        id = format!("{base}_{suffix}");
                        suffix += 1;
                    }
                }
                self.assigned_ids.insert(id.clone(), slot);
                self.tool_ids.insert(slot, id.clone());
                call.insert("id".into(), Value::String(id));
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

/// Trims `tail` to at most `limit` bytes without cutting a UTF-8 character.
///
/// The naive `tail[keep_from..]` panics when the cut lands inside a multi-byte
/// character (any Russian, CJK or emoji content). That panic killed the
/// streaming task, so the client got a clean end of body mid-answer: no error,
/// no `[DONE]`, and the agent stopped half-way.
fn keep_tail(tail: &mut String, limit: usize) {
    if tail.len() <= limit {
        return;
    }
    let mut cut = tail.len() - limit;
    while cut < tail.len() && !tail.is_char_boundary(cut) {
        cut += 1;
    }
    tail.drain(..cut);
}

fn stream_error_event(message: &str) -> String {
    format!(
        "data: {}\n\ndata: [DONE]\n\n",
        serde_json::json!({
            "error": {
                "message": message,
                "type": "proxy_stream_error",
            }
        })
    )
}

fn completion_to_sse(bytes: &[u8], upstream_model: &str) -> Option<String> {
    let parsed: Value = serde_json::from_slice(bytes).ok()?;
    let object = parsed.as_object()?;
    let raw_choices = object.get("choices")?.as_array()?;
    let choices = if raw_choices.is_empty() {
        vec![serde_json::json!({ "index": 0, "message": {} })]
    } else {
        raw_choices.clone()
    };
    let response_id = object.get("id").and_then(Value::as_str).unwrap_or_default();
    let mut first_choices = Vec::with_capacity(choices.len());
    let mut terminal_choices = Vec::with_capacity(choices.len());
    for (position, choice) in choices.iter().enumerate() {
        let index = choice
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(position as u64);
        let message = choice
            .get("message")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut delta = serde_json::Map::new();
        for key in ["role", "content", "tool_calls", "function_call"] {
            if let Some(value) = message.get(key) {
                delta.insert(key.into(), value.clone());
            }
        }
        // Same rule as the streaming path: an id the client cannot tell apart
        // from another call (missing, repeated, or the response id) makes it
        // reject the answer with "Duplicate tool input start".
        if let Some(calls) = delta.get_mut("tool_calls").and_then(Value::as_array_mut) {
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (position, call) in calls.iter_mut().enumerate() {
                let Some(call) = call.as_object_mut() else { continue };
                let given = call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let clashes = given.is_empty()
                    || given == response_id
                    || !seen.insert(given.clone());
                if clashes {
                    let id = format!("call_{index}_{position}");
                    seen.insert(id.clone());
                    call.insert("id".into(), Value::String(id));
                }
                call.entry("index")
                    .or_insert_with(|| serde_json::json!(position));
            }
        }
        first_choices.push(serde_json::json!({
            "index": index,
            "delta": Value::Object(delta),
            "finish_reason": null,
        }));
        terminal_choices.push(serde_json::json!({
            "index": index,
            "delta": {},
            "finish_reason": choice.get("finish_reason").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| serde_json::json!("stop")),
        }));
    }
    let mut first = serde_json::Map::new();
    let mut terminal = serde_json::Map::new();
    for key in ["id", "created"] {
        if let Some(value) = object.get(key) {
            first.insert(key.into(), value.clone());
            terminal.insert(key.into(), value.clone());
        }
    }
    let model = object
        .get("model")
        .cloned()
        .unwrap_or_else(|| Value::String(upstream_model.into()));
    first.insert("model".into(), model.clone());
    terminal.insert("model".into(), model);
    first.insert(
        "object".into(),
        Value::String("chat.completion.chunk".into()),
    );
    terminal.insert(
        "object".into(),
        Value::String("chat.completion.chunk".into()),
    );
    first.insert("choices".into(), Value::Array(first_choices));
    terminal.insert("choices".into(), Value::Array(terminal_choices));
    if let Some(usage) = object.get("usage").filter(|value| value.is_object()) {
        terminal.insert("usage".into(), usage.clone());
    }
    Some(format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        Value::Object(first),
        Value::Object(terminal)
    ))
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

/// True when an SSE frame carries something the client can show: text,
/// reasoning, a tool call or a function call. Keep-alives, role-only deltas and
/// usage frames are not an answer.
fn has_payload(event: &str) -> bool {
    let Some(rest) = event.trim_start().strip_prefix("data:") else {
        return false;
    };
    let rest = rest.trim();
    if rest.is_empty() || rest == "[DONE]" {
        return false;
    }
    let Ok(value) = serde_json::from_str::<Value>(rest) else {
        return false;
    };
    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        return false;
    };
    choices.iter().any(|choice| {
        let Some(delta) = choice.get("delta") else {
            return false;
        };
        let text = |key: &str| {
            delta
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        };
        text("content")
            || text("reasoning_content")
            || text("reasoning")
            || delta
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty())
            || delta.get("function_call").is_some_and(Value::is_object)
    })
}

/// Same question for a non-streaming OpenAI body.
fn completion_has_content(bytes: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        return false;
    };
    choices.iter().any(|choice| {
        let Some(message) = choice.get("message") else {
            return false;
        };
        let text = |key: &str| {
            message
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        };
        text("content")
            || text("reasoning_content")
            || text("reasoning")
            || message
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty())
            || message.get("function_call").is_some_and(Value::is_object)
    })
}

/// How much of an answer may be held back while waiting for its first token.
const PENDING_LIMIT: usize = 64 * 1024;

pub(super) async fn stream_upstream_response(
    response: reqwest::Response,
    state: AppState,
    exposed: String,
    provider: String,
    upstream_model: String,
    stream_requested: bool,
    session: Option<String>,
) -> Result<Response, String> {
    let status = response.status();
    let mut headers = response.headers().clone();
    let (tx, rx) = mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(16);
    let usage_state = state.usage.clone();
    let lifetime_state = state.lifetime.clone();
    let is_sse = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"));
    if stream_requested && !is_sse {
        push_log(
            &state,
            format!(
                "{exposed} → {provider}/{upstream_model}: upstream вернул обычный JSON вместо SSE, адаптирую поток"
            ),
        );
    }
    let (signal_tx, signal_rx) = tokio::sync::oneshot::channel::<bool>();
    let mut upstream_stream = response.bytes_stream();
    tokio::spawn(async move {
        let mut tail = String::new();
        let mut buffer = String::new();
        let mut regular_body = Vec::new();
        let mut upstream_error = None;
        let mut normalizer = SseNormalizer::default();
        // A 200 that carries only keep-alives, a role delta or a usage frame is
        // not an answer: forwarding it left the client with an empty reply and
        // the dialogue dead, while the log said "ответ". Hold frames back until
        // one holds real text, reasoning or a tool call; if the stream ends
        // without one, tell the caller so it can fail over to the next upstream.
        let mut queue: Vec<bytes::Bytes> = Vec::new();
        let mut queued = 0usize;
        let mut has_answer = !status.is_success();
        let mut released = !status.is_success();
        let mut signal = Some(signal_tx);
        if released {
            if let Some(sender) = signal.take() {
                let _ = sender.send(true);
            }
        }
        macro_rules! emit {
            ($data:expr, $visible:expr) => {{
                let visible: bool = $visible;
                let data = bytes::Bytes::from($data);
                if visible {
                    has_answer = true;
                }
                if released {
                    if tx.send(Ok(data)).await.is_err() {
                        return;
                    }
                } else {
                    queued += data.len();
                    queue.push(data);
                    if has_answer {
                        released = true;
                        if let Some(sender) = signal.take() {
                            let _ = sender.send(true);
                        }
                        for item in queue.drain(..) {
                            if tx.send(Ok(item)).await.is_err() {
                                return;
                            }
                        }
                        queued = 0;
                    } else if queued > PENDING_LIMIT {
                        if let Some(sender) = signal.take() {
                            let _ = sender.send(false);
                        }
                        queue.clear();
                        return;
                    }
                }
            }};
        }
        // A panic anywhere below used to kill this task silently: the response
        // body just ended mid-answer, the client saw a clean end of stream and
        // the agent stopped without any error. Catch it and report a stream
        // error instead.
        let pump = async {
        while let Some(item) = upstream_stream.next().await {
            match item {
                Ok(chunk) => {
                    let text = String::from_utf8_lossy(&chunk);
                    tail.push_str(&text);
                    keep_tail(&mut tail, 8192);
                    if !is_sse {
                        if !status.is_success() {
                            if tx.send(Ok(chunk)).await.is_err() {
                                return;
                            }
                            continue;
                        }
                        // A non-streaming body is decided at the end: it is
                        // small, so buffering it costs nothing and lets an
                        // empty 200 be caught instead of passed through.
                        regular_body.extend_from_slice(&chunk);
                        continue;
                    }
                    buffer.push_str(&text);
                    for event in take_sse_events(&mut buffer, false) {
                        match normalizer.normalize_event(&event) {
                            Ok(Some(normalized)) => {
                                let visible = has_payload(&normalized);
                                emit!(normalized, visible);
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
                    upstream_error = Some(err.to_string());
                    break;
                }
            }
        }
        if upstream_error.is_none() && !is_sse && status.is_success() {
            if completion_has_content(&regular_body) {
                if stream_requested {
                    if let Some(normalized) = completion_to_sse(&regular_body, &upstream_model) {
                        emit!(normalized, true);
                    }
                } else {
                    emit!(regular_body, true);
                }
            }
        }
        if upstream_error.is_none() && is_sse {
            for event in take_sse_events(&mut buffer, true) {
                match normalizer.normalize_event(&event) {
                    Ok(Some(normalized)) => {
                        let visible = has_payload(&normalized);
                        emit!(normalized, visible);
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
        if let Some(reason) = upstream_error {
            let message = format!("upstream stream ended unexpectedly: {reason}");
            push_log(
                &state,
                format!("{exposed} → ошибка потока {provider}/{upstream_model}: {message}"),
            );
            if released && stream_requested {
                let _ = tx
                    .send(Ok(bytes::Bytes::from(stream_error_event(&message))))
                    .await;
            } else if released {
                let _ = tx.send(Err(std::io::Error::other(message))).await;
            }
        } else if is_sse && !normalizer.done_seen {
            if normalizer.is_incomplete() {
                let message = "upstream SSE stream ended before [DONE]";
                push_log(
                    &state,
                    format!("{exposed} → ошибка потока {provider}/{upstream_model}: {message}"),
                );
                if released && stream_requested {
                    let _ = tx
                        .send(Ok(bytes::Bytes::from(stream_error_event(message))))
                        .await;
                }
            } else if let Some(final_event) = normalizer.finish_at_end() {
                emit!(final_event, false);
            }
        } else if is_sse {
            if let Some(final_event) = normalizer.finish_at_end() {
                emit!(final_event, false);
            }
        }
        if !has_answer {
            push_log(
                &state,
                format!("{exposed} → свитч: {provider}/{upstream_model} ответил пусто"),
            );
            if let Some(sender) = signal.take() {
                let _ = sender.send(false);
            }
        }
        };
        if futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(pump))
            .await
            .is_err()
        {
            let message = "proxy stream task panicked; the answer was cut off";
            push_log(
                &state,
                format!("{exposed} → ошибка потока {provider}/{upstream_model}: {message}"),
            );
            // The task that owned `tx` is gone, so report through the sender we
            // kept. Without this the client simply sees the body end.
            if released && stream_requested {
                let _ = tx
                    .send(Ok(bytes::Bytes::from(stream_error_event(message))))
                    .await;
            } else if released {
                let _ = tx.send(Err(std::io::Error::other(message))).await;
            }
        }
        let mut usage = usage_state.lock().unwrap();
        let mut provider_stat = usage.providers.remove(&provider).unwrap_or_default();
        let (tokens_in, tokens_out) = tally_usage(&tail, &mut usage, &mut provider_stat);
        {
            let hour = hour_stat(&mut usage);
            hour.tokens_in += tokens_in;
            hour.tokens_out += tokens_out;
        }
        usage.providers.insert(provider.clone(), provider_stat);
        // Borrow the row in place: removing it first lost any increment a
        // concurrent request made while this stream was being tallied.
        let row = usage
            .models
            .entry(format!("{provider}/{upstream_model}"))
            .or_default();
        row.tokens_in += tokens_in;
        row.tokens_out += tokens_out;
        if let Some(row) = session_stat(&mut usage, session.as_deref()) {
            row.tokens_in += tokens_in;
            row.tokens_out += tokens_out;
        }
        drop(usage);
        let mut lifetime = lifetime_state.lock().unwrap();
        lifetime.tokens_in += tokens_in;
        lifetime.tokens_out += tokens_out;
        lifetime.requests += 1;
    });
    if stream_requested && !is_sse {
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
    }
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
    let response = builder
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap_or_else(|_| Response::new(Body::empty()));
    match signal_rx.await {
        Ok(true) => Ok(response),
        _ => Err("upstream returned an empty answer".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keep-alive frames (id/object metadata, pings, comments) must not abort
    /// the stream: a gateway that sends them mid-answer used to make the proxy
    /// log "neither choices nor usage" and drop the whole stream with an error.
    #[test]
    fn keeps_the_stream_alive_when_a_frame_has_no_choices() {
        let mut normalizer = SseNormalizer::default();
        // Metadata ping without choices or usage: skipped, stream continues.
        assert!(normalizer
            .normalize_event("data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\"}\n\n")
            .unwrap()
            .is_none());
        // The answer still flows after the ping.
        let out = normalizer
            .normalize_event("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ок\"}}]}\n\n")
            .unwrap()
            .unwrap();
        assert!(out.contains("ок"));
        // Usage-only frames keep reaching the client.
        let usage = normalizer
            .normalize_event("data: {\"usage\":{\"prompt_tokens\":1}}\n\n")
            .unwrap()
            .unwrap();
        assert!(usage.contains("prompt_tokens"));
    }

    #[test]
    fn emits_finish_reason_when_done_has_no_choices() {
        let mut normalizer = SseNormalizer::default();
        assert!(normalizer
            .normalize_event("data: {\"choices\":[]}\n\n")
            .unwrap()
            .is_none());
        let output = normalizer
            .normalize_event("data: [DONE]\n\n")
            .unwrap()
            .unwrap();
        assert!(output.contains("\"finish_reason\":\"stop\""));
        assert!(output.ends_with("data: [DONE]\n\n"));
    }

    #[test]
    fn detects_an_sse_stream_that_ends_before_done() {
        let mut normalizer = SseNormalizer::default();
        normalizer
            .normalize_event("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
            .unwrap();
        assert!(normalizer.is_incomplete());
        assert!(!normalizer.done_seen);
    }

    #[test]
    fn keeps_argument_fragments_on_the_open_tool_call() {
        let mut normalizer = SseNormalizer::default();
        let open_first = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"call_a\",\"function\":{\"name\":\"read\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(open_first.contains("\"index\":0"), "{open_first}");
        // No id, no index: this is the argument stream of call_a.
        let args = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(args.contains("\"index\":0"), "{args}");
        // A second call must open the next slot, not reuse slot 0.
        let open_second = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"id\":\"call_b\",\"function\":{\"name\":\"write\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(open_second.contains("\"index\":1"), "{open_second}");
        let second_args = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"function\":{\"arguments\":\"{}\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(second_args.contains("\"index\":1"), "{second_args}");
    }

    /// Fragments without an id used to reach the client bare, so it fell back to
    /// the response id for every call and rejected the stream with
    /// "Duplicate tool input start". Each slot now gets its own stable id.
    #[test]
    fn gives_every_tool_call_its_own_id_when_upstream_omits_it() {
        let mut normalizer = SseNormalizer::default();
        let first = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(first.contains("\"id\":\"call_0_0\""), "{first}");
        // Argument fragments of the same call repeat that id.
        let args = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\" {}\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(args.contains("\"id\":\"call_0_0\""), "{args}");
        // A second call must not inherit the first one's id.
        let second = normalizer
            .normalize_event(
                "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"write\",\"arguments\":\"{}\"}}]}}]}\n\n",
            )
            .unwrap()
            .unwrap();
        assert!(second.contains("\"id\":\"call_0_1\""), "{second}");
    }

    #[test]
    fn trims_the_usage_tail_without_splitting_a_character() {
        let mut tail = String::new();
        for _ in 0..4000 {
            tail.push('€'); // three bytes each: the cut can land mid-character
        }
        keep_tail(&mut tail, 8192);
        assert!(tail.len() <= 8192);
        assert!(tail.chars().all(|c| c == '€'), "tail must stay valid UTF-8");
    }

    /// Two tool calls in one answer must reach the client under distinct ids.
    /// A gateway that repeats one id (or reuses the response id) made the client
    /// abort the whole session with "Duplicate tool input start".
    #[test]
    fn repeated_tool_call_ids_are_made_unique() {
        let mut normalizer = SseNormalizer::default();
        let first = normalizer
            .normalize_event(
                r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"chatcmpl-1","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}"#,
            )
            .unwrap()
            .unwrap();
        assert!(first.contains(r#""id":"call_0_0""#), "{first}");

        let second = normalizer
            .normalize_event(
                r#"data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"id":"chatcmpl-1","type":"function","function":{"name":"write","arguments":"{}"}},{"id":"same","type":"function","function":{"name":"a","arguments":"{}"}},{"id":"same","type":"function","function":{"name":"b","arguments":"{}"}}]}}]}"#,
            )
            .unwrap()
            .unwrap();
        let ids: Vec<&str> = second
            .match_indices(r#""id":""#)
            .map(|(at, _)| {
                let rest = &second[at + 6..];
                &rest[..rest.find('"').unwrap()]
            })
            .collect();
        let call_ids: Vec<&str> = ids
            .iter()
            .copied()
            .filter(|id| *id != "chatcmpl-1")
            .collect();
        assert_eq!(call_ids.len(), 3, "three calls in the second frame: {second}");
        let unique: std::collections::HashSet<&&str> = call_ids.iter().collect();
        assert_eq!(unique.len(), 3, "ids must differ: {second}");
        assert!(!call_ids.contains(&"chatcmpl-1"), "response id is not a call id");
    }

    #[test]
    fn only_content_or_tool_calls_count_as_an_answer() {
        for event in [
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1}}\n\n",
        ] {
            assert!(!has_payload(event), "not answer payload: {event}");
        }
        for event in [
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0}]}}]}\n\n",
        ] {
            assert!(has_payload(event), "answer payload: {event}");
        }
        assert!(!completion_has_content(br#"{"choices":[{"message":{"content":""}}]}"#));
        assert!(completion_has_content(br#"{"choices":[{"message":{"content":"hi"}}]}"#));
    }
}
