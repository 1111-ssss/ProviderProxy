//! Black-box checks for the library's public HTTP interface. All providers and
//! configuration files are local test fixtures; no live accounts are used.
use axum::{
    body::to_bytes,
    extract::Request,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
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
async fn uptime_answers_count_model_attempts_and_chain_answers() {
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async { (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "60")]) }),
    ))
    .await;
    let working = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            Json(json!({
                "model": body["model"],
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}
            }))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {
            "limited": {"baseURL": failing.base_url},
            "fine": {"baseURL": working.base_url}
        },
        "models": {
            "alias": {"upstreams": [
                {"provider": "limited", "model": "m"},
                {"provider": "fine", "model": "m"}
            ]}
        }
    }))
    .await;

    let response = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "alias", "messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let answers: Value = proxy
        .client
        .get(proxy.url("/api/uptime/answers"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    // The model that hit the limit still counts as an attempt, so the strip is
    // the real answer rate rather than only the successes.
    assert_eq!(answers["models"]["limited/m"]["percent"], 0.0);
    assert_eq!(answers["models"]["limited/m"]["total"], 1);
    assert_eq!(answers["models"]["fine/m"]["percent"], 100.0);
    // The chain answered, so its own rate is 100% even though one member failed.
    assert_eq!(answers["chains"]["alias"]["percent"], 100.0);
    assert_eq!(answers["chains"]["alias"]["total"], 1);
    // Both windows are always reported: the tab's switch drives the second
    // strip, so its shape cannot depend on whatever the script said.
    assert_eq!(answers["models"]["fine/m"]["percent1h"], 100.0);
    assert_eq!(answers["models"]["fine/m"]["percent24h"], 100.0);
    let hour_cells = answers["models"]["fine/m"]["cells1h"].as_array().unwrap();
    assert_eq!(hour_cells.len(), 12, "an hour is twelve five-minute cells");
    assert!(
        hour_cells.iter().any(|cell| cell["percent"] == 100.0 && cell["total"] == 1),
        "the traffic lands in exactly one five-minute cell"
    );
    assert!(
        hour_cells.iter().filter(|cell| cell["percent"].is_null()).count() >= 11,
        "slots without traffic carry no percentage, so the GUI draws them grey"
    );
    let day_cells = answers["models"]["fine/m"]["cells24h"].as_array().unwrap();
    assert!(!day_cells.is_empty() && day_cells.len() <= 24, "the day strip is one cell per elapsed hour");
    assert_eq!(answers["day"].as_str().unwrap().len(), 10, "the day key is dated");
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
    // Stylesheets and scripts are embedded in the binary and served from the
    // same local server, for both the WebView and a normal browser.
    for path in ["/css/tokens.css", "/js/core.js"] {
        let response = proxy.client.get(proxy.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["cache-control"], "no-store, max-age=0");
    }
    let missing = proxy.client.get(proxy.url("/js/missing.js")).send().await.unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
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
    // The GUI compares the path against this to decide when reset is offered.
    assert!(config["opencodeConfigDefault"]
        .as_str()
        .unwrap_or_default()
        .ends_with("opencode.json")
        || config["opencodeConfigDefault"]
            .as_str()
            .unwrap_or_default()
            .ends_with("opencode.jsonc"));
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
            ]},
            "alias-two": {"upstreams": [
                {"provider": "limited", "model": "limited-model"},
                {"provider": "available", "model": "actual-model"}
            ]}
        }
    }))
    .await;

    // The same provider/model pair stays blocked when reached via another
    // exposed chain alias, not just when the original alias is called again.
    for alias in ["alias", "alias-two"] {
        let response = proxy
            .client
            .post(proxy.url("/v1/chat/completions"))
            .json(&json!({"model": alias, "messages": [{"role": "user", "content": "hello"}]}))
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
    // Model rows are keyed `provider/model`, never by chain alias.
    assert_eq!(usage["models"]["limited/limited-model"]["failovers"], 1);
    assert_eq!(usage["models"]["available/actual-model"]["ok"], 2);
    assert_eq!(usage["cooldowns"][0]["upstream"], "limited");
    assert_eq!(usage["cooldowns"][0]["upstreamModel"], "limited-model");

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
async fn agent_tag_chain_answers_without_joining_the_public_model_list() {
    let working = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            Json(json!({
                "model": body["model"],
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}
            }))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {"fine": {"baseURL": working.base_url, "models": ["cheap-model"]}},
        "models": {},
        "opencodeModels": {"fine": {"models": ["cheap-model"], "tags": ["cheap"]}},
        "opencodeAgentModels": {"compaction": "tag:cheap"}
    }))
    .await;
    fs::write(proxy.directory.join("opencode.json"), "{}").unwrap();
    let sync: Value = proxy
        .client
        .post(proxy.url("/api/opencode-sync"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sync["ok"], true);

    let answer = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "agent-tag:cheap", "messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), StatusCode::OK);
    let body: Value = answer.json().await.unwrap();
    assert_eq!(body["model"], "cheap-model");

    let models: Value = proxy
        .client
        .get(proxy.url("/v1/models"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let ids: Vec<&str> = models["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"fine/cheap-model"));
    assert!(!ids.iter().any(|id| id.starts_with("agent-tag:")));

    let synced: Value =
        serde_json::from_str(&fs::read_to_string(proxy.directory.join("opencode.json")).unwrap())
            .unwrap();
    assert_eq!(
        synced["agents"]["compaction"]["model"],
        "provider-proxy/agent-tag:cheap"
    );
    assert_eq!(
        synced["providers"]["provider-proxy"]["models"]["agent-tag:cheap"]["name"],
        "agent-tag:cheap (proxy, x1)"
    );
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

/// A 200 whose body never sends a byte used to hang the client on "waiting for
/// response headers" forever: no token, no [DONE], no failover. The idle
/// timeout must abandon the attempt and move to the next upstream.
#[tokio::test]
async fn fails_over_when_a_stream_stalls_after_headers() {
    use axum::body::Body;
    use std::convert::Infallible;

    // Never yields a chunk and never ends: a body that hangs after headers.
    let silent = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let body = Body::from_stream(futures_util::stream::poll_fn(
                |_cx| std::task::Poll::<Option<Result<bytes::Bytes, Infallible>>>::Pending,
            ));
            ([( "content-type", "text/event-stream")], body)
        }),
    ))
    .await;
    let answering = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            assert_eq!(body["model"], "backup-model");
            Json(json!({
                "model": body["model"],
                "choices": [{"message": {"role": "assistant", "content": "готово"}}],
                "usage": {"prompt_tokens": 2, "completion_tokens": 3}
            }))
        }),
    ))
    .await;

    let proxy = TestProxy::start(json!({
        // A short idle window keeps the test fast.
        "streamIdleTimeoutSec": 10,
        "errorCooldownSec": 1,
        "providers": {
            "stalled": {"baseURL": silent.base_url},
            "backup": {"baseURL": answering.base_url}
        },
        "models": {
            "chain": {"upstreams": [
                {"provider": "stalled", "model": "stalled-model"},
                {"provider": "backup", "model": "backup-model"}
            ]}
        },
        "opencodeConfig": "/dev/null"
    }))
    .await;

    // The idle window is clamped to at least 10s; the test must finish well
    // inside the harness timeout but after the timeout fires.
    // The default test client gives up after 3s, which is shorter than the idle
    // window this test exercises.
    let patient = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(45))
        .build()
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(40), async {
        patient
            .post(proxy.url("/v1/chat/completions"))
            .json(&json!({"model": "chain", "stream": true, "messages": [{"role": "user", "content": "hi"}]}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
    })
    .await
    .expect("the stalled stream must not hang the request forever");

    assert!(
        response.contains("готово"),
        "the backup upstream must answer after the stall: {response}"
    );
    let usage = proxy.usage().await;
    // A stall is not retried on the same model: it already waited the whole
    // idle window, so the chain moves on and the backup answers.
    assert_eq!(
        usage["days"][0]["models"]["stalled/stalled-model"]["errors"], 1,
        "the stalled attempt is one error: {usage}"
    );
    assert_eq!(
        usage["days"][0]["models"]["backup/backup-model"]["ok"], 1,
        "the backup answered: {usage}"
    );
}

