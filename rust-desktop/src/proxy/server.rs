use axum::{
    extract::DefaultBodyLimit,
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
    chat,
    config::{load_config, open_storage, LOG_MAX_DEFAULT},
    handlers,
    metrics::{load_usage, push_log},
    routing::build_chains,
    types::{AppState, ServerHandle},
};

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
    let log_max = std::env::var("PP_LOG_LINES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(LOG_MAX_DEFAULT);
    let legacy_stats_path = std::env::var_os("PP_STATS_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            config_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("usage-stats.json")
        });
    let (usage, usage_history, usage_day) = load_usage(&storage, &legacy_stats_path);
    let state = AppState {
        config_path: Arc::new(config_path),
        storage,
        config,
        chains,
        cooldowns: Arc::new(Mutex::new(HashMap::new())),
        logs: Arc::new(Mutex::new(std::collections::VecDeque::with_capacity(
            log_max,
        ))),
        usage: Arc::new(Mutex::new(usage)),
        usage_history: Arc::new(Mutex::new(usage_history)),
        usage_day: Arc::new(Mutex::new(usage_day)),
        image_tasks: Arc::new(Mutex::new(HashMap::new())),
        client: Client::builder().build()?,
        port,
        log_max,
    };
    push_log(
        &state,
        format!("provider_proxy Rust on http://127.0.0.1:{port}/v1 — desktop GUI"),
    );
    let persistence_state = state.clone();
    std::thread::Builder::new()
        .name("provider-proxy-usage".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            super::metrics::persist_usage(&persistence_state);
        })?;

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    let actual_port = listener.local_addr()?.port();
    let app = router(state);
    std::thread::Builder::new()
        .name("provider-proxy-http".into())
        .spawn(move || {
            let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
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

fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(handlers::index))
        .route("/index.html", get(handlers::index))
        .route("/api/ping", get(handlers::ping))
        .route("/api/shutdown", post(handlers::shutdown))
        .route(
            "/api/config",
            get(handlers::get_config).put(handlers::put_config),
        )
        .route(
            "/api/skills/image-generation",
            get(handlers::image_skill_get).post(handlers::image_skill_install),
        )
        .route("/api/provider-models", post(handlers::provider_models))
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
