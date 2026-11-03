#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{ACCEPT, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Cursor},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::ZipArchive;

const RELEASE_API: &str = "https://api.github.com/repos/1111-ssss/ProviderProxy/releases/latest";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize)]
pub(crate) struct UpdateInfo {
    pub(crate) version: String,
    pub(crate) current_version: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone)]
struct RemoteUpdate {
    version: String,
    asset_url: String,
}

#[derive(Debug)]
struct StagedUpdate {
    root: PathBuf,
    binary: PathBuf,
    current: PathBuf,
    args: Vec<OsString>,
}

static PENDING_UPDATE: OnceLock<Mutex<Option<StagedUpdate>>> = OnceLock::new();

fn pending_update() -> &'static Mutex<Option<StagedUpdate>> {
    PENDING_UPDATE.get_or_init(|| Mutex::new(None))
}

fn asset_suffix() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        return "windows-x64.zip";
    }
    #[cfg(target_os = "linux")]
    {
        return "linux-x64.zip";
    }
    #[allow(unreachable_code)]
    "unsupported.zip"
}

fn binary_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        return "provider-proxy-desktop.exe";
    }
    #[cfg(target_os = "linux")]
    {
        return "provider-proxy-desktop";
    }
    #[allow(unreachable_code)]
    "provider-proxy-desktop"
}

fn parse_release_version(tag: &str) -> Result<Version, String> {
    let version = tag
        .strip_prefix("app-v")
        .or_else(|| tag.strip_prefix('v'))
        .unwrap_or(tag);
    Version::parse(version).map_err(|error| format!("некорректная версия релиза {tag}: {error}"))
}

async fn latest_update() -> Result<Option<RemoteUpdate>, String> {
    if std::env::var_os("PP_DISABLE_UPDATES").is_some() {
        return Ok(None);
    }

    let current = Version::parse(CURRENT_VERSION)
        .map_err(|error| format!("некорректная текущая версия {CURRENT_VERSION}: {error}"))?;
    let response = reqwest::Client::new()
        .get(RELEASE_API)
        .header(ACCEPT, "application/vnd.github+json")
        .header(USER_AGENT, format!("Provider-Proxy/{CURRENT_VERSION}"))
        .send()
        .await
        .map_err(|error| format!("не удалось проверить GitHub Releases: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub Releases вернул HTTP {}", response.status()));
    }
    let release: GithubRelease = response
        .json()
        .await
        .map_err(|error| format!("не удалось прочитать ответ GitHub Releases: {error}"))?;
    let remote = parse_release_version(&release.tag_name)?;
    if remote <= current {
        return Ok(None);
    }

    let expected_suffix = asset_suffix();
    let expected_name = format!("Provider-Proxy-v{remote}-{expected_suffix}");
    let asset = release
        .assets
        .into_iter()
        .find(|asset| asset.name == expected_name)
        .ok_or_else(|| format!("в релизе нет ZIP-файла {expected_name}"))?;

    Ok(Some(RemoteUpdate {
        version: remote.to_string(),
        asset_url: asset.browser_download_url,
    }))
}

pub(crate) async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    Ok(latest_update().await?.map(|update| UpdateInfo {
        version: update.version,
        current_version: CURRENT_VERSION.to_string(),
    }))
}

async fn download(url: &str) -> Result<Vec<u8>, String> {
    let response = reqwest::Client::new()
        .get(url)
        .header(ACCEPT, "application/octet-stream")
        .header(USER_AGENT, format!("Provider-Proxy/{CURRENT_VERSION}"))
        .send()
        .await
        .map_err(|error| format!("не удалось скачать обновление: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "скачивание обновления вернуло HTTP {}",
            response.status()
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("не удалось прочитать ZIP обновления: {error}"))
}

fn update_root(version: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "provider-proxy-update-{version}-{}-{timestamp}",
        std::process::id()
    ));
    fs::create_dir_all(&root)
        .map_err(|error| format!("не удалось создать каталог обновления: {error}"))?;
    Ok(root)
}

