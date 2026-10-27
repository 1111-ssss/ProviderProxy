[CmdletBinding()]
param(
    [switch]$NoDesktop
)

$ErrorActionPreference = "Stop"
$RustDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $RustDir
$StartMenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) "Provider Proxy"
$DesktopDir = [Environment]::GetFolderPath("Desktop")
$PowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$Installer = New-Object -ComObject WScript.Shell

New-Item -ItemType Directory -Path $StartMenuDir -Force | Out-Null

function New-ProviderProxyShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Target,
        [string]$Arguments = "",
        [string]$WorkingDirectory,
        [string]$IconLocation
    )

    $Shortcut = $Installer.CreateShortcut($Path)
    $Shortcut.TargetPath = $Target
    $Shortcut.Arguments = $Arguments
    $Shortcut.WorkingDirectory = $WorkingDirectory
    $Shortcut.Description = "Provider Proxy"
    if ($IconLocation) { $Shortcut.IconLocation = $IconLocation }
    $Shortcut.Save()
}

$RustLauncher = Join-Path $RustDir "launch-windows.ps1"
$NpmLauncher = Join-Path $Root "launch-windows.ps1"
$RustArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$RustLauncher`""
$NpmArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$NpmLauncher`""
$RustIcon = Join-Path $RustDir "target\release\provider-proxy-desktop.exe"
if (-not (Test-Path -LiteralPath $RustIcon)) { $RustIcon = "$env:SystemRoot\System32\SHELL32.dll,3" }

$Shortcuts = @(
    @{
        Name = "Provider Proxy Rust.lnk"
        Target = $PowerShell
        Arguments = $RustArguments
        WorkingDirectory = $Root
        Icon = $RustIcon
    },
    @{
        Name = "Provider Proxy npm.lnk"
        Target = $PowerShell
        Arguments = $NpmArguments
        WorkingDirectory = $Root
        Icon = "$env:SystemRoot\System32\SHELL32.dll,14"
    }
)

foreach ($Item in $Shortcuts) {
    New-ProviderProxyShortcut -Path (Join-Path $StartMenuDir $Item.Name) -Target $Item.Target -Arguments $Item.Arguments -WorkingDirectory $Item.WorkingDirectory -IconLocation $Item.Icon
    if (-not $NoDesktop) {
        New-ProviderProxyShortcut -Path (Join-Path $DesktopDir $Item.Name) -Target $Item.Target -Arguments $Item.Arguments -WorkingDirectory $Item.WorkingDirectory -IconLocation $Item.Icon
    }
}

Write-Host "Ярлыки Provider Proxy Rust и Provider Proxy npm созданы в меню Пуск и на рабочем столе."
