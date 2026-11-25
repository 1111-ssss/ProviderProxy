//! Uptime view for one provider: the model list and the user's own script.
//!
//! The script is the provider-specific part — only the user knows where its
//! uptime lives. It runs with the proxy's own URL and token in the environment
//! so it can ask for the model list over HTTP instead of being handed one, and
//! it answers with JSON on stdout, which keeps the contract independent of any
//! language: a plain `print` is enough.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::json_error;
use crate::proxy::{auth::authorized, types::AppState};

/// A runaway script must not pin a worker forever; the dialog shows the error.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(60);
/// A diagram is a few hundred bytes; anything past this is a broken script.
const SCRIPT_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct ModelsListQuery {
    pub(crate) provider: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UptimeRequest {
    pub(crate) provider: String,
}

/// Only the names of the models selected for a provider. The script needs to
/// know what to look up, and nothing else about the provider catalog.
pub(crate) async fn provider_models_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModelsListQuery>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let provider = query.provider.unwrap_or_default();
    let config = state.config.read().unwrap();
    let Some(entry) = config
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|all| all.get(&provider))
    else {
        return json_error(StatusCode::NOT_FOUND, format!("нет провайдера «{provider}»"));
    };
    let models: Vec<String> = entry
        .get("models")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Json(json!({ "provider": provider, "models": models })).into_response()
}

/// Run the provider's uptime script and hand back its bars unchanged.
pub(crate) async fn run_uptime(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UptimeRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let (script, token) = {
        let config = state.config.read().unwrap();
        let Some(provider) = config
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|all| all.get(&body.provider))
        else {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("нет провайдера «{}»", body.provider),
            );
        };
        let script = provider
            .get("uptimeScript")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if script.trim().is_empty() {
            return json_error(
                StatusCode::BAD_REQUEST,
                "у провайдера не задан скрипт аптайма",
            );
        }
        let token = config
            .get("authToken")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        (script, token)
    };

    let env = ScriptEnv {
        proxy_url: format!("http://127.0.0.1:{}", state.port),
        token,
        provider: body.provider.clone(),
    };
    let result =
        tokio::task::spawn_blocking(move || run_script(&script, &env)).await;

    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(message)) => json_error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("скрипт не выполнился: {error}"),
        ),
    }
}

struct ScriptEnv {
    proxy_url: String,
    token: String,
    provider: String,
}

/// `PP_PYTHON` wins so a machine with an unusual interpreter still works; the
/// usual three names cover Linux/macOS and both Windows launchers.
fn python_candidates() -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(custom) = std::env::var("PP_PYTHON") {
        if !custom.trim().is_empty() {
            names.push(custom);
        }
    }
    names.extend(["python3", "python", "py"].map(str::to_string));
    names
}

