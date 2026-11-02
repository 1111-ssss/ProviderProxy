[CmdletBinding()]
param(
    [switch]$Installer
)

$ErrorActionPreference = "Stop"
$RustDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RustDir

if ($Installer) {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        throw "Для установщика и автообновлений задайте TAURI_SIGNING_PRIVATE_KEY."
    }
    & cargo tauri build --ci -- --locked
} else {
    # This produces target\release\provider-proxy-desktop.exe without requiring
    # a signing key. Signed installers are built with -Installer or in CI.
    & cargo build --release --locked
}

if ($LASTEXITCODE -ne 0) {
    throw "Сборка Provider Proxy завершилась с кодом $LASTEXITCODE."
}

$Binary = Join-Path $RustDir "target\release\provider-proxy-desktop.exe"
if (Test-Path -LiteralPath $Binary) {
    Write-Host "EXE: $Binary"
}

$Installers = Join-Path $RustDir "target\release\bundle"
if (Test-Path -LiteralPath $Installers) {
    Write-Host "Установщики: $Installers"
}
