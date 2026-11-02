use axum::{
    body::to_bytes,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Local;
use serde_json::{json, Map, Value};
use std::{fs, path::PathBuf, time::Duration};

use super::{
    auth::authorized,
    config::{merge_config_secrets, public_config, save_config},
    metrics::{
        cooldown_snapshot, now_ms, persist_usage, push_log, usage_history_view,
        USAGE_RETENTION_DAYS,
    },
    opencode::{default_opencode_config_setting, sync_opencode},
    routing::{add_model_metadata, map_headers, string_field, subst},
    types::{AppState, ImageUsage, ProviderModelsRequest},
};

const INDEX_HTML: &str = include_str!("../../frontend/index.html");
const IMAGE_SKILL: &str = include_str!("../../../skills/image-generation/SKILL.md");

fn image_skill_path(state: &AppState) -> PathBuf {
    if let Some(path) = std::env::var_os("PP_OPENCODE_SKILLS_DIR") {
        return PathBuf::from(path).join("image-generation/SKILL.md");
    }
    dirs::config_dir()
        .unwrap_or_else(|| {
            state
                .config_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf()
        })
        .join("opencode/skills/image-generation/SKILL.md")
}

fn image_skill_status(state: &AppState) -> (PathBuf, bool, bool) {
    let path = image_skill_path(state);
    let installed = path.is_file();
    let same = installed
        && fs::read_to_string(&path)
            .map(|content| content == IMAGE_SKILL)
            .unwrap_or(false);
    (path, installed, same)
}

pub(crate) async fn index() -> impl IntoResponse {
    (
        [
            ("content-type", "text/html; charset=utf-8"),
            ("cache-control", "no-store, max-age=0"),
        ],
        INDEX_HTML,
    )
}

pub(crate) async fn ping() -> impl IntoResponse {
    Json(json!({ "ok": true, "apiVersion": 3 }))
}

pub(crate) async fn shutdown(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    push_log(&state, "shutdown requested from GUI");
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(100));
        std::process::exit(0);
    });
    (
        StatusCode::OK,
        [
            ("content-type", "application/json"),
            ("connection", "close"),
        ],
        Json(json!({ "ok": true, "stopping": true })),
    )
        .into_response()
}

pub(crate) async fn get_config(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let mut exposed = public_config(&state.config.read().unwrap());
    if exposed.get("opencodeConfig").is_none() {
        if let Some(object) = exposed.as_object_mut() {
            object.insert(
                "opencodeConfig".into(),
                Value::String(default_opencode_config_setting()),
            );
        }
    }
    Json(exposed).into_response()
}

pub(crate) async fn put_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    if !body.is_object() || !body.get("models").map(Value::is_object).unwrap_or(true) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "config must be an object with a models object",
        );
    }
    let previous = state.config.read().unwrap().clone();
    let merged = merge_config_secrets(&body, &previous);
    let old_port = previous.get("port").and_then(Value::as_u64).unwrap_or(8787) as u16;
    let new_chains = super::routing::build_chains(&merged);
    if let Err(err) = save_config(&state.storage, &merged) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    *state.config.write().unwrap() = merged.clone();
    *state.chains.write().unwrap() = new_chains.clone();
    push_log(
        &state,
        format!(
            "config updated via GUI: {} providers, {} models",
            merged
                .get("providers")
                .and_then(Value::as_object)
                .map(|v| v.len())
                .unwrap_or(0),
            new_chains.len()
        ),
    );
    let synced = sync_opencode(&state).await;
    Json(json!({
        "ok": true,
        "opencodeSynced": synced,
        "restartRequired": merged.get("port").and_then(Value::as_u64).unwrap_or(8787) as u16 != old_port
    }))
    .into_response()
}

pub(crate) async fn image_skill_get(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let (path, installed, same) = image_skill_status(&state);
    Json(json!({
        "path": path,
        "installed": installed,
        "same": same
    }))
    .into_response()
}

