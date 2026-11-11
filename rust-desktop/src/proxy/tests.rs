use super::config::{
    database_path, export_config, merge_config_secrets, merge_imported_config, merge_redacted,
    open_storage, public_config,
};
use super::metrics::{hour_stat, load_usage, model_stat, now_ms, tally_usage, USAGE_RETENTION_DAYS};
use super::routing::{build_chains, with_model};
use super::server::{shutdown_running_instance, start_server};
use super::types::{AppState, ModelUsage, ProviderUsage, Usage};
use reqwest::Client;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

#[test]
fn loads_only_the_last_seven_calendar_days_of_usage() {
    let directory = std::env::temp_dir().join(format!("provider-proxy-usage-test-{}", now_ms()));
    fs::create_dir_all(&directory).unwrap();
    let stats = directory.join("usage-stats.json");
    let today = chrono::Local::now().date_naive();
    let day = |offset: i64| {
        (today - chrono::Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    };
    let mut days = serde_json::Map::new();
    days.insert(day(0), json!({"requests": 7}));
    days.insert(
        day((USAGE_RETENTION_DAYS - 1) as i64),
        json!({"requests": 1}),
    );
    days.insert(day(USAGE_RETENTION_DAYS as i64), json!({"requests": 99}));
    fs::write(
        &stats,
        serde_json::to_string(&json!({"version": 1, "days": days})).unwrap(),
    )
    .unwrap();

    let storage = open_storage(&directory.join("state.db")).unwrap();
    let (usage, history, loaded_day) = load_usage(&storage, &stats);
    assert_eq!(loaded_day, day(0));
    assert_eq!(usage.requests, 7);
    assert_eq!(
        history
            .get(&day((USAGE_RETENTION_DAYS - 1) as i64))
            .unwrap()
            .requests,
        1
    );
    assert!(!history.contains_key(&day(USAGE_RETENTION_DAYS as i64)));
    let _ = fs::remove_dir_all(directory);
}

#[test]
fn builds_chain_and_direct_models_from_config() {
    let config = json!({
        "providers": {
            "a": { "baseURL": "https://a.example/v1", "apiKey": "ka", "models": ["direct", "new"] }
        },
        "models": {
            "proxy-model": { "upstreams": [{ "provider": "a", "model": "a-model" }] }
        },
        "opencodeModels": { "a": { "all": true, "models": ["direct"] } }
    });
    let chains = build_chains(&config);
    assert_eq!(chains["proxy-model"][0].model, "a-model");
    assert_eq!(chains["a/direct"][0].base_url, "https://a.example/v1");
    assert_eq!(chains["a/new"][0].model, "new");
}

#[test]
fn normalizes_tool_arguments_before_forwarding_chat_requests() {
    let body = json!({
        "messages": [
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_1",
                    "function": { "name": "run", "arguments": { "command": "pwd" } }
                }]
            },
            { "role": "tool", "tool_call_id": "call_1", "content": { "exitCode": 0 } }
        ]
    });
    let normalized = with_model(&body, "provider-model");
    assert_eq!(normalized["model"], "provider-model");
    assert_eq!(
        normalized["messages"][0]["tool_calls"][0]["function"]["arguments"],
        r#"{"command":"pwd"}"#
    );
    assert_eq!(normalized["messages"][1]["content"], r#"{"exitCode":0}"#);
}

#[test]
fn redacts_and_merges_secrets_without_losing_existing_values() {
    let previous = json!({ "authToken": "secret", "providers": { "a": { "apiKey": "key" } } });
    let public = public_config(&previous);
    assert_eq!(public["authTokenConfigured"], true);
    assert_eq!(public["providers"]["a"]["apiKeyConfigured"], true);
    let merged = merge_redacted(&public, &previous);
    assert_eq!(merged["authToken"], "secret");
    assert_eq!(merged["providers"]["a"]["apiKey"], "key");
}

