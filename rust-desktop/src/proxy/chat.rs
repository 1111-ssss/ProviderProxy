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
        hour_stat, model_stat, provider_stat, push_chat_log, record_chain_uptime,
        record_model_uptime, revert_model_uptime, session_idle_gap, session_request_end,
        session_request_start, session_stat,
    },
    routing::{failover_status, model_label, rank_chain, with_model},
    stream::stream_upstream_response,
    types::{AppState, Upstream, Usage},
};

/// reqwest's Display text is a debug string ("error sending request for url
/// (https://…)"), which repeats the provider and the endpoint the log already
/// names. Keep the cause in words a user can act on.
fn describe_send_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "таймаут ответа".into()
    } else if err.is_connect() {
        "нет соединения".into()
    } else if err.is_body() || err.is_decode() {
        "повреждённый ответ".into()
    } else if err.is_request() {
        "не удалось отправить запрос".into()
    } else {
        "ошибка сети".into()
    }
}

async fn send_with_header_timeout(
    request: reqwest::RequestBuilder,
    header_timeout_sec: u64,
) -> Result<reqwest::Response, String> {
    let request = request.send();
    if header_timeout_sec == 0 {
        return request.await.map_err(|err| describe_send_error(&err));
    }
    timeout(Duration::from_secs(header_timeout_sec), request)
        .await
        .map_err(|_| "апстрим не прислал ответ вовремя".to_string())?
        .map_err(|err| describe_send_error(&err))
}

/// ", пробую следующего" only when a next upstream actually exists: on a
/// single-model chain the next attempt is the same model after its cooldown.
fn has_next_upstream(chain: &[Upstream], upstream: &Upstream) -> bool {
    // By name and model, not by pointer: the chain is cloned for ranking, so
    // pointer identity no longer holds and every switch logged as a plain error.
    // The last match decides: a repeated link must not promise a switch it does
    // not have.
    chain
        .iter()
        .rposition(|candidate| {
            candidate.name == upstream.name && candidate.model == upstream.model
        })
        .is_some_and(|index| index + 1 < chain.len())
}

fn failover_note(chain: &[Upstream], upstream: &Upstream) -> &'static str {
    if has_next_upstream(chain, upstream) {
        ", пробую следующего"
    } else {
        ""
    }
}

fn attempt_log_kind(chain: &[Upstream], upstream: &Upstream) -> &'static str {
    if has_next_upstream(chain, upstream) { "свитч" } else { "ошибка" }
}

/// Why an attempt failed, which decides how long the model rests.
///
/// The chain is not a fixed queue any more: an ordinary error switches to the
/// next model right away without a cooldown (it may be a one-off), while a rate
/// limit, a dead key or a model the provider does not serve is blocked so the
/// next request does not pay for the same answer again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureKind {
    /// Rate limit: 429, or a body that says so.
    Limited,
    /// The provider does not serve the model (404).
    Missing,
    /// The key or the account is dead: 401, 402, 403.
    Denied,
    /// The model answered nothing usable (empty body, 502, 503, 524).
    Unusable,
    /// A network error before the response: switch, do not block.
    Transient,
    /// A status the client should see: 400, 422 and the like.
    Passthrough,
}

impl FailureKind {
    /// Status codes with a fixed meaning for the whole provider account.
    fn from_status(status: StatusCode) -> Self {
        match status {
            StatusCode::TOO_MANY_REQUESTS => Self::Limited,
            StatusCode::NOT_FOUND | StatusCode::GONE => Self::Missing,
            StatusCode::UNAUTHORIZED | StatusCode::PAYMENT_REQUIRED | StatusCode::FORBIDDEN => {
                Self::Denied
            }
            // 524 is Cloudflare's "origin timed out"; 500 is as unusable as a
            // gateway error, and three quiet retries cost less than a failover.
            StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT => Self::Unusable,
            other if other.as_u16() == 524 => Self::Unusable,
            _ => Self::Passthrough,
        }
    }
}
/// Counts one failed attempt: the error counters, the log line and the model's
/// last outcome. It deliberately sets no cooldown — the caller decides whether
/// the failure blocks anything, because a one-off 400 or 502 should move the
/// chain on and leave the model usable for the next request.
fn record_failure(
    state: &AppState,
    upstream: &Upstream,
    session: &Option<String>,
    kind: FailureKind,
) {
    let mut usage = state.usage.lock().unwrap();
    let limited = kind == FailureKind::Limited;
    {
        let provider = provider_stat(&mut usage, &upstream.name);
        if limited {
            provider.limits += 1;
        } else {
            provider.errors += 1;
        }
    }
    {
        let stat = model_stat(&mut usage, &upstream.name, &upstream.model);
        if limited {
            stat.limits += 1;
        } else {
            stat.errors += 1;
        }
        stat.failovers += 1;
    }
    usage.failovers += 1;
    if let Some(row) = session_stat(&mut usage, session.as_deref()) {
        if limited {
            row.limits += 1;
        } else {
            row.errors += 1;
        }
    }
    drop(usage);
    state
        .last_outcome
        .lock()
        .unwrap()
        .insert(cooldown_key(upstream), false);
    record_model_uptime(state, &upstream.name, &upstream.model, false);
}

