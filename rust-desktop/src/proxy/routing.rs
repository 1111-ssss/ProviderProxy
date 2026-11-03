use serde_json::{Map, Value};
use std::collections::HashMap;

use super::types::Upstream;

pub(crate) fn subst(value: &str) -> String {
    let mut out = value.to_string();
    let mut start = 0;
    while let Some(relative) = out[start..].find("{env:") {
        let begin = start + relative;
        let Some(end_relative) = out[begin..].find('}') else {
            break;
        };
        let end = begin + end_relative;
        let name = &out[begin + 5..end];
        let replacement = std::env::var(name).unwrap_or_default();
        out.replace_range(begin..=end, &replacement);
        start = begin + replacement.len();
    }
    out
}

fn safe_host(url: &str) -> String {
    url::Url::parse(url)
        .map(|u| u.host_str().unwrap_or(url).to_string())
        .unwrap_or_else(|_| url.to_string())
}

pub(crate) fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(crate) fn map_headers(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), subst(v))))
                .collect()
        })
        .unwrap_or_default()
}

fn is_image_model(provider: &Value, id: &str) -> bool {
    let info = provider
        .get("modelInfo")
        .and_then(|models| models.get(id));
    let endpoints = info.and_then(|model| model.get("endpoints")).and_then(Value::as_array);
    info.and_then(|model| model.get("image")).and_then(Value::as_bool) == Some(true)
        || info
            .and_then(|model| model.get("type"))
            .and_then(Value::as_str)
            .is_some_and(|kind| kind.eq_ignore_ascii_case("image"))
        || endpoints.is_some_and(|items| {
            items.iter().filter_map(Value::as_str).any(|endpoint| {
                endpoint.to_ascii_lowercase().contains("images/generations")
                    || endpoint.to_ascii_lowercase().contains("images/tasks")
            })
        })
        || id.to_ascii_lowercase().contains("image")
}

pub(crate) fn direct_model_ids(provider: &Value, definition: &Value) -> Vec<String> {
    let all = definition.get("all").and_then(Value::as_bool) == Some(true);
    let models = if all {
        provider.get("models")
    } else {
        definition.get("models")
    };
    models
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| !all || !is_image_model(provider, id))
        .map(ToOwned::to_owned)
        .collect()
}

pub(crate) fn build_chains(config: &Value) -> HashMap<String, Vec<Upstream>> {
    let mut result = HashMap::new();
    let providers = config.get("providers").and_then(Value::as_object);
    if let Some(models) = config.get("models").and_then(Value::as_object) {
        for (name, definition) in models {
            let mut chain = Vec::new();
            if let Some(upstreams) = definition.get("upstreams").and_then(Value::as_array) {
                for upstream in upstreams {
                    let provider_name = string_field(upstream, "provider");
                    let provider = provider_name
                        .as_ref()
                        .and_then(|provider| providers.and_then(|all| all.get(provider)))
                        .unwrap_or(upstream);
                    let Some(base_url) = string_field(provider, "baseURL") else {
                        continue;
                    };
                    let model = string_field(upstream, "model").unwrap_or_else(|| name.clone());
                    let provider_display = provider_name
                        .clone()
                        .or_else(|| string_field(provider, "name"))
                        .unwrap_or_else(|| safe_host(&base_url));
                    let headers = if upstream.get("headers").is_some() {
                        map_headers(upstream.get("headers"))
                    } else {
                        map_headers(provider.get("headers"))
                    };
                    chain.push(Upstream {
                        name: provider_display,
                        base_url: base_url.trim_end_matches('/').to_string(),
                        model,
                        api_key: subst(&string_field(provider, "apiKey").unwrap_or_default()),
                        headers,
                    });
                }
            }
            result.insert(name.clone(), chain);
        }
    }
    if let Some(direct) = config.get("opencodeModels").and_then(Value::as_object) {
        for (provider_name, definition) in direct {
            let Some(provider) = providers.and_then(|all| all.get(provider_name)) else {
                continue;
            };
            let Some(base_url) = string_field(provider, "baseURL") else {
                continue;
            };
            for model in direct_model_ids(provider, definition) {
                let exposed = format!("{provider_name}/{model}");
                result.entry(exposed).or_insert_with(|| {
                    vec![Upstream {
                        name: provider_name.clone(),
                        base_url: base_url.trim_end_matches('/').to_string(),
                        model,
                        api_key: subst(&string_field(provider, "apiKey").unwrap_or_default()),
                        headers: map_headers(provider.get("headers")),
                    }]
                });
            }
        }
    }
    result
}

