use axum::{
    extract::DefaultBodyLimit,
    response::Response,
    routing::{get, post},
    Router,
};
use reqwest::Client;
use std::{
    collections::HashMap,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
};
use tokio::net::TcpListener as TokioTcpListener;

use super::{
    assets,
    chat,
    config::{load_config, open_storage},
    handlers,
    metrics::{load_lifetime, load_usage, push_log},
    routing::build_chains,
    types::{AppState, ServerHandle},
};

/// A second launch must take over from the copy that already holds the port.
///
/// Asks that instance to exit through its own `/api/shutdown` (the only way to
/// stop it without guessing a PID) and waits for the port to come free. Only
/// shuts down something that answers our own `/api/ping` signature, so an
/// unrelated service on the same port is never touched. Returns true when the
/// port is free afterwards (or nothing was listening), false when a copy is
/// still holding it.
pub fn shutdown_running_instance(config_path: &PathBuf) -> bool {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    fn exchange(port: u16, request: &str) -> Option<String> {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = String::new();
        stream.read_to_string(&mut response).ok()?;
        Some(response)
    }

    // The port comes from the config; when it cannot be read, fall back to the
    // default so a broken database still cannot leave a stale process behind.
    let (port, token) = configured_endpoint(config_path).unwrap_or((8787, String::new()));
    // Never shut down something that is not us: another program on the port
    // would answer ping differently (or not at all).
    let ping = exchange(
        port,
        "GET /api/ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    if !ping.as_deref().is_some_and(|r| r.contains("apiVersion")) {
        return false;
    }
    let auth = if token.is_empty() {
        String::new()
    } else {
        format!("Authorization: Bearer {token}\r\n")
    };
    let _ = exchange(
        port,
        &format!(
            "POST /api/shutdown HTTP/1.1\r\nHost: localhost\r\n{auth}Connection: close\r\nContent-Length: 0\r\n\r\n"
        ),
    );
    // Wait for the outgoing process to release the port. It writes its usage
    // counters while shutting down, so the wait is generously bounded.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// The port and token the configuration names, read without starting the server.
pub(super) fn configured_endpoint(config_path: &PathBuf) -> Option<(u16, String)> {
    let storage = open_storage(config_path).ok()?;
    let config = load_config(&storage, &config_path.with_extension("json")).ok()?;
    // Release the database before the caller waits: the outgoing process still
    // writes its usage counters while it shuts down.
    drop(storage);
    let port = config
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(8787) as u16;
    let token = config
        .get("authToken")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    Some((port, token))
}

pub fn start_server(
    config_path: PathBuf,
) -> Result<ServerHandle, Box<dyn std::error::Error + Send + Sync>> {
    let storage = Arc::new(open_storage(&config_path)?);
    let legacy_config_path = if config_path.extension().is_some_and(|extension| extension == "db") {
        config_path.with_extension("json")
    } else {
        config_path.clone()
    };
    let raw = load_config(&storage, &legacy_config_path)?;
    let config = Arc::new(RwLock::new(raw.clone()));
    let chains = Arc::new(RwLock::new(build_chains(&raw)));
    let port = raw
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(8787) as u16;
    // Bind before the state is built: with `port: 0` the kernel picks a free
    // port, and everything downstream (the uptime script's own URL, the
    // opencode config) must use the port that is really listening.
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    let actual_port = listener.local_addr()?.port();
    let legacy_stats_path = std::env::var_os("PP_STATS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            config_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("usage-stats.json")
        });
    let (usage, usage_history, usage_day) = load_usage(&storage, &legacy_stats_path);
    let lifetime = load_lifetime(&storage);
    let state = AppState {
        config_path: Arc::new(config_path),
        storage,
        config,
        chains,
        cooldowns: Arc::new(Mutex::new(HashMap::new())),
        usage: Arc::new(Mutex::new(usage)),
        usage_history: Arc::new(Mutex::new(usage_history)),
        usage_persisted: Arc::new(Mutex::new(HashMap::new())),
        usage_day: Arc::new(Mutex::new(usage_day)),
        lifetime: Arc::new(Mutex::new(lifetime)),
        lifetime_persisted: Arc::new(Mutex::new(None)),
        image_tasks: Arc::new(Mutex::new(HashMap::new())),
        // Streaming responses must not have a total request timeout: the
        // upstream may spend a long time producing the first token and then
        // continue sending a large completion. The chat handler applies the
        // configured timeout only while waiting for response headers.
        client: Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .pool_max_idle_per_host(32)
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()?,
        port: actual_port,
    };
    push_log(
        &state,
        format!("provider_proxy Rust on http://127.0.0.1:{actual_port}/v1 — desktop GUI"),
    );
    let persistence_state = state.clone();
    std::thread::Builder::new()
        .name("provider-proxy-usage".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            super::metrics::persist_usage(&persistence_state);
            super::metrics::persist_lifetime(&persistence_state);
        })?;

    let app = router(state);
    std::thread::Builder::new()
        .name("provider-proxy-http".into())
        .spawn(move || {
            // Keep HTTP handlers and upstream streams on a multi-thread Tokio
            // runtime. They are already asynchronous, but making this
            // explicit prevents a one-core/one-worker launch from turning
            // unrelated requests into a serial queue.
            let workers = std::thread::available_parallelism()
                .map(|count| count.get().max(2))
                .unwrap_or(2);
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(workers)
                .enable_all()
                .build()
                .expect("tokio runtime");
            runtime.block_on(async move {
                let tokio_listener = match TokioTcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(err) => {
                        eprintln!(
                            "provider_proxy Rust HTTP server could not adopt listener: {err}"
                        );
                        return;
                    }
                };
                if let Err(err) = axum::serve(tokio_listener, app).await {
                    eprintln!("provider_proxy Rust HTTP server stopped: {err}");
                }
            });
        })?;
    Ok(ServerHandle { port: actual_port })
}

