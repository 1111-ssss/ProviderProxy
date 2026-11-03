param()

$ErrorActionPreference = "Stop"
$RustDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $RustDir
$Binary = Join-Path $RustDir "target\release\provider-proxy-desktop.exe"
$Config = if ($env:PP_CONFIG_FILE) { $env:PP_CONFIG_FILE } else { Join-Path $Root "config.json" }
$SourceRoots = @(
    (Join-Path $RustDir "src"),
    (Join-Path $RustDir "frontend"),
    (Join-Path $RustDir "Cargo.toml"),
    (Join-Path $RustDir "Cargo.lock"),
    (Join-Path $RustDir "build.rs"),
    (Join-Path $RustDir "tauri.conf.json")
)
$NeedsBuild = -not (Test-Path -LiteralPath $Binary)
if (-not $NeedsBuild) {
    $BinaryTime = (Get-Item -LiteralPath $Binary).LastWriteTimeUtc
    $SourceFiles = foreach ($SourceRoot in $SourceRoots) {
        if (Test-Path -LiteralPath $SourceRoot -PathType Container) { Get-ChildItem -LiteralPath $SourceRoot -File -Recurse }
        elseif (Test-Path -LiteralPath $SourceRoot -PathType Leaf) { Get-Item -LiteralPath $SourceRoot }
    }
    $NeedsBuild = @($SourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $BinaryTime }).Count -gt 0
}

if ($NeedsBuild) {
    $Build = Join-Path $RustDir "build-windows.ps1"
    if (-not (Test-Path -LiteralPath $Build)) {
        throw "Не найден скрипт сборки Rust-приложения: $Build"
    }
    & $Build
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Binary)) {
        throw "Rust-приложение не собрано. Подробности выше в выводе cargo."
    }
}

$Argument = "`"$Config`""
Start-Process -FilePath $Binary -WorkingDirectory $Root -ArgumentList $Argument
