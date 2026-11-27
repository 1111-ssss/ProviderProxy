use super::*;

#[derive(Deserialize)]
pub(crate) struct LogsQuery {
    before: Option<i64>,
    limit: Option<usize>,
}

pub(crate) async fn v1_models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let chains = state.chains.read().unwrap();
    let data: Vec<Value> = chains
        .keys()
        // Tag chains exist only for an OpenCode helper agent; they are not part
        // of the public model list.
        .filter(|id| !id.starts_with("agent-tag:"))
        .map(|id| json!({ "id": id, "object": "model", "owned_by": "provider_proxy" }))
        .collect();
    push_log(&state, format!("GET /v1/models → {} моделей", data.len()));
    Json(json!({ "object": "list", "data": data })).into_response()
}

pub(crate) async fn get_logs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<LogsQuery>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    // `before` walks back through the stored day; without it the first page is
    // the newest records. The GUI never holds more than one page of lines.
    let limit = query.limit.unwrap_or(200);
    let mut page: Vec<(i64, String)> = log_page(&state.storage, query.before, limit)
        .into_iter()
        // The GUI's own chatter would drown the real records.
        .filter(|(_, line)| !line.contains("gui:"))
        .collect();
    // `next` is the cursor for the following page; absent when the day ends.
    let next = if page.len() == limit.clamp(1, 500) {
        page.last().map(|(id, _)| *id)
    } else {
        None
    };
    let lines: Vec<Value> = page
        .drain(..)
        .map(|(id, line)| json!({ "id": id, "line": line }))
        .collect();
    // Titles travel with the lines so hovering an id can name the session and
    // the search can match that name without a second request.
    Json(json!({
        "lines": lines,
        "next": next,
        "total": log_count(&state.storage),
        "sessionTitles": session_titles(&state),
    }))
    .into_response()
}

/// Titles for every session the seven-day window knows, so the GUI can show a
/// name instead of an opaque id. Looked up from the harness only as a label.
fn session_titles(state: &AppState) -> std::collections::HashMap<String, String> {
    let mut keys: Vec<String> = state
        .usage
        .lock()
        .unwrap()
        .sessions
        .keys()
        .cloned()
        .collect();
    for day in state.usage_history.lock().unwrap().values() {
        keys.extend(day.sessions.keys().cloned());
    }
    keys.sort_unstable();
    keys.dedup();
    super::super::session_titles::titles_for(&keys)
}

pub(crate) async fn get_uptime_answers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    Json(uptime_snapshot(&state)).into_response()
}

pub(crate) async fn get_usage(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    // Refresh the stored snapshot so `days[0]` matches the live counters even in
    // tests and during the first second of traffic; the writer itself skips the
    // SQLite transaction when nothing changed.
    persist_usage(&state);
    let mut value =
        serde_json::to_value(state.usage.lock().unwrap().clone()).unwrap_or_else(|_| json!({}));
    let cooldowns = cooldown_snapshot(&state);
    if let Value::Object(object) = &mut value {
        object.insert("cooldowns".into(), Value::Array(cooldowns));
        let since = object
            .get("since")
            .and_then(Value::as_u64)
            .unwrap_or(now_ms() as u64) as u128;
        object.insert("uptimeMs".into(), json!(now_ms().saturating_sub(since)));
        object.insert(
            "today".into(),
            Value::String(state.usage_day.lock().unwrap().clone()),
        );
        object.insert("retentionDays".into(), json!(USAGE_RETENTION_DAYS));
        object.insert("days".into(), Value::Array(usage_history_view(&state)));
        object.insert("sessionTitles".into(), json!(session_titles(&state)));
        object.insert(
            "lifetimeTokens".into(),
            serde_json::to_value(state.lifetime.lock().unwrap().clone()).unwrap_or_else(|_| json!({})),
        );
    }
    Json(value).into_response()
}

pub(crate) async fn opencode_sync(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let ok = sync_opencode(&state).await;
    let config = state.config.read().unwrap();
    let chains = config
        .get("models")
        .and_then(Value::as_object)
        .map(|models| {
            models
                .values()
                .filter(|v| v.get("enabled").and_then(Value::as_bool) != Some(false))
                .count()
        })
        .unwrap_or(0);
    let direct = config
        .get("opencodeModels")
        .and_then(Value::as_object)
        .map(|direct| {
            direct
                .iter()
                .filter(|(_, definition)| definition.get("enabled").and_then(Value::as_bool) != Some(false))
                .map(|(provider_name, definition)| {
                    config
                        .get("providers")
                        .and_then(|providers| providers.get(provider_name))
                        .map(|provider| direct_model_ids(provider, definition).len())
                        .unwrap_or_else(|| definition.get("models").and_then(Value::as_array).map(Vec::len).unwrap_or(0))
                })
                .sum::<usize>()
        })
        .unwrap_or(0);
    Json(json!({ "ok": ok, "models": chains + direct })).into_response()
}