pub(crate) async fn image_skill_install(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let (path, installed, same) = image_skill_status(&state);
    let overwrite = body
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if installed && !same && !overwrite {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "skill already exists and differs from the bundled version",
                "path": path,
                "installed": installed,
                "same": same
            })),
        )
            .into_response();
    }
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
        }
    }
    if let Err(err) = fs::write(&path, IMAGE_SKILL) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    push_log(
        &state,
        format!(
            "skill: image-generation {} at {}",
            if same {
                "already installed"
            } else if installed {
                "updated"
            } else {
                "installed"
            },
            path.display()
        ),
    );
    let (_, installed, same) = image_skill_status(&state);
    Json(json!({
        "ok": true,
        "path": path,
        "installed": installed,
        "same": same
    }))
    .into_response()
}

pub(crate) async fn provider_models(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ProviderModelsRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let (base_url, api_key, provider_headers) = {
        let config = state.config.read().unwrap();
        let provider = body
            .provider
            .as_ref()
            .and_then(|name| config.get("providers").and_then(|v| v.get(name)));
        (
            provider
                .and_then(|v| string_field(v, "baseURL"))
                .or(body.base_url.clone())
                .unwrap_or_default(),
            provider
                .and_then(|v| string_field(v, "apiKey"))
                .or(body.api_key.clone())
                .unwrap_or_default(),
            provider
                .map(|v| map_headers(v.get("headers")))
                .unwrap_or_else(|| body.headers.clone().unwrap_or_default()),
        )
    };
    if base_url.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "provider has no baseURL");
    }
    let mut request = state
        .client
        .get(format!("{}/models", base_url.trim_end_matches('/')))
        .bearer_auth(subst(&api_key));
    for (key, value) in provider_headers {
        request = request.header(key, value);
    }
    let response = match request.timeout(Duration::from_secs(10)).send().await {
        Ok(response) => response,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    };
    let status = response.status();
    let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return json_error(StatusCode::BAD_GATEWAY, format!("HTTP {status}"));
    }
    let raw = data.get("data").or_else(|| data.get("models"));
    let mut models = Vec::new();
    let mut details = Map::new();
    match raw {
        Some(Value::Array(items)) => {
            for item in items {
                add_model_metadata(item, &mut models, &mut details);
            }
        }
        Some(Value::Object(items)) => {
            for (id, metadata) in items {
                let mut item = metadata.clone();
                if let Value::Object(object) = &mut item {
                    object.insert("id".into(), Value::String(id.to_string()));
                }
                add_model_metadata(&item, &mut models, &mut details);
            }
        }
        _ => {}
    }
    Json(json!({ "models": models, "details": details })).into_response()
}