#[test]
fn keeps_a_provider_key_when_the_gui_renames_the_provider() {
    let previous = json!({ "providers": { "old": { "apiKey": "key" } }, "models": {} });
    let next = json!({
        "providers": { "new": { "apiKey": "", "apiKeyConfigured": true, "apiKeySource": "old" } },
        "models": {}
    });
    let merged = merge_config_secrets(&next, &previous);
    assert_eq!(merged["providers"]["new"]["apiKey"], "key");
}

#[test]
fn exports_optional_sections_and_preserves_secrets_on_partial_import() {
    let previous = json!({
        "authToken": "auth",
        "providers": { "a": { "baseURL": "https://a.example", "apiKey": "key" } },
        "models": { "chain": { "upstreams": [] } },
        "opencodeModels": { "a": { "models": ["direct"] } }
    });
    let without_optional = export_config(&previous, false, false, false);
    assert!(without_optional["providers"]["a"]["apiKey"].is_null());
    assert!(without_optional.get("models").is_none());
    assert!(without_optional.get("opencodeModels").is_none());

    let imported =
        merge_imported_config(&json!({ "appSettings": { "theme": "light" } }), &previous);
    assert_eq!(imported["authToken"], "auth");
    assert_eq!(imported["providers"]["a"]["apiKey"], "key");
    assert!(imported["models"]["chain"].is_object());
}

#[test]
fn tallies_the_last_usage_object_for_streams() {
    let mut usage = Usage::default();
    let mut provider = ProviderUsage::default();
    tally_usage(
            "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}\n\ndata: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":13}}",
            &mut usage,
            &mut provider,
        );
    assert_eq!(usage.tokens_in, 7);
    assert_eq!(usage.tokens_out, 13);
    assert_eq!(provider.tokens_in, 7);
    assert_eq!(provider.tokens_out, 13);
}

#[test]
fn models_are_keyed_by_provider_and_upstream_model() {
    let mut usage = Usage::default();
    model_stat(&mut usage, "logfare", "deepseek-v4.1").ok += 1;
    model_stat(&mut usage, "logfare", "deepseek-v4.1").tokens_in += 10;
    model_stat(&mut usage, "aquadevs", "deepseek-v4.1").errors += 1;

    assert_eq!(usage.models.len(), 2, "the same model name under two providers is two rows");
    let row = usage
        .models
        .get("logfare/deepseek-v4.1")
        .expect("rows are provider/model, never a chain alias");
    assert_eq!(row.ok, 1);
    assert_eq!(row.tokens_in, 10);
    assert_eq!(usage.models["aquadevs/deepseek-v4.1"].errors, 1);
}

#[test]
fn hourly_buckets_keep_tokens_and_outcomes_apart() {
    let mut usage = Usage::default();
    hour_stat(&mut usage).requests += 1;
    hour_stat(&mut usage).ok += 1;
    hour_stat(&mut usage).tokens_in += 5;
    hour_stat(&mut usage).tokens_out += 9;
    hour_stat(&mut usage).failed += 1;

    let key = super::metrics::hour_key();
    assert_eq!(key.len(), 2, "hour keys are HH so the frontend can slot them");
    let bucket = usage.hours.get(&key).expect("current hour is recorded");
    assert_eq!(bucket.requests, 1);
    assert_eq!(bucket.ok, 1);
    assert_eq!(bucket.failed, 1);
    assert_eq!(bucket.tokens_in, 5);
    assert_eq!(bucket.tokens_out, 9);
    assert_eq!(usage.hours.len(), 1, "one bucket per hour, not per request");
}

