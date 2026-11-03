//! Black-box checks for the library's public HTTP interface. All providers and
//! configuration files are local test fixtures; no live accounts are used.
use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use provider_proxy_desktop::proxy::start_server;
use reqwest::Client;
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

struct TestProxy {
    directory: PathBuf,
    base_url: String,
    client: Client,
}

impl TestProxy {
    async fn start(mut config: Value) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "provider-proxy-http-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir(&directory).unwrap();
        config["port"] = json!(0);
        config["opencodeConfig"] = json!(directory.join("opencode.json"));
        fs::write(directory.join("config.json"), config.to_string()).unwrap();
        let server = start_server(directory.join("config.json")).unwrap();
        let proxy = Self {
            directory,
            base_url: format!("http://127.0.0.1:{}", server.port),
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
        };
        for _ in 0..100 {
            if let Ok(response) = proxy.client.get(proxy.url("/api/ping")).send().await {
                if response.status().is_success() {
                    return proxy;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("test proxy did not become ready");
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    async fn usage(&self) -> Value {
        self.client
            .get(self.url("/api/usage"))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap()
    }
}

impl Drop for TestProxy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

struct MockProvider {
    base_url: String,
    task: tokio::task::JoinHandle<()>,
}

impl MockProvider {
    async fn start(app: Router) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base_url: format!("http://{address}/v1"),
            task,
        }
    }
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn protects_api_and_redacts_config_but_serves_the_gui() {
    let proxy = TestProxy::start(json!({
        "authToken": "test-token",
        "providers": {
            "one": {
                "baseURL": "http://127.0.0.1:1/v1",
                "apiKey": "fixture-key",
                "headers": {"Authorization": "fixture-header", "x-region": "local"}
            }
        },
        "models": {}
    }))
    .await;

    for path in ["/api/config", "/api/logs", "/api/usage", "/v1/models"] {
        for token in [None, Some("wrong-token")] {
            let mut request = proxy.client.get(proxy.url(path));
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            let response = request.send().await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            let body: Value = response.json().await.unwrap();
            assert_eq!(body["error"]["message"], "bad proxy token");
        }
    }

    for path in ["/", "/index.html"] {
        let response = proxy.client.get(proxy.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store, max-age=0");
        assert!(response.text().await.unwrap().contains("<html"));
    }
    let config: Value = proxy
        .client
        .get(proxy.url("/api/config"))
        .bearer_auth("test-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(config["authToken"], "");
    assert_eq!(config["authTokenConfigured"], true);
    assert_eq!(config["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(config["providers"]["one"]["apiKey"], "");
    assert_eq!(config["providers"]["one"]["apiKeyConfigured"], true);
    assert!(config["providers"]["one"]["headers"]
        .get("Authorization")
        .is_none());
    assert_eq!(config["providers"]["one"]["headers"]["x-region"], "local");
}

#[tokio::test]
async fn fails_over_and_skips_a_provider_during_its_cooldown() {
    let limited_requests = Arc::new(AtomicUsize::new(0));
    let counter = limited_requests.clone();
    let limited = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "60")])
            }
        }),
    ))
    .await;
    let available = MockProvider::start(
        Router::new()
            .route(
                "/v1/chat/completions",
                post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                    // Verify the real outbound request, not a private helper.
                    assert_eq!(body["model"], "actual-model");
                    assert_eq!(body["messages"][0]["content"], "hello");
                    assert_eq!(headers["authorization"], "Bearer fixture-key");
                    assert_eq!(headers["x-region"], "local");
                    Json(json!({
                        "model": body["model"],
                        "choices": [{"message": {"content": "ok"}}],
                        "usage": {"prompt_tokens": 3, "completion_tokens": 5}
                    }))
                }),
            )
            .route(
                "/v1/models",
                get(|| async {
                    Json(json!({"data": [{"id": "actual-model", "context_length": 8192}]}))
                }),
            ),
    )
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {
            "limited": {"baseURL": limited.base_url},
            "available": {
                "baseURL": available.base_url,
                "apiKey": "fixture-key",
                "headers": {"x-region": "local"}
            }
        },
        "models": {
            "alias": {"upstreams": [
                {"provider": "limited", "model": "limited-model"},
                {"provider": "available", "model": "actual-model"}
            ]}
        }
    }))
    .await;

    for _ in 0..2 {
        let response = proxy
            .client
            .post(proxy.url("/v1/chat/completions"))
            .json(&json!({"model": "alias", "messages": [{"role": "user", "content": "hello"}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["model"], "actual-model");
        assert_eq!(body["choices"][0]["message"]["content"], "ok");
    }
    assert_eq!(limited_requests.load(Ordering::SeqCst), 1);
    let usage = proxy.usage().await;
    assert_eq!(usage["requests"], 2);
    assert_eq!(usage["ok"], 2);
    assert_eq!(usage["failovers"], 1);
    assert_eq!(usage["tokensIn"], 6);
    assert_eq!(usage["tokensOut"], 10);
    assert_eq!(usage["retentionDays"], 7);
    assert_eq!(usage["days"].as_array().unwrap().len(), 7);
    assert_eq!(usage["providers"]["limited"]["limits"], 1);
    assert_eq!(usage["models"]["alias"]["failovers"], 1);
    assert_eq!(usage["cooldowns"][0]["upstream"], "limited");

    let discovery: Value = proxy
        .client
        .post(proxy.url("/api/provider-models"))
        .json(&json!({"provider": "available"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(discovery["models"], json!(["actual-model"]));
    assert_eq!(discovery["details"]["actual-model"]["contextLength"], 8192);
}

#[tokio::test]
async fn forwards_sse_body_headers_and_usage() {
    const EVENTS: [&str; 3] = [
        ": keepalive\r\n\r\nevent: message\r\ndata: null\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
        "data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":11}}\n\n",
        "data: [DONE]\n\n",
    ];
    let upstream = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let chunks =
                futures_util::stream::iter(EVENTS.map(|event| {
                    Ok::<_, std::io::Error>(bytes::Bytes::from_static(event.as_bytes()))
                }));
            (
                [
                    ("content-type", "text/event-stream"),
                    ("x-request-id", "test-request"),
                ],
                axum::body::Body::from_stream(chunks),
            )
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {"local": {"baseURL": upstream.base_url}},
        "models": {"stream": {"upstreams": [{"provider": "local", "model": "actual-model"}]}}
    }))
    .await;
    let response = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "stream", "stream": true, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.headers()["x-request-id"], "test-request");
    assert_eq!(
        response.text().await.unwrap(),
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null,\"index\":0}]}\n\ndata: {\"usage\":{\"completion_tokens\":11,\"prompt_tokens\":7}}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}],\"object\":\"chat.completion.chunk\"}\n\ndata: [DONE]\n\n"
    );
    let usage = proxy.usage().await;
    assert_eq!(usage["tokensIn"], 7);
    assert_eq!(usage["tokensOut"], 11);
    assert_eq!(usage["providers"]["local"]["tokensOut"], 11);
}