fn stage_update(version: &str, bytes: &[u8]) -> Result<StagedUpdate, String> {
    let root = update_root(version)?;
    let binary = root.join(binary_name());
    let result = (|| {
        let mut archive = ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("некорректный ZIP обновления: {error}"))?;
        let expected = binary_name();
        let mut found = false;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("не удалось прочитать ZIP обновления: {error}"))?;
            let entry_name = entry
                .name()
                .map_err(|error| format!("некорректное имя файла в ZIP: {error}"))?
                .into_owned();
            let safe_path = entry_name
                .split(['/', '\\'])
                .all(|part| part != ".." && !part.is_empty());
            let is_binary = Path::new(&entry_name)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(expected);
            if !safe_path || entry.is_dir() || !is_binary {
                continue;
            }
            let mut output = File::create(&binary)
                .map_err(|error| format!("не удалось сохранить обновление: {error}"))?;
            io::copy(&mut entry, &mut output)
                .map_err(|error| format!("не удалось распаковать обновление: {error}"))?;
            found = true;
            break;
        }
        if !found {
            return Err(format!("в ZIP нет бинарника {expected}"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("не удалось сделать обновление исполняемым: {error}"))?;
        }
        let current = std::env::current_exe()
            .map_err(|error| format!("не удалось определить путь приложения: {error}"))?;
        Ok(StagedUpdate {
            root: root.clone(),
            binary,
            current,
            args: std::env::args_os().skip(1).collect(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&root);
    }
    result
}

#[cfg(windows)]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(unix)]
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn schedule_update(update: StagedUpdate) -> Result<(), String> {
    let pid = std::process::id();
    let current = update.current.to_string_lossy();
    let binary = update.binary.to_string_lossy();
    let root = update.root.to_string_lossy();

    #[cfg(windows)]
    {
        let arguments = update
            .args
            .iter()
            .map(|arg| ps_quote(&arg.to_string_lossy()))
            .collect::<Vec<_>>();
        let start = if arguments.is_empty() {
            format!("Start-Process -FilePath {}", ps_quote(&current))
        } else {
            format!(
                "Start-Process -FilePath {} -ArgumentList @({})",
                ps_quote(&current),
                arguments.join(", ")
            )
        };
        let script = format!(
            "$ErrorActionPreference = 'Stop'\n$targetPid = {pid}\nwhile (Get-Process -Id $targetPid -ErrorAction SilentlyContinue) {{ Start-Sleep -Milliseconds 200 }}\n$moved = $false\nfor ($attempt = 0; $attempt -lt 50; $attempt++) {{\n    try {{\n        Move-Item -LiteralPath {} -Destination {} -Force\n        $moved = $true\n        break\n    }} catch {{\n        Start-Sleep -Milliseconds 200\n    }}\n}}\nif (-not $moved) {{ exit 1 }}\n{}\nRemove-Item -LiteralPath {} -Recurse -Force -ErrorAction SilentlyContinue",
            ps_quote(&binary),
            ps_quote(&current),
            start,
            ps_quote(&root),
        );
        let encoded = BASE64.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-ExecutionPolicy",
                "Bypass",
                "-EncodedCommand",
                &encoded,
            ])
            .spawn()
            .map_err(|error| format!("не удалось запустить установщик обновления: {error}"))?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        let arguments = update
            .args
            .iter()
            .map(|arg| sh_quote(&arg.to_string_lossy()))
            .collect::<Vec<_>>();
        let start = if arguments.is_empty() {
            format!("exec {}", sh_quote(&current))
        } else {
            format!("exec {} {}", sh_quote(&current), arguments.join(" "))
        };
        let script = format!(
            "while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; moved=0; for attempt in $(seq 1 50); do if mv -f -- {} {}; then moved=1; break; fi; sleep 0.2; done; [ \"$moved\" -eq 1 ] || exit 1; chmod 755 {}; rm -rf -- {}; {}",
            sh_quote(&binary),
            sh_quote(&current),
            sh_quote(&current),
            sh_quote(&root),
            start,
        );
        Command::new("sh")
            .args(["-c", &script])
            .spawn()
            .map_err(|error| format!("не удалось запустить установщик обновления: {error}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("автообновление не поддерживается на этой платформе".into())
}

pub(crate) async fn install_update(restart: bool) -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Err("автообновление доступно только в release-сборке приложения".into());
    }
    let Some(update) = latest_update().await? else {
        return Ok(false);
    };
    let bytes = download(&update.asset_url).await?;
    let staged = stage_update(&update.version, &bytes)?;
    if restart {
        schedule_update(staged)?;
    } else {
        *pending_update()
            .lock()
            .map_err(|_| "не удалось сохранить ожидающее обновление".to_string())? = Some(staged);
    }
    Ok(true)
}

pub(crate) fn restart_pending() -> Result<bool, String> {
    let pending = pending_update()
        .lock()
        .map_err(|_| "не удалось получить ожидающее обновление".to_string())?
        .take();
    let Some(pending) = pending else {
        return Ok(false);
    };
    schedule_update(pending)?;
    Ok(true)
}
