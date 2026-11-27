use chrono::Local;
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::{
    config::Storage,
    types::{
        AppState, HourUsage, LifetimeTokens, ModelUsage, ProviderUsage, SessionUsage, Usage,
        MODEL_ROWS_VERSION,
    },
};

pub(crate) const USAGE_RETENTION_DAYS: usize = 7;
/// Log history: one day, capped by row count. The GUI pages through it from
/// SQLite instead of holding the whole day in memory.
pub(crate) const LOG_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
pub(crate) const LOG_DB_LIMIT: usize = 5000;
/// Trimming on every insert would cost a delete scan per log line; a minute of
/// slack costs a few hundred extra rows.
const LOG_TRIM_INTERVAL_MS: u64 = 60_000;

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
    // Serialize under the history lock, write outside it: a busy SQLite file
    // must not block the GUI poll and the session-title lookup behind it.
    let payloads = {
        let mut history = state.usage_history.lock().unwrap();
        history.insert(today.clone(), current);
        let keep: std::collections::HashSet<_> = usage_day_keys(&today).into_iter().collect();
        history.retain(|date, _| keep.contains(date));
        let mut payloads = HashMap::with_capacity(history.len());
        for (date, snapshot) in history.iter() {
            match serde_json::to_string(snapshot) {
                Ok(text) => {
                    payloads.insert(date.clone(), text);
                }
                Err(err) => {
                    push_log(state, format!("usage: не удалось сериализовать {date}: {err}"));
                    return;
                }
            }
        }
        payloads
    };
    // The writer ticks every second and most ticks carry no new traffic. Skip
    // the transaction when the snapshots are byte-identical to the last write.
    if *state.usage_persisted.lock().unwrap() == payloads {
        return;
    }
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
            for (date, payload) in payloads.iter() {
                insert.execute(params![date, payload])?;
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
                if !payloads.contains_key(&date) {
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
        return;
    }
    *state.usage_persisted.lock().unwrap() = payloads;
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
    let totals = state.lifetime.lock().unwrap().clone();
    let Ok(serialized) = serde_json::to_string(&totals) else {
        return;
    };
    if state
        .lifetime_persisted
        .lock()
        .unwrap()
        .as_deref()
        .is_some_and(|last| last == serialized.as_str())
    {
        return;
    }
    let Ok(connection) = state.storage.connection.lock() else {
        return;
    };
    let written = connection.execute(
        "INSERT INTO settings(key, value) VALUES('lifetimeTokens', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![serialized],
    );
    if written.is_ok() {
        *state.lifetime_persisted.lock().unwrap() = Some(serialized);
    }
}

/// One bucket's outcomes: answers delivered and attempts made.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct UptimeBucket {
    pub ok: u64,
    pub total: u64,
}

/// Outcome per five-minute slot of the current day. Five minutes is the
/// resolution the hour window needs; the day view adds slots up into hours.
/// Only today is kept: the second uptime strip is "what happened today".
#[derive(Debug, Default)]
pub(crate) struct UptimeDay {
    /// Minutes since local midnight / 5, i.e. 0..288.
    pub slots: HashMap<u16, UptimeBucket>,
}

const SLOTS_PER_HOUR: u16 = 12;
const SLOTS_PER_DAY: u16 = 24 * SLOTS_PER_HOUR;

#[derive(Debug, Default)]
pub(crate) struct UptimeCounters {
    day: String,
    /// `provider/model` -> slots.
    pub models: HashMap<String, UptimeDay>,
    /// Exposed chain name -> slots. `provider/model` requests are chains too
    /// (a one-link chain), but the GUI reads them from `models`.
    pub chains: HashMap<String, UptimeDay>,
}

fn uptime_now() -> (String, u16) {
    let now = Local::now();
    let minutes = u16::from(now.format("%H").to_string().parse::<u8>().unwrap_or(0)) * 60
        + u16::from(now.format("%M").to_string().parse::<u8>().unwrap_or(0));
    (local_day_key(), minutes / 5)
}

impl UptimeCounters {
    /// A new day starts empty; the previous day is dropped rather than summed.
    fn roll(&mut self, day: &str) {
        if self.day != day {
            self.day = day.to_string();
            self.models.clear();
            self.chains.clear();
        }
    }