/// An upstream can close SSE cleanly at the transport layer while its answer is
/// still incomplete. The proxy must report an error without appending the
/// successful-stream marker, or clients may accept the partial answer as done.
#[tokio::test]
async fn truncated_stream_error_is_not_followed_by_done() {
    let truncated = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let body = axum::body::Body::from_stream(futures_util::stream::unfold(0, |step| async move {
                match step {
                    0 => Some((Ok::<_, std::io::Error>(bytes::Bytes::from_static(
                        b"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial answer\"},\"finish_reason\":null}]}\n\n",
                    )), 1)),
                    1 => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        Some((Err(std::io::Error::other("upstream disconnected")), 2))
                    }
                    _ => None,
                }
            }));
            ([("content-type", "text/event-stream")], body)
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": { "truncated": { "baseURL": truncated.base_url } },
        "models": { "chain": { "upstreams": [{ "provider": "truncated", "model": "m" }] } }
    }))
    .await;

    let body = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "stream": true, "messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();

    assert!(body.contains("partial answer"), "the test must exercise a mid-answer cutoff: {body}");
    assert!(body.contains("proxy_stream_error"), "truncation must be surfaced as an error: {body}");
    assert!(!body.contains("[DONE]"), "an errored partial answer must not look complete: {body}");
}