#[tokio::test]
async fn accepts_chat_payloads_larger_than_axums_default_two_megabyte_limit() {
    let upstream = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|request: Request| async move {
            let bytes = to_bytes(request.into_body(), 10 * 1024 * 1024)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(body["messages"][0]["content"].as_str().unwrap().len() > 2 * 1024 * 1024);
            Json(json!({
                "model": body["model"],
                "choices": [{"message": {"content": "ok"}}]
            }))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {"local": {"baseURL": upstream.base_url}},
        "models": {"large": {"upstreams": [{"provider": "local", "model": "actual-model"}]}}
    }))
    .await;
    let response = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({
            "model": "large",
            "messages": [{"role": "user", "content": "x".repeat(3 * 1024 * 1024)}]
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
        "ok"
    );
}

#[tokio::test]
async fn updates_config_models_and_an_isolated_opencode_file() {
    let proxy = TestProxy::start(json!({"providers": {}, "models": {}})).await;
    let opencode_path = proxy.directory.join("opencode.json");
    fs::write(
        &opencode_path,
        r#"{"providers":{"unrelated":{"name":"keep"}}}"#,
    )
    .unwrap();
    let config = json!({
        "port": 0,
        "providers": {},
        "models": {"new-alias": {"upstreams": []}},
        "opencodeConfig": opencode_path
    });
    let response = proxy
        .client
        .put(proxy.url("/api/config"))
        .json(&config)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let result: Value = response.json().await.unwrap();
    assert_eq!(result["ok"], true);
    assert_eq!(result["opencodeSynced"], true);
    assert_eq!(result["restartRequired"], false);

    let database = rusqlite::Connection::open(proxy.directory.join("config.db")).unwrap();
    let saved: Value = serde_json::from_str(
        &database
            .query_row(
                "SELECT value FROM settings WHERE key = 'config'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(saved, config);
    let legacy: Value =
        serde_json::from_str(&fs::read_to_string(proxy.directory.join("config.json")).unwrap())
            .unwrap();
    assert_eq!(legacy["models"], json!({}));
    let models: Value = proxy
        .client
        .get(proxy.url("/v1/models"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], "new-alias");
    let synced: Value = serde_json::from_str(&fs::read_to_string(&opencode_path).unwrap()).unwrap();
    assert_eq!(synced["providers"]["unrelated"]["name"], "keep");
    assert_eq!(
        synced["providers"]["provider-proxy"]["models"]["new-alias"]["name"],
        "new-alias (proxy, x0)"
    );
    assert!(proxy.directory.join("opencode.json.bak").is_file());

    let sync_result: Value = proxy
        .client
        .post(proxy.url("/api/opencode-sync"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sync_result, json!({"ok": true, "models": 1}));

    let invalid = proxy
        .client
        .put(proxy.url("/api/config"))
        .json(&json!({"models": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let unchanged: Value = serde_json::from_str(
        &database
            .query_row(
                "SELECT value FROM settings WHERE key = 'config'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(unchanged, config);
}

#[tokio::test]
async fn image_suggestions_use_connections_not_the_cached_catalog_or_legacy_allowlist() {
    let upstream = MockProvider::start(Router::new().route(
        "/v1/images/tasks",
        post(|| async {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": {"message": "fixture image failure"}})),
            )
        }),
    ))
    .await;
    for selected in [vec!["selected-image", "endpoint-only"], vec![]] {
        let proxy = TestProxy::start(json!({
            "providers": {"local": {
                "baseURL": upstream.base_url,
                "models": selected,
                "modelInfo": {
                    "selected-image": {"type": "image"},
                    "endpoint-only": {"endpoints": ["images/generations"]},
                    "cached-image": {"type": "image"}
                },
                "modelAvailability": {"availability-image": {"available": true}}
            }},
            "models": {},
            "imageSettings": {"skillModels": {"local": ["cached-image"]}}
        }))
        .await;
        let response = proxy
            .client
            .post(proxy.url("/api/image-tasks"))
            .json(&json!({"provider": "local", "model": "failed-image", "prompt": "fixture"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let result: Value = response.json().await.unwrap();
        let expected = if selected.is_empty() {
            json!([])
        } else {
            json!(["local/endpoint-only", "local/selected-image"])
        };
        assert_eq!(result["suggestedModels"], expected);
    }
}

#[tokio::test]
async fn keeps_error_responses_for_unknown_and_empty_chains() {
    let proxy = TestProxy::start(json!({
        "providers": {},
        "models": {"empty": {"upstreams": []}}
    }))
    .await;
    for (model, status, message) in [
        ("missing", StatusCode::NOT_FOUND, "unknown model: missing"),
        (
            "empty",
            StatusCode::BAD_GATEWAY,
            "all upstreams failed for empty: all upstreams are cooling down",
        ),
    ] {
        let response = proxy
            .client
            .post(proxy.url("/v1/chat/completions"))
            .json(&json!({"model": model, "messages": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["error"]["message"], message);
    }
    let usage = proxy.usage().await;
    assert_eq!(usage["requests"], 1);
    assert_eq!(usage["failed"], 1);
}
