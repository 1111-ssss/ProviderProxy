#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use provider_proxy_desktop::proxy::{shutdown_running_instance, start_server};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

mod platform;
mod updater;

/// Reports download progress to the GUI. Emitted from the download loop so the
/// bar advances during a slow release asset.
fn emit_update_progress(app: &tauri::AppHandle, done: u64, total: u64) {
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "done": done, "total": total }),
    );
}

#[tauri::command]
async fn check_for_update() -> Result<Option<updater::UpdateInfo>, String> {
    updater::check_for_update().await
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, restart: bool) -> Result<bool, String> {
    let report = |done, total| emit_update_progress(&app, done, total);
    let installed = updater::install_update(restart, Some(&report)).await?;
    if restart && installed {
        app.exit(0);
    }
    Ok(installed)
}

#[tauri::command]
async fn list_versions() -> Result<Vec<updater::VersionInfo>, String> {
    updater::list_versions().await
}

#[tauri::command]
async fn rollback_to(app: tauri::AppHandle, version: String) -> Result<bool, String> {
    let report = |done, total| emit_update_progress(&app, done, total);
    let installed = updater::rollback_to(version, Some(&report)).await?;
    if installed {
        app.exit(0);
    }
    Ok(installed)
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    if updater::restart_pending()? {
        app.exit(0);
    } else {
        app.restart();
    }
    Ok(())
}

fn browser_url(url: &Url) -> Option<&str> {
    // Check-in links are web pages, never commands, files or custom protocols.
    matches!(url.scheme(), "http" | "https").then(|| url.as_str())
}

/// Start the local proxy, taking over the port from a previous copy. A busy port
/// used to panic here: the window never appeared and the old instance kept
/// running, which reads as "the app reopened".
fn start_proxy(config_path: PathBuf) -> provider_proxy_desktop::proxy::ServerHandle {
    for attempt in 0..3 {
        shutdown_running_instance(&config_path);
        match start_server(config_path.clone()) {
            Ok(server) => return server,
            Err(error) if attempt < 2 => {
                eprintln!("provider_proxy: порт занят, повторяю запуск ({attempt}): {error}");
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(error) => {
                // No console on Windows release builds, so the message also goes
                // to stderr for launch.sh, which captures it into its log.
                eprintln!("provider_proxy: не удалось запустить прокси на порту: {error}");
                std::process::exit(1);
            }
        }
    }
    unreachable!("start_proxy always returns or exits inside the loop")
}

fn main() {
    let config_path = platform::requested_config_path();
    // A second launch replaces the running window instead of failing on a busy
    // port and leaving the old copy (and its stale config) on screen.
    let server = Arc::new(start_proxy(config_path));
    let port = server.port;
    tauri::Builder::default()
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
            list_versions,
            rollback_to,
            restart_app,
            platform::autostart_enabled,
            platform::set_autostart,
            platform::autostart_tray_enabled,
            platform::create_app_shortcut
        ])
        .setup(move |app| {
            let url = Url::parse(&format!("http://127.0.0.1:{port}/")).expect("local proxy URL");
            // Autostart passes --tray: start quietly with only the tray icon and
            // leave the window hidden until the user asks for it.
            let in_tray = platform::started_in_tray();
            let browser = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Provider Proxy")
                .inner_size(1240.0, 900.0)
                .min_inner_size(900.0, 620.0)
                .visible(!in_tray)
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

            // A hidden window still needs to exist for the tray menu to show it,
            // but WebKit should not keep a hidden view alive on first paint.
            if in_tray {
                let _ = window.hide();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window hides the app; the tray menu or in-app
                // settings are used for a real process exit. Hiding (rather than
                // exiting) keeps the proxy serving opencode. If hiding ever
                // fails there is no way back to the window, so exit instead of
                // leaving an invisible copy running.
                api.prevent_close();
                if window.hide().is_err() {
                    window.app_handle().exit(0);
                }
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
