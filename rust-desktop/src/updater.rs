#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{ACCEPT, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    fs::{self, File},
    io::{self, Cursor},
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::ZipArchive;

const RELEASE_API: &str = "https://api.github.com/repos/1111-ssss/ProviderProxy/releases/latest";
const RELEASES_API: &str = "https://api.github.com/repos/1111-ssss/ProviderProxy/releases?per_page=30";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize)]
pub(crate) struct UpdateInfo {
    pub(crate) version: String,
    pub(crate) current_version: String,
    /// True when this version is not newer than the one the user rolled back
    /// from. The GUI shows it only for a manual check and never auto-installs
    /// it, so a deliberate rollback is not silently undone.
    pub(crate) gated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct VersionInfo {
    pub(crate) version: String,
    pub(crate) current: bool,
    /// Publication date as the API reports it, so the picker can show when a
    /// version was released instead of a bare number.
    pub(crate) published: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
    #[serde(default, rename = "published_at")]
    published_at: Option<String>,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
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

async fn github_releases() -> Result<Vec<GithubRelease>, String> {
    let response = reqwest::Client::new()
        .get(RELEASES_API)
        .header(ACCEPT, "application/vnd.github+json")
        .header(USER_AGENT, format!("Provider-Proxy/{CURRENT_VERSION}"))
        .send()
        .await
        .map_err(|error| format!("не удалось получить список релизов: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub Releases вернул HTTP {}",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("не удалось прочитать список релизов: {error}"))
}

/// The download URL for `version` on this platform, if the release has one.
fn release_asset(release: &GithubRelease, version: &Version) -> Option<String> {
    let name = format!("Provider-Proxy-v{version}-{}", asset_suffix());
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .map(|asset| asset.browser_download_url.clone())
}

fn current_version() -> Result<Version, String> {
    Version::parse(CURRENT_VERSION)
        .map_err(|error| format!("некорректная текущая версия {CURRENT_VERSION}: {error}"))
}

/// The version the user rolled back from, remembered across restarts. While it
/// is set, updates at or below it are hidden from the automatic check: a
/// deliberate rollback must not be undone behind the user's back.
fn rollback_ceiling_file() -> PathBuf {
    if let Some(path) = std::env::var_os("PP_ROLLBACK_CEILING_FILE") {
        return PathBuf::from(path);
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("provider-proxy/rollback-ceiling")
}

fn read_rollback_ceiling() -> Option<Version> {
    let raw = fs::read_to_string(rollback_ceiling_file()).ok()?;
    Version::parse(raw.trim()).ok()
}

fn write_rollback_ceiling(version: &Version) {
    let path = rollback_ceiling_file();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, version.to_string());
}

pub(crate) fn clear_rollback_ceiling() {
    let _ = fs::remove_file(rollback_ceiling_file());
}

/// A discovery is "gated" when it is not strictly newer than the version the
/// user rolled back from. The GUI then keeps it to a manual check.
fn is_gated(remote: &Version) -> bool {
    read_rollback_ceiling().is_some_and(|ceiling| *remote <= ceiling)
}

/// Published releases, newest first. Only ones with a ZIP for this platform are
/// offered: a version the app cannot install is not a rollback target.
pub(crate) async fn list_versions() -> Result<Vec<VersionInfo>, String> {
    if std::env::var_os("PP_DISABLE_UPDATES").is_some() {
        return Ok(Vec::new());
    }
    let current = current_version()?;
    let releases = github_releases().await?;
    let published: HashMap<String, String> = releases
        .iter()
        .filter_map(|release| {
            let version = parse_release_version(&release.tag_name).ok()?;
            Some((version.to_string(), release.published_at.clone()?))
        })
        .collect();
    Ok(rollback_targets(releases, &current)
        .into_iter()
        .map(|version| {
            let published = published.get(&version.to_string()).cloned().unwrap_or_default();
            VersionInfo {
                current: version == current,
                version: version.to_string(),
                published,
            }
        })
        .collect())
}

/// Published versions this app can actually install, newest first. A version
/// newer than the running one is not a rollback target, and one without a ZIP
/// for this platform cannot be installed at all.
fn rollback_targets(releases: Vec<GithubRelease>, current: &Version) -> Vec<Version> {
    let mut versions: Vec<Version> = releases
        .iter()
        .filter_map(|release| {
            if release.draft || release.prerelease {
                return None;
            }
            let version = parse_release_version(&release.tag_name).ok()?;
            if &version > current || release_asset(release, &version).is_none() {
                return None;
            }
            Some(version)
        })
        .collect();
    versions.sort_unstable();
    versions.dedup();
    versions.reverse();
    versions
}

/// Install an older published release and restart into it. The config lives
/// outside the binary, so settings and history survive the swap.
pub(crate) async fn rollback_to(
    version: String,
    progress: Option<ProgressSink<'_>>,
) -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Err("откат доступен только в release-сборке приложения".into());
    }
    let target = Version::parse(&version)
        .map_err(|error| format!("некорректная версия {version}: {error}"))?;
    if target == current_version()? {
        return Err(format!("{version} уже установлена"));
    }
    let release = github_releases()
        .await?
        .into_iter()
        .find(|release| {
            parse_release_version(&release.tag_name)
                .map(|tag| tag == target)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("релиз {version} не найден"))?;
    let url = release_asset(&release, &target)
        .ok_or_else(|| format!("в релизе {version} нет ZIP для этой платформы"))?;
    let bytes = download_with_progress(&url, progress).await?;
    // Remember where the user rolled back from, so the automatic check does not
    // offer the very version they left.
    write_rollback_ceiling(&current_version()?);
    schedule_update(stage_update(&version, &bytes)?)?;
    Ok(true)
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
    Ok(latest_update().await?.map(|update| {
        let remote = Version::parse(&update.version).unwrap_or_else(|_| Version::new(0, 0, 0));
        UpdateInfo {
            gated: is_gated(&remote),
            version: update.version,
            current_version: CURRENT_VERSION.to_string(),
        }
    }))
}

/// Callback the caller supplies to observe a download: `(bytes_done, bytes_total)`.
/// `total` is 0 when the server does not send `Content-Length`.
pub(crate) type ProgressSink<'a> = &'a (dyn Fn(u64, u64) + Send + Sync);

async fn download_with_progress(
    url: &str,
    progress: Option<ProgressSink<'_>>,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
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
    let total = response.content_length().unwrap_or(0);
    let mut bytes = Vec::with_capacity(total as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("не удалось прочитать ZIP обновления: {error}"))?;
        bytes.extend_from_slice(&chunk);
        if let Some(report) = progress {
            report(bytes.len() as u64, total);
        }
    }
    Ok(bytes)
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
        crate::platform::quiet(Command::new("powershell.exe"))
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

pub(crate) async fn install_update(
    restart: bool,
    progress: Option<ProgressSink<'_>>,
) -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Err("автообновление доступно только в release-сборке приложения".into());
    }
    let Some(update) = latest_update().await? else {
        return Ok(false);
    };
    let bytes = download_with_progress(&update.asset_url, progress).await?;
    let staged = stage_update(&update.version, &bytes)?;
    // Installing any update clears the rollback ceiling: the user moved forward
    // again, so the old "do not offer this" rule no longer applies.
    clear_rollback_ceiling();
    if restart {
        schedule_update(staged)?;
    } else {
        let mut pending = pending_update()
            .lock()
            .map_err(|_| "не удалось сохранить ожидающее обновление".to_string())?;
        // Replacing a staged update must not leave its temp directory behind.
        if let Some(previous) = pending.take() {
            let _ = fs::remove_dir_all(previous.root);
        }
        *pending = Some(staged);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            assets: assets
                .iter()
                .map(|name| GithubAsset {
                    name: name.to_string(),
                    browser_download_url: format!("https://example.invalid/{name}"),
                })
                .collect(),
            published_at: Some("2026-11-03T20:33:32Z".to_string()),
            prerelease: false,
            draft: false,
        }
    }

    #[test]
    fn offers_only_older_versions_with_a_platform_zip() {
        let zip = format!("Provider-Proxy-v{{}}-{}", asset_suffix());
        let releases = vec![
            release("app-v9.0.0", &[&zip.replace("{}", "9.0.0")]),
            release("v0.1.5", &[&zip.replace("{}", "0.1.5")]),
            release("v0.1.4", &[&zip.replace("{}", "0.1.4")]),
            // A release without the platform ZIP cannot be installed.
            release("v0.1.3", &["Provider-Proxy-v0.1.3-macos.zip"]),
        ];
        let current = Version::parse("0.1.5").unwrap();
        let versions = rollback_targets(releases, &current);
        assert_eq!(
            versions.iter().map(Version::to_string).collect::<Vec<_>>(),
            vec!["0.1.5", "0.1.4"]
        );
    }

    /// After a rollback the user must not be offered the version they left
    /// again: the automatic check hides anything at or below the ceiling, and a
    /// genuinely newer release is offered normally.
    #[test]
    fn a_rollback_hides_versions_up_to_where_the_user_left() {
        let ceiling = std::env::temp_dir().join(format!(
            "provider-proxy-ceiling-{}.txt",
            std::process::id()
        ));
        std::env::set_var("PP_ROLLBACK_CEILING_FILE", &ceiling);
        clear_rollback_ceiling();
        assert!(!is_gated(&Version::parse("9.9.9").unwrap()), "no ceiling: nothing is gated");

        write_rollback_ceiling(&Version::parse("0.1.8").unwrap());
        assert!(is_gated(&Version::parse("0.1.8").unwrap()), "the left version is gated");
        assert!(is_gated(&Version::parse("0.1.7").unwrap()), "older is gated too");
        assert!(!is_gated(&Version::parse("0.1.9").unwrap()), "a newer release stays visible");

        clear_rollback_ceiling();
        assert!(!is_gated(&Version::parse("0.1.8").unwrap()), "cleared: nothing is gated");
        let _ = std::fs::remove_file(&ceiling);
        std::env::remove_var("PP_ROLLBACK_CEILING_FILE");
    }
}
