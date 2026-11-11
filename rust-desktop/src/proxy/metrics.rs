use chrono::Local;
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{
    config::Storage,
    types::{AppState, HourUsage, LifetimeTokens, ModelUsage, ProviderUsage, Usage, MODEL_ROWS_VERSION},
};

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

pub(crate) fn load_usage(
    storage: &Storage,
    legacy_path: &Path,
) -> (Usage, HashMap<String, Usage>, String) {
    let today = local_day_key();
    let mut history = HashMap::new();
    let Ok(mut connection) = storage.connection.lock() else {
        return (Usage::default(), history, today);
    };
    let count = connection
        .query_row("SELECT COUNT(*) FROM usage_days", [], |row| {
            row.get::<_, u64>(0)
        })
        .unwrap_or(0);
    if count == 0 {
        if let Ok(text) = fs::read_to_string(legacy_path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                if let Some(days) = value.get("days").and_then(Value::as_object) {
                    if let Ok(transaction) = connection.transaction() {
                        {
                            if let Ok(mut insert) = transaction.prepare(
                                "INSERT OR IGNORE INTO usage_days(day, payload) VALUES(?1, ?2)",
                            ) {
                                for (date, snapshot) in days {
                                    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok() {
                                        let _ = insert.execute(params![date, snapshot.to_string()]);
                                    }
                                }
                            }
                        }
                        let _ = transaction.commit();
                    }
                }
            }
        }
    }
    if let Ok(mut rows) = connection.prepare("SELECT day, payload FROM usage_days") {
        if let Ok(iter) = rows.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in iter.flatten() {
                if let Ok(mut snapshot) = serde_json::from_str::<Usage>(&row.1) {
                    // Older snapshots keyed model rows by chain alias. A chain
                    // name may contain a slash too (`logfare/economy/...`), so a
                    // name check cannot separate them; the version flag can.
                    if snapshot.models_version < MODEL_ROWS_VERSION {
                        snapshot.models.clear();
                        snapshot.models_version = MODEL_ROWS_VERSION;
                    }
                    history.insert(row.0, snapshot);
                }
            }
        }
    }
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
    let Ok(mut connection) = state.storage.connection.lock() else {
        push_log(state, "usage: SQLite storage lock poisoned");
        return;
    };
    let Ok(transaction) = connection.transaction() else {
        push_log(state, "usage: не удалось начать транзакцию SQLite");
        return;
    };
    let result = (|| {
        {
            let mut insert = transaction.prepare("INSERT INTO usage_days(day, payload) VALUES(?1, ?2) ON CONFLICT(day) DO UPDATE SET payload = excluded.payload")?;
            for (date, snapshot) in history.iter() {
                insert.execute(params![date, serde_json::to_string(snapshot)?])?;
            }
        }
        {
            let mut rows = transaction.prepare("SELECT day FROM usage_days")?;
            let existing = rows
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            drop(rows);
            let mut remove = transaction.prepare("DELETE FROM usage_days WHERE day = ?1")?;
            for date in existing {
                if !history.contains_key(&date) {
                    remove.execute(params![date])?;
                }
            }
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    })();
    if let Err(err) = result {
        push_log(
            state,
            format!(
                "usage: не удалось сохранить историю SQLite {}: {err}",
                state.storage.path.display()
            ),
        );
        return;
    }
    if let Err(err) = transaction.commit() {
        push_log(
            state,
            format!("usage: не удалось завершить транзакцию SQLite: {err}"),
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

/// Totals that outlive the seven-day window. Stored as one small JSON blob in
/// `settings`, written with the same absolute value every time, so a crash
/// between ticks cannot double-count.
pub(crate) fn load_lifetime(storage: &Storage) -> LifetimeTokens {
    let Ok(connection) = storage.connection.lock() else {
        return LifetimeTokens::default();
    };
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'lifetimeTokens'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn persist_lifetime(state: &AppState) {
    let totals = *state.lifetime.lock().unwrap();
    let Ok(serialized) = serde_json::to_string(&totals) else {
        return;
    };
    let Ok(connection) = state.storage.connection.lock() else {
        return;
    };
    let _ = connection.execute(
        "INSERT INTO settings(key, value) VALUES('lifetimeTokens', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serialized],
    );
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

/// Bucket key for the current local hour, "HH".
pub(crate) fn hour_key() -> String {
    Local::now().format("%H").to_string()
}

/// Current-hour bucket. Requests are counted once at the start of a request and
/// the outcome/tokens at the points where the day counters already move, so the
/// hourly chart and the day totals cannot drift apart.
pub(crate) fn hour_stat<'a>(usage: &'a mut Usage) -> &'a mut HourUsage {
    let key = hour_key();
    usage.hours.entry(key).or_default()
}

pub(crate) fn provider_stat<'a>(usage: &'a mut Usage, name: &str) -> &'a mut ProviderUsage {
    usage.providers.entry(name.to_string()).or_default()
}

/// One upstream model, keyed `provider/model`. A chain is an alias: counting it
/// hid which real model answered, and two chains sharing an upstream double
/// counted it.
pub(crate) fn model_stat<'a>(
    usage: &'a mut Usage,
    provider: &str,
    model: &str,
) -> &'a mut ModelUsage {
    usage
        .models
        .entry(format!("{provider}/{model}"))
        .or_default()
}

/// Parse the last `usage` object in `text` and add it to the day and provider
/// counters. Model rows are left to the caller: keying them by `provider/model`
/// means they cannot be borrowed for a whole request, and taking them out of the
/// map let a concurrent request's increment land on an orphaned copy.
pub(crate) fn tally_usage(
    text: &str,
    usage: &mut Usage,
    provider: &mut ProviderUsage,
) -> (u64, u64) {
    let Some(start) = text.rfind("\"usage\"") else {
        return (0, 0);
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
    (input, output)
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