#[test]
fn lifetime_totals_outlive_the_seven_day_window() {
    let path = std::env::temp_dir().join(format!(
        "provider-proxy-lifetime-test-{}.db",
        now_ms()
    ));
    let storage = super::config::open_storage(&path).unwrap();
    let state = AppState {
        config_path: std::sync::Arc::new(path.clone()),
        storage: std::sync::Arc::new(storage),
        config: std::sync::Arc::new(std::sync::RwLock::new(json!({}))),
        chains: std::sync::Arc::new(std::sync::RwLock::new(Default::default())),
        cooldowns: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
        logs: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
        usage: std::sync::Arc::new(std::sync::Mutex::new(Usage::default())),
        usage_history: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
        usage_day: std::sync::Arc::new(std::sync::Mutex::new(String::new())),
        lifetime: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
        image_tasks: std::sync::Arc::new(std::sync::Mutex::new(Default::default())),
        client: reqwest::Client::new(),
        port: 0,
        log_max: 10,
    };
    {
        let mut lifetime = state.lifetime.lock().unwrap();
        lifetime.tokens_in = 1234;
        lifetime.tokens_out = 5678;
        lifetime.requests = 9;
    }
    super::metrics::persist_lifetime(&state);
    let reloaded = super::metrics::load_lifetime(&state.storage);
    assert_eq!(reloaded.tokens_in, 1234);
    assert_eq!(reloaded.tokens_out, 5678);
    assert_eq!(reloaded.requests, 9);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn starts_server_without_a_caller_tokio_runtime() {
    assert!(tokio::runtime::Handle::try_current().is_err());
    let path = std::env::temp_dir().join(format!(
        "provider-proxy-rust-runtime-test-{}.json",
        now_ms()
    ));
    fs::write(&path, r#"{"port":0,"providers":{},"models":{}}"#).unwrap();

    let server = start_server(path.clone()).unwrap();
    let address = format!("127.0.0.1:{}", server.port);
    let mut connection = TcpStream::connect(&address).unwrap();
    connection
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    connection
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    connection
        .write_all(b"GET /api/ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    connection.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(
        response.ends_with(r#"{"apiVersion":3,"ok":true}"#),
        "{response}"
    );
    let database = database_path(&path);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(database);
}

/// A second launch must not kill an unrelated program that happens to hold the
/// configured port. The takeover is gated on our own /api/ping signature.
#[tokio::test]
async fn does_not_shut_down_a_stranger_on_the_configured_port() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let stranger_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/api/ping",
            axum::routing::get(|| async { axum::Json(json!({ "service": "something-else" })) }),
        );
        let _ = axum::serve(listener, app).await;
    });

    let path = std::env::temp_dir().join(format!("provider-proxy-takeover-{}.json", now_ms()));
    fs::write(
        &path,
        json!({
            "port": stranger_port,
            "opencodeConfig": path.with_extension("opencode.json").display().to_string(),
            "providers": {},
            "models": {}
        })
        .to_string(),
    )
    .unwrap();

    assert!(
        !shutdown_running_instance(&path),
        "a service without our apiVersion must be left alone"
    );
    // Still alive: the stranger answers after the takeover attempt.
    let response = Client::new()
        .get(format!("http://127.0.0.1:{stranger_port}/api/ping"))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());

    let database = database_path(&path);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(database);
    let _ = fs::remove_file(path.with_extension("opencode.json"));
}

