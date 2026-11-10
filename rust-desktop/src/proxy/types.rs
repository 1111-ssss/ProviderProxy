use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, RwLock},
    time::Instant,
};

use super::config::Storage;

#[derive(Debug, Clone)]
pub(crate) struct Upstream {
    pub(crate) name: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: String,
    pub(crate) headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub(crate) struct ProviderUsage {
    pub(crate) requests: u64,
    pub(crate) ok: u64,
    pub(crate) limits: u64,
    pub(crate) errors: u64,
    #[serde(rename = "tokensIn")]
    pub(crate) tokens_in: u64,
    #[serde(rename = "tokensOut")]
    pub(crate) tokens_out: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub(crate) struct ModelUsage {
    pub(crate) requests: u64,
    pub(crate) ok: u64,
    pub(crate) failovers: u64,
    #[serde(rename = "tokensIn")]
    pub(crate) tokens_in: u64,
    #[serde(rename = "tokensOut")]
    pub(crate) tokens_out: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub(crate) struct ImageUsage {
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) requests: u64,
    pub(crate) ok: u64,
    pub(crate) errors: u64,
    #[serde(rename = "lastStatus")]
    pub(crate) last_status: u16,
    #[serde(rename = "lastUsedAt", skip_serializing_if = "Option::is_none")]
    pub(crate) last_used_at: Option<String>,
    #[serde(rename = "lastEditAt", skip_serializing_if = "Option::is_none")]
    pub(crate) last_edit_at: Option<String>,
    #[serde(rename = "lastMode", skip_serializing_if = "Option::is_none")]
    pub(crate) last_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct Usage {
    pub(crate) since: u128,
    pub(crate) requests: u64,
    pub(crate) ok: u64,
    pub(crate) failed: u64,
    pub(crate) failovers: u64,
    #[serde(rename = "tokensIn")]
    pub(crate) tokens_in: u64,
    #[serde(rename = "tokensOut")]
    pub(crate) tokens_out: u64,
    #[serde(rename = "imagesGenerated")]
    pub(crate) images_generated: u64,
    pub(crate) providers: HashMap<String, ProviderUsage>,
    pub(crate) models: HashMap<String, ModelUsage>,
    pub(crate) images: HashMap<String, ImageUsage>,
    #[serde(rename = "recentImages")]
    pub(crate) recent_images: Vec<Value>,
    #[serde(rename = "lastImageModel", skip_serializing_if = "Option::is_none")]
    pub(crate) last_image_model: Option<Value>,
    #[serde(rename = "lastEditImageModel", skip_serializing_if = "Option::is_none")]
    pub(crate) last_edit_image_model: Option<Value>,
}

impl Default for Usage {
    fn default() -> Self {
        Self {
            since: super::metrics::now_ms(),
            requests: 0,
            ok: 0,
            failed: 0,
            failovers: 0,
            tokens_in: 0,
            tokens_out: 0,
            images_generated: 0,
            providers: HashMap::new(),
            models: HashMap::new(),
            images: HashMap::new(),
            recent_images: Vec::new(),
            last_image_model: None,
            last_edit_image_model: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LifetimeTokens {
    pub(crate) tokens_in: u64,
    pub(crate) tokens_out: u64,
    pub(crate) requests: u64,
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config_path: Arc<PathBuf>,
    pub(crate) storage: Arc<Storage>,
    pub(crate) config: Arc<RwLock<Value>>,
    pub(crate) chains: Arc<RwLock<HashMap<String, Vec<Upstream>>>>,
    pub(crate) cooldowns: Arc<Mutex<HashMap<String, Instant>>>,
    pub(crate) logs: Arc<Mutex<VecDeque<String>>>,
    pub(crate) usage: Arc<Mutex<Usage>>,
    pub(crate) usage_history: Arc<Mutex<HashMap<String, Usage>>>,
    pub(crate) usage_day: Arc<Mutex<String>>,
    /// Totals that never reset: the seven-day history is pruned, so summing it
    /// cannot answer "how much have I spent in total".
    pub(crate) lifetime: Arc<Mutex<LifetimeTokens>>,
    pub(crate) image_tasks: Arc<Mutex<HashMap<String, String>>>,
    pub(crate) client: reqwest::Client,
    pub(crate) port: u16,
    pub(crate) log_max: usize,
}

pub struct ServerHandle {
    pub port: u16,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProviderModelsRequest {
    pub(crate) provider: Option<String>,
    #[serde(rename = "baseURL")]
    pub(crate) base_url: Option<String>,
    #[serde(rename = "apiKey")]
    pub(crate) api_key: Option<String>,
    pub(crate) headers: Option<HashMap<String, String>>,
}
