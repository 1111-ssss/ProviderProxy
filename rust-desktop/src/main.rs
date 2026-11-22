#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use provider_proxy_desktop::proxy::{shutdown_running_instance, start_server};
use std::path::{Path, PathBuf};
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

/// The window could not be created (usually no WebView2). The proxy is already
/// listening, so offer the same GUI in the system browser instead of dying mute.
fn offer_browser_fallback(port: u16, error: &str) {
    let url = format!("http://127.0.0.1:{port}/");
    let reason = if webview2_installed() {
        format!("Окно приложения не создалось: {error}")
    } else {
        "На этом компьютере не установлен Microsoft Edge WebView2 Runtime — без него приложение не может открыть окно.".to_string()
    };
    let message = format!(
        "{reason}\n\nПрокси уже работает, и интерфейс доступен в браузере:\n{url}\n\nОткрыть браузерную версию?"
    );
    eprintln!("provider_proxy: {message}");
    #[cfg(target_os = "windows")]
    {
        // A log next to the exe survives even if the dialog is dismissed.
        if let Some(directory) = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
        {
            let _ = std::fs::write(directory.join("provider-proxy-error.log"), &message);
        }
        if platform::confirm("Provider Proxy: нет окна", &message) {
            // The default-handler shim opens the URL without a console window.
            let _ = std::process::Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", &url])
                .spawn();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (reason, error);
    }
}

/// Port named by the configuration, for messages shown before a server exists.
fn port_hint(config_path: &Path) -> Option<u16> {
    let raw = std::fs::read_to_string(config_path.with_extension("json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .map(|port| port as u16)
}

/// WebView2 is a separate Microsoft runtime. Note that VS Code working proves
/// nothing: VS Code ships its own Chromium (Electron) and does not use WebView2.
/// Windows 11 and updated Windows 10 have it, but LTSC, N editions and fresh
/// offline installs often do not.
#[cfg(target_os = "windows")]
fn webview2_installed() -> bool {
    // The Evergreen runtime registers its version under this client id, either
    // per machine (with a WOW6432Node view) or per user.
    const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    [
        format!(r"HKLM\SOFTWARE\WOW6432Node\{CLIENT}"),
        format!(r"HKLM\SOFTWARE\{CLIENT}"),
        format!(r"HKCU\SOFTWARE\{CLIENT}"),
    ]
    .iter()
    .any(|key| {
        std::process::Command::new("reg")
            .args(["query", key, "/v", "pv"])
            .output()
            .map(|output| output.status.success() && !output.stdout.is_empty())
            .unwrap_or(false)
    })
}

#[cfg(not(target_os = "windows"))]
fn webview2_installed() -> bool {
    true
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
                offer_browser_fallback(
                    port_hint(&config_path).unwrap_or(8787),
                    &format!("Не удалось занять порт прокси: {error}"),
                );
                std::process::exit(1);
            }
        }
    }
    unreachable!("start_proxy always returns or exits inside the loop")
}

/// Writes panics to a file next to the exe: a Windows GUI build has no console,
/// so a crash would otherwise leave no trace at all.
fn install_panic_log() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(directory) = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
        {
            let _ = std::fs::write(
                directory.join("provider-proxy-crash.log"),
                format!("{} {info}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")),
            );
        }
        previous(info);
    }));
}

fn main() {
    install_panic_log();
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
                // Every platform drops the native frame: the page draws its own
                // caption bar. The shadow keeps the rounded corners Windows 11
                // gives an undecorated window and is a no-op elsewhere. The init
                // script flags the page before its own scripts run, so the bar is
                // laid out even if the Tauri JS API is unavailable.
                .decorations(false)
                .shadow(true)
                .initialization_script("document.documentElement.dataset.frame = 'custom'")
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
        .unwrap_or_else(|error| {
            // No window means the WebView could not be created, usually because
            // WebView2 is missing. The proxy itself is already running, so the
            // GUI works in any browser on this machine.
            offer_browser_fallback(port, &error.to_string());
            std::process::exit(1);
        });
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