/// Reproduces the field crash: a long Russian answer split into many SSE
/// chunks used to panic when the 8 KiB usage tail was trimmed mid-character.
/// The client then saw a clean end of body with no error and the agent stopped
/// half-way. The response here must arrive complete, with [DONE].
#[tokio::test]
async fn streams_a_long_russian_answer_without_cutting_it_off() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async {
                let chunk = |text: &str| {
                    format!(
                        "data: {}\n\n",
                        json!({
                            "id": "chatcmpl-test",
                            "object": "chat.completion.chunk",
                            "model": "upstream-model",
                            "choices": [{ "index": 0, "delta": { "content": text }, "finish_reason": null }]
                        })
                    )
                };
                // Multi-byte characters, well past the 8 KiB tail limit.
                let mut body = String::new();
                for _ in 0..600 {
                    body.push_str(&chunk("Проверка кириллицы и длинного ответа — "));
                }
                body.push_str(&format!(
                    "data: {}\n\n",
                    json!({
                        "id": "chatcmpl-test",
                        "usage": { "prompt_tokens": 7, "completion_tokens": 11 }
                    })
                ));
                body.push_str("data: [DONE]\n\n");
                (
                    [("content-type", "text/event-stream")],
                    body,
                )
            }),
        );
        let _ = axum::serve(listener, app).await;
    });

    let path = std::env::temp_dir().join(format!("provider-proxy-cyrillic-{}.json", now_ms()));
    let opencode = path.with_extension("opencode.json");
    fs::write(&opencode, "{}").unwrap();
    fs::write(
        &path,
        json!({
            "port": 0,
            "opencodeConfig": opencode.display().to_string(),
            "providers": { "p": { "baseURL": format!("http://127.0.0.1:{upstream_port}/v1"), "apiKey": "k" } },
            "models": { "chain": { "upstreams": [{ "provider": "p", "model": "m" }] } }
        })
        .to_string(),
    )
    .unwrap();

    let server = start_server(path.clone()).unwrap();
    let response = Client::new()
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", server.port))
        .json(&json!({
            "model": "chain",
            "stream": true,
            "messages": [{ "role": "user", "content": "тест" }]
        }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let body = response.text().await.unwrap();

    assert!(body.ends_with("data: [DONE]\n\n"), "the stream must end with [DONE]");
    assert!(!body.contains("proxy_stream_error"), "the answer must not be cut off: {body:.200}");
    assert!(body.contains("Проверка кириллицы"), "the text must survive the rewrite");
    assert!(
        body.contains("\"prompt_tokens\":7"),
        "the usage chunk still reaches the client, which some clients rely on"
    );

    let database = database_path(&path);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(database);
    let _ = fs::remove_file(&opencode);
}

/// A 400 that is passed straight through is still an outcome. It used to return
/// before the counters, so the table showed one request with 0 ok / 0 err.
#[tokio::test]
async fn counts_a_passed_through_400_as_an_error() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(|| async {
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    axum::Json(json!({ "error": { "message": "messages: field required" } })),
                )
            }),
        );
        let _ = axum::serve(listener, app).await;
    });

    let path = std::env::temp_dir().join(format!("provider-proxy-400-{}.json", now_ms()));
    let opencode = path.with_extension("opencode.json");
    fs::write(&opencode, "{}").unwrap();
    fs::write(
        &path,
        json!({
            "port": 0,
            "opencodeConfig": opencode.display().to_string(),
            "providers": { "p": { "baseURL": format!("http://127.0.0.1:{upstream_port}/v1"), "apiKey": "k" } },
            "models": { "chain": { "upstreams": [{ "provider": "p", "model": "m" }] } }
        })
        .to_string(),
    )
    .unwrap();

    let server = start_server(path.clone()).unwrap();
    let client = Client::new();
    let response = client
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", server.port))
        .json(&json!({ "model": "chain", "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    let usage: Value = client
        .get(format!("http://127.0.0.1:{}/api/usage", server.port))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let provider = &usage["days"][0]["providers"]["p"];
    assert_eq!(provider["requests"], 1, "the attempt is counted: {usage}");
    assert_eq!(provider["errors"], 1, "a passed-through 400 is an error: {usage}");
    assert_eq!(provider["ok"], 0, "it is not a success: {usage}");

    let database = database_path(&path);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(database);
    let _ = fs::remove_file(&opencode);
}

/// Harness mode: a failing upstream must not end the run with 502. The proxy
/// waits out the cooldown and tries the chain again until something answers.
#[tokio::test]
async fn retries_the_chain_until_an_upstream_answers_in_retry_mode() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let calls = std::sync::Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move || {
                let counter = counter.clone();
                async move {
                    // Fail once, then answer: exactly the case where a plain
                    // failover would have already returned 502 to the client.
                    if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                        return axum::response::IntoResponse::into_response((
                            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                            axum::Json(json!({ "error": { "message": "boom" } })),
                        ));
                    }
                    axum::response::IntoResponse::into_response(axum::Json(json!({
                        "id": "chatcmpl-test",
                        "choices": [{ "index": 0, "message": { "role": "assistant", "content": "готово" }, "finish_reason": "stop" }],
                        "usage": { "prompt_tokens": 3, "completion_tokens": 2 }
                    })))
                }
            }),
        );
        let _ = axum::serve(listener, app).await;
    });

    let path = std::env::temp_dir().join(format!("provider-proxy-retry-{}.json", now_ms()));
    let opencode = path.with_extension("opencode.json");
    fs::write(&opencode, "{}").unwrap();
    fs::write(
        &path,
        json!({
            "port": 0,
            "retryForever": true,
            "errorCooldownSec": 1,
            "opencodeConfig": opencode.display().to_string(),
            "providers": { "p": { "baseURL": format!("http://127.0.0.1:{upstream_port}/v1"), "apiKey": "k" } },
            "models": { "chain": { "upstreams": [{ "provider": "p", "model": "m" }] } }
        })
        .to_string(),
    )
    .unwrap();

    let server = start_server(path.clone()).unwrap();
    let response = Client::new()
        .post(format!("http://127.0.0.1:{}/v1/chat/completions", server.port))
        .json(&json!({
            "model": "chain",
            "messages": [{ "role": "user", "content": "тест" }]
        }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "retry mode must wait and try again instead of failing the run"
    );
    assert!(calls.load(Ordering::SeqCst) >= 2, "the chain must be retried");

    let database = database_path(&path);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(database);
    let _ = fs::remove_file(&opencode);
}