fn cooldown_key(upstream: &Upstream) -> String {
    // A cooldown belongs to the provider/model, not a chain alias. This keeps
    // another alias from immediately retrying the same failed model.
    format!("{}|{}", upstream.name, upstream.model)
}

/// Key for the whole provider: one dead key or one exhausted account blocks
/// every model of it, not just the one that happened to answer 429 first.
fn provider_cooldown_key(upstream: &Upstream) -> String {
    format!("{}|*", upstream.name)
}

fn block_until(state: &AppState, key: &str, seconds: u64) {
    let seconds = seconds.clamp(1, 86_400);
    state
        .cooldowns
        .lock()
        .unwrap()
        .insert(key.to_string(), Instant::now() + Duration::from_secs(seconds));
}

/// The block of a chain with one upstream, and the longest wait before a fully
/// blocked chain's blocks are dropped. One setting for both: a single model has
/// nowhere to fail over to, so a long park just removes it from the client.
const SINGLE_COOLDOWN_DEFAULT: u64 = 30;

fn single_cooldown_sec(state: &AppState) -> u64 {
    state
        .config
        .read()
        .unwrap()
        .get("singleCooldownSec")
        .and_then(Value::as_u64)
        .unwrap_or(SINGLE_COOLDOWN_DEFAULT)
        .max(1)
}

/// The cooldown a failure deserves. A rate limit follows `limitCooldownSec`
/// (or the provider's own `retry-after`), everything else `errorCooldownSec`.
///
/// `single` is a chain with one upstream: there is nothing to fail over to, so
/// a long block just makes the only model unreachable. It is capped by
/// `singleCooldownSec` instead.
fn failure_cooldown(
    state: &AppState,
    kind: FailureKind,
    retry_after: Option<u64>,
    single: bool,
) -> u64 {
    let config = state.config.read().unwrap();
    let default = match kind {
        FailureKind::Limited => config
            .get("limitCooldownSec")
            .and_then(Value::as_u64)
            .unwrap_or(300),
        _ => config
            .get("errorCooldownSec")
            .and_then(Value::as_u64)
            .unwrap_or(30),
    };
    // A provider may answer `Retry-After: 53128` (14.7 h). Honouring that
    // verbatim parked the model for the rest of the day, so the configured
    // value is the ceiling: a shorter hint is still respected, a longer one is
    // not allowed to outlast the setting.
    let seconds = retry_after.map_or(default, |hint| hint.min(default));
    drop(config);
    if single {
        return seconds.min(single_cooldown_sec(state)).max(1);
    }
    // The old `max(1)` guard: a zero (hand-edited config) would expire at once
    // and let a retry loop hammer the same dead upstream.
    seconds.max(1)
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
    drop(usage);
    revert_model_uptime(state, &upstream.name, &upstream.model);
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
            // The provider-wide block counts too: without it a limited account
            // looked free and the retry loop polled every two seconds.
            let until = cooldowns
                .get(&cooldown_key(upstream))
                .into_iter()
                .chain(cooldowns.get(&provider_cooldown_key(upstream)))
                .max()?;
            Some(until.saturating_duration_since(now))
        })
        .filter(|remaining| !remaining.is_zero())
        .min()
}

/// Frees every chain link: called when the whole chain is parked for longer
/// than the short block, so a client is never left waiting out a 30-minute
/// cooldown with no chance of an answer.
fn release_chain(state: &AppState, chain: &[Upstream]) {
    let mut cooldowns = state.cooldowns.lock().unwrap();
    for upstream in chain {
        cooldowns.remove(&cooldown_key(upstream));
        cooldowns.remove(&provider_cooldown_key(upstream));
    }
}

