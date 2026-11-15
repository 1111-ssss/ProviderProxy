//! OS integration that is not part of the proxy: autostart entries and
//! application shortcuts. Kept out of `main.rs` so the window setup there stays
//! about the window. Every command is registered in `main.rs`.

use std::path::{Path, PathBuf};

use provider_proxy_desktop::proxy::default_config_path;
use std::fs;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::process::Command;

/// Set when the app is started by the autostart entry. The window stays hidden
/// and only the tray icon appears, so logging in does not open a GUI window.
const TRAY_FLAG: &str = "--tray";

pub(crate) fn started_in_tray() -> bool {
    std::env::args().skip(1).any(|arg| arg == TRAY_FLAG)
}

/// The database this process was told to use: argv[1], then PP_CONFIG_FILE,
/// then the default lookup. `main` uses the same order to start the server.
pub(crate) fn requested_config_path() -> PathBuf {
    pick_config_path(
        std::env::args_os().nth(1),
        std::env::var_os("PP_CONFIG_FILE"),
    )
}

/// argv wins over PP_CONFIG_FILE, which wins over the default lookup.
pub(crate) fn pick_config_path(
    argument: Option<std::ffi::OsString>,
    env: Option<std::ffi::OsString>,
) -> PathBuf {
    argument
        .map(PathBuf::from)
        .or_else(|| env.map(PathBuf::from))
        .unwrap_or_else(default_config_path)
}

fn autostart_config_path() -> Result<PathBuf, String> {
    // Must match the database the running process opened. Reading only
    // default_config_path() ignored an explicit path argument, so the autostart
    // entry pointed at ./config.db instead of the user's real database.
    let path = requested_config_path();
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .map_err(|error| error.to_string())
    }
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

fn autostart_command(executable: &Path, config: &Path, tray: bool) -> String {
    let mut command = format!("\"{}\" \"{}\"", executable.display(), config.display());
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
pub(crate) fn autostart_tray_enabled() -> Result<bool, String> {
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
pub(crate) fn autostart_enabled() -> Result<bool, String> {
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
pub(crate) fn set_autostart(enabled: bool, tray: bool) -> Result<bool, String> {
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
fn create_windows_shortcut(desktop: bool) -> Result<String, String> {
    let data_dir =
        dirs::data_dir().ok_or_else(|| "не удалось определить каталог AppData".to_string())?;
    let (shortcut_dir, shortcut) = if desktop {
        let desktop_dir =
            dirs::desktop_dir().ok_or_else(|| "не удалось определить рабочий стол".to_string())?;
        let shortcut = desktop_dir.join("Provider Proxy.lnk");
        (desktop_dir, shortcut)
    } else {
        let shortcut_dir = data_dir.join("Microsoft/Windows/Start Menu/Programs/Provider Proxy");
        let shortcut = shortcut_dir.join("Provider Proxy.lnk");
        (shortcut_dir, shortcut)
    };
    fs::create_dir_all(&shortcut_dir).map_err(|error| error.to_string())?;
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
            "не удалось создать ярлык Windows".into()
        } else {
            format!("не удалось создать ярлык Windows: {details}")
        });
    }
    Ok(shortcut.to_string_lossy().into_owned())
}

#[cfg(target_os = "linux")]
fn create_linux_shortcut(desktop: bool) -> Result<String, String> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| "не удалось определить каталог данных пользователя".to_string())?;
    // XDG desktop folders are localised, so ask the platform instead of assuming a name.
    let shortcut_dir = if desktop {
        dirs::desktop_dir().ok_or_else(|| "не удалось определить рабочий стол".to_string())?
    } else {
        data_dir.join("applications")
    };
    fs::create_dir_all(&shortcut_dir).map_err(|error| error.to_string())?;
    let shortcut = shortcut_dir.join("provider-proxy.desktop");
    let executable = autostart_executable()?;
    let config = autostart_config_path()?;
    let working_directory = executable.parent().unwrap_or_else(|| Path::new("."));
    let icon = working_directory.join("icons/icon.png");
    let mut entry = String::from(
        "[Desktop Entry]\nType=Application\nName=Provider Proxy\nComment=Provider Proxy desktop application\n",
    );
    entry.push_str(&format!(
        "Exec={} {}\n",
        desktop_exec(&executable),
        desktop_exec(&config)
    ));
    entry.push_str(&format!("Path={}\n", desktop_exec(working_directory)));
    if icon.is_file() {
        entry.push_str(&format!("Icon={}\n", desktop_exec(&icon)));
    }
    entry.push_str(
        "Terminal=false\nCategories=Development;Utility;\nStartupWMClass=provider-proxy-desktop\n",
    );
    fs::write(&shortcut, entry).map_err(|error| error.to_string())?;
    // GNOME/KDE only treat a desktop file as launchable when it is executable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&shortcut, fs::Permissions::from_mode(0o755));
    }
    // Drop the earlier file names so the launcher does not show duplicates.
    for stale in ["provider-proxy-rust.desktop", "provider-proxy-npm.desktop"] {
        let path = shortcut_dir.join(stale);
        if path != shortcut {
            let _ = fs::remove_file(path);
        }
    }
    // A newly written file stays invisible to the launcher until its database is
    // refreshed, which is why the button used to appear to do nothing.
    refresh_desktop_database(&shortcut_dir);
    Ok(shortcut.to_string_lossy().into_owned())
}

/// Refresh the launcher's application index after writing a `.desktop` file.
#[cfg(target_os = "linux")]
fn refresh_desktop_database(directory: &Path) {
    let _ = Command::new("update-desktop-database").arg(directory).status();
    for tool in ["kbuildsycoca6", "kbuildsycoca5"] {
        if Command::new(tool).arg("--noincremental").status().is_ok() {
            break;
        }
    }
}

#[tauri::command]
pub(crate) fn create_app_shortcut(desktop: bool) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        return create_windows_shortcut(desktop);
    }

    #[cfg(target_os = "linux")]
    {
        return create_linux_shortcut(desktop);
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = desktop;
        Err("создание ярлыка поддерживается только на Windows и Linux".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The autostart entry must point at the database the app actually opened.
    /// It used to ignore argv and fall back to ./config.db, so a login launched
    /// an empty copy that filled itself from config.example.json.
    #[test]
    fn autostart_follows_the_database_this_process_opened() {
        use std::ffi::OsString;
        let from_arg = pick_config_path(Some(OsString::from("/real/config.db")), None);
        assert_eq!(from_arg, PathBuf::from("/real/config.db"));
        let from_env = pick_config_path(None, Some(OsString::from("/env/config.db")));
        assert_eq!(from_env, PathBuf::from("/env/config.db"));
    }
}
