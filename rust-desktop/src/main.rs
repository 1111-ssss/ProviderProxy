use provider_proxy_desktop::proxy::{default_config_path, start_server};
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

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
        // Handle new windows natively; the GUI is served over the local HTTP
        // API and must not need remote IPC permissions to open a web link.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(server.clone())
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
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Provider Proxy");
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
