use serde_json::{json, Map, Value};
use std::fs;

use super::{config::expand_home, metrics::push_log, routing::direct_model_ids, types::AppState};

pub(crate) fn default_opencode_config_setting() -> String {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".config")
        .join("opencode");
    if dir.join("opencode.jsonc").exists() {
        "~/.config/opencode/opencode.jsonc".into()
    } else {
        "~/.config/opencode/opencode.json".into()
    }
}

fn default_opencode_config_path(config: &Value) -> std::path::PathBuf {
    if let Some(path) = config.get("opencodeConfig").and_then(Value::as_str) {
        return expand_home(path);
    }
    let dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".config")
        .join("opencode");
    let jsonc = dir.join("opencode.jsonc");
    let json = dir.join("opencode.json");
    if json.exists() {
        json
    } else if jsonc.exists() {
        jsonc
    } else {
        json
    }
}

fn model_context_length(config: &Value, provider: &str, model: &str) -> Option<u64> {
    let info = config
        .get("providers")
        .and_then(|providers| providers.get(provider))
        .and_then(|provider| provider.get("modelInfo"))
        .and_then(|models| models.get(model))?;
    let context = info.get("contextLength").and_then(Value::as_u64);
    let provider_context = info.get("providerContextLength").and_then(Value::as_u64);
    match (
        context.filter(|value| *value > 0),
        provider_context.filter(|value| *value > 0),
    ) {
        (Some(context), Some(provider_context)) => Some(context.min(provider_context)),
        (Some(context), None) => Some(context),
        (None, Some(provider_context)) => Some(provider_context),
        (None, None) => None,
    }
}

fn chain_context_length(config: &Value, chain: &[super::types::Upstream]) -> Option<u64> {
    chain
        .iter()
        .filter_map(|upstream| model_context_length(config, &upstream.name, &upstream.model))
        .min()
}

fn apply_model_context(item: &mut Value, context: Option<u64>) {
    let Some(context) = context else {
        return;
    };
    let Some(object) = item.as_object_mut() else {
        return;
    };
    let limit = object
        .entry("limit")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(limit) = limit.as_object_mut() {
        limit.insert("context".into(), json!(context));
    }
}

pub(crate) async fn sync_opencode(state: &AppState) -> bool {
    let config = state.config.read().unwrap().clone();
    let path = default_opencode_config_path(&config);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => {
            push_log(
                state,
                format!(
                    "opencode: нет файла {} — карта моделей не обновлена",
                    path.display()
                ),
            );
            return false;
        }
    };
    let mut document: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => {
            push_log(
                state,
                format!(
                    "opencode: {} не читается как JSON — карта моделей не обновлена",
                    path.display()
                ),
            );
            return false;
        }
    };
    let provider_id = config
        .get("opencodeProvider")
        .and_then(Value::as_str)
        .unwrap_or("provider-proxy");
    let providers = document
        .as_object_mut()
        .and_then(|root| {
            if !root.contains_key("providers") {
                root.insert("providers".into(), Value::Object(Map::new()));
            }
            root.get_mut("providers")
        })
        .and_then(Value::as_object_mut);
    let Some(providers) = providers else {
        return false;
    };
    let entry = providers
        .entry(provider_id.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(provider) = entry.as_object_mut() else {
        return false;
    };
    provider
        .entry("package")
        .or_insert_with(|| Value::String("aisdk:@ai-sdk/openai-compatible".into()));
    provider
        .entry("name")
        .or_insert_with(|| Value::String("Provider Proxy".into()));
    let settings = provider
        .entry("settings")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut();
    let Some(settings) = settings else {
        return false;
    };
    let port = state.port;
    settings.insert(
        "baseURL".into(),
        Value::String(format!("http://127.0.0.1:{port}/v1")),
    );
    if let Some(auth) = config.get("authToken").and_then(Value::as_str) {
        settings.insert("apiKey".into(), Value::String(auth.into()));
    }
    let previous = provider
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let chains = state.chains.read().unwrap();
    let mut models = Map::new();
    if let Some(config_models) = config.get("models").and_then(Value::as_object) {
        for (name, definition) in config_models {
            if definition.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let chain_len = chains.get(name).map(Vec::len).unwrap_or(0);
            let mut item = previous.get(name).cloned().unwrap_or_else(|| json!({}));
            if let Value::Object(object) = &mut item {
                object.insert(
                    "name".into(),
                    Value::String(format!("{name} (proxy, x{chain_len})")),
                );
            }
            apply_model_context(
                &mut item,
                chains
                    .get(name)
                    .and_then(|chain| chain_context_length(&config, chain)),
            );
            models.insert(name.clone(), item);
        }
    }
    if let Some(direct) = config.get("opencodeModels").and_then(Value::as_object) {
        for (provider_name, definition) in direct {
            if definition.get("enabled").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let provider_config = config
                .get("providers")
                .and_then(|providers| providers.get(provider_name));
            let Some(provider_config) = provider_config else {
                continue;
            };
            for model in direct_model_ids(provider_config, definition) {
                let name = format!("{provider_name}/{model}");
                let mut item = previous.get(&name).cloned().unwrap_or_else(|| json!({}));
                if let Value::Object(object) = &mut item {
                    object.insert("name".into(), Value::String(format!("{name} (config)")));
                }
                apply_model_context(
                    &mut item,
                    model_context_length(&config, provider_name, &model),
                );
                models.insert(name, item);
            }
        }
    }
    provider.insert("models".into(), Value::Object(models));
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&document).unwrap_or_else(|_| raw.clone())
    );
    // The GUI saves on every edit, and most edits do not touch the model map.
    // Rewriting an unchanged file churns its mtime and opencode reloads the
    // whole config for nothing, so an identical document is left alone and
    // nothing is logged.
    if serialized == raw {
        return true;
    }
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let _ = fs::write(format!("{}.bak", path.display()), &raw);
    if fs::write(&path, serialized).is_err() {
        return false;
    }
    push_log(
        state,
        format!("opencode: карта моделей записана в {}", path.display()),
    );
    true
}
