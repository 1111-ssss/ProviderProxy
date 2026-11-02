[CmdletBinding()]
param(
    [switch]$Bundle
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildScript = Join-Path $Root "rust-desktop\build-windows.ps1"

if ($Bundle) {
    & $BuildScript -Installer
} else {
    & $BuildScript
}

if ($LASTEXITCODE -ne 0) {
    throw "Сборка Provider Proxy завершилась с кодом $LASTEXITCODE."
}