/// Retry mode must not spin for an hour when the chain cannot ever answer:
/// an empty chain has no upstream to retry, so the request has to fail fast.
#[tokio::test]
async fn retry_mode_gives_up_on_an_empty_chain() {
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "providers": {},
        "models": {"empty": {"upstreams": []}},
        "opencodeConfig": "/dev/null"
    }))
    .await;
    let started = std::time::Instant::now();
    let response = tokio::time::timeout(
        Duration::from_secs(10),
        proxy
            .client
            .post(proxy.url("/v1/chat/completions"))
            .json(&json!({"model": "empty", "messages": []}))
            .send(),
    )
    .await
    .expect("retry mode must not hang on an empty chain")
    .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "an empty chain cannot answer, so retrying it is pointless"
    );
}

/// A chain of one has nothing to fail over to, but "retry until answered" is
/// still the user's choice: the request keeps retrying, it just parks its only
/// model for the short `singleCooldownSec` instead of hours.
#[tokio::test]
async fn retry_mode_keeps_retrying_a_single_model_chain() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": {"message": "boom"}})))
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "errorCooldownSec": 120,
        "singleCooldownSec": 1,
        "providers": {"p": {"baseURL": failing.base_url}},
        "models": {"solo": {"upstreams": [{"provider": "p", "model": "m"}]}},
        "opencodeConfig": "/dev/null"
    }))
    .await;
    let request = tokio::spawn({
        let url = proxy.url("/v1/chat/completions");
        let client = proxy.client.clone();
        async move {
            let _ = client
                .post(url)
                .json(&json!({"model": "solo", "messages": []}))
                .send()
                .await;
        }
    });
    tokio::time::sleep(Duration::from_secs(4)).await;
    request.abort();
    let attempts = hits.load(Ordering::SeqCst);
    assert!(
        attempts >= 2,
        "retry mode must keep going for a single model: {attempts} attempts in 4s"
    );
    assert!(
        attempts <= 12,
        "the short block still spaces the retries: {attempts} attempts in 4s"
    );
}

/// A cooldown of zero (only possible through a hand-edited config) used to make
/// the retry loop hammer the same upstream with no pause.
#[tokio::test]
async fn retry_mode_never_hammers_with_a_zero_cooldown() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": {"message": "boom"}})))
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "errorCooldownSec": 0,
        "providers": {"p": {"baseURL": failing.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}},
        "opencodeConfig": "/dev/null"
    }))
    .await;
    // Abandon the client after a moment; the server keeps retrying for an hour,
    // so only the request rate during the first second is meaningful.
    let request = tokio::spawn({
        let proxy_url = proxy.url("/v1/chat/completions");
        let client = proxy.client.clone();
        async move {
            let _ = client
                .post(proxy_url)
                .json(&json!({"model": "chain", "messages": []}))
                .send()
                .await;
        }
    });
    tokio::time::sleep(Duration::from_secs(3)).await;
    request.abort();
    let attempts = hits.load(Ordering::SeqCst);
    // A 500 gets three tries inside one round now, and a clamped one-second
    // cooldown allows about three rounds in three seconds. Anything far above
    // that means the clamp is gone and the loop is spinning.
    assert!(
        attempts <= 12,
        "a zero cooldown must be clamped, not turned into a hot loop: {attempts} attempts in 3s"
    );
}

/// A client that hangs up must not leave the proxy retrying in the background,
/// including the non-stream path: a plain request in retry mode used to keep
/// hitting the provider minutes after the chat was cancelled.
#[tokio::test]
async fn retry_mode_stops_a_non_stream_request_when_the_client_hangs_up() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": {"message": "boom"}})))
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "errorCooldownSec": 1,
        "providers": {"p": {"baseURL": failing.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}},
        "opencodeConfig": "/dev/null"
    }))
    .await;
    let request = tokio::spawn({
        let url = proxy.url("/v1/chat/completions");
        let client = proxy.client.clone();
        async move {
            let _ = client.post(url).json(&json!({"model": "chain", "messages": []})).send().await;
        }
    });
    tokio::time::sleep(Duration::from_millis(2500)).await;
    request.abort();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after_abort = hits.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let later = hits.load(Ordering::SeqCst);
    assert_eq!(
        after_abort, later,
        "a plain retry-mode request must stop when the client leaves: {after_abort} then {later}"
    );
}

