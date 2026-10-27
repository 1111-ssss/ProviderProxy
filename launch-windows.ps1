param()

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Config = if ($env:PP_CONFIG_FILE) { $env:PP_CONFIG_FILE } else { Join-Path $Root "config.json" }
$Server = Join-Path $Root "server.mjs"

try {
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
} catch {
    throw "Node.js не найден. Установите Node.js и повторите запуск."
}

$Port = 8787
if (Test-Path -LiteralPath $Config) {
    try {
        $Configured = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
        if ($Configured.port) { $Port = [int]$Configured.port }
    } catch {
        # The server will report an invalid config in its own output.
    }
}

$PingUrl = "http://127.0.0.1:$Port/api/ping"
try {
    $Existing = Invoke-WebRequest -Uri $PingUrl -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    if ($Existing.StatusCode -eq 200) {
        Start-Process $PingUrl
        exit 0
    }
} catch {
    # No running proxy yet; start one below.
}

$Log = Join-Path $Root "server.log"
$ErrorLog = Join-Path $Root "server-error.log"
$Arguments = @("`"$Server`"", "`"$Config`"")
Start-Process -FilePath $Node -WorkingDirectory $Root -ArgumentList $Arguments -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError $ErrorLog

for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    Start-Sleep -Milliseconds 100
    try {
        $Ready = Invoke-WebRequest -Uri $PingUrl -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        if ($Ready.StatusCode -eq 200) {
            Start-Process $PingUrl
            exit 0
        }
    } catch {
        # Keep waiting while Node starts.
    }
}

throw "Provider Proxy не запустился. Подробности: $Log и $ErrorLog"
