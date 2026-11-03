use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use super::crypto::{decrypt_secret, encrypt_secret};

pub(crate) const LOG_MAX_DEFAULT: usize = 500;

pub(crate) struct Storage {
    pub(crate) path: PathBuf,
    pub(crate) connection: Mutex<Connection>,
}

pub(crate) fn database_path(config_path: &Path) -> PathBuf {
    if let Ok(path) = std::env::var("PP_DB_FILE") {
        return PathBuf::from(path);
    }
    if config_path
        .extension()
        .is_some_and(|extension| extension == "db")
    {
        return config_path.to_path_buf();
    }
    let mut path = config_path.to_path_buf();
    path.set_extension("db");
    path
}

pub(crate) fn open_storage(
    config_path: &Path,
) -> Result<Storage, Box<dyn std::error::Error + Send + Sync>> {
    let path = database_path(config_path);
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(&path)?;
    #[cfg(unix)]
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS settings (\
             key TEXT PRIMARY KEY,\
             value TEXT NOT NULL\
         );\
         CREATE TABLE IF NOT EXISTS usage_days (\
             day TEXT PRIMARY KEY,\
             payload TEXT NOT NULL\
         );",
    )?;
    Ok(Storage {
        path,
        connection: Mutex::new(connection),
    })
}

pub fn default_config_path() -> PathBuf {
    if let Ok(path) = std::env::var("PP_CONFIG_FILE") {
        return PathBuf::from(path);
    }
    if let Ok(directory) = std::env::current_dir() {
        let database = directory.join("config.db");
        if database.exists() {
            return database;
        }
        let legacy = directory.join("config.json");
        if legacy.exists() {
            return legacy;
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("provider-proxy")
        .join("config.db")
}

fn is_secret_key(key: &str, parent: &str) -> bool {
    key == "apiKey" || key == "authToken" || parent == "headers"
}

fn clear_unreadable_encrypted_secrets(value: &Value, parent: &str) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| clear_unreadable_encrypted_secrets(item, parent))
                .collect(),
        ),
        Value::Object(items) => {
            let mut out = Map::new();
            for (key, item) in items {
                if is_secret_key(key, parent)
                    && item
                        .as_str()
                        .is_some_and(|text| text.starts_with("enc:v1:"))
                {
                    // The ciphertext cannot be recovered without master.key.
                    // Keep the rest of the config usable so the GUI can start
                    // and the user can enter replacement credentials.
                    out.insert(key.clone(), Value::String(String::new()));
                } else {
                    out.insert(key.clone(), clear_unreadable_encrypted_secrets(item, key));
                }
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

fn transform_secrets(value: &Value, parent: &str, encrypt: bool) -> Result<Value, String> {
    match value {
        Value::Array(items) => Ok(Value::Array(
            items
                .iter()
                .map(|item| transform_secrets(item, parent, encrypt))
                .collect::<Result<Vec<_>, _>>()?,
        )),
        Value::Object(items) => {
            let mut out = Map::new();
            for (key, item) in items {
                if is_secret_key(key, parent) && item.is_string() {
                    let text = item.as_str().unwrap_or_default();
                    let next = if encrypt {
                        encrypt_secret(text)?
                    } else {
                        decrypt_secret(text)?
                    };
                    out.insert(key.clone(), Value::String(next));
                } else {
                    out.insert(key.clone(), transform_secrets(item, key, encrypt)?);
                }
            }
            Ok(Value::Object(out))
        }
        _ => Ok(value.clone()),
    }
}

pub(crate) fn load_config(
    storage: &Storage,
    legacy_path: &Path,
) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    let stored = storage
        .connection
        .lock()
        .map_err(|_| std::io::Error::other("SQLite storage lock poisoned"))?
        .query_row(
            "SELECT value FROM settings WHERE key = 'config'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(raw) = stored {
        let value: Value = serde_json::from_str(&raw)?;
        return match transform_secrets(&value, "", false) {
            Ok(value) => Ok(value),
            Err(error) if error.contains("cannot read config key") => {
                eprintln!(
                    "provider_proxy: {error}; encrypted credentials were cleared in memory — re-enter them in Settings"
                );
                Ok(clear_unreadable_encrypted_secrets(&value, ""))
            }
            Err(error) => Err(std::io::Error::other(error).into()),
        };
    }

    let value = if !legacy_path.exists() {
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("config.example.json");
        if example.exists() {
            serde_json::from_str(&fs::read_to_string(example)?)?
        } else {
            json!({ "port": 8787, "providers": {}, "models": {} })
        }
    } else {
        let raw: Value = serde_json::from_str(&fs::read_to_string(legacy_path)?)?;
        match transform_secrets(&raw, "", false) {
            Ok(value) => value,
            Err(error) if error.contains("cannot read config key") => {
                eprintln!(
                    "provider_proxy: {error}; encrypted credentials were cleared in memory — re-enter them in Settings"
                );
                clear_unreadable_encrypted_secrets(&raw, "")
            }
            Err(error) => return Err(std::io::Error::other(error).into()),
        }
    };
    save_config(storage, &value).map_err(std::io::Error::other)?;
    Ok(value)
}

pub(crate) fn save_config(storage: &Storage, value: &Value) -> Result<(), String> {
    let encrypted = transform_secrets(value, "", true)?;
    let serialized = serde_json::to_string(&encrypted).map_err(|e| e.to_string())?;
    storage
        .connection
        .lock()
        .map_err(|_| "SQLite storage lock poisoned".to_string())?
        .execute(
            "INSERT INTO settings(key, value) VALUES('config', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![serialized],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub(crate) fn public_config(value: &Value) -> Value {
    fn redact(value: &Value, parent: &str) -> Value {
        match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| redact(v, parent)).collect()),
            Value::Object(items) => {
                let mut out = Map::new();
                for (key, item) in items {
                    if (key == "apiKey" || key == "authToken")
                        && !item.as_str().unwrap_or_default().is_empty()
                    {
                        out.insert(key.clone(), Value::String(String::new()));
                        out.insert(format!("{key}Configured"), Value::Bool(true));
                    } else if parent == "headers" && super::auth::sensitive_header(key) {
                        continue;
                    } else {
                        out.insert(key.clone(), redact(item, key));
                    }
                }
                Value::Object(out)
            }
            _ => value.clone(),
        }
    }
    redact(value, "")
}

