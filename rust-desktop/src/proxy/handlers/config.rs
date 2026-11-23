use super::*;

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
    if let Some(object) = exposed.as_object_mut() {
        // The GUI must tell a saved override from the effective default, which
        // depends on whether opencode.jsonc or opencode.json exists on disk.
        object.insert(
            "opencodeConfigDefault".into(),
            Value::String(default_opencode_config_setting()),
        );
        object.insert(
            "appVersion".into(),
            Value::String(env!("CARGO_PKG_VERSION").into()),
        );
    }
    Json(exposed).into_response()
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
pub(crate) struct ExportOptions {
    #[serde(default = "default_true")]
    keys: bool,
    #[serde(default = "default_true")]
    chains: bool,
    #[serde(default = "default_true")]
    models: bool,
}

pub(crate) async fn export_config_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(options): Query<ExportOptions>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let exported = export_config(
        &state.config.read().unwrap(),
        options.keys,
        options.chains,
        options.models,
    );
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"provider-proxy-config.json\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Json(exported),
    )
        .into_response()
}

fn validate_imported_config(value: &Value) -> Result<(), &'static str> {
    if !value.is_object() {
        return Err("config must be an object");
    }
    for key in ["providers", "models", "opencodeModels"] {
        if value.get(key).is_some_and(|item| !item.is_object()) {
            return Err(match key {
                "providers" => "providers must be an object",
                "models" => "models must be an object",
                _ => "opencodeModels must be an object",
            });
        }
    }
    Ok(())
}

pub(crate) async fn import_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let imported = body
        .get("config")
        .filter(|value| value.is_object())
        .unwrap_or(&body);
    if let Err(error) = validate_imported_config(imported) {
        return json_error(StatusCode::BAD_REQUEST, error);
    }
    let previous = state.config.read().unwrap().clone();
    let merged = merge_imported_config(imported, &previous);
    let old_port = previous.get("port").and_then(Value::as_u64).unwrap_or(8787) as u16;
    let new_chains = super::super::routing::build_chains(&merged);
    if let Err(error) = save_config(&state.storage, &merged) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error);
    }
    *state.config.write().unwrap() = merged.clone();
    *state.chains.write().unwrap() = new_chains.clone();
    push_log(
        &state,
        format!(
            "config imported: {} providers, {} models",
            merged
                .get("providers")
                .and_then(Value::as_object)
                .map(|value| value.len())
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
    let new_chains = super::super::routing::build_chains(&merged);
    if let Err(err) = save_config(&state.storage, &merged) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    *state.config.write().unwrap() = merged.clone();
    *state.chains.write().unwrap() = new_chains.clone();
    // The GUI saves on every edit, so an unchanged config is common. Logging it
    // each time filled the log with noise and hid real changes.
    if merged != previous {
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
    }
    let synced = sync_opencode(&state).await;
    Json(json!({
        "ok": true,
        "opencodeSynced": synced,
        "restartRequired": merged.get("port").and_then(Value::as_u64).unwrap_or(8787) as u16 != old_port
    }))
    .into_response()
}
