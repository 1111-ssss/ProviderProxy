use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
};

const CONFIG_KEY_PREFIX: &str = "enc:v1:";

fn master_key_path() -> PathBuf {
    std::env::var_os("PP_CONFIG_KEY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("provider-proxy")
                .join("master.key")
        })
}

fn key_bytes(create: bool) -> Result<[u8; 32], String> {
    let raw = if let Ok(value) = std::env::var("PP_CONFIG_KEY") {
        value.into_bytes()
    } else {
        let path = master_key_path();
        match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if create && err.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let bytes: [u8; 32] = rand::random();
                let mut file = File::create(&path).map_err(|e| e.to_string())?;
                file.write_all(&bytes).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).ok();
                }
                bytes.to_vec()
            }
            Err(err) => return Err(format!("cannot read config key {}: {err}", path.display())),
        }
    };
    let digest = Sha256::digest(raw);
    Ok(digest.into())
}

pub(crate) fn encrypt_secret(value: &str) -> Result<String, String> {
    if value.is_empty() || value.starts_with("{env:") || value.starts_with(CONFIG_KEY_PREFIX) {
        return Ok(value.to_string());
    }
    let key = key_bytes(true)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce: [u8; 12] = rand::random();
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), value.as_bytes())
        .map_err(|e| e.to_string())?;
    let split = encrypted.len().saturating_sub(16);
    let (ciphertext, tag) = encrypted.split_at(split);
    Ok(format!(
        "{CONFIG_KEY_PREFIX}{}:{}:{}",
        URL_SAFE_NO_PAD.encode(nonce),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(ciphertext)
    ))
}

pub(crate) fn decrypt_secret(value: &str) -> Result<String, String> {
    if !value.starts_with(CONFIG_KEY_PREFIX) {
        return Ok(value.to_string());
    }
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 5 || parts[1] != "v1" {
        return Err("invalid encrypted secret".into());
    }
    let nonce = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|e| e.to_string())?;
    let tag = URL_SAFE_NO_PAD
        .decode(parts[3])
        .map_err(|e| e.to_string())?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(parts[4])
        .map_err(|e| e.to_string())?;
    let mut combined = ciphertext;
    combined.extend_from_slice(&tag);
    let key = key_bytes(false)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), combined.as_ref())
        .map_err(|_| "cannot decrypt config; check PP_CONFIG_KEY or master.key".to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}
