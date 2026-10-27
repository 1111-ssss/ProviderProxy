use chrono::Local;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::types::{AppState, ModelUsage, ProviderUsage, Usage};

pub(crate) const USAGE_RETENTION_DAYS: usize = 7;

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn local_day_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn usage_day_keys(today: &str) -> Vec<String> {
    let Some(mut date) = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok() else {
        return vec![today.to_string()];
    };
    let mut keys = Vec::with_capacity(USAGE_RETENTION_DAYS);
    for _ in 0..USAGE_RETENTION_DAYS {
        keys.push(date.format("%Y-%m-%d").to_string());
        date -= chrono::Duration::days(1);
    }
    keys
}

#[derive(Debug, Deserialize, Default)]
struct StoredUsage {
    #[serde(default)]
    days: HashMap<String, Usage>,
}

pub(crate) fn load_usage(path: &Path) -> (Usage, HashMap<String, Usage>, String) {
    let today = local_day_key();
    let mut history = fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<StoredUsage>(&text).ok())
        .map(|stored| stored.days)
        .unwrap_or_default();
    let keep: std::collections::HashSet<_> = usage_day_keys(&today).into_iter().collect();
    history.retain(|date, _| keep.contains(date));
    let mut usage = history.get(&today).cloned().unwrap_or_default();
    usage.since = now_ms();
    (usage, history, today)
}

pub(crate) fn roll_usage_day(state: &AppState) {
    let today = local_day_key();
    let mut current_day = state.usage_day.lock().unwrap();
    if *current_day == today {
        return;
    }
    let current = state.usage.lock().unwrap().clone();
    state
        .usage_history
        .lock()
        .unwrap()
        .insert(current_day.clone(), current);
    let mut next = state
        .usage_history
        .lock()
        .unwrap()
        .get(&today)
        .cloned()
        .unwrap_or_default();
    next.since = now_ms();
    *state.usage.lock().unwrap() = next;
    *current_day = today;
}

pub(crate) fn persist_usage(state: &AppState) {
    roll_usage_day(state);
    let today = state.usage_day.lock().unwrap().clone();
    let current = state.usage.lock().unwrap().clone();
    let mut history = state.usage_history.lock().unwrap();
    history.insert(today.clone(), current);
    let keep: std::collections::HashSet<_> = usage_day_keys(&today).into_iter().collect();
    history.retain(|date, _| keep.contains(date));
    let stored = json!({
        "version": 1,
        "retentionDays": USAGE_RETENTION_DAYS,
        "days": &*history,
    });
    if let Some(parent) = state.stats_path.parent() {
        // A test/app shutdown may remove a temporary config directory while the
        // persistence worker is still winding down. Do not recreate it.
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return;
        }
    }
    if let Err(err) = fs::write(
        &*state.stats_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&stored).unwrap_or_else(|_| "{}".into())
        ),
    ) {
        push_log(
            state,
            format!(
                "usage: не удалось сохранить историю {}: {err}",
                state.stats_path.display()
            ),
        );
    }
}

pub(crate) fn usage_history_view(state: &AppState) -> Vec<Value> {
    roll_usage_day(state);
    let today = state.usage_day.lock().unwrap().clone();
    let history = state.usage_history.lock().unwrap();
    usage_day_keys(&today)
        .into_iter()
        .map(|date| {
            let snapshot = history.get(&date).cloned().unwrap_or_default();
            let mut value = serde_json::to_value(snapshot).unwrap_or_else(|_| json!({}));
            if let Value::Object(object) = &mut value {
                object.insert("date".into(), Value::String(date));
            }
            value
        })
        .collect()
}

pub(crate) fn push_log(state: &AppState, message: impl Into<String>) {
    let line = format!(
        "[{}] {}",
        Local::now().format("%Y-%m-%d %H:%M:%S"),
        message.into()
    );
    println!("{line}");
    let mut logs = state.logs.lock().unwrap();
    logs.push_back(line);
    while logs.len() > state.log_max {
        logs.pop_front();
    }
}

pub(crate) fn provider_stat<'a>(usage: &'a mut Usage, name: &str) -> &'a mut ProviderUsage {
    usage.providers.entry(name.to_string()).or_default()
}

pub(crate) fn model_stat<'a>(usage: &'a mut Usage, name: &str) -> &'a mut ModelUsage {
    usage.models.entry(name.to_string()).or_default()
}

pub(crate) fn tally_usage(
    text: &str,
    usage: &mut Usage,
    provider: &mut ProviderUsage,
    model: &mut ModelUsage,
) {
    let Some(start) = text.rfind("\"usage\"") else {
        return;
    };
    let tail = &text[start..];
    let number = |key: &str| {
        let marker = format!("\"{key}\"");
        let Some(pos) = tail.find(&marker) else {
            return 0;
        };
        tail[pos + marker.len()..]
            .split(|c: char| !c.is_ascii_digit())
            .find(|part| !part.is_empty())
            .and_then(|part| part.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let input = number("prompt_tokens");
    let output = number("completion_tokens");
    usage.tokens_in += input;
    usage.tokens_out += output;
    provider.tokens_in += input;
    provider.tokens_out += output;
    model.tokens_in += input;
    model.tokens_out += output;
}

pub(crate) fn cooldown_snapshot(state: &AppState) -> Vec<Value> {
    let now = std::time::Instant::now();
    state
        .cooldowns
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, until)| **until > now)
        .map(|(key, until)| {
            let mut parts = key.split('|');
            json!({
                "model": parts.next().unwrap_or_default(),
                "upstream": parts.next().unwrap_or_default(),
                "until": now_ms() + until.saturating_duration_since(now).as_millis()
            })
        })
        .collect()
}