pub(crate) async fn image_task_create(State(state): State<AppState>, request: Request) -> Response {
    let headers = request.headers().clone();
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    const IMAGE_BODY_LIMIT: usize = 64 * 1024 * 1024;
    let declared_length = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    let bytes = match to_bytes(request.into_body(), IMAGE_BODY_LIMIT).await {
        Ok(bytes) => bytes,
        Err(err) => {
            push_log(&state, format!("image request rejected before parse: HTTP 413, declaredBytes={declared_length}, body exceeds {} bytes: {err}", IMAGE_BODY_LIMIT));
            return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": { "message": format!("image request body exceeds {} bytes", IMAGE_BODY_LIMIT), "code": "payload_too_large" }, "status": 413, "declaredBytes": declared_length, "suggestedModels": image_model_suggestions(&state, "") }))).into_response();
        }
    };
    let request_bytes = bytes.len();
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(err) => {
            push_log(
                &state,
                format!(
                    "image request rejected: HTTP 400, invalid JSON, {request_bytes} bytes: {err}"
                ),
            );
            return json_error(StatusCode::BAD_REQUEST, "invalid JSON body");
        }
    };
    let provider_name = body
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (base_url, api_key, provider_headers) = {
        let config = state.config.read().unwrap();
        let provider = config.get("providers").and_then(|v| v.get(provider_name));
        (
            provider
                .and_then(|v| string_field(v, "baseURL"))
                .unwrap_or_default(),
            provider
                .and_then(|v| string_field(v, "apiKey"))
                .unwrap_or_default(),
            provider
                .map(|v| map_headers(v.get("headers")))
                .unwrap_or_default(),
        )
    };
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let prompt = body
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if base_url.is_empty() || model.is_empty() || prompt.trim().is_empty() {
        push_log(
            &state,
            format!(
                "image request {provider_name}/{model} → HTTP 400: provider, model and prompt are required"
            ),
        );
        return json_error(
            StatusCode::BAD_REQUEST,
            "provider, model and prompt are required",
        );
    }
    let edit = body
        .get("image")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    push_log(
        &state,
        format!(
            "image request {provider_name}/{model}: {request_bytes} bytes, mode={}, promptChars={}{}",
            if edit { "edit" } else { "generate" },
            prompt.trim().chars().count(),
            body.get("image").and_then(Value::as_str).map(|value| format!(", referenceChars={}", value.len())).unwrap_or_default()
        ),
    );
    let image_key = format!("{provider_name}/{model}");
    let now = Local::now().to_rfc3339();
    let edit = body
        .get("image")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    {
        let mut usage = state.usage.lock().unwrap();
        let stat = usage
            .images
            .entry(image_key.clone())
            .or_insert_with(|| ImageUsage {
                provider: provider_name.to_string(),
                model: model.to_string(),
                ..Default::default()
            });
        stat.requests += 1;
        stat.last_used_at = Some(now.clone());
        stat.last_mode = Some(if edit { "edit" } else { "generate" }.to_string());
        if edit {
            stat.last_edit_at = Some(now.clone());
        }
        usage.last_image_model = Some(
            json!({ "provider": provider_name, "model": model, "mode": if edit { "edit" } else { "generate" }, "at": now }),
        );
        if edit {
            usage.last_edit_image_model = Some(
                json!({ "provider": provider_name, "model": model, "at": Local::now().to_rfc3339() }),
            );
        }
        usage.recent_images.push(json!({ "provider": provider_name, "model": model, "mode": if edit { "edit" } else { "generate" }, "status": "pending", "at": Local::now().to_rfc3339() }));
        if usage.recent_images.len() > 30 {
            let remove = usage.recent_images.len() - 30;
            usage.recent_images.drain(0..remove);
        }
    }
    let mut payload = serde_json::Map::new();
    payload.insert("model".into(), Value::String(model.to_string()));
    payload.insert("prompt".into(), Value::String(prompt.trim().to_string()));
    for key in ["ratio", "size", "image"] {
        if let Some(value) = body.get(key).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                payload.insert(key.into(), Value::String(value.trim().to_string()));
            }
        }
    }
    let endpoint = {
        let config = state.config.read().unwrap();
        let endpoints = config
            .get("providers")
            .and_then(|providers| providers.get(provider_name))
            .and_then(|provider| provider.get("modelInfo"))
            .and_then(|models| models.get(model))
            .and_then(|metadata| metadata.get("endpoints"));
        if contains_endpoint(endpoints, "images/generations") {
            "images/generations"
        } else {
            "images/tasks"
        }
    };
    let candidates = if endpoint == "images/generations" {
        ["images/generations", "images/tasks"]
    } else {
        ["images/tasks", "images/generations"]
    };
    let mut selected_endpoint = candidates[0];
    let mut response = None;
    let mut data = json!({});
    for candidate in candidates {
        selected_endpoint = candidate;
        let mut request = state
            .client
            .post(format!("{}/{candidate}", base_url.trim_end_matches('/')))
            .bearer_auth(subst(&api_key))
            .json(&Value::Object(payload.clone()));
        for (key, value) in &provider_headers {
            request = request.header(key, value);
        }
        let candidate_response = match request.send().await {
            Ok(response) => response,
            Err(err) => {
                if let Some(stat) = state.usage.lock().unwrap().images.get_mut(&image_key) {
                    stat.errors += 1;
                    stat.last_status = StatusCode::BAD_GATEWAY.as_u16();
                }
                push_log(
                    &state,
                    format!("image {selected_endpoint} {provider_name}/{model} → HTTP 502: {err}; requestBytes={request_bytes}; suggested={}", image_model_suggestions(&state, &format!("{provider_name}/{model}")).join(",")),
                );
                if let Some(item) = state
                    .usage
                    .lock()
                    .unwrap()
                    .recent_images
                    .iter_mut()
                    .rev()
                    .find(|item| {
                        item.get("provider").and_then(Value::as_str) == Some(provider_name)
                            && item.get("model").and_then(Value::as_str) == Some(model)
                            && item.get("status").and_then(Value::as_str) == Some("pending")
                    })
                {
                    item["status"] = Value::String("failed".into());
                    item["endpoint"] = Value::String(selected_endpoint.into());
                }
                let suggestions =
                    image_model_suggestions(&state, &format!("{provider_name}/{model}"));
                return (StatusCode::BAD_GATEWAY, Json(json!({ "error": { "message": err.to_string() }, "status": 502, "provider": provider_name, "model": model, "endpoint": selected_endpoint, "requestBytes": request_bytes, "suggestedModels": suggestions }))).into_response();
            }
        };
        let status = candidate_response.status();
        data = candidate_response
            .json()
            .await
            .unwrap_or_else(|_| json!({}));
        if status != StatusCode::NOT_FOUND || candidate == candidates[1] {
            response = Some(status);
            break;
        }
    }
    let status = response.unwrap_or(StatusCode::BAD_GATEWAY);
    if status.is_success() {
        let mut result = data;
        let task_id = result
            .get("task_id")
            .or_else(|| result.get("taskId"))
            .or_else(|| result.get("id"))
            .or_else(|| result.get("data").and_then(|data| data.get("task_id")))
            .or_else(|| result.get("data").and_then(|data| data.get("taskId")))
            .or_else(|| result.get("data").and_then(|data| data.get("id")))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if let Value::Object(object) = &mut result {
            object.insert(
                "_providerEndpoint".into(),
                Value::String(selected_endpoint.into()),
            );
        }
        {
            let mut usage = state.usage.lock().unwrap();
            let stat = usage
                .images
                .get_mut(&image_key)
                .expect("image stat created");
            stat.last_status = status.as_u16();
            if selected_endpoint == "images/generations" {
                stat.ok += 1;
                usage.images_generated += 1;
            }
        }
        if let Some(item) = state
            .usage
            .lock()
            .unwrap()
            .recent_images
            .iter_mut()
            .rev()
            .find(|item| {
                item.get("provider").and_then(Value::as_str) == Some(provider_name)
                    && item.get("model").and_then(Value::as_str) == Some(model)
                    && item.get("status").and_then(Value::as_str) == Some("pending")
            })
        {
            if task_id.is_none() {
                item["status"] = Value::String("succeeded".into());
                item["endpoint"] = Value::String(selected_endpoint.into());
            }
        }
        if let Some(task_id) = task_id {
            state
                .image_tasks
                .lock()
                .unwrap()
                .insert(format!("{provider_name}/{task_id}"), image_key.clone());
        }
        push_log(
            &state,
            format!("image {selected_endpoint} {provider_name}/{model} → HTTP {status}"),
        );
        Json(result).into_response()
    } else {
        let message = data
            .get("error")
            .and_then(|error| error.get("message").or(Some(error)))
            .and_then(Value::as_str)
            .or_else(|| data.get("detail").and_then(Value::as_str))
            .unwrap_or("image provider request failed");
        let suggestions = image_model_suggestions(&state, &format!("{provider_name}/{model}"));
        push_log(
            &state,
            format!("image {selected_endpoint} {provider_name}/{model} → HTTP {status}: {message}; requestBytes={request_bytes}; suggested={}", suggestions.join(",")),
        );
        if let Some(stat) = state.usage.lock().unwrap().images.get_mut(&image_key) {
            stat.errors += 1;
            stat.last_status = status.as_u16();
        }
        if let Some(item) = state
            .usage
            .lock()
            .unwrap()
            .recent_images
            .iter_mut()
            .rev()
            .find(|item| {
                item.get("provider").and_then(Value::as_str) == Some(provider_name)
                    && item.get("model").and_then(Value::as_str) == Some(model)
                    && item.get("status").and_then(Value::as_str) == Some("pending")
            })
        {
            item["status"] = Value::String("failed".into());
            item["endpoint"] = Value::String(selected_endpoint.into());
        }
        let mut response = json!({ "error": { "message": format!("HTTP {status}: {message}") }, "status": status.as_u16(), "provider": provider_name, "model": model, "endpoint": selected_endpoint, "requestBytes": request_bytes, "suggestedModels": suggestions });
        if status == StatusCode::PAYLOAD_TOO_LARGE {
            response["error"] = json!({ "message": format!("image request body is too large ({request_bytes} bytes)"), "code": "payload_too_large" });
        }
        let client_status = if status == StatusCode::PAYLOAD_TOO_LARGE {
            StatusCode::PAYLOAD_TOO_LARGE
        } else {
            StatusCode::BAD_GATEWAY
        };
        (client_status, Json(response)).into_response()
    }
}

