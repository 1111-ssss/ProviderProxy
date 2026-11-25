use super::*;

const IMAGE_SKILL: &str = include_str!("../../../../skills/image-generation/SKILL.md");

fn skills_dir(state: &AppState) -> PathBuf {
    if let Some(path) = std::env::var_os("PP_OPENCODE_SKILLS_DIR") {
        return PathBuf::from(path);
    }
    dirs::config_dir()
        .unwrap_or_else(|| {
            state
                .config_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf()
        })
        .join("opencode/skills")
}

fn image_skill_path(state: &AppState) -> PathBuf {
    skills_dir(state).join("image-generation/SKILL.md")
}

/// Minimal frontmatter reader: OpenCode only needs `name` and `description` as
/// top-level keys, so a YAML dependency would be more than this list needs.
pub(crate) fn skill_frontmatter(content: &str, folder: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (folder.to_string(), String::new());
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        // Keys a description may wrap onto its own line are ignored.
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        match key.trim() {
            "name" if !value.is_empty() => name = value.to_string(),
            "description" if !value.is_empty() => description = value.to_string(),
            _ => {}
        }
    }
    (
        if name.is_empty() {
            folder.to_string()
        } else {
            name
        },
        description,
    )
}

/// Every skill folder under `root` that has a readable `SKILL.md`, sorted by
/// name. Kept path-in, path-out so a test can point it at a temp folder.
pub(crate) fn list_skills(root: &std::path::Path) -> Vec<Value> {
    let mut skills = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return skills;
    };
    for entry in entries.flatten() {
        let folder = entry.file_name().to_string_lossy().to_string();
        if folder.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        let path = entry.path().join("SKILL.md");
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let (name, description) = skill_frontmatter(&content, &folder);
        skills.push(json!({
            "folder": folder,
            "name": name,
            "description": description,
            "path": path,
            "bundled": folder == "image-generation",
        }));
    }
    skills.sort_by(|a, b| {
        let key = |v: &Value| v["name"].as_str().unwrap_or("").to_lowercase();
        key(a).cmp(&key(b))
    });
    skills
}

pub(crate) async fn skills_get(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let root = skills_dir(&state);
    Json(json!({ "root": root, "skills": list_skills(&root) })).into_response()
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

/// Task ids only leave the map when the GUI polls a terminal status. A tab that
/// closes mid-task would keep its entry forever, so a new task prunes entries
/// older than the TTL and the map is capped by dropping the oldest ones.
const IMAGE_TASK_TTL: Duration = Duration::from_secs(6 * 60 * 60);
pub(crate) const IMAGE_TASK_MAX: usize = 256;

pub(crate) fn prune_image_tasks(
    tasks: &mut HashMap<String, (String, Instant)>,
    now: Instant,
) {
    tasks.retain(|_, (_, created)| now.duration_since(*created) < IMAGE_TASK_TTL);
    while tasks.len() > IMAGE_TASK_MAX {
        let oldest = tasks
            .iter()
            .min_by_key(|(_, (_, created))| *created)
            .map(|(key, _)| key.clone());
        match oldest {
            Some(key) => tasks.remove(&key),
            None => break,
        };
    }
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
            // The stat is created above, but the day can roll over while the
            // upstream request is in flight, which drops it. A missing row must
            // not panic the handler.
            if let Some(stat) = usage.images.get_mut(&image_key) {
                stat.last_status = status.as_u16();
                if selected_endpoint == "images/generations" {
                    stat.ok += 1;
                    usage.images_generated += 1;
                    state.lifetime.lock().unwrap().images_generated += 1;
                }
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
            let mut tasks = state.image_tasks.lock().unwrap();
            prune_image_tasks(&mut tasks, Instant::now());
            tasks.insert(
                format!("{provider_name}/{task_id}"),
                (image_key.clone(), Instant::now()),
            );
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
            // `image` is also written for auto-detected models, so chat endpoints
            // in the provider's catalog override it, same rule as routing.rs.
            let has_endpoints = metadata.and_then(|v| v.get("endpoints")).is_some();
            let image = (metadata
                .and_then(|v| v.get("image"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && !has_endpoints)
                || metadata
                    .and_then(|v| v.get("type"))
                    .and_then(Value::as_str)
                    .is_some_and(|v| v.eq_ignore_ascii_case("image"))
                || contains_endpoint(
                    metadata.and_then(|v| v.get("endpoints")),
                    "images/generations",
                )
                || contains_endpoint(metadata.and_then(|v| v.get("endpoints")), "images/tasks")
                || contains_endpoint(metadata.and_then(|v| v.get("endpoints")), "images/edits")
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
        .map(|(image_key, _)| image_key.clone());
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
                state.lifetime.lock().unwrap().images_generated += 1;
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