pub(crate) fn merge_redacted(next: &Value, previous: &Value) -> Value {
    match next {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, item)| merge_redacted(item, previous.get(i).unwrap_or(&Value::Null)))
                .collect(),
        ),
        Value::Object(items) => {
            let mut out = Map::new();
            for (key, item) in items {
                if key.ends_with("Configured") || key == "apiKeySource" {
                    continue;
                }
                if (key == "apiKey" || key == "authToken")
                    && item.as_str().unwrap_or_default().is_empty()
                    && next
                        .get(format!("{key}Configured"))
                        .and_then(Value::as_bool)
                        == Some(true)
                {
                    if let Some(old) = previous.get(key) {
                        out.insert(key.clone(), old.clone());
                        continue;
                    }
                }
                out.insert(
                    key.clone(),
                    merge_redacted(item, previous.get(key).unwrap_or(&Value::Null)),
                );
            }
            Value::Object(out)
        }
        _ => next.clone(),
    }
}

pub(crate) fn merge_config_secrets(next: &Value, previous: &Value) -> Value {
    let mut merged = merge_redacted(next, previous);
    let Some(merged_object) = merged.as_object_mut() else {
        return merged;
    };
    let Some(next_providers) = next.get("providers").and_then(Value::as_object) else {
        return merged;
    };
    let Some(merged_providers) = merged_object
        .get_mut("providers")
        .and_then(Value::as_object_mut)
    else {
        return merged;
    };
    let Some(previous_providers) = previous.get("providers").and_then(Value::as_object) else {
        return merged;
    };
    for (name, next_provider) in next_providers {
        let Some(source) = next_provider.get("apiKeySource").and_then(Value::as_str) else {
            continue;
        };
        let Some(source_key) = previous_providers.get(source).and_then(|v| v.get("apiKey")) else {
            continue;
        };
        if let Some(provider) = merged_providers
            .get_mut(name)
            .and_then(Value::as_object_mut)
        {
            if provider
                .get("apiKey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .is_empty()
            {
                provider.insert("apiKey".into(), source_key.clone());
            }
        }
    }
    merged
}

pub(crate) fn export_config(value: &Value, keys: bool, chains: bool, models: bool) -> Value {
    fn strip(value: &Value, parent: &str, keys: bool) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| strip(item, parent, keys)).collect())
            }
            Value::Object(items) => {
                let mut out = Map::new();
                for (key, item) in items {
                    if !keys
                        && (key == "apiKey"
                            || key == "authToken"
                            || (parent == "headers" && super::auth::sensitive_header(key)))
                    {
                        continue;
                    }
                    out.insert(key.clone(), strip(item, key, keys));
                }
                Value::Object(out)
            }
            _ => value.clone(),
        }
    }

    let mut exported = strip(value, "", keys);
    if let Some(object) = exported.as_object_mut() {
        if !chains {
            object.remove("models");
        }
        if !models {
            object.remove("opencodeModels");
        }
    }
    exported
}

pub(crate) fn merge_imported_config(next: &Value, previous: &Value) -> Value {
    let mut object = previous.as_object().cloned().unwrap_or_default();
    if let Some(imported) = next.as_object() {
        for (key, value) in imported {
            object.insert(key.clone(), value.clone());
        }
        if let Some(providers) = imported.get("providers").and_then(Value::as_object) {
            let mut providers = providers.clone();
            for (name, provider) in &mut providers {
                let Some(provider_object) = provider.as_object_mut() else {
                    continue;
                };
                let previous_provider = previous
                    .get("providers")
                    .and_then(Value::as_object)
                    .and_then(|all| all.get(name))
                    .and_then(Value::as_object);
                if !provider_object.contains_key("apiKey") {
                    if let Some(api_key) = previous_provider.and_then(|value| value.get("apiKey")) {
                        provider_object.insert("apiKey".into(), api_key.clone());
                    }
                }
                if let (Some(headers), Some(previous_headers)) = (
                    provider_object
                        .get_mut("headers")
                        .and_then(Value::as_object_mut),
                    previous_provider
                        .and_then(|value| value.get("headers"))
                        .and_then(Value::as_object),
                ) {
                    for (header, value) in previous_headers {
                        if super::auth::sensitive_header(header) && !headers.contains_key(header) {
                            headers.insert(header.clone(), value.clone());
                        }
                    }
                }
            }
            object.insert("providers".into(), Value::Object(providers));
        }
    }
    merge_config_secrets(&Value::Object(object), previous)
}

pub(crate) fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest)
    } else {
        PathBuf::from(path)
    }
}
