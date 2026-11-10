#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use provider_proxy_desktop::proxy::{default_config_path, start_server};
mod updater;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::Arc;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn check_for_update() -> Result<Option<updater::UpdateInfo>, String> {
    updater::check_for_update().await
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle, restart: bool) -> Result<bool, String> {
    let installed = updater::install_update(restart).await?;
    if restart {
        if installed {
            app.exit(0);
        }
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

fn autostart_config_path() -> Result<PathBuf, String> {
    let path = default_config_path();
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "linux")]
fn autostart_executable() -> Result<PathBuf, String> {
    // When an AppImage is running, current_exe() points into its temporary
    // mount. That path disappears as soon as the application exits, so use
    // the original AppImage path for the desktop entry instead.
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        let path = PathBuf::from(appimage);
        if path.is_file() {
            return if path.is_absolute() {
                Ok(path)
            } else {
                std::env::current_dir()
                    .map(|directory| directory.join(path))
                    .map_err(|error| error.to_string())
            };
        }
    }
    std::env::current_exe().map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn windows_command_arg(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

/// Set when the app is started by the autostart entry. The window stays hidden
/// and only the tray icon appears, so logging in does not open a GUI window.
const TRAY_FLAG: &str = "--tray";

fn started_in_tray() -> bool {
    std::env::args().skip(1).any(|arg| arg == TRAY_FLAG)
}

fn autostart_command(executable: &Path, config: &Path, tray: bool) -> String {
    let mut command = format!(
        "\"{}\" \"{}\"",
        executable.display(),
        config.display()
    );
    if tray {
        command.push(' ');
        command.push_str(TRAY_FLAG);
    }
    command
}

/// Sidecar that remembers the tray choice while autostart is switched off.
fn autostart_tray_preference_file() -> PathBuf {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    config.join("provider-proxy/autostart-tray")
}

fn write_autostart_preference(tray: bool) -> Result<(), String> {
    let path = autostart_tray_preference_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, if tray { "1" } else { "0" }).map_err(|error| error.to_string())
}

fn read_autostart_preference() -> bool {
    fs::read_to_string(autostart_tray_preference_file())
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
}

/// Reads whether the stored autostart entry starts the app in the tray.
#[tauri::command]
fn autostart_tray_enabled() -> Result<bool, String> {
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
        return if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).contains(TRAY_FLAG))
        } else {
            Ok(read_autostart_preference())
        };
    }

    #[cfg(target_os = "linux")]
    {
        // The entry is deleted when autostart is off, so the sidecar file keeps
        // the choice until it is turned back on.
        return Ok(autostart_file()
            .is_file()
            .then(|| {
                fs::read_to_string(autostart_file())
                    .map(|entry| entry.contains(TRAY_FLAG))
                    .unwrap_or(false)
            })
            .unwrap_or_else(read_autostart_preference));
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    Err("автозапуск поддерживается только на Windows и Linux".into())
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
fn set_autostart(enabled: bool, tray: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let status = if enabled {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let config = autostart_config_path()?;
            let command = autostart_command(&executable, &config, tray);
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
        if !status.success() && enabled {
            return Err("не удалось изменить автозапуск Windows".into());
        }
        // The frontend always sends the current tray choice, including when
        // autostart is being turned off, so the setting survives toggling.
        let _ = write_autostart_preference(tray);
        return autostart_enabled();
    }

    #[cfg(target_os = "linux")]
    {
        // Remember the tray choice while the entry is disabled: enabling it
        // later must not lose the setting.
        if !enabled {
            let _ = write_autostart_preference(tray);
        }
        let path = autostart_file();
        if enabled {
            let executable = autostart_executable()?;
            let config = autostart_config_path()?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let desktop = format!(
                "[Desktop Entry]\nType=Application\nName=Provider Proxy\nComment=Provider Proxy desktop application\nExec={}\nPath={}\nTerminal=false\nCategories=Development;Utility;\nStartupWMClass=provider-proxy-desktop\n",
                autostart_command(&executable, &config, tray),
                desktop_exec(executable.parent().unwrap_or_else(|| Path::new(".")))
            );
            fs::write(&path, desktop).map_err(|error| error.to_string())?;
            let _ = write_autostart_preference(tray);
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        return autostart_enabled();
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (enabled, tray);
        Err("автозапуск поддерживается только на Windows и Linux".into())
    }
}

#[cfg(target_os = "windows")]
fn create_windows_app_shortcut() -> Result<String, String> {
    let data_dir =
        dirs::data_dir().ok_or_else(|| "не удалось определить каталог AppData".to_string())?;
    let shortcut_dir = data_dir.join("Microsoft/Windows/Start Menu/Programs/Provider Proxy");
    fs::create_dir_all(&shortcut_dir).map_err(|error| error.to_string())?;
    let shortcut = shortcut_dir.join("Provider Proxy Rust.lnk");
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let config = autostart_config_path()?;
    let working_directory = executable.parent().unwrap_or_else(|| Path::new("."));

    // A .lnk is what the Windows Start menu indexes as an installed app.
    // Pass paths through environment variables so PowerShell never has to
    // re-parse user-controlled path fragments as part of its script.
    let script = r#"
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:PP_SHORTCUT_PATH)
$shortcut.TargetPath = $env:PP_SHORTCUT_TARGET
$shortcut.Arguments = $env:PP_SHORTCUT_ARGUMENTS
$shortcut.WorkingDirectory = $env:PP_SHORTCUT_WORKDIR
$shortcut.Description = 'Provider Proxy'
$shortcut.IconLocation = "$env:PP_SHORTCUT_TARGET,0"
$shortcut.Save()
"#;
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("PP_SHORTCUT_PATH", &shortcut)
        .env("PP_SHORTCUT_TARGET", &executable)
        .env("PP_SHORTCUT_ARGUMENTS", windows_command_arg(&config))
        .env("PP_SHORTCUT_WORKDIR", working_directory)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if details.is_empty() {
            "не удалось создать ярлык в меню Пуск Windows".into()
        } else {
            format!("не удалось создать ярлык в меню Пуск Windows: {details}")
        });
    }
    Ok(shortcut.to_string_lossy().into_owned())
}