#[cfg(test)]
mod cooldown_tests {
    use super::*;
    use serde_json::json;

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
    fn retry_note_only_says_next_when_there_is_another_upstream() {
        let chain = [upstream("one", "m"), upstream("two", "m")];
        assert!(has_next_upstream(&chain, &chain[0]));
        assert!(!has_next_upstream(&chain, &chain[1]));
        let duplicate = [upstream("one", "m"), upstream("one", "m")];
        assert!(!has_next_upstream(&duplicate, &duplicate[1]));
    }

    #[tokio::test]
    async fn send_errors_are_written_as_actionable_russian() {
        // Port 0 can never have a listener: a bound-and-released ephemeral port
        // gets reused by a parallel test, which then answers 404 instead of
        // refusing the connection and makes this test flaky.
        let error = reqwest::Client::new()
            .get("http://127.0.0.1:0")
            .send()
            .await
            .unwrap_err();
        assert_eq!(describe_send_error(&error), "нет соединения");
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
    fn retry_wait_sees_a_provider_wide_block() {
        let now = Instant::now();
        let chain = [upstream("p", "m"), upstream("q", "m")];
        let cooldowns = HashMap::from([("p|*".into(), now + Duration::from_secs(90))]);
        assert_eq!(
            nearest_cooldown_wait(&chain, &cooldowns, now),
            Some(Duration::from_secs(90)),
            "a limited account must be waited out, not polled"
        );
    }

    #[test]
    fn retry_wait_uses_fallback_when_no_model_is_blocked() {
        let now = Instant::now();
        let chain = [upstream("p", "m")];
        let cooldowns = HashMap::new();
        assert_eq!(nearest_cooldown_wait(&chain, &cooldowns, now), None);
    }

    fn config(value: Value) -> AppState {
        super::super::tests::test_state_with_config(value)
    }

    #[tokio::test]
    async fn retry_after_is_a_ceiling_not_a_verdict() {
        let state = config(json!({"limitCooldownSec": 120, "errorCooldownSec": 120}));
        assert_eq!(
            failure_cooldown(&state, FailureKind::Limited, Some(53128), false),
            120,
            "a 14.7 h Retry-After must not park the model past the setting"
        );
        assert_eq!(
            failure_cooldown(&state, FailureKind::Limited, Some(7), false),
            7,
            "a shorter hint is still respected"
        );
    }

    #[tokio::test]
    async fn a_single_model_never_blocks_longer_than_the_setting() {
        let state = config(json!({
            "limitCooldownSec": 300,
            "errorCooldownSec": 300,
            "singleCooldownSec": 30
        }));
        assert_eq!(failure_cooldown(&state, FailureKind::Limited, None, true), 30);
        assert_eq!(
            failure_cooldown(&state, FailureKind::Limited, Some(53128), true),
            30
        );
        assert_eq!(failure_cooldown(&state, FailureKind::Unusable, None, true), 30);
        // A multi-model chain keeps its full cooldowns.
        assert_eq!(failure_cooldown(&state, FailureKind::Limited, None, false), 300);
    }

    #[tokio::test]
    async fn a_fully_blocked_chain_is_released_when_blocks_outlast_the_cap() {
        let state = config(json!({"singleCooldownSec": 30}));
        let chain = [upstream("p", "m")];
        state.cooldowns.lock().unwrap().insert(
            "p|m".into(),
            Instant::now() + Duration::from_secs(600),
        );
        release_chain(&state, &chain);
        assert!(
            state.cooldowns.lock().unwrap().is_empty(),
            "a parked chain must be freed, not waited out"
        );
    }
}

impl Drop for SessionTimer {
    fn drop(&mut self) {
        if let Ok(mut usage) = self.usage.lock() {
            session_request_end(&mut usage, self.session.as_deref(), self.started.elapsed());
        }
    }
}

/// Builds and sends one attempt. A gateway-shaped answer (500/502/503/524) is
/// a likely hiccup, so the same model is asked twice more right away; the third
/// answer is handed back, and the caller blocks the model.
#[allow(clippy::too_many_arguments)]
async fn send_attempt(
    state: &AppState,
    upstream: &Upstream,
    body: &Value,
    session: &Option<String>,
    exposed: &str,
    chain: &[Upstream],
) -> Result<reqwest::Response, String> {
    const UNUSABLE_ATTEMPTS: u32 = 3;
    let header_timeout_sec = state
        .config
        .read()
        .unwrap()
        .get("headerTimeoutSec")
        .and_then(Value::as_u64)
        .unwrap_or(120);
    let mut attempt = 1;
    loop {
        // Counted per real request, not per chain link: three quiet retries are
        // three requests in the usage table, so requests never lag behind errors.
        {
            let mut usage = state.usage.lock().unwrap();
            provider_stat(&mut usage, &upstream.name).requests += 1;
            model_stat(&mut usage, &upstream.name, &upstream.model).requests += 1;
        }
        {
            let mut lifetime = state.lifetime.lock().unwrap();
            *lifetime.providers.entry(upstream.name.clone()).or_default() += 1;
            *lifetime.models.entry(format!("{}/{}", upstream.name, upstream.model)).or_default() += 1;
        }
        let mut request = state
            .client
            .post(format!("{}/chat/completions", upstream.base_url))
            .json(&with_model(body, &upstream.model));
        if !upstream.api_key.is_empty() {
            request = request.bearer_auth(&upstream.api_key);
        }
        for (name, value) in &upstream.headers {
            request = request.header(name, value);
        }
        let response = send_with_header_timeout(request, header_timeout_sec).await?;
        if FailureKind::from_status(response.status()) != FailureKind::Unusable
            || attempt >= UNUSABLE_ATTEMPTS
        {
            return Ok(response);
        }
        record_failure(state, upstream, session, FailureKind::Unusable);
        attempt += 1;
        push_chat_log(
            state,
            session.as_deref(),
            format!(
                "{exposed} → {}: {} — HTTP {}, попытка {attempt} из {UNUSABLE_ATTEMPTS}",
                attempt_log_kind(chain, upstream),
                model_label(exposed, &upstream.model),
                response.status().as_u16()
            ),
        );
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
    // A chain of one has nowhere to fail over to, so its blocks are kept short
    // by `singleCooldownSec` below; retry mode itself still applies, because the
    // user asked for "repeat until answered" and a single model is still that.
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
    // A chain of one has nowhere to fail over to, so its blocks are short: a
    // long limit would leave the only model unusable for hours.
    let single = chain.len() <= 1;
    // How many times a provider answered a rate limit in this request. The
    // second one means the account, not the model, is out of quota.
    let mut limit_hits: HashMap<String, u32> = HashMap::new();
    // How many quiet retries an unusable model got in this request. Three in a
    // row with nothing usable and it is blocked like any other dead model.
    const UNUSABLE_ATTEMPTS: u32 = 3;
    let mut unusable_attempts: HashMap<String, u32> = HashMap::new();
    loop {
        if retry_stream.client_gone() {
            break;
        }
        // Re-decided every round: the outcome of this very run and the external
        // uptime make a dead first link sink below a live second one.
        let order = {
            let uptime = state.uptime_bars.lock().unwrap();
            let last = state.last_outcome.lock().unwrap();
            rank_chain(&chain, &uptime, &last)
        };
        // A queue, not a slice: a model that answered nothing usable goes back
        // to the front for its next try instead of handing the turn to a model
        // the user ranked lower.
        let mut queue: std::collections::VecDeque<Upstream> = order.into_iter().collect();
        while let Some(item) = queue.pop_front() {
            let upstream = &item;
            let key = cooldown_key(upstream);
            let provider_key = provider_cooldown_key(upstream);
            let blocked = state
                .cooldowns
                .lock()
                .unwrap()
                .iter()
                .any(|(name, until)| {
                    *until > Instant::now() && (*name == key || *name == provider_key)
                });
            if blocked {
                continue;
            }
            attempted = true;
            let response = match send_attempt(&state, upstream, &body, &session, &exposed, &chain)
                .await
            {
                Ok(response) => response,
                Err(err) => {
                    // Nothing was counted as ok yet: this attempt failed before
                    // headers, so only the error bucket moves.
                    record_failure(&state, upstream, &session, FailureKind::Transient);
                    last_error = format!("{}: {err}", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!(
                            "{exposed} → {}: {} — {err}{}",
                            attempt_log_kind(&chain, upstream),
                            model_label(&exposed, &upstream.model),
                            failover_note(&chain, upstream)
                        ),
                    );
                    continue;
                }
            };
            let status = response.status();
            // A 400 is the one status whose body decides what happened: some
            // providers answer 400 for an unsupported request, others for a
            // rate limit. Every other status is decided from the status alone,
            // because reading a 200 body here would take it from the stream.
            if status == StatusCode::BAD_REQUEST {
                let text = response.text().await.unwrap_or_default();
                let lowered = text.to_ascii_lowercase();
                if lowered.contains("ratelimit") || lowered.contains("rate limit") {
                    let seconds = failure_cooldown(&state, FailureKind::Limited, None, single);
                    record_failure(&state, upstream, &session, FailureKind::Limited);
                    // The second limit from one provider in this request is the
                    // account: block every model of it, not just this one.
                    let hits = limit_hits.entry(upstream.name.clone()).or_default();
                    *hits += 1;
                    if *hits >= 2 {
                        block_until(&state, &provider_cooldown_key(upstream), seconds);
                    }
                    block_until(&state, &key, seconds);
                    last_error = format!("{}: HTTP 400 (лимит)", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!(
                            "{exposed} → {}: {} — HTTP 400 (лимит), заблокирован{}",
                            attempt_log_kind(&chain, upstream),
                            model_label(&exposed, &upstream.model),
                            failover_note(&chain, upstream)
                        ),
                    );
                    continue;
                }
                if lowered.contains("unsupported") || lowered.contains("not support") {
                    record_failure(&state, upstream, &session, FailureKind::Passthrough);
                    last_error = format!("{}: HTTP 400, запрос не поддерживается", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!(
                            "{exposed} → {}: {} — HTTP 400, запрос не поддерживается{}",
                            attempt_log_kind(&chain, upstream),
                            model_label(&exposed, &upstream.model),
                            failover_note(&chain, upstream)
                        ),
                    );
                    continue;
                }
                // A plain 400 is passed through as-is, but it is still an
                // outcome: without this the provider showed one request and no
                // ok/err at all, because the counters sat after the return.
                // In retry mode it is just another failed attempt: the run must
                // not end on a client-shaped error either.
                record_failure(&state, upstream, &session, FailureKind::Passthrough);
                if !retry_forever {
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!(
                            "{exposed} → ошибка: {} — HTTP 400",
                            model_label(&exposed, &upstream.model)
                        ),
                    );
                    record_chain_uptime(&state, &exposed, false);
                    return (
                        StatusCode::BAD_REQUEST,
                        [("content-type", "application/json")],
                        text,
                    )
                        .into_response();
                }
                last_error = format!("{}: HTTP 400 {text}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → {}: {} — HTTP 400{}{}",
                        attempt_log_kind(&chain, upstream),
                        model_label(&exposed, &upstream.model),
                        if text.trim().is_empty() {
                            String::new()
                        } else {
                            format!(": {}", text.trim())
                        },
                        failover_note(&chain, upstream)
                    ),
                );
                continue;
            }
            if status == StatusCode::TOO_MANY_REQUESTS {
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                let seconds = failure_cooldown(&state, FailureKind::Limited, retry_after, single);
                record_failure(&state, upstream, &session, FailureKind::Limited);
                // The second limit from one provider in this request is the
                // account: block every model of it, not just this one.
                let hits = limit_hits.entry(upstream.name.clone()).or_default();
                *hits += 1;
                if *hits >= 2 {
                    block_until(&state, &provider_cooldown_key(upstream), seconds);
                }
                block_until(&state, &key, seconds);
                last_error = format!("{}: HTTP {status}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → {}: {} — HTTP {}, заблокирован{}",
                        attempt_log_kind(&chain, upstream),
                        model_label(&exposed, &upstream.model),
                        status.as_u16(),
                        failover_note(&chain, upstream)
                    ),
                );
                continue;
            }
            // 404 is not a "server error" and 401 is neither, but both mean
            // this link cannot answer: switch away and rest it.
            if failover_status(status)
                || matches!(status, StatusCode::NOT_FOUND | StatusCode::UNAUTHORIZED)
            {
                let kind = FailureKind::from_status(status);
                let retry_after = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok());
                let seconds = failure_cooldown(&state, kind, retry_after, single);
                record_failure(&state, upstream, &session, kind);
                match kind {
                    // A model the provider does not serve or a dead account
                    // will not heal in a minute: block it (404/401/402/403).
                    FailureKind::Missing | FailureKind::Denied => block_until(&state, &key, seconds),
                    // 500/502/503/524: send_attempt already asked three times,
                    // so this is a rest, not a first strike.
                    FailureKind::Unusable => block_until(&state, &key, seconds),
                    _ => {}
                }
                last_error = format!("{}: HTTP {status}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → {}: {} — HTTP {}, заблокирован{}",
                        attempt_log_kind(&chain, upstream),
                        model_label(&exposed, &upstream.model),
                        status.as_u16(),
                        failover_note(&chain, upstream)
                    ),
                );
                continue;
            }

            // Retry mode treats every non-2xx as a failed attempt, including
            // statuses that are not eligible for ordinary failover (401, 404).
            if retry_forever && !status.is_success() {
                record_failure(&state, upstream, &session, FailureKind::Passthrough);
                last_error = format!("{}: HTTP {status}", upstream.name);
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → {}: {} — HTTP {}{}",
                        attempt_log_kind(&chain, upstream),
                        model_label(&exposed, &upstream.model),
                        status.as_u16(),
                        failover_note(&chain, upstream)
                    ),
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
                drop(usage);
                record_model_uptime(&state, &upstream.name, &upstream.model, succeeded);
            }
            if !status.is_success() {
                // A non-2xx that is passed straight through was already logged
                // above, because its body is forwarded unchanged.
                push_chat_log(
                    &state,
                    session.as_deref(),
                    format!(
                        "{exposed} → ошибка: {} — HTTP {}",
                        model_label(&exposed, &upstream.model),
                        status.as_u16()
                    ),
                );
            }
            let answer_started = Instant::now();
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
                        state
                            .last_outcome
                            .lock()
                            .unwrap()
                            .insert(key.clone(), true);
                        push_chat_log(
                            &state,
                            session.as_deref(),
                            format!(
                                "{exposed} → ответ: {}",
                                model_label(&exposed, &upstream.model)
                            ),
                        );
                    }
                    record_chain_uptime(&state, &exposed, status.is_success());
                    return response;
                }
                Err(err) => {
                    // The 200 status already counted a provisional "ok"; the
                    // empty body moves it to errors through record_failure.
                    revert_provisional_ok(&state, upstream, &session);
                    // An empty answer is often a hiccup: try the same model
                    // again right away, and only block it after a third miss.
                    // A stall is not: it already waited the whole idle window,
                    // and repeating it would triple the client's wait.
                    let quick = answer_started.elapsed() < Duration::from_secs(5);
                    let tries = unusable_attempts.entry(key.clone()).or_default();
                    *tries += 1;
                    record_failure(&state, upstream, &session, FailureKind::Unusable);
                    if quick && *tries < UNUSABLE_ATTEMPTS {
                        last_error = format!("{}: {err}", upstream.name);
                        push_chat_log(
                            &state,
                            session.as_deref(),
                            format!(
                                "{exposed} → {}: {} — {err}, попытка {tries} из {UNUSABLE_ATTEMPTS}",
                                attempt_log_kind(&chain, upstream),
                                model_label(&exposed, &upstream.model)
                            ),
                        );
                        // Same model again, right now: an empty answer is
                        // usually a hiccup, not a reason to lose the turn.
                        queue.push_front(item.clone());
                        continue;
                    }
                    unusable_attempts.remove(&key);
                    let seconds = failure_cooldown(&state, FailureKind::Unusable, None, single);
                    block_until(&state, &key, seconds);
                    last_error = format!("{}: {err}", upstream.name);
                    push_chat_log(
                        &state,
                        session.as_deref(),
                        format!(
                            "{exposed} → {}: {} — {err}{}",
                            attempt_log_kind(&chain, upstream),
                            model_label(&exposed, &upstream.model),
                            failover_note(&chain, upstream)
                        ),
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
        // The wait is capped: sitting out a 30-minute block left the client with
        // no answer that whole time, so after the short block the chain's blocks
        // are dropped and the models are tried again.
        let now = Instant::now();
        let cap = Duration::from_secs(single_cooldown_sec(&state));
        let nearest = nearest_cooldown_wait(&chain, &state.cooldowns.lock().unwrap(), now);
        let wait = nearest.unwrap_or(Duration::from_secs(2));
        if wait > cap {
            release_chain(&state, &chain);
            push_chat_log(
                &state,
                session.as_deref(),
                format!(
                    "{exposed} → блоки длиннее {} с, снимаю их и пробую снова",
                    cap.as_secs()
                ),
            );
            tokio::time::sleep(cap).await;
            continue;
        }
        let wait = wait.max(Duration::from_secs(1));
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
    record_chain_uptime(&state, &exposed, false);
    json_error(
        StatusCode::BAD_GATEWAY,
        format!("all upstreams failed for {exposed}: {last_error}"),
    )
}
