param(
    [string]$MockHost = "127.0.0.1",
    [int]$MockPort = 18080,
    [int]$MockHttpsPort = 18443,
    [string]$MitmListenHost = "0.0.0.0",
    [int]$MitmPort = 8080,
    [string]$WsListenHost = "127.0.0.1",
    [int]$WsListenPort = 15007,
    [int]$WsTlsListenPort = 15443,
    [int]$ImListenPort = 15008,
    [string]$UpstreamWsUrl = "ws://148.178.21.210:15007",
    [string]$WsReplayFixture = "",
    [string]$WsStructuredLoginFixture = "",
    [string]$WsInteractionFixture = "",
    [switch]$WsInteractionDb,
    [string]$LocalBaseUrl = "",
    [string]$SdkBaseUrl = "",
    [switch]$NoMitmProxy,
    [switch]$NoUpstreamProxy,
    [switch]$NoWebSocketProxy,
    [switch]$NoWebSocketMysql,
    [switch]$NoLoginMysql,
    [switch]$NoBusinessMysql,
    [long]$ForceDiamond = -1
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$runtimeDir = Join-Path $root "runtime"
$stateFile = Join-Path $runtimeDir "stack.json"
$mockStdout = Join-Path $runtimeDir "mock-service.out.log"
$mockStderr = Join-Path $runtimeDir "mock-service.err.log"
$proxyStdout = Join-Path $runtimeDir "mitmproxy.out.log"
$proxyStderr = Join-Path $runtimeDir "mitmproxy.err.log"
$wsStdout = Join-Path $runtimeDir "websocket-proxy.out.log"
$wsStderr = Join-Path $runtimeDir "websocket-proxy.err.log"
$tlsDir = Join-Path $runtimeDir "tls"
$tlsCertPath = Join-Path $tlsDir "mock-cert.pem"
$tlsKeyPath = Join-Path $tlsDir "mock-key.pem"
$wsTlsCertPath = Join-Path $tlsDir "gateway-cert.pem"
$wsTlsKeyPath = Join-Path $tlsDir "gateway-key.pem"
$routeScript = Join-Path $root "mitmproxy\\route_to_local_mock.py"
$mitmLauncher = Join-Path $root "mitmproxy\\run_mitmdump.py"
$ensureCertScript = Join-Path $root "ensure_dev_cert.py"
$ensureWsCertScript = Join-Path $root "scripts\ensure-ws-cert.py"
$serverScript = Join-Path $root "server.js"
$websocketProxyScript = Join-Path $root "websocket_proxy.py"
$imWebsocketScript = Join-Path $root "im_websocket_server.py"
$imStdout = Join-Path $runtimeDir "im-websocket.out.log"
$imStderr = Join-Path $runtimeDir "im-websocket.err.log"

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

function Get-PythonCandidates {
    $candidates = @()
    if ($env:PYTHON_EXE) {
        $candidates += $env:PYTHON_EXE
    }
    if ($env:PYTHON) {
        $candidates += $env:PYTHON
    }
    if ($env:CODEX_PYTHON) {
        $candidates += $env:CODEX_PYTHON
    }

    $shadowBotPython = "D:\study\ShadowBot\shadowbot-6.0.30\python310\python.exe"
    $bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    $candidates += @(
        $shadowBotPython,
        $bundledPython,
        "python",
        "py"
    )

    $seen = @{}
    foreach ($candidate in $candidates) {
        if (-not $candidate) {
            continue
        }
        $key = $candidate.ToLowerInvariant()
        if ($seen.ContainsKey($key)) {
            continue
        }
        $seen[$key] = $true
        $candidate
    }
}

function Test-Python {
    param(
        [string]$PythonExe,
        [string]$ImportModule = ""
    )

    if ([System.IO.Path]::IsPathRooted($PythonExe) -and -not (Test-Path $PythonExe)) {
        return $false
    }
    if (-not [System.IO.Path]::IsPathRooted($PythonExe)) {
        $command = Get-Command $PythonExe -ErrorAction SilentlyContinue
        if (-not $command) {
            return $false
        }
    }

    $code = "import sys; print(sys.executable)"
    if ($ImportModule) {
        $code = "import sys; import $ImportModule; print(sys.executable)"
    }

    try {
        $output = & $PythonExe -c $code 2>$null
        return ($LASTEXITCODE -eq 0 -and $output)
    } catch {
        return $false
    }
}

function Resolve-Python {
    param(
        [string]$Label,
        [string]$ImportModule = ""
    )

    foreach ($candidate in Get-PythonCandidates) {
        if (Test-Python -PythonExe $candidate -ImportModule $ImportModule) {
            return $candidate
        }
    }

    if ($ImportModule) {
        throw "Python for $Label not found. Need a Python that can import '$ImportModule'."
    }
    throw "Python for $Label not found."
}

function Repair-ProcessEnvironmentPath {
    $environment = [System.Environment]::GetEnvironmentVariables("Process")
    $canonicalPathValue = $null

    foreach ($key in @("Path", "PATH")) {
        if ($environment.Contains($key)) {
            $canonicalPathValue = [string]$environment[$key]
            break
        }
    }

    if (-not $canonicalPathValue) {
        $canonicalPathValue = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    }

    [System.Environment]::SetEnvironmentVariable("PATH", $null, "Process")
    [System.Environment]::SetEnvironmentVariable("Path", $canonicalPathValue, "Process")
}

function Assert-PortAvailable {
    param(
        [int]$Port,
        [string]$Label
    )

    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
        throw "$Label port $Port is already in use. Stop the existing listener or choose another port."
    }
}