    fn counts(&mut self, day: &str, slot: u16, chain: bool, name: &str) -> &mut UptimeBucket {
        self.roll(day);
        let rows = if chain { &mut self.chains } else { &mut self.models };
        rows.entry(name.to_string())
            .or_default()
            .slots
            .entry(slot)
            .or_default()
    }
}

/// One attempt against one upstream model: `ok` means the upstream answered.
pub(crate) fn record_model_uptime(state: &AppState, provider: &str, model: &str, ok: bool) {
    let (day, slot) = uptime_now();
    let mut counters = state.uptime.lock().unwrap();
    let bucket = counters.counts(&day, slot, false, &format!("{provider}/{model}"));
    bucket.total += 1;
    if ok {
        bucket.ok += 1;
    }
}

/// Undoes the provisional ok counted when the upstream sent headers: the body
/// turned out empty, so the attempt is re-counted as a failure right after.
pub(crate) fn revert_model_uptime(state: &AppState, provider: &str, model: &str) {
    let (day, slot) = uptime_now();
    let mut counters = state.uptime.lock().unwrap();
    let bucket = counters.counts(&day, slot, false, &format!("{provider}/{model}"));
    bucket.total = bucket.total.saturating_sub(1);
    bucket.ok = bucket.ok.saturating_sub(1);
}

/// One client request against a chain: `ok` means the chain produced an answer.
pub(crate) fn record_chain_uptime(state: &AppState, chain: &str, ok: bool) {
    let (day, slot) = uptime_now();
    let mut counters = state.uptime.lock().unwrap();
    let bucket = counters.counts(&day, slot, true, chain);
    bucket.total += 1;
    if ok {
        bucket.ok += 1;
    }
}

fn uptime_percent(bucket: UptimeBucket) -> Option<f64> {
    (bucket.total > 0).then(|| (bucket.ok as f64 / bucket.total as f64 * 1000.0).round() / 10.0)
}

fn sum_slots(day: &UptimeDay, range: std::ops::RangeInclusive<i64>) -> UptimeBucket {
    let mut total = UptimeBucket::default();
    for slot in range {
        if slot < 0 || slot >= i64::from(SLOTS_PER_DAY) {
            continue;
        }
        if let Some(bucket) = day.slots.get(&(slot as u16)) {
            total.ok += bucket.ok;
            total.total += bucket.total;
        }
    }
    total
}

/// One cell. `percent` is absent when the slot saw no traffic, so the GUI draws
/// it as an empty (grey) box instead of a misleading 0 %.
fn slot_cell(today: &str, slot: i64, bucket: UptimeBucket) -> Value {
    let minutes = (slot * 5).max(0) as u16;
    let mut cell = json!({
        "t": format!("{today}T{:02}:{:02}:00", minutes / 60, minutes % 60),
        "percent": uptime_percent(bucket),
        "ok": bucket.ok,
        "total": bucket.total,
    });
    if slot < 0 {
        // A slot before midnight has no date to name: it is a placeholder box,
        // and a wrong timestamp would be worse than none.
        cell.as_object_mut().map(|object| object.remove("t"));
    }
    cell
}

/// `{"percent", "percent1h", "percent24h", "ok", "total", "cells1h", "cells24h"}`
/// for one key. Both windows are always present, so the tab's hour/day switch
/// moves the second strip too — the script's window has nothing to do with it.
/// Each strip is full width and ends at the current slot: a day that has just
/// started shows grey placeholder boxes on the left, not a short line.
fn uptime_entry_json(day: &UptimeDay, slot_now: u16, today: &str) -> Value {
    let slot_now = i64::from(slot_now);
    let day_total = sum_slots(day, 0..=i64::from(SLOTS_PER_DAY) - 1);
    // Trailing hour: the last twelve five-minute slots, ending now.
    let hour_start = slot_now - i64::from(SLOTS_PER_HOUR) + 1;
    let hour_total = sum_slots(day, hour_start..=slot_now);
    let cells1h: Vec<Value> = (hour_start..=slot_now)
        .map(|slot| {
            let bucket = if slot < 0 { UptimeBucket::default() } else {
                day.slots.get(&(slot as u16)).copied().unwrap_or_default()
            };
            slot_cell(today, slot, bucket)
        })
        .collect();
    let cells24h: Vec<Value> = (0..24)
        .map(|index| {
            let hour = slot_now / i64::from(SLOTS_PER_HOUR) - 23 + index;
            let bucket = sum_slots(
                day,
                hour * i64::from(SLOTS_PER_HOUR)..=(hour + 1) * i64::from(SLOTS_PER_HOUR) - 1,
            );
            let mut cell = slot_cell(today, hour * i64::from(SLOTS_PER_HOUR), bucket);
            if let Some(object) = cell.as_object_mut() {
                match object.get("t").and_then(Value::as_str) {
                    Some(_) if hour >= 0 => {
                        object.insert("t".into(), json!(format!("{today}T{:02}:00:00", hour)));
                    }
                    _ => {
                        object.remove("t");
                    }
                }
            }
            cell
        })
        .collect();
    let percent = uptime_percent(day_total);
    json!({
        "percent": percent,
        "percent24h": percent,
        "percent1h": uptime_percent(hour_total),
        "ok": day_total.ok,
        "total": day_total.total,
        "cells24h": cells24h,
        "cells1h": cells1h,
    })
}

