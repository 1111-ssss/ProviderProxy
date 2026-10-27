param()

$ErrorActionPreference = "Stop"
$RustDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $RustDir
$Binary = Join-Path $RustDir "target\release\provider-proxy-desktop.exe"
$Config = if ($env:PP_CONFIG_FILE) { $env:PP_CONFIG_FILE } else { Join-Path $Root "config.json" }

if (-not (Test-Path -LiteralPath $Binary)) {
    throw "Rust-приложение не собрано. Выполните 'cargo tauri build' или 'cargo build --release' в rust-desktop."
}

$Argument = "`"$Config`""
Start-Process -FilePath $Binary -WorkingDirectory $Root -ArgumentList $Argument