/// A client that hangs up must not leave the proxy retrying in the background,
/// including the streaming retry path, where the work runs in its own task and
/// dropping the response body does not cancel it by itself.
#[tokio::test]
async fn retry_mode_stops_a_stream_request_when_the_client_hangs_up() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": {"message": "boom"}})))
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "errorCooldownSec": 1,
        "providers": {"p": {"baseURL": failing.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}},
        "opencodeConfig": "/dev/null"
    }))
    .await;
    let request = tokio::spawn({
        let url = proxy.url("/v1/chat/completions");
        let client = proxy.client.clone();
        async move {
            let _ = client
                .post(url)
                .json(&json!({"model": "chain", "stream": true, "messages": []}))
                .send()
                .await;
        }
    });
    tokio::time::sleep(Duration::from_millis(2500)).await;
    request.abort();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after_abort = hits.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let later = hits.load(Ordering::SeqCst);
    assert_eq!(
        after_abort, later,
        "the streaming retry task must stop once the client is gone: {after_abort} then {later}"
    );
}

/// A client that hangs up must not leave the proxy retrying in the background.
#[tokio::test]
async fn retry_mode_stops_when_the_client_hangs_up() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": {"message": "boom"}})))
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "errorCooldownSec": 1,
        "providers": {"p": {"baseURL": failing.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}},
        "opencodeConfig": "/dev/null"
    }))
    .await;
    let request = tokio::spawn({
        let url = proxy.url("/v1/chat/completions");
        let client = proxy.client.clone();
        async move {
            let _ = client.post(url).json(&json!({"model": "chain", "messages": []})).send().await;
        }
    });
    tokio::time::sleep(Duration::from_millis(2500)).await;
    request.abort();
    tokio::time::sleep(Duration::from_secs(1)).await;
    let after_abort = hits.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_secs(4)).await;
    let later = hits.load(Ordering::SeqCst);
    assert_eq!(
        after_abort, later,
        "the retry loop must stop once the client is gone: {after_abort} then {later}"
    );
}

/// Normal streaming retains the original upstream response unchanged. Retry
/// mode is covered separately because only that path needs an open proxy stream.
#[tokio::test]
async fn normal_failover_diagnostics_stay_out_of_the_answer_stream() {
    const ANSWER: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n";
    let broken = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async { (StatusCode::BAD_GATEWAY, Json(json!({"error": {"message": "boom"}}))) }),
    ))
    .await;
    let healthy = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            (
                [("content-type", "text/event-stream")],
                axum::body::Body::from_stream(futures_util::stream::iter([Ok::<_, std::io::Error>(
                    bytes::Bytes::from_static(ANSWER.as_bytes()),
                )])),
            )
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {
            "broken": {"baseURL": broken.base_url},
            "healthy": {"baseURL": healthy.base_url}
        },
        "models": {"chain": {"upstreams": [
            {"provider": "broken", "model": "m"},
            {"provider": "healthy", "model": "m"}
        ]}}
    }))
    .await;
    let response = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "stream": true, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.text().await.unwrap();
    assert!(!body.contains(": proxy:"), "ordinary failover diagnostics belong in proxy logs: {body}");
    assert!(!body.contains("\"content\":\"broken/m"), "proxy errors are not model deltas: {body}");
    assert!(body.contains("\"content\":\"hello\""), "answer remains intact: {body}");
    let logs: Value = proxy
        .client
        .get(proxy.url("/api/logs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        logs["lines"].as_array().unwrap().iter().any(|row| {
            row["line"]
                .as_str()
                .unwrap_or_default()
                .contains("chain (m) — HTTP 502, заблокирован")
        }),
        "details stay in the proxy logs, not the assistant response: {logs}"
    );
}

/// In retry mode the answer may be minutes away. Keep the connection alive
/// without sending upstream diagnostics into the model's stream.
#[tokio::test]
async fn retry_mode_sends_only_keepalive_comments_until_answer() {
    let failing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "boom") }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "retryForever": true,
        "errorCooldownSec": 1,
        "providers": {"p": {"baseURL": failing.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}}
    }))
    .await;
    // The shared test client has a 3s timeout, and this response never ends.
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let response = client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "stream": true, "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut frames = response.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(5), frames.next())
        .await
        .expect("the stream must open while the proxy is still retrying")
        .unwrap()
        .unwrap();
    let first = String::from_utf8_lossy(&first);
    assert!(
        first.contains(": keepalive\n\n"),
        "retry mode keeps the connection alive using an ignored SSE comment: {first}"
    );
    assert!(!first.contains("вернул HTTP"), "upstream diagnostics stay out of the model stream: {first}");
    assert!(!first.contains("повторяю через"), "retry status stays out of the model stream: {first}");
    drop(frames);
}

