//! Rust backend, independent of the Tauri desktop shell.
//!
//! Keep implementation modules private: callers only select a configuration
//! path, start the server, and use the bound port from the returned handle.
mod auth;
mod chat;
mod config;
mod crypto;
mod handlers;
mod metrics;
mod opencode;
mod routing;
mod session_titles;
mod server;
mod stream;
mod types;

pub use config::default_config_path;
pub use server::{shutdown_running_instance, start_server};
pub use types::ServerHandle;
#[cfg(test)]
mod tests;
