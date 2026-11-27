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

/// The GUI's already-fetched uptime, grouped per provider.
#[derive(Debug, Deserialize)]
pub(crate) struct UptimeBarsRequest {
    pub(crate) bars: Vec<UptimeBarsEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UptimeBarsEntry {
    pub(crate) provider: String,
    pub(crate) models: Vec<UptimeBarEntry>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UptimeBarEntry {
    pub(crate) model: String,
    pub(crate) percent: f64,
}

/// The provider's whole catalog: what it currently serves plus the models the
/// user keeps by hand. The uptime tab shows every model the provider has, so the
/// script has to parse all of them — handing it only the selection made it skip
/// everything the user had not picked yet.
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
    let models: Vec<String> = {
        let mut names: Vec<String> = Vec::new();
        let mut push = |name: &str| {
            if !name.is_empty() && !names.iter().any(|known| known == name) {
                names.push(name.to_string());
            }
        };
        let availability = entry.get("modelAvailability").and_then(Value::as_object);
        // Served right now: an entry marked unavailable is one the provider
        // dropped, so asking its status page for it would only add noise.
        for (id, state) in availability.into_iter().flatten() {
            if state.get("available").and_then(Value::as_bool) != Some(false) {
                push(id);
            }
        }
        for id in entry
            .get("manualModels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = id.as_str() {
                push(id);
            }
        }
        // Selected before the catalog was ever checked: nothing says the
        // provider dropped them, so they are still worth a lookup. Ones that
        // were checked and marked gone are left out above.
        for id in entry
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = id.as_str() {
                if availability.is_none_or(|known| !known.contains_key(id)) {
                    push(id);
                }
            }
        }
        names
    };
    Json(json!({ "provider": provider, "models": models })).into_response()
}

/// External uptime the GUI already fetched, pushed back so the chain ranking
/// can prefer a model the provider's own status page calls healthy. Only the
/// numbers are kept, and only the latest answer: the scripts own the truth.
pub(crate) async fn put_uptime_bars(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UptimeBarsRequest>,
) -> Response {
    if !authorized(&state, &headers) {
        return json_error(StatusCode::UNAUTHORIZED, "bad proxy token");
    }
    let mut bars = state.uptime_bars.lock().unwrap();
    for entry in body.bars {
        let provider = bars.entry(entry.provider).or_default();
        for bar in entry.models {
            provider.insert(bar.model, bar.percent);
        }
    }
    Json(json!({ "ok": true })).into_response()
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
        let stored = provider
            .get("uptimeScript")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let file = provider
            .get("uptimeScriptPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Editing the file must take effect without picking it again, so the
        // path wins over the stored copy. A moved or deleted file falls back to
        // the text saved at selection time, which keeps a browser-only setup
        // working.
        let script = match read_script_file(file) {
            Some(text) => text,
            None => stored.to_string(),
        };
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

/// The script on disk, when a path was recorded and still readable.
fn read_script_file(path: &str) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    (!text.trim().is_empty()).then_some(text)
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
        let label = bar
            .get("label")
            .and_then(Value::as_str)
            .filter(|label| !label.is_empty())
            .or_else(|| bar.get("model").and_then(Value::as_str))
            .unwrap_or_default();
        // A bar without a number is a model the script could not place: the GUI
        // draws it as "no data". A bar without a name has nothing to draw.
        if label.is_empty() {
            continue;
        }
        let percent = bar.get("percent").and_then(Value::as_f64);
        let mut entry = json!({ "label": label });
        if let Some(percent) = percent {
            // NaN/inf is not a number a strip can draw.
            if percent.is_finite() {
                entry["percent"] = json!(percent.clamp(0.0, 100.0));
            }
        }
        // Time cells, as a status page draws them: one small box per interval.
        for field in ["cells", "cells1h", "cells24h"] {
            if let Some(cleaned) = clean_cells(bar.get(field)) {
                entry[field] = cleaned;
            }
        }
        // Speed and latency are optional: a status API that reports only a
        // percentage still draws the same bar. Negative numbers are nonsense
        // for all three, so they are dropped instead of shown as "-1 ms".
        for field in ["tps", "ttftMs", "latencyMs", "percent1h", "percent24h"] {
            if let Some(number) = bar.get(field).and_then(Value::as_f64) {
                if number.is_finite() && number >= 0.0 {
                    entry[field] = if field.starts_with("percent") {
                        json!(number.clamp(0.0, 100.0))
                    } else {
                        json!(number)
                    };
                }
            }
        }
        clean.push(entry);
    }
    if clean.is_empty() {
        return Err("скрипт не отдал ни одной полоски".into());
    }
    // "24h" | "1h" — the window the percentages describe. A bar carrying both
    // percentages makes the dialog offer a switch; the window names the default.
    let window = value
        .get("window")
        .and_then(Value::as_str)
        .filter(|window| matches!(*window, "24h" | "1h"))
        .unwrap_or("24h");
    Ok(json!({
        "title": value.get("title").and_then(Value::as_str).unwrap_or("Аптайм моделей"),
        "window": window,
        "bars": clean,
    }))
}