/// Session duration is the sum of the gaps between requests, and a gap longer
/// than the idle threshold is a pause that must not count.
#[tokio::test]
async fn session_duration_counts_gaps_and_skips_pauses() {
    let upstream = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            Json(json!({
                "model": body["model"],
                "choices": [{"message": {"role": "assistant", "content": "ok"}}]
            }))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        // 10s threshold: a 12s pause is dropped, a 1s gap is counted.
        "sessionIdleGapSec": 10,
        "providers": {"p": {"baseURL": upstream.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}},
        "opencodeConfig": "/dev/null"
    }))
    .await;

    let call = || async {
        proxy
            .client
            .post(proxy.url("/v1/chat/completions"))
            .header("x-opencode-session-id", "ses_gap_test")
            .json(&json!({"model": "chain", "messages": []}))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
    };

    call().await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    call().await;
    let after_short = session_active_ms(&proxy, "ses_gap_test").await;
    assert!(
        (900..=3000).contains(&after_short),
        "a 1.2s gap within the threshold must count: {after_short}ms"
    );

    // A gap well past the threshold is a pause: it must not add its length.
    tokio::time::sleep(Duration::from_secs(2)).await;
    call().await;
    let after_pause = session_active_ms(&proxy, "ses_gap_test").await;
    assert!(
        after_pause < after_short + 2500,
        "a pause longer than the threshold must not be counted: {after_short} -> {after_pause}"
    );
}