Repair-ProcessEnvironmentPath

if (Test-Path $stateFile) {
    Write-Host "Existing stack state found. Stopping previous processes first..."
    & (Join-Path $root "stop-stack.ps1")
}

$proxyUnknown = if ($NoUpstreamProxy) { "0" } else { "1" }

Assert-PortAvailable -Port $MockPort -Label "Mock service"
Assert-PortAvailable -Port $MockHttpsPort -Label "Mock HTTPS service"
if (-not $NoMitmProxy) {
    Assert-PortAvailable -Port $MitmPort -Label "mitmproxy"
}
if (-not $NoWebSocketProxy) {
    Assert-PortAvailable -Port $WsListenPort -Label "WebSocket proxy"
    Assert-PortAvailable -Port $ImListenPort -Label "IM WebSocket service"
    if ($WsTlsListenPort -gt 0) {
        Assert-PortAvailable -Port $WsTlsListenPort -Label "TLS WebSocket proxy"
    }
}

$nodeExe = (Get-Command node).Source
$mitmPythonExe = $null
if (-not $NoMitmProxy) {
    $mitmPythonExe = Resolve-Python -Label "mitmproxy" -ImportModule "mitmproxy.tools.main"
}
$wsPythonExe = Resolve-Python -Label "websocket proxy" -ImportModule "websockets"

if (-not ((Test-Path $tlsCertPath) -and (Test-Path $tlsKeyPath))) {
    $certPythonExe = Resolve-Python -Label "TLS certificate generation" -ImportModule "cryptography"
    & $certPythonExe $ensureCertScript --cert-path $tlsCertPath --key-path $tlsKeyPath --host $MockHost
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to generate local mock TLS certificate."
    }
}

