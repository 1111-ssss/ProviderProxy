use axum::http::HeaderMap;
use serde_json::Value;

use super::types::AppState;

pub(super) fn sensitive_header(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("authorization")
        || key.contains("api-key")
        || key.contains("token")
        || key.contains("secret")
}

pub(super) fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let config = state.config.read().unwrap();
    let token = config
        .get("authToken")
        .and_then(Value::as_str)
        .unwrap_or_default();
    token.is_empty()
        || headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == format!("Bearer {token}"))
            .unwrap_or(false)
}