pub(crate) fn uptime_snapshot(state: &AppState) -> Value {
    let (today, slot_now) = uptime_now();
    let mut counters = state.uptime.lock().unwrap();
    counters.roll(&today);
    let rows = |map: &HashMap<String, UptimeDay>| {
        map.iter()
            .map(|(name, day)| (name.clone(), uptime_entry_json(day, slot_now, &today)))
            .collect::<serde_json::Map<_, _>>()
    };
    json!({
        "day": today,
        "models": rows(&counters.models),
        "chains": rows(&counters.chains),
    })
}

pub(crate) fn push_log(state: &AppState, message: impl Into<String>) {
    let line = format!(
        "[{}] {}",
        Local::now().format("%Y-%m-%d %H:%M:%S"),
        message.into()
    );
    println!("{line}");
    append_log(state, &line);
}

/// Persist one line. The GUI reads pages from SQLite, so nothing is kept in
/// memory: a day of logs would only be a cache of the database.
fn append_log(state: &AppState, line: &str) {
    let Some(created_ms) = now_ms().try_into().ok() else {
        return;
    };
    let created_ms: u64 = created_ms;
    let Ok(connection) = state.storage.connection.lock() else {
        return;
    };
    if connection
        .execute(
            "INSERT INTO logs(created_ms, line) VALUES(?1, ?2)",
            params![created_ms, line],
        )
        .is_err()
    {
        return;
    }
    // Trim at most once a minute: the check itself is a cheap settings read,
    // the deletes are not.
    let now = created_ms;
    let last = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'logsTrimmedAt'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(0);
    if now.saturating_sub(last) < LOG_TRIM_INTERVAL_MS {
        return;
    }
    let _ = connection.execute(
        "INSERT INTO settings(key, value) VALUES('logsTrimmedAt', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now.to_string()],
    );
    let cutoff = now.saturating_sub(LOG_RETENTION_MS);
    let _ = connection.execute("DELETE FROM logs WHERE created_ms < ?1", params![cutoff]);
    let _ = connection.execute(
        "DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?1)",
        params![LOG_DB_LIMIT],
    );
}

/// One page of stored logs, newest first. `before` is an exclusive id cursor so
/// the "older" button can walk back without loading the day.
pub(crate) fn log_page(
    storage: &Storage,
    before: Option<i64>,
    limit: usize,
) -> Vec<(i64, String)> {
    let Ok(connection) = storage.connection.lock() else {
        return Vec::new();
    };
    let limit = limit.clamp(1, 500) as i64;
    let query = match before {
        Some(_) => "SELECT id, line FROM logs WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
        None => "SELECT id, line FROM logs ORDER BY id DESC LIMIT ?1",
    };
    let Ok(mut statement) = connection.prepare(query) else {
        return Vec::new();
    };
    let read = |row: &rusqlite::Row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?));
    let rows = match before {
        Some(id) => statement.query_map(params![id, limit], read),
        None => statement.query_map(params![limit], read),
    };
    let Ok(rows) = rows else {
        return Vec::new();
    };
    rows.flatten().collect()
}

/// Total rows kept, so the pager can show how far back it goes.
pub(crate) fn log_count(storage: &Storage) -> usize {
    let Ok(connection) = storage.connection.lock() else {
        return 0;
    };
    connection
        .query_row("SELECT COUNT(*) FROM logs", [], |row| row.get::<_, usize>(0))
        .unwrap_or(0)
}