#[cfg(target_os = "linux")]
fn create_linux_app_shortcut() -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "не удалось определить каталог данных пользователя".to_string())?;
    let applications_dir = data_dir.join("applications");
    fs::create_dir_all(&applications_dir).map_err(|error| error.to_string())?;
    let shortcut = applications_dir.join("provider-proxy-rust.desktop");
    let executable = autostart_executable()?;
    let config = autostart_config_path()?;
    let working_directory = executable.parent().unwrap_or_else(|| Path::new("."));
    let desktop = format!(
        "[Desktop Entry]\nType=Application\nName=Provider Proxy Rust\nComment=Provider Proxy desktop application\nExec={} {}\nPath={}\nTerminal=false\nCategories=Development;Utility;\nStartupWMClass=provider-proxy-desktop\n",
        desktop_exec(&executable),
        desktop_exec(&config),
        desktop_exec(working_directory)
    );
    fs::write(&shortcut, desktop).map_err(|error| error.to_string())?;
    Ok(shortcut.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_app_shortcut() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return create_windows_app_shortcut();
    }

    #[cfg(target_os = "linux")]
    {
        return create_linux_app_shortcut();
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    Err("создание ярлыка поддерживается только на Windows и Linux".into())
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
            set_autostart,
            autostart_tray_enabled,
            create_app_shortcut
        ])
        .setup(move |app| {
            let url = Url::parse(&format!("http://127.0.0.1:{port}/")).expect("local proxy URL");
            // Autostart passes --tray: start quietly with only the tray icon and
            // leave the window hidden until the user asks for it.
            let in_tray = started_in_tray();
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
