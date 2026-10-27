use serde_json::{json, Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

use super::crypto::{decrypt_secret, encrypt_secret};

pub(crate) const LOG_MAX_DEFAULT: usize = 500;

pub fn default_config_path() -> PathBuf {
    if let Ok(path) = std::env::var("PP_CONFIG_FILE") {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::current_dir().map(|p| p.join("config.json")) {
        if path.exists() {
            return path;
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("provider-proxy")
        .join("config.json")
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

pub(crate) fn load_config(path: &Path) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
    if !path.exists() {
        let example = Path::new(env!("CARGO_MANIFEST_DIR")).join("config.example.json");
        let value = if example.exists() {
            serde_json::from_str(&fs::read_to_string(example)?)?
        } else {
            json!({ "port": 8787, "providers": {}, "models": {} })
        };
        return Ok(value);
    }
    let raw: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    match transform_secrets(&raw, "", false) {
        Ok(value) => Ok(value),
        Err(error) if error.contains("cannot read config key") => {
            eprintln!(
                "provider_proxy: {error}; encrypted credentials were cleared in memory — re-enter them in Settings"
            );
            Ok(clear_unreadable_encrypted_secrets(&raw, ""))
        }
        Err(error) => Err(std::io::Error::other(error).into()),
    }
}

pub(crate) fn save_config(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let encrypted = transform_secrets(value, "", true)?;
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&encrypted).map_err(|e| e.to_string())?
        ),
    )
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

pub(crate) fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest)
    } else {
        PathBuf::from(path)
    }
}
