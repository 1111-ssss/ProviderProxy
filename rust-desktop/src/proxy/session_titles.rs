//! Best-effort lookup of harness session titles.
//!
//! Traffic accounting never reads the harness's files: sessions are counted from
//! the `x-opencode-session-id` header alone. This module only decorates that
//! table with the name the user already sees in the harness. A missing database
//! or a different harness simply means the table falls back to the id.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// Titles change only when a session is renamed, so a minute of staleness is
/// cheaper than opening the harness database on every 3-second poll.
const TITLE_TTL: Duration = Duration::from_secs(60);

struct Cache {
    loaded_at: Option<Instant>,
    titles: HashMap<String, String>,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(Cache {
            loaded_at: None,
            titles: HashMap::new(),
        })
    })
}

fn database_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(dir) = dirs::data_dir() {
        paths.push(dir.join("opencode").join("opencode.db"));
    }
    if let Some(home) = dirs::home_dir() {
        // opencode keeps its state here on Linux regardless of XDG_DATA_HOME.
        paths.push(home.join(".local/share/opencode/opencode.db"));
    }
    paths
}

fn read_titles() -> HashMap<String, String> {
    for path in database_candidates() {
        if !path.exists() {
            continue;
        }
        let Ok(connection) = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) else {
            continue;
        };
        let mut titles = HashMap::new();
        // Newer builds write `session_v2`, older ones `session`. Both are read
        // so a rollback does not empty the names.
        for table in ["session_v2", "session"] {
            let Ok(mut statement) = connection.prepare(&format!("SELECT id, title FROM {table}"))
            else {
                continue;
            };
            let Ok(rows) = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) else {
                continue;
            };
            for (id, title) in rows.flatten() {
                if !title.trim().is_empty() {
                    titles.entry(id).or_insert(title);
                }
            }
        }
        if !titles.is_empty() {
            return titles;
        }
    }
    HashMap::new()
}

fn titles() -> HashMap<String, String> {
    let Ok(mut cache) = cache().lock() else {
        return HashMap::new();
    };
    if cache
        .loaded_at
        .is_some_and(|loaded| loaded.elapsed() < TITLE_TTL)
    {
        return cache.titles.clone();
    }
    cache.titles = read_titles();
    cache.loaded_at = Some(Instant::now());
    cache.titles.clone()
}

fn match_titles(all: &HashMap<String, String>, keys: &[String]) -> HashMap<String, String> {
    keys.iter()
        .filter_map(|key| {
            let title = all.get(key).cloned().or_else(|| {
                all.iter()
                    .find(|(id, _)| id.starts_with(key.as_str()))
                    .map(|(_, title)| title.clone())
            })?;
            Some((key.clone(), title))
        })
        .collect()
}

/// Map each stored session key to a title. The harness sends a shortened id in
/// the header, so a full id that starts with the key is the same session.
pub(crate) fn titles_for(keys: &[String]) -> HashMap<String, String> {
    if keys.is_empty() {
        return HashMap::new();
    }
    let all = titles();
    if all.is_empty() {
        return HashMap::new();
    }
    match_titles(&all, keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_a_shortened_header_id_to_the_full_session() {
        let all: HashMap<String, String> = [
            (
                "ses_e3aedd559ffeDhFEwM08Gs0owf".to_string(),
                "Синхронизация папки".to_string(),
            ),
            ("ses_other".to_string(), "Другая".to_string()),
        ]
        .into();
        let keys = vec!["ses_e3aedd559ffeDhFEwM08".to_string(), "ses_unknown".to_string()];
        let matched = match_titles(&all, &keys);
        assert_eq!(
            matched.get("ses_e3aedd559ffeDhFEwM08").map(String::as_str),
            Some("Синхронизация папки")
        );
        assert_eq!(matched.len(), 1, "an unknown id gets no title");
    }
}