async fn session_active_ms(proxy: &TestProxy, id: &str) -> u64 {
    // The stream tallies after the body ends, so give that task a moment.
    for _ in 0..40 {
        let usage = proxy.usage().await;
        let row = &usage["days"][0]["sessions"][id];
        if let Some(value) = row["activeMs"].as_u64() {
            if value > 0 {
                return value;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    0
}

#[tokio::test]
async fn uptime_script_sees_the_model_list_and_its_bars_reach_the_gui() {
    // The script stands in for a real Python one: same stdout contract, and it
    // asks for the model list through the API instead of being handed it.
    let proxy = TestProxy::start(json!({
        "authToken": "test-token",
        "providers": {
            "local": {
                "baseURL": "http://127.0.0.1:1/v1",
                "apiKey": "fixture",
                "models": ["m1", "m2"],
                // The script must see the catalog, not just the selection:
                // `cat1`/`cat2` are served but never picked, `gone` was dropped
                // by the provider, `hand` was typed in by the user.
                "manualModels": ["hand"],
                "modelAvailability": {
                    "cat1": { "available": true },
                    "cat2": { "available": true },
                    "gone": { "available": false }
                },
                "uptimeScript": "import json, os, urllib.request\nurl = os.environ['PP_MODELS_API']\nreq = urllib.request.Request(url, headers={'authorization': 'Bearer ' + os.environ['PP_PROXY_TOKEN']})\nmodels = json.load(urllib.request.urlopen(req))['models']\nprint(json.dumps({'bars': [{'label': m, 'percent': 100} for m in models]}))\n"
            }
        },
        "models": {}
    }))
    .await;
    let auth = HeaderMap::from_iter([(
        "authorization".parse().unwrap(),
        "Bearer test-token".parse().unwrap(),
    )]);

    // Without the token both endpoints stay closed.
    let open = proxy
        .client
        .get(proxy.url("/api/provider-models-list?provider=local"))
        .send()
        .await
        .unwrap();
    assert_eq!(open.status(), StatusCode::UNAUTHORIZED);

    let listed: Value = proxy
        .client
        .get(proxy.url("/api/provider-models-list?provider=local"))
        .headers(auth.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        listed["models"],
        json!(["cat1", "cat2", "hand", "m1", "m2"]),
        "the whole catalog, not just the selection"
    );
    assert_eq!(listed.as_object().unwrap().len(), 2, "names only, nothing else about the provider");

    let missing = proxy
        .client
        .get(proxy.url("/api/provider-models-list?provider=nope"))
        .headers(auth.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let run: Value = proxy
        .client
        .post(proxy.url("/api/uptime/run"))
        .headers(auth.clone())
        .json(&json!({ "provider": "local" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // No Python on the runner is allowed to fail as "interpreter missing", but a
    // script that ran and produced nothing usable must not pass silently.
    match run.get("bars") {
        Some(bars) => {
            let bars = bars.as_array().unwrap();
            assert_eq!(bars.len(), 5, "every catalog model gets a bar, not just the picked ones");
            assert_eq!(bars[0]["label"], "cat1", "a served but unpicked model is parsed too");
        }
        None => {
            let message = run["error"]["message"].as_str().unwrap_or_default();
            assert!(
                message.contains("не найден интерпретатор"),
                "the script ran but did not answer: {message}"
            );
        }
    }
}

/// The picked file wins over the saved text, so editing the script on disk is
/// picked up without choosing it again. A file that disappeared falls back to
/// the text saved when it was chosen.
#[tokio::test]
async fn an_edited_uptime_script_file_is_read_on_every_run() {
    let dir = std::env::temp_dir().join(format!(
        "provider-proxy-uptime-api-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("uptime.py");
    std::fs::write(&path, "print('{\"bars\":[{\"label\":\"from-file\",\"percent\":100}]}')\n").unwrap();

    let proxy = TestProxy::start(json!({
        "authToken": "test-token",
        "providers": {
            "local": {
                "baseURL": "http://127.0.0.1:1/v1",
                "apiKey": "fixture",
                "models": ["m1"],
                "uptimeScript": "print('{\"bars\":[{\"label\":\"from-text\",\"percent\":100}]}')\n",
                "uptimeScriptFile": "uptime.py",
                "uptimeScriptPath": path.to_string_lossy()
            }
        },
        "models": {}
    }))
    .await;
    let auth = HeaderMap::from_iter([(
        "authorization".parse().unwrap(),
        "Bearer test-token".parse().unwrap(),
    )]);
    let run = || {
        proxy
            .client
            .post(proxy.url("/api/uptime/run"))
            .headers(auth.clone())
            .json(&json!({ "provider": "local" }))
    };

    let answer: Value = run().send().await.unwrap().json().await.unwrap();
    if let Some(message) = answer["error"]["message"].as_str() {
        // No Python on this machine: nothing to prove about the file.
        assert!(message.contains("не найден интерпретатор"), "{message}");
        let _ = std::fs::remove_dir_all(&dir);
        return;
    }
    assert_eq!(answer["bars"][0]["label"], "from-file", "the file beats the saved text");

    // The user edits the file: the next run is the new script, no re-picking.
    std::fs::write(&path, "print('{\"bars\":[{\"label\":\"edited\",\"percent\":50}]}')\n").unwrap();
    let edited: Value = run().send().await.unwrap().json().await.unwrap();
    assert_eq!(edited["bars"][0]["label"], "edited");

    // The file goes away: the saved text keeps the provider working.
    std::fs::remove_file(&path).unwrap();
    let fallback: Value = run().send().await.unwrap().json().await.unwrap();
    assert_eq!(fallback["bars"][0]["label"], "from-text");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn stored_logs_page_back_through_the_day() {
    let proxy = TestProxy::start(json!({
        "authToken": "test-token",
        "providers": { "local": { "baseURL": "http://127.0.0.1:1/v1", "apiKey": "k" } },
        "models": {}
    }))
    .await;
    let auth = HeaderMap::from_iter([(
        "authorization".parse().unwrap(),
        "Bearer test-token".parse().unwrap(),
    )]);
    // The boot line is already there; three requests add three more.
    for _ in 0..3 {
        let _ = proxy
            .client
            .get(proxy.url("/v1/models"))
            .headers(auth.clone())
            .send()
            .await
            .unwrap();
    }
    let first: Value = proxy
        .client
        .get(proxy.url("/api/logs?limit=2"))
        .headers(auth.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let lines = first["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2, "one page is capped by limit");
    assert!(lines[0]["id"].as_i64() > lines[1]["id"].as_i64(), "newest first");
    let cursor = first["next"].as_i64().expect("more lines are waiting");
    assert_eq!(cursor, lines[1]["id"].as_i64().unwrap());

    let older: Value = proxy
        .client
        .get(proxy.url(&format!("/api/logs?before={cursor}&limit=10")))
        .headers(auth.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let older_lines = older["lines"].as_array().unwrap();
    assert!(!older_lines.is_empty(), "the day continues behind the cursor");
    assert!(
        older_lines.iter().all(|row| row["id"].as_i64().unwrap() < cursor),
        "the cursor is exclusive"
    );
    assert!(
        first["total"].as_u64().unwrap() >= 4,
        "the pager can count the stored day: {first}"
    );
    assert!(first["total"].as_u64().unwrap() <= 5000, "the day is capped");
}

/// The GUI never sees the key: it gets back an empty `apiKey` plus
/// `apiKeyConfigured`. Saving the dialog with that field untouched must keep the
/// stored key, not wipe it.
#[tokio::test]
async fn editing_a_provider_with_an_empty_key_field_keeps_the_saved_key() {
    let upstream = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers["authorization"], "Bearer kept-key");
            Json(json!({
                "model": body["model"],
                "choices": [{"message": {"content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}
            }))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {"local": {"baseURL": upstream.base_url, "apiKey": "kept-key"}},
        "models": {"alias": {"upstreams": [{"provider": "local", "model": "m"}]}}
    }))
    .await;
    // What the dialog does: take the public config, change one field, save it
    // back with the key field still empty.
    let mut config: Value = proxy
        .client
        .get(proxy.url("/api/config"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(config["providers"]["local"]["apiKey"], "");
    assert_eq!(config["providers"]["local"]["apiKeyConfigured"], true);
    config["providers"]["local"]["baseURL"] = json!(upstream.base_url);
    config["providers"]["local"]["homepage"] = json!("https://example.test");
    let saved = proxy
        .client
        .put(proxy.url("/api/config"))
        .json(&config)
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    let after: Value = proxy
        .client
        .get(proxy.url("/api/config"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["providers"]["local"]["apiKeyConfigured"], true);
    assert_eq!(after["providers"]["local"]["homepage"], "https://example.test");

    // The proof is the live request: the upstream must still get the old key.
    let answer = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "alias", "messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), StatusCode::OK);
}

/// The skills dialog is only useful if it sees what is on disk. The route and
/// the folder scan are checked through the real HTTP surface.
#[tokio::test]
async fn lists_skill_folders_from_the_skills_directory() {
    let skills = std::env::temp_dir().join(format!(
        "provider-proxy-http-skills-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    for (folder, frontmatter) in [
        ("image-generation", "name: image-generation\ndescription: bundled\n"),
        ("debugging", "name: debugging\ndescription: \"Find the cause\"\n"),
    ] {
        fs::create_dir_all(skills.join(folder)).unwrap();
        fs::write(
            skills.join(folder).join("SKILL.md"),
            format!("---\n{frontmatter}---\n# body\n"),
        )
        .unwrap();
    }
    // Only this test reads the variable, so no other test sees a changed root.
    std::env::set_var("PP_OPENCODE_SKILLS_DIR", &skills);
    let proxy = TestProxy::start(json!({ "providers": {}, "models": {} })).await;
    let body: Value = proxy
        .client
        .get(proxy.url("/api/skills"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    std::env::remove_var("PP_OPENCODE_SKILLS_DIR");
    let _ = fs::remove_dir_all(&skills);

    assert_eq!(body["root"], json!(skills));
    let names: Vec<&str> = body["skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|skill| skill["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["debugging", "image-generation"]);
    assert_eq!(body["skills"][0]["description"], "Find the cause");
    assert_eq!(body["skills"][1]["bundled"], true);
}

/// Three quiet retries, then a block: a model that keeps answering 502 is not
/// worth a failover per request, and a single hiccup must not block it either.
#[tokio::test]
async fn an_unusable_model_gets_three_tries_inside_one_request() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let broken = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::BAD_GATEWAY, "boom")
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {"p": {"baseURL": broken.base_url}},
        "models": {"chain": {"upstreams": [{"provider": "p", "model": "m"}]}}
    }))
    .await;

    let response = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "messages": []}))
        .send()
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK, "nothing answered");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        3,
        "502 gets three attempts, not one and not a hot loop"
    );
    let usage = proxy.usage().await;
    assert_eq!(usage["providers"]["p"]["errors"], 3, "every attempt is counted: {usage}");
    assert_eq!(
        usage["cooldowns"][0]["upstreamModel"], "m",
        "after the third miss the model is blocked: {usage}"
    );

    // The block is real: the next request does not touch the dead upstream.
    let _ = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 3, "a blocked model is not retried");
}

/// Two rate limits from one provider in one request are the account, not the
/// model: the whole provider is blocked, so another model of it is skipped too.
#[tokio::test]
async fn two_rate_limits_block_the_whole_provider() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let limited = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(json!({"error": {"message": "rate limit exceeded"}})),
                )
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {"p": {"baseURL": limited.base_url}},
        "models": {"chain": {"upstreams": [
            {"provider": "p", "model": "one"},
            {"provider": "p", "model": "two"},
            {"provider": "p", "model": "three"}
        ]}}
    }))
    .await;
    let _ = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 2, "the third model is skipped: the account is out");
    let usage = proxy.usage().await;
    let blocked: Vec<&str> = usage["cooldowns"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["upstreamModel"].as_str())
        .collect();
    assert!(blocked.contains(&"*"), "the provider itself is blocked: {usage}");
}

/// A 400 that names a rate limit is a limit, not a bad request: it must switch
/// and block like a 429 instead of being handed to the client.
#[tokio::test]
async fn a_400_that_names_a_rate_limit_switches_and_blocks() {
    let limited = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": {"message": "RateLimit: slow down"}})),
            )
        }),
    ))
    .await;
    let healthy = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            Json(json!({"model": body["model"], "choices": [{"message": {"content": "ok"}}]}))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {
            "limited": {"baseURL": limited.base_url},
            "healthy": {"baseURL": healthy.base_url}
        },
        "models": {"chain": {"upstreams": [
            {"provider": "limited", "model": "m"},
            {"provider": "healthy", "model": "m"}
        ]}}
    }))
    .await;
    let response = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "messages": []}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK, "the healthy link answered");
    let usage = proxy.usage().await;
    assert_eq!(usage["providers"]["limited"]["limits"], 1, "counted as a limit: {usage}");
    assert_ne!(
        usage["cooldowns"][0]["until"], 0,
        "the limited model rests: {usage}"
    );
}