if (-not $NoWebSocketProxy -and $WsTlsListenPort -gt 0) {
    $certPythonExe = Resolve-Python -Label "WSS certificate generation" -ImportModule "cryptography"
    $mitmCaPem = Join-Path $env:USERPROFILE ".mitmproxy\mitmproxy-ca.pem"
    if (-not (Test-Path -LiteralPath $mitmCaPem)) {
        throw "mitmproxy CA not found: $mitmCaPem"
    }
    & $certPythonExe $ensureWsCertScript `
        --ca-pem $mitmCaPem `
        --cert-path $wsTlsCertPath `
        --key-path $wsTlsKeyPath `
        --dns-name "hdgame-dglobal-gate.lilithcdn.com" `
        --dns-name "hdgame-dglobal-gate.lilithgame.com"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to generate local WSS certificate."
    }
}

$mockArguments = @(
    $serverScript,
    "--host", $MockHost,
    "--port", $MockPort,
    "--https-port", $MockHttpsPort,
    "--https-key-file", $tlsKeyPath,
    "--https-cert-file", $tlsCertPath,
    "--proxy-unknown", $proxyUnknown,
    "--disable-sdk-sls", "1"
)

if ($LocalBaseUrl) {
    $mockArguments += @("--local-base-url", $LocalBaseUrl)
}
if ($SdkBaseUrl) {
    $mockArguments += @("--sdk-base-url", $SdkBaseUrl)
}
if ($ForceDiamond -ge 0) {
    $mockArguments += @("--force-diamond", [string]$ForceDiamond)
}

$proxyArguments = @(
    $mitmLauncher,
    "-s", $routeScript,
    "--listen-host", $MitmListenHost,
    "--listen-port", $MitmPort,
    "--ignore-hosts", "^(?!.*(account-global\.lilith\.com|park-m-global\.lilith\.com|lilithgame\.com|farlightgames\.com|sharesrc\.cyou|graph\.facebook\.com|34\.149\.80\.225)).*$",
    "--set", "upstream_cert=false",
    "--set", "ssl_insecure=true",
    "--set", "connection_strategy=lazy",
    "--set", "afk_mock_host=$MockHost",
    "--set", "afk_mock_port=$MockPort",
    "--set", "afk_mock_https_port=$MockHttpsPort"
)

$wsArguments = @(
    "-u",
    $websocketProxyScript,
    "--listen-host", $WsListenHost,
    "--listen-port", $WsListenPort,
    "--upstream-url", $UpstreamWsUrl
)
if ($WsTlsListenPort -gt 0) {
    $wsArguments += @(
        "--tls-listen-port", [string]$WsTlsListenPort,
        "--tls-cert-file", $wsTlsCertPath,
        "--tls-key-file", $wsTlsKeyPath
    )
}

if ($WsReplayFixture) {
    $wsArguments += @("--replay-fixture", $WsReplayFixture)
}
if ($WsStructuredLoginFixture) {
    $wsArguments += @("--structured-login-fixture", $WsStructuredLoginFixture)
}
if ($WsInteractionFixture) {
    $wsArguments += @("--interaction-fixture", $WsInteractionFixture)
}
if ($WsInteractionDb) {
    $wsArguments += @("--interaction-db")
}
if ($NoWebSocketMysql) {
    $wsArguments += @("--no-mysql")
}
if ($NoLoginMysql) {
    $wsArguments += @("--no-login-mysql")
}
if ($NoBusinessMysql) {
    $wsArguments += @("--no-business-mysql")
}

$env:AFK_MOCK_HOST = $MockHost
$env:AFK_MOCK_PORT = [string]$MockPort
$env:AFK_MOCK_INTERNAL_BASE_URL = "http://127.0.0.1`:$MockPort"
if ($ForceDiamond -ge 0) {
    $env:AFK_FORCE_DIAMOND = [string]$ForceDiamond
} else {
    Remove-Item Env:\AFK_FORCE_DIAMOND -ErrorAction SilentlyContinue
}

$mockProcess = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList $mockArguments `
    -RedirectStandardOutput $mockStdout `
    -RedirectStandardError $mockStderr `
    -WindowStyle Hidden `
    -PassThru

$proxyProcess = $null
if (-not $NoMitmProxy) {
    $proxyProcess = Start-Process `
        -FilePath $mitmPythonExe `
        -ArgumentList $proxyArguments `
        -RedirectStandardOutput $proxyStdout `
        -RedirectStandardError $proxyStderr `
        -WindowStyle Hidden `
        -PassThru
}

$wsProcess = $null
$imProcess = $null
if (-not $NoWebSocketProxy) {
    $wsProcess = Start-Process `
        -FilePath $wsPythonExe `
        -ArgumentList $wsArguments `
        -RedirectStandardOutput $wsStdout `
        -RedirectStandardError $wsStderr `
        -WindowStyle Hidden `
        -PassThru
    $imProcess = Start-Process `
        -FilePath $wsPythonExe `
        -ArgumentList @("-u", $imWebsocketScript, "--listen-host", $WsListenHost, "--listen-port", [string]$ImListenPort, "--api-base-url", "http://127.0.0.1:$MockPort") `
        -RedirectStandardOutput $imStdout `
        -RedirectStandardError $imStderr `
        -WindowStyle Hidden `
        -PassThru
}

Start-Sleep -Milliseconds 1200
$mockProcess.Refresh()
if ($proxyProcess) {
    $proxyProcess.Refresh()
}
if ($wsProcess) {
    $wsProcess.Refresh()
}
if ($imProcess) {
    $imProcess.Refresh()
}

if ($mockProcess.HasExited) {
    $stderr = if (Test-Path $mockStderr) { Get-Content $mockStderr -Raw } else { "" }
    $stdout = if (Test-Path $mockStdout) { Get-Content $mockStdout -Raw } else { "" }
    throw "Mock service exited during startup.`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
}

if ($proxyProcess -and $proxyProcess.HasExited) {
    $stderr = if (Test-Path $proxyStderr) { Get-Content $proxyStderr -Raw } else { "" }
    $stdout = if (Test-Path $proxyStdout) { Get-Content $proxyStdout -Raw } else { "" }
    Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue
    throw "mitmproxy exited during startup.`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
}

if ($wsProcess -and $wsProcess.HasExited) {
    $stderr = if (Test-Path $wsStderr) { Get-Content $wsStderr -Raw } else { "" }
    $stdout = if (Test-Path $wsStdout) { Get-Content $wsStdout -Raw } else { "" }
    Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
    throw "WebSocket proxy exited during startup.`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
}
if ($imProcess -and $imProcess.HasExited) {
    $stderr = if (Test-Path $imStderr) { Get-Content $imStderr -Raw } else { "" }
    Stop-Process -Id $mockProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $proxyProcess.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $wsProcess.Id -Force -ErrorAction SilentlyContinue
    throw "IM WebSocket service exited during startup.`nSTDERR:`n$stderr"
}

$state = @{
    started_at = (Get-Date).ToString("o")
    mock_pid = $mockProcess.Id
    proxy_pid = if ($proxyProcess) { $proxyProcess.Id } else { $null }
    ws_pid = if ($wsProcess) { $wsProcess.Id } else { $null }
    im_pid = if ($imProcess) { $imProcess.Id } else { $null }
    mock_host = $MockHost
    mock_port = $MockPort
    mock_https_port = $MockHttpsPort
    mitm_listen_host = $MitmListenHost
    mitm_port = $MitmPort
    ws_listen_host = $WsListenHost
    ws_listen_port = $WsListenPort
    ws_tls_listen_port = $WsTlsListenPort
    im_listen_port = $ImListenPort
    upstream_ws_url = $UpstreamWsUrl
    ws_replay_fixture = $WsReplayFixture
    ws_structured_login_fixture = $WsStructuredLoginFixture
    ws_interaction_fixture = $WsInteractionFixture
    ws_interaction_db = [bool]$WsInteractionDb
    ws_mysql_enabled = (-not $NoWebSocketMysql)
    login_mysql_enabled = (-not $NoLoginMysql)
    business_mysql_enabled = (-not $NoBusinessMysql)
    tavern_draw_cost_item_id = 13
    tavern_draw_cost_amount = 1
    force_diamond = if ($ForceDiamond -ge 0) { $ForceDiamond } else { $null }
    local_base_url = $LocalBaseUrl
    sdk_base_url = $SdkBaseUrl
    proxy_unknown = ($proxyUnknown -eq "1")
    mitm_proxy_enabled = (-not $NoMitmProxy)
    websocket_proxy_enabled = (-not $NoWebSocketProxy)
    tls_cert_path = $tlsCertPath
    tls_key_path = $tlsKeyPath
    ws_tls_cert_path = $wsTlsCertPath
    ws_tls_key_path = $wsTlsKeyPath
    mock_stdout = $mockStdout
    mock_stderr = $mockStderr
    proxy_stdout = $proxyStdout
    proxy_stderr = $proxyStderr
    ws_stdout = $wsStdout
    ws_stderr = $wsStderr
    im_stdout = $imStdout
    im_stderr = $imStderr
} | ConvertTo-Json

Set-Content -Path $stateFile -Value $state -Encoding UTF8

Write-Host "Local platform mock started."
Write-Host "mock pid : $($mockProcess.Id)"
if ($proxyProcess) {
    Write-Host "proxy pid: $($proxyProcess.Id)"
}
Write-Host "health   : http://$MockHost`:$MockPort/__afk/health"
Write-Host "https    : https://$MockHost`:$MockHttpsPort/__afk/health"
Write-Host "requests : $(Join-Path $root 'logs\\requests.jsonl')"
if ($proxyProcess) {
    Write-Host "proxy    : configure the emulator HTTP proxy to <host-ip>:$MitmPort"
} else {
    Write-Host "proxy    : skipped (-NoMitmProxy)"
}
if ($wsProcess) {
    Write-Host "im socket: ws://$WsListenHost`:$ImListenPort"
    if ($WsTlsListenPort -gt 0) {
        Write-Host "wss proxy: wss://$WsListenHost`:$WsTlsListenPort"
    }
    if ($WsReplayFixture) {
        Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> replay fixture $WsReplayFixture"
    } elseif ($WsStructuredLoginFixture) {
        if ($WsInteractionFixture) {
            Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> structured login fixture $WsStructuredLoginFixture + interaction fixture $WsInteractionFixture"
        } elseif ($WsInteractionDb) {
            Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> structured login fixture $WsStructuredLoginFixture + MySQL interaction rules"
        } else {
            Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> structured login fixture $WsStructuredLoginFixture"
        }
    } elseif ($WsInteractionFixture) {
        Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> interaction fixture $WsInteractionFixture"
    } elseif ($WsInteractionDb) {
        Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> MySQL interaction rules"
    } else {
        Write-Host "ws proxy : ws://$WsListenHost`:$WsListenPort -> $UpstreamWsUrl"
    }
    Write-Host "ws logs  : $(Join-Path $root 'logs\\ws-frames.jsonl')"
    if (-not $NoWebSocketMysql) {
        Write-Host "ws mysql : enabled (table AFK.ws_frame_logs)"
    }
    if (-not $NoLoginMysql) {
        Write-Host "login db : enabled (tables AFK.accounts/sessions/players)"
    }
    if (-not $NoBusinessMysql) {
        Write-Host "game db  : enabled (tables AFK.inventory_items/characters/stage_progress)"
        Write-Host "tavern   : official draw cost item 13 x 1"
        if ($ForceDiamond -ge 0) {
            Write-Host "diamond  : force server value $ForceDiamond"
        }
    }
}