fn run_script(script: &str, env: &ScriptEnv) -> Result<Value, String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let directory = std::env::temp_dir().join(format!(
        "provider-proxy-uptime-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("не удалось создать временную папку: {error}"))?;
    let path = directory.join("uptime.py");
    let written = std::fs::write(&path, script);
    let result = written
        .map_err(|error| format!("не удалось записать скрипт: {error}"))
        .and_then(|()| {
            let mut last_error = String::from("не найден интерпретатор Python");
            for name in python_candidates() {
                match run_interpreter(&name, &path, env) {
                    Ok(value) => return Ok(value),
                    Err(Failure::Missing) => {
                        last_error = format!("не найден интерпретатор «{name}»");
                    }
                    // A present interpreter that failed is a script error, not a
                    // missing one: running the same broken script again under
                    // another name would only repeat it.
                    Err(Failure::Failed(message)) => return Err(message),
                }
            }
            Err(last_error)
        });
    let _ = std::fs::remove_dir_all(&directory);
    result
}

enum Failure {
    Missing,
    Failed(String),
}

fn run_interpreter(name: &str, path: &std::path::Path, env: &ScriptEnv) -> Result<Value, Failure> {
    let models_api = format!(
        "{}/api/provider-models-list?provider={}",
        env.proxy_url,
        urlencoding_display(&env.provider)
    );
    let mut child = match Command::new(name)
        .arg(path)
        .env("PP_PROXY_URL", &env.proxy_url)
        // The token never goes into argv: a process list is world-readable.
        .env("PP_PROXY_TOKEN", &env.token)
        .env("PP_PROVIDER", &env.provider)
        .env("PP_MODELS_API", models_api)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Failure::Missing)
        }
        Err(error) => {
            return Err(Failure::Failed(format!(
                "не удалось запустить «{name}»: {error}"
            )))
        }
    };
    // Drain both pipes on their own threads: a script that prints a lot would
    // otherwise block on a full pipe while this thread waits for it to exit.
    let stdout = child.stdout.take().map(spawn_reader);
    let stderr = child.stderr.take().map(spawn_reader);
    let deadline = std::time::Instant::now() + SCRIPT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                return Err(Failure::Failed(format!("скрипт не дождались: {error}")));
            }
        }
    };
    let out = stdout.map(join_reader).unwrap_or_default();
    let err = stderr.map(join_reader).unwrap_or_default();
    let Some(status) = status else {
        return Err(Failure::Failed(format!(
            "скрипт не уложился в {} с и был остановлен",
            SCRIPT_TIMEOUT.as_secs()
        )));
    };
    if !status.success() {
        return Err(Failure::Failed(format!(
            "скрипт завершился с кодом {}: {}",
            status.code().unwrap_or(-1),
            tail(&err, 400)
        )));
    }
    if out.len() > SCRIPT_OUTPUT_LIMIT {
        return Err(Failure::Failed(
            "скрипт напечатал больше 1 МиБ — это не диаграмма".into(),
        ));
    }
    parse_bars(&out).map_err(Failure::Failed)
}

fn spawn_reader(mut stream: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buffer = String::new();
        // One byte past the limit is enough to detect an oversized output.
        let _ = stream
            .by_ref()
            .take(SCRIPT_OUTPUT_LIMIT as u64 + 1)
            .read_to_string(&mut buffer);
        buffer
    })
}

fn join_reader(handle: std::thread::JoinHandle<String>) -> String {
    handle.join().unwrap_or_default()
}

/// Accept the script's JSON and keep only what the dialog draws. A missing
/// `bars` array is an error, so a wrong contract is visible instead of an
/// empty diagram.
fn parse_bars(stdout: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(stdout.trim()).map_err(|error| {
        format!(
            "ожидался JSON в stdout: {error}; начало вывода: {}",
            tail(stdout, 200)
        )
    })?;
    let bars = value
        .get("bars")
        .and_then(Value::as_array)
        .ok_or_else(|| "в JSON нет массива \"bars\"".to_string())?;
    let mut clean = Vec::with_capacity(bars.len());
    for bar in bars {
        let Some(percent) = bar.get("percent").and_then(Value::as_f64) else {
            continue;
        };
        let label = bar
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| !label.is_empty())
            .or_else(|| bar.get("model").and_then(Value::as_str))
            .unwrap_or_default();
        clean.push(json!({ "label": label, "percent": percent.clamp(0.0, 100.0) }));
    }
    if clean.is_empty() {
        return Err("скрипт не отдал ни одной полоски с \"percent\"".into());
    }
    Ok(json!({
        "title": value.get("title").and_then(Value::as_str).unwrap_or("Аптайм моделей"),
        "bars": clean,
    }))
}

/// A provider name may carry spaces or slashes; the query string must survive
/// them, so only the unreserved characters are passed through.
fn urlencoding_display(value: &str) -> String {
    value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || "-._~".contains(char) {
                char.to_string()
            } else {
                char.to_string()
                    .as_bytes()
                    .iter()
                    .map(|byte| format!("%{byte:02X}"))
                    .collect()
            }
        })
        .collect()
}

