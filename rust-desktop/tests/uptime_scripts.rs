//! The uptime scripts for the two real status pages, run against recorded
//! answers. The scripts are the provider-specific part, so they are checked the
//! way the proxy runs them: a file on disk, JSON on stdout, no network.
//!
//! `PP_UPTIME_FIXTURE` makes both scripts read `tests/uptime/*.json` instead of
//! calling the provider, so the test is offline and does not spend a provider's
//! rate limit.

use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/uptime")
}

/// `None` when the machine has no Python at all: the parsers are shipped as
/// examples, and a missing interpreter must not fail the Rust suite.
fn run_script(name: &str, extra: &[(&str, &str)]) -> Option<Value> {
    let dir = fixture_dir();
    let mut command = Command::new(std::env::var("PP_PYTHON").unwrap_or_else(|_| "python3".into()));
    command
        .arg(dir.join(name))
        .env("PP_UPTIME_FIXTURE", &dir)
        // Never used: with a fixture the model list comes from the folder.
        .env("PP_MODELS_API", "http://127.0.0.1:9/unused")
        .env("PP_PROXY_URL", "http://127.0.0.1:9");
    for (key, value) in extra {
        command.env(key, value);
    }
    let output = command.output().ok()?;
    assert!(
        output.status.success(),
        "{name} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bars: Value = serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|error| panic!("{name} printed no JSON: {error}"));
    Some(bars)
}

fn bar<'a>(payload: &'a Value, label: &str) -> &'a Value {
    payload["bars"]
        .as_array()
        .expect("bars")
        .iter()
        .find(|bar| bar["label"] == label)
        .unwrap_or_else(|| panic!("no bar for {label}"))
}

#[test]
fn the_aquadevs_script_reads_both_its_endpoints() {
    let Some(payload) = run_script("aquadevs.py", &[]) else {
        eprintln!("python3 not found, skipping");
        return;
    };
    assert_eq!(payload["window"], "24h");
    // uptimeList["<id>_24"] is a share, so the bar shows it as a percentage.
    let glm = bar(&payload, "glm-5.3");
    assert_eq!(glm["percent24h"], 64.2);
    assert_eq!(glm["percent1h"], 100.0);
    // ping comes from heartbeatList, averaged over the recorded beats.
    assert!(glm["latencyMs"].as_f64().unwrap() > 0.0);
    // The day strip is the beats of the last 24 hours, not the whole page
    // history (the page returns about eight days, one beat per four hours).
    let day = glm["cells24h"].as_array().unwrap();
    assert!(
        (6..=50).contains(&day.len()),
        "a day of beats, not eight days: {}",
        day.len()
    );
    // The hour strip is the last beat alone, so a skipped monitor cannot
    // stretch it into four hours; its percentage agrees with that box.
    assert_eq!(glm["cells1h"].as_array().unwrap().len(), 1);
    let boxed = glm["cells1h"][0]["percent"].as_f64().unwrap();
    assert_eq!(glm["percent1h"].as_f64().unwrap(), boxed);
    assert!(glm["cells24h"][0]["t"].is_string(), "a beat carries its time");
    // A model id the status page does not list gets a bar with no number: the
    // GUI draws it as "no data", and a zero would read as a dead model.
    assert!(bar(&payload, "no-such-model")["percent"].is_null());
}

/// One run answers both windows, like aquadevs: the dialog's "24 ч / 1 ч"
/// switch appears only when every bar carries both percentages.
#[test]
fn the_logfare_script_reports_both_windows_and_their_cells() {
    let Some(payload) = run_script("logfare.py", &[]) else {
        eprintln!("python3 not found, skipping");
        return;
    };
    assert_eq!(payload["window"], "24h");
    let model = bar(&payload, "deepseek-v4.1-flash");
    assert_eq!(model["percent24h"], 71.5);
    assert_eq!(model["percent1h"], 40.2, "the hour comes from its own request");
    // The summary carries speed and latency, so the dialog can show them.
    assert!(model["tps"].as_f64().unwrap() > 0.0);
    assert!(model["ttftMs"].as_f64().unwrap() > 0.0);
    assert!(model["latencyMs"].as_f64().unwrap() > 0.0);

    // Cells are the history buckets, one box per interval, with their time.
    for field in ["cells24h", "cells1h"] {
        let cells = model[field].as_array().unwrap_or_else(|| panic!("{field}"));
        assert!(cells.len() > 10, "{field} is a strip, not one box");
        // A bucket without an uptime reading keeps its slot but no number: the
        // GUI draws it grey instead of dropping it out of the strip.
        assert!(cells.iter().all(|cell| cell["t"].is_string()), "{field} keeps every slot");
        assert!(cells.iter().any(|cell| cell["percent"].is_number()), "{field} carries numbers");
    }
    // A model the status page does not know still gets a bar at zero.
    assert_eq!(bar(&payload, "no-such-model")["percent"], 0.0);
}

#[test]
fn recorded_answers_are_the_shape_the_parsers_expect() {
    // Guards the fixtures themselves: a hand-trimmed file that lost the arrays
    // would make the scripts silently print zeros.
    for name in [
        "aq-monitors.json",
        "aq-heartbeat.json",
        "lf-24.json",
        "lf-1.json",
        "lf-hist-24.json",
        "lf-hist-1.json",
    ] {
        let raw = fs::read_to_string(fixture_dir().join(name)).expect(name);
        let value: Value = serde_json::from_str(&raw).expect(name);
        assert!(value.is_object(), "{name}");
    }
    let heartbeat: Value =
        serde_json::from_str(&fs::read_to_string(fixture_dir().join("aq-heartbeat.json")).unwrap())
            .unwrap();
    assert!(heartbeat["uptimeList"].as_object().unwrap().len() > 1);
    assert!(heartbeat["heartbeatList"].as_object().unwrap().len() > 1);
}

/// The two headers that broke the live run: without the token the proxy answers
/// 401 on the models API, and without a User-Agent the aquadevs status page
/// answers 403. A one-shot server checks what the scripts actually send.
#[test]
fn the_uptime_scripts_send_the_token_and_a_user_agent() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    let Some(python) = std::env::var("PP_PYTHON")
        .ok()
        .or_else(|| Command::new("python3").arg("--version").output().ok().map(|_| "python3".into()))
    else {
        eprintln!("python3 not found, skipping");
        return;
    };
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let address = listener.local_addr().expect("addr");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buffer[..read]).to_string());
            let body = r#"{"provider":"p","models":["m1"]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });

    let dir = fixture_dir();
    // open_url is the single place both scripts reach the network through, so
    // checking its headers covers the models API and the status pages alike.
    let script = format!(
        "import sys, json; sys.path.insert(0, {dir:?}); import logfare; print(json.load(logfare.open_url(__import__('os').environ['PP_MODELS_API']))['models'])",
        dir = dir.to_string_lossy()
    );
    let output = Command::new(python)
        .arg("-c")
        .arg(script)
        .env("PP_MODELS_API", format!("http://{address}/api/provider-models-list?provider=p"))
        .env("PP_PROXY_TOKEN", "secret-token")
        .output()
        .expect("ran python");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("m1"));

    let request = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("a request arrived");
    let lower = request.to_lowercase();
    assert!(lower.contains("authorization: bearer secret-token"), "the proxy token must be sent:\n{request}");
    assert!(lower.contains("user-agent:"), "the status pages reject a bare urllib request:\n{request}");
}
