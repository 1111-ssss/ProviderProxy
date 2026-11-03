[CmdletBinding()]
param(
    [switch]$Installer
)

$ErrorActionPreference = "Stop"
$RustDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RustDir

if ($Installer) {
    & cargo tauri build --ci -- --locked
} else {
    # This produces target\release\provider-proxy-desktop.exe.
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