/// A 404 is a provider-side truth: the model is not there, so the request
/// switches at once and the next request does not try it again.
#[tokio::test]
async fn a_404_switches_once_and_blocks_the_model() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let missing = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                (StatusCode::NOT_FOUND, "no such model")
            }
        }),
    ))
    .await;
    let healthy = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            Json(json!({"model": body["model"], "choices": [{"message": {"content": "ok"}}]}))
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {
            "missing": {"baseURL": missing.base_url},
            "healthy": {"baseURL": healthy.base_url}
        },
        "models": {"chain": {"upstreams": [
            {"provider": "missing", "model": "gone"},
            {"provider": "healthy", "model": "m"}
        ]}}
    }))
    .await;
    for _ in 0..2 {
        let response = proxy
            .client
            .post(proxy.url("/v1/chat/completions"))
            .json(&json!({"model": "chain", "messages": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    assert_eq!(hits.load(Ordering::SeqCst), 1, "a missing model is asked once, not every request");
}

/// The GUI pushes the external uptime it already fetched, so the chain can rank
/// by it. An unknown provider is simply recorded, not an error.
#[tokio::test]
async fn the_gui_can_push_external_uptime_for_ranking() {
    let proxy = TestProxy::start(json!({"providers": {}, "models": {}})).await;
    let response = proxy
        .client
        .post(proxy.url("/api/uptime/bars"))
        .json(&json!({"bars": [
            {"provider": "p", "models": [{"model": "good", "percent": 98.5}, {"model": "bad", "percent": 12.0}]}
        ]}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["ok"], true);
}

/// A 502 inside the attempt is retried on the same model before the chain moves
/// on: the model `one` answers 502 twice and then works, so the healthy backup
/// must never be asked.
#[tokio::test]
async fn a_gateway_error_is_retried_on_the_same_model_first() {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let flaky = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move |Json(body): Json<Value>| {
            let counter = counter.clone();
            async move {
                let attempt = counter.fetch_add(1, Ordering::SeqCst);
                if attempt < 2 {
                    return (StatusCode::BAD_GATEWAY, "boom").into_response();
                }
                Json(json!({"model": body["model"], "choices": [{"message": {"content": "ok"}}]}))
                    .into_response()
            }
        }),
    ))
    .await;
    let backup_hits = Arc::new(AtomicUsize::new(0));
    let backup_counter = backup_hits.clone();
    let backup = MockProvider::start(Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let counter = backup_counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Json(json!({"choices": [{"message": {"content": "backup"}}]}))
            }
        }),
    ))
    .await;
    let proxy = TestProxy::start(json!({
        "providers": {
            "flaky": {"baseURL": flaky.base_url},
            "backup": {"baseURL": backup.base_url}
        },
        "models": {"chain": {"upstreams": [
            {"provider": "flaky", "model": "m"},
            {"provider": "backup", "model": "m"}
        ]}}
    }))
    .await;
    let body: Value = proxy
        .client
        .post(proxy.url("/v1/chat/completions"))
        .json(&json!({"model": "chain", "messages": []}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "ok", "the retried model answered");
    assert_eq!(hits.load(Ordering::SeqCst), 3, "two 502s, then the answer, all on one model");
    assert_eq!(backup_hits.load(Ordering::SeqCst), 0, "a hiccup must not cost the backup a request");
}