#[tokio::test]
async fn serves_the_desktop_api_from_a_local_port() {
    let path = std::env::temp_dir().join(format!("provider-proxy-rust-test-{}.json", now_ms()));
    // Without an explicit opencodeConfig the config import below would rewrite
    // the developer's real ~/.config/opencode/opencode.jsonc.
    let opencode = path.with_extension("opencode.json");
    fs::write(&opencode, "{}").unwrap();
    fs::write(
        &path,
        format!(
            r#"{{"port":0,"providers":{{}},"models":{{"one":{{"upstreams":[]}}}},"opencodeConfig":"{}"}}"#,
            opencode.display()
        ),
    )
    .unwrap();
    let server = start_server(path.clone()).unwrap();
    let client = Client::new();
    let mut config = None;
    for _ in 0..20 {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{}/api/config", server.port))
            .send()
            .await
        {
            config = Some(response);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let config = config.expect("local Rust HTTP server should start");
    assert!(config.status().is_success());
    let exported = client
        .get(format!("http://127.0.0.1:{}/api/config/export", server.port))
        .send()
        .await
        .unwrap();
    assert!(exported.status().is_success());
    let exported: Value = exported.json().await.unwrap();
    assert!(exported["models"]["one"].is_object());
    let without_optional = client
        .get(format!(
            "http://127.0.0.1:{}/api/config/export?keys=false&chains=false&models=false",
            server.port
        ))
        .send()
        .await
        .unwrap();
    assert!(without_optional.status().is_success());
    let without_optional: Value = without_optional.json().await.unwrap();
    assert!(without_optional.get("models").is_none());
    let imported = client
        .post(format!("http://127.0.0.1:{}/api/config/import", server.port))
        .json(&json!({ "appSettings": { "theme": "light" } }))
        .send()
        .await
        .unwrap();
    assert!(imported.status().is_success());
    let models: Value = client
        .get(format!("http://127.0.0.1:{}/v1/models", server.port))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], "one");
    let database = database_path(&path);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(database);
    let _ = fs::remove_file(&opencode);
}
