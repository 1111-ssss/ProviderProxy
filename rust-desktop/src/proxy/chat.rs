use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::time::timeout;

use super::{
    auth::authorized,
    handlers::json_error,
    metrics::{model_stat, provider_stat, push_log},
    routing::{failover_status, with_model},
    stream::stream_upstream_response,
    types::AppState,
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
    {
        let mut usage = state.usage.lock().unwrap();
        usage.requests += 1;
        model_stat(&mut usage, &exposed).requests += 1;
    }
    let mut last_error = "all upstreams are cooling down".to_string();
    for upstream in chain {
        let key = format!("{exposed}|{}|{}", upstream.name, upstream.model);
        if state
            .cooldowns
            .lock()
            .unwrap()
            .get(&key)
            .is_some_and(|until| *until > Instant::now())
        {
            continue;
        }
        {
            let mut usage = state.usage.lock().unwrap();
            provider_stat(&mut usage, &upstream.name).requests += 1;
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
                let cooldown = Duration::from_secs(
                    state
                        .config
                        .read()
                        .unwrap()
                        .get("errorCooldownSec")
                        .and_then(Value::as_u64)
                        .unwrap_or(30),
                );
                state
                    .cooldowns
                    .lock()
                    .unwrap()
                    .insert(key, Instant::now() + cooldown);
                let mut usage = state.usage.lock().unwrap();
                provider_stat(&mut usage, &upstream.name).errors += 1;
                usage.failovers += 1;
                model_stat(&mut usage, &exposed).failovers += 1;
                last_error = format!("{}: {err}", upstream.name);
                push_log(
                    &state,
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
            if status == StatusCode::TOO_MANY_REQUESTS {
                provider_stat(&mut usage, &upstream.name).limits += 1;
            } else {
                provider_stat(&mut usage, &upstream.name).errors += 1;
            }
            usage.failovers += 1;
            model_stat(&mut usage, &exposed).failovers += 1;
            last_error = format!("{}: HTTP {status}", upstream.name);
            push_log(
                &state,
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
                let seconds = state
                    .config
                    .read()
                    .unwrap()
                    .get("errorCooldownSec")
                    .and_then(Value::as_u64)
                    .unwrap_or(30);
                state
                    .cooldowns
                    .lock()
                    .unwrap()
                    .insert(key, Instant::now() + Duration::from_secs(seconds));
                let mut usage = state.usage.lock().unwrap();
                provider_stat(&mut usage, &upstream.name).errors += 1;
                usage.failovers += 1;
                model_stat(&mut usage, &exposed).failovers += 1;
                last_error = format!("{}: HTTP 400, unsupported content", upstream.name);
                push_log(
                    &state,
                    format!("{exposed} → свитч: {last_error}, пробую следующего"),
                );
                continue;
            }
            push_log(
                &state,
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

        {
            let mut usage = state.usage.lock().unwrap();
            usage.ok += 1;
            provider_stat(&mut usage, &upstream.name).ok += 1;
            model_stat(&mut usage, &exposed).ok += 1;
        }
        push_log(
            &state,
            format!(
                "{exposed} → {}: {}/{} (HTTP {status})",
                if status.is_success() {
                    "ответ"
                } else {
                    "ошибка"
                },
                upstream.name,
                upstream.model
            ),
        );
        return stream_upstream_response(
            response,
            state.clone(),
            exposed,
            upstream.name,
            upstream.model,
        )
        .await;
    }
    state.usage.lock().unwrap().failed += 1;
    json_error(
        StatusCode::BAD_GATEWAY,
        format!("all upstreams failed for {exposed}: {last_error}"),
    )
}