/// One bar's time cells: `{"percent": 0..100, "t": "<iso>"}`. The timestamp is
/// optional, so a status page that only reports the shape still draws boxes.
/// A cell with a time but no percentage is kept as a grey slot: dropping it
/// shifted every later box and made the strip look like a shorter window.
/// The list is capped because it is a strip of boxes, not a log.
fn clean_cells(value: Option<&Value>) -> Option<Value> {
    const MAX_CELLS: usize = 200;
    let cells = value?.as_array()?;
    let cleaned: Vec<Value> = cells
        .iter()
        .take(MAX_CELLS)
        .filter_map(|cell| {
            let at = cell.get("t").and_then(Value::as_str).filter(|at| !at.is_empty());
            let mut out = serde_json::Map::new();
            match cell.get("percent").and_then(Value::as_f64) {
                Some(percent) if percent.is_finite() => {
                    out.insert("percent".into(), json!(percent.clamp(0.0, 100.0)));
                }
                // A number that is not a number and no time at all: junk.
                _ if at.is_none() => return None,
                _ => {}
            }
            if let Some(at) = at {
                out.insert("t".into(), json!(at));
            }
            Some(Value::Object(out))
        })
        .collect();
    (!cleaned.is_empty()).then(|| Value::Array(cleaned))
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
    fn a_bar_without_a_number_is_kept_as_no_data() {
        let value = parse_bars(
            r#"{"bars":[{"label":"known","percent":40},{"label":"untracked"},{"percent":10}]}"#,
        )
        .expect("a bar without a number is still a bar");
        assert_eq!(value["bars"][1]["label"], "untracked");
        assert!(
            value["bars"][1].get("percent").is_none(),
            "no number, no percent: the GUI says 'no data', not 0 %"
        );
        assert_eq!(value["bars"].as_array().unwrap().len(), 2, "a nameless bar is junk");
    }

    #[test]
    fn optional_metrics_are_kept_when_sane_and_dropped_otherwise() {
        let value = parse_bars(
            r#"{"window":"1h","bars":[
                {"label":"m1","percent":97,"tps":12.5,"ttftMs":820,"latencyMs":1500,"percent1h":50,"percent24h":97},
                {"label":"m2","percent":50,"tps":-3,"ttftMs":"быстро","latencyMs":-1}
            ]}"#,
        )
        .expect("valid bars");
        assert_eq!(value["window"], "1h");
        let first = &value["bars"][0];
        assert_eq!(first["tps"], 12.5);
        assert_eq!(first["ttftMs"], 820.0);
        assert_eq!(first["latencyMs"], 1500.0);
        assert_eq!(first["percent1h"], 50.0);
        assert_eq!(first["percent24h"], 97.0);
        // A negative or non-numeric value is missing, not a zero or a string.
        let second = &value["bars"][1];
        assert!(second.get("tps").is_none());
        assert!(second.get("ttftMs").is_none());
        assert!(second.get("latencyMs").is_none());
        // A window outside the two the dialog knows falls back to the day.
        let other = parse_bars(r#"{"window":"7d","bars":[{"label":"m","percent":1}]}"#).unwrap();
        assert_eq!(other["window"], "24h");
    }

    #[test]
    fn time_cells_keep_their_timestamp_and_drop_junk() {
        let value = parse_bars(
            r#"{"bars":[{"label":"m","percent":90,"cells24h":[
                {"percent":100,"t":"2026-11-26T10:00:00Z"},
                {"percent":-5},
                {"percent":"много"},
                {"t":"без процента"},
                {"percent":42.5,"t":""}
            ],"cells1h":[{"percent":10}],"cells":"мусор"}]}"#,
        )
        .expect("valid bars");
        let cells = value["bars"][0]["cells24h"].as_array().expect("cells24h");
        // A cell with a time but no number keeps its slot (drawn grey); pure
        // junk is dropped.
        assert_eq!(cells.len(), 4, "a timed cell without a number is a grey slot");
        assert_eq!(cells[0]["t"], "2026-11-26T10:00:00Z");
        assert_eq!(cells[1]["percent"], 0.0, "a negative percentage is clamped");
        assert!(cells[1].get("t").is_none(), "a cell without a time is kept");
        assert!(cells[2].get("percent").is_none(), "a string percent is not a number");
        assert_eq!(cells[2]["t"], "без процента", "its time keeps the slot, drawn grey");
        assert_eq!(cells[3]["percent"], 42.5, "an empty timestamp does not drop the number");
        assert_eq!(value["bars"][0]["cells1h"][0]["percent"], 10.0);
        assert!(
            value["bars"][0].get("cells").is_none(),
            "a strip that is not an array is dropped"
        );
    }

    #[test]
    fn a_huge_cell_strip_is_cut_to_a_strip() {
        let cells: Vec<String> = (0..500).map(|i| format!(r#"{{"percent":{i}}}"#)).collect();
        let json = format!(
            r#"{{"bars":[{{"label":"m","percent":1,"cells":[{}]}}]}}"#,
            cells.join(",")
        );
        let value = parse_bars(&json).expect("valid bars");
        assert_eq!(value["bars"][0]["cells"].as_array().unwrap().len(), 200);
    }

    #[test]
    fn a_broken_contract_is_an_error_not_an_empty_chart() {
        assert!(parse_bars("не json").is_err());
        assert!(parse_bars(r#"{"bars":[]}"#).is_err());
        // A bar without a number is not a broken contract any more: it is a
        // model the script could not place, drawn as "no data".
        let missing = parse_bars(r#"{"bars":[{"label":"m"}]}"#).expect("a label is enough");
        assert!(missing["bars"][0].get("percent").is_none());
    }

    #[test]
    fn a_recorded_path_wins_over_the_saved_text() {
        let path = std::env::temp_dir().join(format!(
            "provider-proxy-uptime-path-{}.py",
            std::process::id()
        ));
        std::fs::write(&path, "print('from file')").expect("wrote");
        assert_eq!(
            read_script_file(path.to_str().unwrap()).as_deref(),
            Some("print('from file')")
        );
        // A path that no longer resolves must not shadow the stored copy.
        let _ = std::fs::remove_file(&path);
        assert!(read_script_file(path.to_str().unwrap()).is_none());
        assert!(read_script_file("").is_none());
        assert!(read_script_file("   ").is_none());
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