pub(crate) fn with_model(body: &Value, model: &str) -> Value {
    let mut body = body.clone();
    if let Value::Object(object) = &mut body {
        object.insert("model".into(), Value::String(model.into()));
        if let Some(Value::Array(messages)) = object.get_mut("messages") {
            for message in messages {
                let Value::Object(message) = message else {
                    continue;
                };
                if let Some(Value::Array(tool_calls)) = message.get_mut("tool_calls") {
                    for call in tool_calls {
                        let Value::Object(call) = call else {
                            continue;
                        };
                        let Some(Value::Object(function)) = call.get_mut("function") else {
                            continue;
                        };
                        if let Some(arguments) = function.get_mut("arguments") {
                            if !arguments.is_string() {
                                *arguments = Value::String(
                                    serde_json::to_string(arguments)
                                        .unwrap_or_else(|_| "{}".into()),
                                );
                            }
                        }
                    }
                }
                if let Some(Value::Object(function_call)) = message.get_mut("function_call") {
                    if let Some(arguments) = function_call.get_mut("arguments") {
                        if !arguments.is_string() {
                            *arguments = Value::String(
                                serde_json::to_string(arguments).unwrap_or_else(|_| "{}".into()),
                            );
                        }
                    }
                }
                if message.get("role").and_then(Value::as_str) == Some("tool") {
                    if let Some(content) = message.get_mut("content") {
                        if !content.is_string() {
                            *content = Value::String(
                                serde_json::to_string(content).unwrap_or_else(|_| "null".into()),
                            );
                        }
                    }
                }
            }
        }
    }
    body
}

pub(crate) fn failover_status(status: axum::http::StatusCode) -> bool {
    // Ordinary client errors are request/model errors and must not silently
    // switch to another model. Only known quota/access/timeout/server errors
    // are eligible for chain failover.
    matches!(
        status,
        axum::http::StatusCode::PAYMENT_REQUIRED
            | axum::http::StatusCode::FORBIDDEN
            | axum::http::StatusCode::REQUEST_TIMEOUT
            | axum::http::StatusCode::TOO_MANY_REQUESTS
    ) || status.is_server_error()
}

pub(crate) fn add_model_metadata(
    item: &Value,
    models: &mut Vec<String>,
    details: &mut Map<String, Value>,
) {
    let id = item
        .get("id")
        .or_else(|| item.get("name"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| item.as_str().map(ToOwned::to_owned));
    let Some(id) = id else {
        return;
    };
    models.push(id.clone());
    let context = [
        "context_length",
        "contextLength",
        "context_window",
        "max_context_length",
        "maxContextLength",
    ]
    .iter()
    .find_map(|key| item.get(*key).and_then(Value::as_u64));
    let model_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
    let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
    let mut endpoints = Vec::new();
    collect_strings(
        item.get("endpoints")
            .or_else(|| item.get("endpoint"))
            .or_else(|| item.get("supported_endpoints")),
        &mut endpoints,
    );
    let image = model_type.eq_ignore_ascii_case("image")
        || endpoints.iter().any(|endpoint| {
            endpoint.to_ascii_lowercase().contains("images/generations")
                || endpoint.to_ascii_lowercase().contains("images/tasks")
        })
        || format!("{id} {name}")
            .to_ascii_lowercase()
            .contains("image");
    if context.is_some() || !model_type.is_empty() || !endpoints.is_empty() || image {
        let mut metadata = serde_json::Map::new();
        if let Some(context) = context {
            metadata.insert("contextLength".into(), serde_json::json!(context));
        }
        if !model_type.is_empty() {
            metadata.insert("type".into(), Value::String(model_type.to_string()));
        }
        if !endpoints.is_empty() {
            metadata.insert(
                "endpoints".into(),
                Value::Array(endpoints.iter().cloned().map(Value::String).collect()),
            );
        }
        if image {
            metadata.insert("image".into(), Value::Bool(true));
        }
        details.insert(id, Value::Object(metadata));
    }
}

fn collect_strings(value: Option<&Value>, out: &mut Vec<String>) {
    match value {
        Some(Value::String(value)) => out.push(value.clone()),
        Some(Value::Array(values)) => values
            .iter()
            .for_each(|value| collect_strings(Some(value), out)),
        Some(Value::Object(values)) => values
            .values()
            .for_each(|value| collect_strings(Some(value), out)),
        _ => {}
    }
}