/// Log lines that belong to one harness conversation carry its id as a trailing
/// tag, so the GUI can show which chat a request came from. Non-chat lines have
/// no session and no tag; the GUI strips the tag and renders it as a chip.
pub(crate) fn session_tag(session: Option<&str>) -> String {
    match session.filter(|id| !id.is_empty()) {
        Some(id) => format!(" [ses:{id}]"),
        None => String::new(),
    }
}

/// `push_log` for a chat request: appends the session id tag when the client
/// sent one, so the GUI can attribute the line to a conversation.
pub(crate) fn push_chat_log(state: &AppState, session: Option<&str>, message: impl Into<String>) {
    push_log(state, format!("{}{}", message.into(), session_tag(session)));
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
    let now = now_ms();
    if usage.first_activity == 0 {
        usage.first_activity = now;
    }
    usage.last_activity = now;
    usage.hours.entry(key).or_default()
}

/// Default gap above which a chat is considered paused: time between two
/// requests longer than this is not added to the session's active duration.
const SESSION_IDLE_GAP_DEFAULT_SEC: u64 = 300;

pub(crate) fn session_idle_gap(state: &AppState) -> Duration {
    let seconds = state
        .config
        .read()
        .unwrap()
        .get("sessionIdleGapSec")
        .and_then(Value::as_u64)
        .unwrap_or(SESSION_IDLE_GAP_DEFAULT_SEC);
    Duration::from_secs(seconds)
}

/// Session row for this request, counting the pause since the previous one.
/// A gap within the idle threshold means the chat was still in use, so it adds
/// to `active_ms`; a longer gap is a pause and adds nothing.
pub(crate) fn session_request_start<'a>(
    usage: &'a mut Usage,
    session: Option<&str>,
    idle_gap: Duration,
) -> Option<&'a mut SessionUsage> {
    let key = session?.trim();
    if key.is_empty() {
        return None;
    }
    let now = now_ms();
    let entry = usage
        .sessions
        .entry(key.to_string())
        .or_insert_with(|| SessionUsage {
            first_seen: now,
            ..SessionUsage::default()
        });
    if entry.last_seen > 0 {
        let gap = now.saturating_sub(entry.last_seen) as u64;
        if gap <= idle_gap.as_millis() as u64 {
            entry.active_ms = entry.active_ms.saturating_add(gap);
        }
    }
    entry.last_seen = now;
    Some(entry)
}

/// Adds the time this request stayed with the proxy, so a long retry loop is
/// counted even though it exceeds the idle gap. Called once per request.
pub(crate) fn session_request_end(
    usage: &mut Usage,
    session: Option<&str>,
    elapsed: Duration,
) {
    let Some(key) = session.map(str::trim).filter(|key| !key.is_empty()) else {
        return;
    };
    if let Some(entry) = usage.sessions.get_mut(key) {
        entry.active_ms = entry
            .active_ms
            .saturating_add(elapsed.as_millis().min(u128::from(u64::MAX)) as u64);
        entry.last_seen = now_ms();
    }
}

/// The session row for the id the client sent. An empty id (a client that does
/// not send `x-opencode-session-id`) is ignored rather than lumped into one
/// fake session.
pub(crate) fn session_stat<'a>(
    usage: &'a mut Usage,
    session: Option<&str>,
) -> Option<&'a mut SessionUsage> {
    let key = session?.trim();
    if key.is_empty() {
        return None;
    }
    let now = now_ms();
    let entry = usage.sessions.entry(key.to_string()).or_insert_with(|| SessionUsage {
        first_seen: now,
        ..SessionUsage::default()
    });
    entry.last_seen = now;
    Some(entry)
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
    let mut cooldowns = state.cooldowns.lock().unwrap();
    // Drop expired entries; their provider/model pair may remain blocked through
    // another configured chain, so membership in a specific alias is irrelevant.
    cooldowns.retain(|_, until| *until > now);
    cooldowns
        .iter()
        .map(|(key, until)| {
            let mut parts = key.split('|');
            json!({
                "upstream": parts.next().unwrap_or_default(),
                "upstreamModel": parts.next().unwrap_or_default(),
                "until": now_ms() + until.saturating_duration_since(now).as_millis()
            })
        })
        .collect()
}