fn image_model_suggestions(state: &AppState, exclude: &str) -> Vec<String> {
    let config = state.config.read().unwrap();
    let providers = config.get("providers").and_then(Value::as_object);
    let mut out = Vec::new();
    for (provider_name, provider) in providers.into_iter().flatten() {
        let mut ids = Vec::new();
        if let Some(models) = provider.get("models").and_then(Value::as_array) {
            ids.extend(
                models
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned),
            );
        }
        ids.sort();
        ids.dedup();
        for model in ids {
            let metadata = provider.get("modelInfo").and_then(|v| v.get(&model));
            let image = metadata
                .and_then(|v| v.get("image"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || metadata
                    .and_then(|v| v.get("type"))
                    .and_then(Value::as_str)
                    .is_some_and(|v| v.eq_ignore_ascii_case("image"))
                || contains_endpoint(
                    metadata.and_then(|v| v.get("endpoints")),
                    "images/generations",
                )
                || contains_endpoint(metadata.and_then(|v| v.get("endpoints")), "images/tasks")
                || model.to_ascii_lowercase().contains("image");
            if image && format!("{provider_name}/{model}") != exclude {
                out.push(format!("{provider_name}/{model}"));
            }
        }
    }
    out.truncate(8);
    out
}

fn contains_endpoint(value: Option<&Value>, needle: &str) -> bool {
    match value {
        Some(Value::String(value)) => {
            value.eq_ignore_ascii_case(needle) || value.to_ascii_lowercase().contains(needle)
        }
        Some(Value::Array(values)) => values
            .iter()
            .any(|value| contains_endpoint(Some(value), needle)),
        Some(Value::Object(values)) => values
            .values()
            .any(|value| contains_endpoint(Some(value), needle)),
        _ => false,
    }
}

pub(crate) async fn image_task_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((provider_name, task_id)): Path<(String, String)>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let (base_url, api_key, provider_headers) = {
        let config = state.config.read().unwrap();
        let provider = config.get("providers").and_then(|v| v.get(&provider_name));
        (
            provider
                .and_then(|v| string_field(v, "baseURL"))
                .unwrap_or_default(),
            provider
                .and_then(|v| string_field(v, "apiKey"))
                .unwrap_or_default(),
            provider
                .map(|v| map_headers(v.get("headers")))
                .unwrap_or_default(),
        )
    };
    if base_url.is_empty() || task_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "provider and taskId are required");
    }
    let mut request = state
        .client
        .get(format!(
            "{}/images/tasks/{}",
            base_url.trim_end_matches('/'),
            task_id
        ))
        .bearer_auth(subst(&api_key));
    for (key, value) in provider_headers {
        request = request.header(key, value);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(err) => return json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    };
    let status = response.status();
    let data: Value = response.json().await.unwrap_or_else(|_| json!({}));
    let image_key = state
        .image_tasks
        .lock()
        .unwrap()
        .get(&format!("{provider_name}/{task_id}"))
        .cloned();
    let task_status = data
        .get("status")
        .or_else(|| data.get("result").and_then(|value| value.get("status")))
        .or_else(|| data.get("data").and_then(|value| value.get("status")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if let Some(image_key) = image_key {
        let terminal_ok = ["completed", "complete", "success", "succeeded", "done"]
            .contains(&task_status.as_str());
        let terminal_error =
            ["failed", "error", "cancelled", "canceled"].contains(&task_status.as_str());
        if terminal_ok || terminal_error || !status.is_success() {
            let mut usage = state.usage.lock().unwrap();
            if let Some(stat) = usage.images.get_mut(&image_key) {
                if terminal_ok {
                    stat.ok += 1;
                } else {
                    stat.errors += 1;
                }
                stat.last_status = status.as_u16();
            }
            if terminal_ok {
                usage.images_generated += 1;
            }
            let final_status = if terminal_ok { "succeeded" } else { "failed" };
            let model_name = image_key
                .split_once('/')
                .map(|(_, model)| model)
                .unwrap_or_default();
            if let Some(item) = usage.recent_images.iter_mut().rev().find(|item| {
                item.get("provider").and_then(Value::as_str) == Some(provider_name.as_str())
                    && item.get("model").and_then(Value::as_str) == Some(model_name)
                    && item.get("status").and_then(Value::as_str) == Some("pending")
            }) {
                item["status"] = Value::String(final_status.into());
                item["endpoint"] = Value::String("images/tasks".into());
            }
            state
                .image_tasks
                .lock()
                .unwrap()
                .remove(&format!("{provider_name}/{task_id}"));
        }
    }
    push_log(
        &state,
        format!(
            "image tasks/{task_id} {provider_name} → HTTP {status}{}{}",
            if task_status.is_empty() { "" } else { " (" },
            if task_status.is_empty() {
                String::new()
            } else {
                format!("{task_status})")
            }
        ),
    );
    if status.is_success() {
        Json(data).into_response()
    } else {
        json_error(StatusCode::BAD_GATEWAY, format!("HTTP {status}: {data}"))
    }
}

pub(crate) async fn v1_models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let chains = state.chains.read().unwrap();
    push_log(&state, format!("GET /v1/models → {} моделей", chains.len()));
    let data: Vec<Value> = chains
        .keys()
        .map(|id| json!({ "id": id, "object": "model", "owned_by": "provider_proxy" }))
        .collect();
    Json(json!({ "object": "list", "data": data })).into_response()
}

pub(crate) async fn get_logs(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let lines: Vec<String> = state
        .logs
        .lock()
        .unwrap()
        .iter()
        .filter(|line| !line.contains("gui:"))
        .cloned()
        .collect();
    Json(json!({ "lines": lines, "max": state.log_max })).into_response()
}

pub(crate) async fn get_usage(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
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
        .map(|providers| {
            providers
                .values()
                .filter(|v| v.get("enabled").and_then(Value::as_bool) != Some(false))
                .map(|v| {
                    v.get("models")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0)
                })
                .sum::<usize>()
        })
        .unwrap_or(0);
    Json(json!({ "ok": ok, "models": chains + direct })).into_response()
}

pub(super) fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message.into() } })),
    )
        .into_response()
}
