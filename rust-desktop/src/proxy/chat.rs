use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use futures_util::StreamExt;
use std::collections::HashMap;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_stream::wrappers::ReceiverStream;

use super::{
    auth::authorized,
    handlers::json_error,
    metrics::{
        hour_stat, model_stat, provider_stat, push_chat_log, session_idle_gap,
        session_request_end, session_request_start, session_stat,
    },
    routing::{failover_status, with_model},
    stream::stream_upstream_response,
    types::{AppState, Upstream, Usage},
};

async fn send_with_header_timeout(
    request: reqwest::RequestBuilder,
    header_timeout_sec: u64,
) -> Result<reqwest::Response, String> {
    let request = request.send();
    if header_timeout_sec == 0 {
        return request.await.map_err(|err| err.to_string());
    }
    timeout(Duration::from_secs(header_timeout_sec), request)
        .await
        .map_err(|_| "header timeout".to_string())?
        .map_err(|err| err.to_string())
}

/// Counts one failed attempt: cooldown for that exact model, error counters and
/// the log line. Every failure path uses it, so a 400, a dead key and an empty
/// answer are counted the same way.
fn record_failure(state: &AppState, upstream: &Upstream, key: &str, session: &Option<String>) {
    // A zero (only possible in a hand-edited config) would expire instantly and
    // turn retry mode into a hot loop against the same dead upstream.
    let cooldown = Duration::from_secs(
        state
            .config
            .read()
            .unwrap()
            .get("errorCooldownSec")
            .and_then(Value::as_u64)
            .unwrap_or(30)
            .max(1),
    );
    state
        .cooldowns
        .lock()
        .unwrap()
        .insert(key.to_string(), Instant::now() + cooldown);
    let mut usage = state.usage.lock().unwrap();
    provider_stat(&mut usage, &upstream.name).errors += 1;
    usage.failovers += 1;
    let stat = model_stat(&mut usage, &upstream.name, &upstream.model);
    stat.failovers += 1;
    stat.errors += 1;
    if let Some(row) = session_stat(&mut usage, session.as_deref()) {
        row.errors += 1;
    }
}

fn cooldown_key(upstream: &Upstream) -> String {
    // A cooldown belongs to the provider/model, not a chain alias. This keeps
    // another alias from immediately retrying the same failed model.
    format!("{}|{}", upstream.name, upstream.model)
}

/// Undo the provisional "ok" counted when the upstream answered with headers:
/// the body turned out empty, so the attempt is a failure after all.
fn revert_provisional_ok(state: &AppState, upstream: &Upstream, session: &Option<String>) {
    let mut usage = state.usage.lock().unwrap();
    usage.ok = usage.ok.saturating_sub(1);
    let hour = hour_stat(&mut usage);
    hour.ok = hour.ok.saturating_sub(1);
    let provider = provider_stat(&mut usage, &upstream.name);
    provider.ok = provider.ok.saturating_sub(1);
    let model = model_stat(&mut usage, &upstream.name, &upstream.model);
    model.ok = model.ok.saturating_sub(1);
    if let Some(row) = session_stat(&mut usage, session.as_deref()) {
        row.ok = row.ok.saturating_sub(1);
    }
}

/// Adds this request's duration to its session when the handler returns, on
/// every path (success, failover, early error). It is what keeps the active
/// time correct when "retry until answered" holds a request open for a long
/// while: that time is real activity, not an idle gap.
struct SessionTimer {
    usage: Arc<std::sync::Mutex<Usage>>,
    session: Option<String>,
    started: Instant,
}

fn nearest_cooldown_wait(
    chain: &[Upstream],
    cooldowns: &HashMap<String, Instant>,
    now: Instant,
) -> Option<Duration> {
    chain
        .iter()
        .filter_map(|upstream| {
            cooldowns
                .get(&cooldown_key(upstream))
                .map(|until| until.saturating_duration_since(now))
        })
        .filter(|remaining| !remaining.is_zero())
        .min()
}

#[cfg(test)]
mod cooldown_tests {
    use super::*;

    fn upstream(name: &str, model: &str) -> Upstream {
        Upstream {
            name: name.into(),
            base_url: String::new(),
            model: model.into(),
            api_key: String::new(),
            headers: HashMap::new(),
        }
    }

    #[test]
    fn retry_wait_ignores_expired_cooldowns() {
        let now = Instant::now();
        let chain = [upstream("p", "expired"), upstream("p", "blocked")];
        let cooldowns = HashMap::from([
            ("p|expired".into(), now - Duration::from_secs(1)),
            ("p|blocked".into(), now + Duration::from_secs(42)),
        ]);
        assert_eq!(
            nearest_cooldown_wait(&chain, &cooldowns, now),
            Some(Duration::from_secs(42))
        );
    }