/// Serve an embedded stylesheet or script by its file name. The directory is in
/// the route, so each handler rebuilds the full request path for `assets::serve`.
async fn css_asset(axum::extract::Path(file): axum::extract::Path<String>) -> Response {
    assets::serve(&format!("/css/{file}"))
}

async fn js_asset(axum::extract::Path(file): axum::extract::Path<String>) -> Response {
    assets::serve(&format!("/js/{file}"))
}

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(handlers::index))
        .route("/index.html", get(handlers::index))
        .route("/css/{file}", get(css_asset))
        .route("/js/{file}", get(js_asset))
        .route("/api/ping", get(handlers::ping))
        .route("/api/shutdown", post(handlers::shutdown))
        .route(
            "/api/config",
            get(handlers::get_config).put(handlers::put_config),
        )
        .route("/api/config/export", get(handlers::export_config_handler))
        .route("/api/config/import", post(handlers::import_config))
        .route(
            "/api/skills",
            get(handlers::skills_get),
        )
        .route(
            "/api/skills/image-generation",
            get(handlers::image_skill_get).post(handlers::image_skill_install),
        )
        .route("/api/provider-models", post(handlers::provider_models))
        .route(
            "/api/provider-models-list",
            get(handlers::provider_models_list),
        )
        .route("/api/uptime/run", post(handlers::run_uptime))
        .route("/api/image-tasks", post(handlers::image_task_create))
        .route(
            "/api/image-tasks/{provider}/{task_id}",
            get(handlers::image_task_get),
        )
        .route("/api/opencode-sync", post(handlers::opencode_sync))
        .route("/api/logs", get(handlers::get_logs))
        .route("/api/usage", get(handlers::get_usage))
        .route("/v1/models", get(handlers::v1_models))
        .route("/v1/chat/completions", post(chat::chat_completions))
        // OpenCode can include a large conversation/tool payload in an image
        // request. Axum's default JSON extractor limit is 2 MiB, which turns
        // into a vague HTTP 413 before our handlers can return a useful error.
        // Keep one explicit, bounded limit for all local API routes.
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(state)
}
