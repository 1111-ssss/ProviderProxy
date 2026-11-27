use axum::{
    body::to_bytes,
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Local;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use super::{
    assets,
    auth::authorized,
    config::{
        export_config, merge_config_secrets, merge_imported_config, public_config, save_config,
    },
    metrics::{
        cooldown_snapshot, log_count, log_page, now_ms, persist_usage, push_log,
        uptime_snapshot, usage_history_view, USAGE_RETENTION_DAYS,
    },
    opencode::{default_opencode_config_setting, sync_opencode},
    routing::{add_model_metadata, direct_model_ids, map_headers, string_field, subst},
    types::{AppState, ImageUsage, ProviderModelsRequest},
};

mod config;
mod images;
mod observe;
mod uptime;

pub(crate) use config::*;
pub(crate) use images::*;
pub(crate) use observe::*;
pub(crate) use uptime::*;

pub(crate) async fn index() -> impl IntoResponse {
    assets::serve("/")
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

pub(super) fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message.into() } })),
    )
        .into_response()
}