    #[test]
    fn retry_wait_uses_fallback_when_no_model_is_blocked() {
        let now = Instant::now();
        let chain = [upstream("p", "m")];
        let cooldowns = HashMap::new();
        assert_eq!(nearest_cooldown_wait(&chain, &cooldowns, now), None);
    }
}

impl Drop for SessionTimer {
    fn drop(&mut self) {
        if let Ok(mut usage) = self.usage.lock() {
            session_request_end(&mut usage, self.session.as_deref(), self.started.elapsed());
        }
    }
}

/// The retry stream connection lets the retry loop stop when its client leaves.
struct RetryStream {
    sink: Option<mpsc::Sender<Result<Bytes, std::io::Error>>>,
}

impl RetryStream {
    fn silent() -> Self {
        Self {
            sink: None,
        }
    }

    /// True once the client hung up, so the retry loop can stop.
    fn client_gone(&self) -> bool {
        self.sink.as_ref().is_some_and(mpsc::Sender::is_closed)
    }
}

/// Opens the SSE connection before the first success, then forwards the answer.
/// Keepalives are SSE comments, never model content.
fn retry_stream_response(
    state: AppState,
    body: Value,
    chain: Vec<Upstream>,
    exposed: String,
    session: Option<String>,
    retry_forever: bool,
) -> Response {
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(16);
    let forward = tx.clone();
    tokio::spawn(async move {
        // Comments keep intermediaries and clients from treating a long retry
        // cooldown as a dead connection; OpenAI stream parsers ignore them.
        let heartbeat_tx = tx.clone();
        let _ = heartbeat_tx
            .send(Ok(Bytes::from_static(b": keepalive\n\n")))
            .await;
        let heartbeat = tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(15),
                Duration::from_secs(15),
            );
            loop {
                interval.tick().await;
                if heartbeat_tx
                    .send(Ok(Bytes::from_static(b": keepalive\n\n")))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let retry_stream = RetryStream {
            sink: Some(tx.clone()),
        };
        let response = run_chain(
            state,
            body,
            chain,
            exposed,
            session,
            retry_forever,
            // The body is already SSE, so the answer is adapted to it: a plain
            // JSON completion cannot be written into an open event stream.
            true,
            retry_stream,
        )
        .await;
        heartbeat.abort();
        if response.status().is_success() {
            let mut frames = response.into_body().into_data_stream();
            while let Some(frame) = frames.next().await {
                let Ok(frame) = frame else { break };
                // A closed receiver means the client left; sending into it also
                // tells the retry loop to stop.
                if forward.send(Ok(frame)).await.is_err() {
                    return;
                }
            }
            return;
        }
        // Retry exhaustion is an error, not a successful completion.
        let reason = response_error_text(response).await;
        let _ = forward
            .send(Ok(Bytes::from(format!(
                "data: {}\n\n",
                serde_json::json!({
                    "error": {
                        "message": reason,
                        "type": "proxy_retry_exhausted"
                    }
                })
            ))))
            .await;
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(ReceiverStream::new(rx)))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

async fn response_error_text(response: Response) -> String {
    let raw = axum::body::to_bytes(response.into_body(), 16 * 1024)
        .await
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default();
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or(raw)
}

pub(super) async fn chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let exposed = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let chain = state.chains.read().unwrap().get(&exposed).cloned();
    let Some(chain) = chain else {
        return json_error(StatusCode::NOT_FOUND, format!("unknown model: {exposed}"));
    };
    // The harness names each conversation in a header, so sessions can be
    // counted from traffic alone — no reading of its database or logs.
    let session = headers
        .get("x-opencode-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let stream_requested = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let retry_forever = state
        .config
        .read()
        .unwrap()
        .get("retryForever")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    // Retry mode can wait for an hour, so its stream must open before the first
    // success. Ordinary streaming keeps the upstream response untouched.
    if stream_requested && retry_forever {
        return retry_stream_response(state, body, chain, exposed, session, retry_forever);
    }
    run_chain(
        state,
        body,
        chain,
        exposed,
        session,
        retry_forever,
        stream_requested,
        RetryStream::silent(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_chain(
    state: AppState,
    body: Value,
    chain: Vec<Upstream>,
    exposed: String,
    session: Option<String>,
    retry_forever: bool,
    stream_requested: bool,
    retry_stream: RetryStream,
) -> Response {
    {
        let mut usage = state.usage.lock().unwrap();
        usage.requests += 1;
        hour_stat(&mut usage).requests += 1;
        let idle_gap = session_idle_gap(&state);
        // Counts the pause since the previous request while the row is fresh.
        if let Some(row) = session_request_start(&mut usage, session.as_deref(), idle_gap) {
            row.requests += 1;
        }
    }
    // Runs on every return path below; see its docs.
    let _session_timer = SessionTimer {
        usage: state.usage.clone(),
        session: session.clone(),
        started: Instant::now(),
    };
    let mut last_error = "all upstreams are cooling down".to_string();
    let mut attempted = false;
    // Harness mode: instead of handing the client a 502, wait out the cooldowns
    // and try the chain again. A run then ends only when an upstream answers.
    // Any non-2xx counts as a failed attempt here, not only quota/timeout/server
    // errors: a plain 400 or a dead key must not end the run either.
    const RETRY_WINDOW: Duration = Duration::from_secs(60 * 60);
    let started = Instant::now();
    loop {
        if retry_stream.client_gone() {
            break;
        }
        for upstream in &chain {
            let key = cooldown_key(upstream);
            if state
                .cooldowns
                .lock()
                .unwrap()
                .get(&key)
                .is_some_and(|until| *until > Instant::now())
            {
                continue;
            }
            attempted = true;
            {
                let mut usage = state.usage.lock().unwrap();
                provider_stat(&mut usage, &upstream.name).requests += 1;
                model_stat(&mut usage, &upstream.name, &upstream.model).requests += 1;
            }
            let mut request = state
                .client
                .post(format!("{}/chat/completions", upstream.base_url))
                .json(&with_model(&body, &upstream.model));
            if !upstream.api_key.is_empty() {
                request = request.bearer_auth(&upstream.api_key);
            }
            for (key, value) in &upstream.headers {
                request = request.header(key, value);
            }
            let header_timeout_sec = state
                .config
                .read()
                .unwrap()
                .get("headerTimeoutSec")
                .and_then(Value::as_u64)
                .unwrap_or(120);
            let response = match send_with_header_timeout(request, header_timeout_sec).await {
                Ok(response) => response,
                Err(err) => {
                    // Nothing was counted as ok yet: this attempt failed before
                    // headers, so only the error bucket moves.
                    record_failure(&state, upstream, &key, &session);
                    last_error = format!("{}: {err}", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!("{exposed} → свитч: {last_error}, пробую следующего"),
                    );
                    continue;
                }
            };
            let status = response.status();
            if failover_status(status) {
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                let default_seconds = if status == StatusCode::TOO_MANY_REQUESTS {
                    state
                        .config
                        .read()
                        .unwrap()
                        .get("limitCooldownSec")
                        .and_then(Value::as_u64)
                        .unwrap_or(300)
                } else {
                    state
                        .config
                        .read()
                        .unwrap()
                        .get("errorCooldownSec")
                        .and_then(Value::as_u64)
                        .unwrap_or(30)
                };
                let seconds = retry_after.unwrap_or(default_seconds).clamp(1, 86_400);
                state
                    .cooldowns
                    .lock()
                    .unwrap()
                    .insert(key, Instant::now() + Duration::from_secs(seconds));
                let mut usage = state.usage.lock().unwrap();
                let limited = status == StatusCode::TOO_MANY_REQUESTS;
                if limited {
                    provider_stat(&mut usage, &upstream.name).limits += 1;
                } else {
                    provider_stat(&mut usage, &upstream.name).errors += 1;
                }
                usage.failovers += 1;
                let stat = model_stat(&mut usage, &upstream.name, &upstream.model);
                stat.failovers += 1;
                if limited {
                    stat.limits += 1;
                } else {
                    stat.errors += 1;
                }
                if let Some(row) = session_stat(&mut usage, session.as_deref()) {
                    if limited {
                        row.limits += 1;
                    } else {
                        row.errors += 1;
                    }
                }
                last_error = format!("{}: HTTP {status}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → свитч: {}/{} заблокирован (HTTP {status}), пробую следующего",
                        upstream.name, upstream.model
                    ),
                );
                continue;
            }
            if status == StatusCode::BAD_REQUEST {
                let text = response.text().await.unwrap_or_default();
                if text.to_ascii_lowercase().contains("unsupported")
                    || text.to_ascii_lowercase().contains("not support")
                {
                    record_failure(&state, upstream, &key, &session);
                    last_error = format!("{}: HTTP 400, unsupported content", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!("{exposed} → свитч: {last_error}, пробую следующего"),
                    );
                    continue;
                }
                // A plain 400 is passed through as-is, but it is still an
                // outcome: without this the provider showed one request and no
                // ok/err at all, because the counters sat after the return.
                // In retry mode it is just another failed attempt: the run must
                // not end on a client-shaped error either.
                if !retry_forever {
                    {
                        let mut usage = state.usage.lock().unwrap();
                        provider_stat(&mut usage, &upstream.name).errors += 1;
                        let stat = model_stat(&mut usage, &upstream.name, &upstream.model);
                        stat.errors += 1;
                        if let Some(row) = session_stat(&mut usage, session.as_deref()) {
                            row.errors += 1;
                        }
                    }
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!(
                            "{exposed} → ошибка: {}/{} (HTTP 400)",
                            upstream.name, upstream.model
                        ),
                    );
                    return (
                        StatusCode::BAD_REQUEST,
                        [("content-type", "application/json")],
                        text,
                    )
                        .into_response();
                }
                record_failure(&state, &upstream, &key, &session);
                last_error = format!("{}: HTTP 400 {text}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!("{exposed} → свитч: {last_error}, пробую следующего"),
                );
                continue;
            }

            // Retry mode treats every non-2xx as a failed attempt, including
            // statuses that are not eligible for ordinary failover (401, 404).
            if retry_forever && !status.is_success() {
                record_failure(&state, &upstream, &key, &session);
                last_error = format!("{}: HTTP {status}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!("{exposed} → свитч: {last_error}, пробую следующего"),
                );
                continue;
            }

            {
                // "ok" means the upstream answered successfully. A 401/404 that
                // is passed straight through is a failed attempt, not a success:
                // counting it as ok made the tables show green for dead keys.
                let mut usage = state.usage.lock().unwrap();
                let succeeded = status.is_success();
                if succeeded {
                    usage.ok += 1;
                    provider_stat(&mut usage, &upstream.name).ok += 1;
                    model_stat(&mut usage, &upstream.name, &upstream.model).ok += 1;
                    hour_stat(&mut usage).ok += 1;
                } else {
                    usage.failed += 1;
                    hour_stat(&mut usage).failed += 1;
                    provider_stat(&mut usage, &upstream.name).errors += 1;
                    let stat = model_stat(&mut usage, &upstream.name, &upstream.model);
                    stat.errors += 1;
                }
                if let Some(row) = session_stat(&mut usage, session.as_deref()) {
                    if succeeded {
                        row.ok += 1;
                    } else {
                        row.errors += 1;
                    }
                }
            }
            if !status.is_success() {
                // A non-2xx that is passed straight through was already logged
                // above, because its body is forwarded unchanged.
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → ошибка: {}/{} (HTTP {status})",
                        upstream.name, upstream.model
                    ),
                );
            }
            match stream_upstream_response(
                response,
                state.clone(),
                exposed.clone(),
                upstream.name.clone(),
                upstream.model.clone(),
                stream_requested,
                session.clone(),
            )
            .await
            {
                Ok(response) => {
                    // Only now is it known that the stream carried a real
                    // answer: a 200 that held nothing but reasoning used to be
                    // logged as "ответ" and then fail silently on the client.
                    if status.is_success() {
                        push_chat_log(
                            &state,
                            session.as_deref(),
                            format!(
                                "{exposed} → ответ: {}/{} (HTTP {status})",
                                upstream.name, upstream.model
                            ),
                        );
                    }
                    return response;
                }
                Err(err) => {
                    // The 200 status already counted a provisional "ok"; the
                    // empty body moves it to errors through record_failure.
                    revert_provisional_ok(&state, upstream, &session);
                    record_failure(&state, &upstream, &key, &session);
                    last_error = format!("{}: {err}", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!("{exposed} → свитч: {last_error}, пробую следующего"),
                    );
                }
            }
        }
        // A chain with no usable upstream can never answer: retrying it would
        // spin for the whole window while the client waits for nothing.
        if !retry_forever || chain.is_empty() || started.elapsed() > RETRY_WINDOW {
            break;
        }
        // Sleep until the nearest upstream leaves its cooldown instead of polling:
        // a 5-minute limit cooldown would otherwise log a retry every two seconds.
        let now = Instant::now();
        let wait = nearest_cooldown_wait(&chain, &state.cooldowns.lock().unwrap(), now)
            .unwrap_or(Duration::from_secs(2))
            .max(Duration::from_secs(1));
        push_chat_log(
            &state,
            session.as_deref(),
            format!(
                "{exposed} → все апстримы недоступны, повторяю через {} с (режим ретрая)",
                wait.as_secs()
            ),
        );
        tokio::time::sleep(wait).await;
    } // end retry loop
    let mut usage = state.usage.lock().unwrap();
    usage.failed += 1;
    if !attempted {
        usage.skipped += 1;
    }
    hour_stat(&mut usage).failed += 1;
    // The client got a 502, so the session sees an error even when no upstream
    // was tried. Without this the row would read one request and no outcome.
    if let Some(row) = session_stat(&mut usage, session.as_deref()) {
        row.errors += 1;
    }
    drop(usage);
    json_error(
        StatusCode::BAD_GATEWAY,
        format!("all upstreams failed for {exposed}: {last_error}"),
    )
}
