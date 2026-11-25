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
# Run the exe directly when it exists: a shortcut to powershell.exe flashes a
# console window on every start. The launcher (which builds first) is the
# fallback only until the binary is there.
$RustExe = Join-Path $RustDir "target\release\provider-proxy-desktop.exe"
$RustIcon = $RustExe
if (-not (Test-Path -LiteralPath $RustIcon)) { $RustIcon = "$env:SystemRoot\System32\SHELL32.dll,3" }
$RustTarget = if (Test-Path -LiteralPath $RustExe) { $RustExe } else { $PowerShell }
$RustArguments = if (Test-Path -LiteralPath $RustExe) { "" } else { "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$RustLauncher`"" }

$Shortcuts = @(
    @{
        Name = "Provider Proxy.lnk"
        Target = $RustTarget
        Arguments = $RustArguments
        WorkingDirectory = $Root
        Icon = $RustIcon
    }
)

foreach ($Item in $Shortcuts) {
    New-ProviderProxyShortcut -Path (Join-Path $StartMenuDir $Item.Name) -Target $Item.Target -Arguments $Item.Arguments -WorkingDirectory $Item.WorkingDirectory -IconLocation $Item.Icon
    if (-not $NoDesktop) {
        New-ProviderProxyShortcut -Path (Join-Path $DesktopDir $Item.Name) -Target $Item.Target -Arguments $Item.Arguments -WorkingDirectory $Item.WorkingDirectory -IconLocation $Item.Icon
    }
}

Write-Host "Ярлык Provider Proxy создан в меню Пуск и на рабочем столе."
