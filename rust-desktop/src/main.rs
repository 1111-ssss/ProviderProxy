use provider_proxy_desktop::proxy::{default_config_path, start_server};
use serde::Serialize;
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize)]
struct UpdateInfo {
    version: String,
    current_version: String,
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    // Do not make a locally compiled/debug binary unexpectedly replace itself.
    if cfg!(debug_assertions) || std::env::var_os("PP_DISABLE_UPDATES").is_some() {
        return Ok(None);
    }

    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateInfo {
        version: update.version,
        current_version: update.current_version,
    }))
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, restart: bool) -> Result<bool, String> {
    if cfg!(debug_assertions) || std::env::var_os("PP_DISABLE_UPDATES").is_some() {
        return Ok(false);
    }

    let Some(update) = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(false);
    };

    eprintln!(
        "[updater] installing version {} (current {}, restart: {restart})",
        update.version, update.current_version
    );
    let mut downloaded = 0_usize;
    update
        .restart_after_install(restart)
        .download_and_install(
            |chunk_length, content_length| {
                downloaded += chunk_length;
                eprintln!("[updater] downloaded {downloaded} bytes of {content_length:?}");
            },
            || eprintln!("[updater] download finished"),
        )
        .await
        .map_err(|error| error.to_string())?;

    eprintln!("[updater] update installed");
    if restart {
        app.restart();
    }
    Ok(true)
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    app.restart();
}

#[cfg(target_os = "linux")]
fn autostart_file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    config.join("autostart/provider-proxy.desktop")
}

#[cfg(target_os = "linux")]
fn desktop_exec(path: &Path) -> String {
    format!(
        "\"{}\"",
        path.to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    )
}

#[tauri::command]
fn autostart_enabled() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("reg")
            .args([
                "QUERY",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "ProviderProxy",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        return Ok(output.status.success());
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(autostart_file().is_file());
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    Err("автозапуск поддерживается только на Windows и Linux".into())
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let status = if enabled {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let command = format!("\"{}\"", executable.display());
            Command::new("reg")
                .args([
                    "ADD",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "ProviderProxy",
                    "/t",
                    "REG_SZ",
                    "/d",
                ])
                .arg(command)
                .args(["/f"])
                .status()
        } else {
            Command::new("reg")
                .args([
                    "DELETE",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "ProviderProxy",
                    "/f",
                ])
                .status()
        }
        .map_err(|error| error.to_string())?;
        if !status.success() {
            return Err("не удалось изменить автозапуск Windows".into());
        }
        return autostart_enabled();
    }

    #[cfg(target_os = "linux")]
    {
        let path = autostart_file();
        if enabled {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let desktop = format!(
                "[Desktop Entry]\nType=Application\nName=Provider Proxy\nComment=Provider Proxy desktop application\nExec={}\nTerminal=false\nCategories=Development;Utility;\nStartupWMClass=provider-proxy-desktop\n",
                desktop_exec(&executable)
            );
            fs::write(&path, desktop).map_err(|error| error.to_string())?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        return autostart_enabled();
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = enabled;
        Err("автозапуск поддерживается только на Windows и Linux".into())
    }
}

fn browser_url(url: &Url) -> Option<&str> {
    // Check-in links are web pages, never commands, files or custom protocols.
    matches!(url.scheme(), "http" | "https").then(|| url.as_str())
}

fn main() {
    let config_path = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("PP_CONFIG_FILE").map(std::path::PathBuf::from))
        .unwrap_or_else(default_config_path);

    let server = Arc::new(start_server(config_path).expect("provider_proxy server must start"));
    let port = server.port;
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Handle new windows natively; the GUI is served over the local HTTP
        // API and must not need remote IPC permissions to open a web link.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(server.clone())
        .invoke_handler(tauri::generate_handler![
            check_for_update,
            install_update,
            restart_app,
            autostart_enabled,
            set_autostart
        ])
        .setup(move |app| {
            let url = Url::parse(&format!("http://127.0.0.1:{port}/")).expect("local proxy URL");
            let browser = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Provider Proxy")
                .inner_size(1240.0, 900.0)
                .min_inner_size(900.0, 620.0)
                .on_new_window(move |url, _features| {
                    if let Some(url) = browser_url(&url) {
                        if let Err(error) = browser.opener().open_url(url, None::<&str>) {
                            eprintln!("could not open link in the system browser: {error}");
                        }
                    }
                    // Do not create a second WebView or navigate away from the proxy GUI.
                    NewWindowResponse::Deny
                })
                .build()?;

            let show = MenuItemBuilder::new("Открыть Provider Proxy")
                .id("show")
                .build(app)?;
            let exit = MenuItemBuilder::new("Выйти").id("exit").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&show)
                .separator()
                .item(&exit)
                .build()?;
            let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Provider Proxy");
            // Without a tray icon the app still works, but the window can only
            // be reopened from the in-app UI.
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "exit" => app.exit(0),
                _ => {}
            })
            .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window hides the app; the tray menu or in-app
                // settings are used for a real process exit.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running provider_proxy desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkin_links_allow_web_pages_only() {
        for url in ["https://example.test/checkin", "http://localhost/checkin"] {
            let parsed = Url::parse(url).unwrap();
            assert_eq!(browser_url(&parsed), Some(url));
        }
        for url in [
            "file:///tmp/test",
            "javascript:alert(1)",
            "custom:run",
            "mailto:a@example.test",
        ] {
            assert_eq!(browser_url(&Url::parse(url).unwrap()), None);
        }
    }
}