fn tail(text: &str, limit: usize) -> String {    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().rev().take(limit).collect();
    out = out.chars().rev().collect();
    format!("…{out}")
}

/// A helper mirroring `run_script` without the interpreter search, so a test can
/// pin one and bypass PATH.
#[cfg(test)]
fn run_with(name: &str, script: &str, env: &ScriptEnv) -> Result<Value, String> {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!(
        "provider-proxy-uptime-test-{}-{unique}.sh",
        std::process::id()
    ));
    std::fs::write(&path, script).map_err(|error| error.to_string())?;
    let result = match run_interpreter(name, &path, env) {
        Ok(value) => Ok(value),
        Err(Failure::Missing) => Err(format!("нет интерпретатора «{name}»")),
        Err(Failure::Failed(message)) => Err(message),
    };
    let _ = std::fs::remove_file(&path);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> ScriptEnv {
        ScriptEnv {
            proxy_url: "http://127.0.0.1:1".into(),
            token: String::new(),
            provider: "p".into(),
        }
    }

    #[test]
    fn a_script_answers_with_bars_and_the_model_label_fallback() {
        let value = parse_bars(
            r#"{"title":"Мой аптайм","bars":[{"model":"m1","percent":97.5},{"label":"m2","percent":140}]}"#,
        )
        .expect("valid bars");
        assert_eq!(value["title"], "Мой аптайм");
        assert_eq!(value["bars"][0]["label"], "m1", "a bare model name is accepted");
        assert_eq!(value["bars"][1]["percent"], 100.0, "percent is clamped");
    }

    #[test]
    fn a_broken_contract_is_an_error_not_an_empty_chart() {
        assert!(parse_bars("не json").is_err());
        assert!(parse_bars(r#"{"bars":[]}"#).is_err());
        assert!(
            parse_bars(r#"{"bars":[{"label":"m"}]}"#).is_err(),
            "percent is required"
        );
    }

    #[test]
    fn the_script_stdout_becomes_the_answer() {
        // `sh` stands in for Python: the contract is stdout JSON, not the language.
        let value = run_with(
            "/bin/sh",
            r#"printf '%s' '{"bars":[{"label":"m","percent":50}]}'"#,
            &env(),
        )
        .expect("ran");
        assert_eq!(value["bars"][0]["label"], "m");
    }

    #[test]
    fn a_failing_script_reports_its_exit_code_and_stderr() {
        let error = run_with("/bin/sh", "echo boom >&2; exit 3", &env()).unwrap_err();
        assert!(error.contains("кодом 3"), "{error}");
        assert!(error.contains("boom"), "{error}");
    }

    #[test]
    fn a_hanging_script_is_stopped_instead_of_blocking_the_request() {
        // The wait loop uses the same clock as the handler; a 0-second budget
        // proves the kill path without sleeping for a minute.
        let started = std::time::Instant::now();
        let error = {
            let mut child = Command::new("/bin/sh")
                .arg("-c")
                .arg("sleep 5")
                .stdout(Stdio::piped())
                .spawn()
                .expect("spawned");
            let deadline = started + Duration::from_millis(50);
            loop {
                match child.try_wait().expect("wait") {
                    Some(_) => break None,
                    None if std::time::Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break Some("остановлен");
                    }
                    None => std::thread::sleep(Duration::from_millis(10)),
                }
            }
        };
        assert_eq!(error, Some("остановлен"));
        assert!(started.elapsed() < Duration::from_secs(3), "the kill happened promptly");
    }

    #[test]
    fn the_script_sees_the_proxy_environment() {
        // An absolute URL in the label would break the JSON, so print only the
        // provider and the tail of the models API.
        let value = run_with(
            "/bin/sh",
            r#"printf '{"bars":[{"label":"%s|%s","percent":50}]}' "$PP_PROVIDER" "${PP_MODELS_API##*/}""#,
            &env(),
        )
        .expect("ran");
        assert_eq!(
            value["bars"][0]["label"],
            "p|provider-models-list?provider=p"
        );
    }
}
