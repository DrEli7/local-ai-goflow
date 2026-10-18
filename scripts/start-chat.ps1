param([switch]$NoWindow, [switch]$CheckOnly, [string]$NodeExe)
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This launcher supports Windows only.' }
$packageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$serverScript = Join-Path $packageRoot 'src\chat-server.mjs'
$stateDirectory = Join-Path $packageRoot 'state\chat'
$browserProfileDirectory = Join-Path $stateDirectory 'browser-profile'
$chatUrl = 'http://127.0.0.1:18441/'
$expectedVersion = '0.4.0'

function Assert-UnlinkedPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked launcher paths are unsupported.' }
        }
        $parentDirectory = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parentDirectory) { break }
        $cursor = $parentDirectory.FullName
    }
}

function Get-ChatHealth {
    $response = $null
    $reader = $null
    try {
        $request = [Net.HttpWebRequest]::Create($chatUrl + 'api/status')
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 800
        $request.ReadWriteTimeout = 800
        $response = $request.GetResponse()
        if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 32768) { return $null }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $buffer = New-Object char[] 1024
        $text = New-Object Text.StringBuilder
        while (($count = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($text.Length + $count -gt 32768) { return $null }
            [void]$text.Append($buffer, 0, $count)
        }
        return ($text.ToString() | ConvertFrom-Json)
    } catch { return $null }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
    }
}

function Test-MatchingHealth($Health) {
    return ($null -ne $Health -and $Health.app -ceq 'local-ai-goflow-chat' -and $Health.version -ceq $expectedVersion -and $Health.serverHash -ceq $serverHash -and $Health.pid -is [int] -and $Health.pid -gt 0)
}

function Test-ChatPort {
    $connection = New-Object Net.Sockets.TcpClient
    try {
        $pending = $connection.ConnectAsync('127.0.0.1', 18441)
        return ($pending.Wait(400) -and $connection.Connected)
    } catch { return $false }
    finally { $connection.Dispose() }
}

Assert-UnlinkedPath $serverScript
Assert-UnlinkedPath $stateDirectory
Assert-UnlinkedPath $browserProfileDirectory
if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw 'The package chat server is missing.' }
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'NodeExe must name an existing absolute Node executable.' }
$NodeExe = [IO.Path]::GetFullPath($NodeExe)
Assert-UnlinkedPath $NodeExe
$nodeVersion = & $NodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or later is required.' }
$hashStream = [IO.File]::OpenRead($serverScript)
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $serverHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hashAlgorithm.Dispose() }
$health = Get-ChatHealth
$reusable = Test-MatchingHealth $health
if (-not $reusable -and (Test-ChatPort)) { throw 'Port 18441 is occupied by an unknown or different chat server. Nothing was stopped. Inspect the owner or close the previous version before retrying.' }
$plan = [ordered]@{ app='local-ai-goflow-chat'; version=$expectedVersion; url=$chatUrl; source=$packageRoot; node=$NodeExe; serverHash=$serverHash; browserProfile=$browserProfileDirectory; reuse=[bool]$reusable; noWindow=[bool]$NoWindow; checkOnly=[bool]$CheckOnly }
if ($CheckOnly) { $plan | ConvertTo-Json; return }

if (-not $reusable) {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    Assert-UnlinkedPath $stateDirectory
    $standardLog = Join-Path $stateDirectory 'server.stdout.log'
    $errorLog = Join-Path $stateDirectory 'server.stderr.log'
    foreach ($logPath in @($standardLog, $errorLog)) { Assert-UnlinkedPath $logPath }
    $launchedProcess = Start-Process -FilePath $NodeExe -ArgumentList @(('"' + $serverScript + '"')) -WorkingDirectory $packageRoot -WindowStyle Hidden -RedirectStandardOutput $standardLog -RedirectStandardError $errorLog -PassThru
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.Elapsed.TotalSeconds -lt 15) {
        $health = Get-ChatHealth
        if (Test-MatchingHealth $health) { break }
        $launchedProcess.Refresh()
        if ($launchedProcess.HasExited) { throw 'The chat server exited during startup. Inspect state/chat/server.stderr.log for runtime status.' }
        Start-Sleep -Milliseconds 200
    }
    if (-not (Test-MatchingHealth $health)) { throw 'The chat server did not become ready within 15 seconds. No unrelated process was stopped.' }
}

if (-not $NoWindow) {
    $browserCandidates = @()
    foreach ($programDirectory in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($programDirectory) {
            $browserCandidates += (Join-Path $programDirectory 'Microsoft\Edge\Application\msedge.exe')
            $browserCandidates += (Join-Path $programDirectory 'Google\Chrome\Application\chrome.exe')
        }
    }
    $browserExe = $browserCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($browserExe) {
        Assert-UnlinkedPath $browserProfileDirectory
        New-Item -ItemType Directory -Path $browserProfileDirectory -Force | Out-Null
        Assert-UnlinkedPath $browserProfileDirectory
        $browserArguments = @(
            ('--user-data-dir="' + $browserProfileDirectory + '"'),
            '--no-first-run',
            '--no-default-browser-check',
            ('--app=' + $chatUrl)
        )
        Start-Process -FilePath $browserExe -ArgumentList $browserArguments -WindowStyle Normal | Out-Null
    } else {
        Write-Output 'Edge/Chrome was not found in a standard location; opening the chat in the system browser with its existing profile. A dedicated chat browser profile requires Edge or Chrome.'
        Start-Process -FilePath $chatUrl | Out-Null
    }
}
[ordered]@{ app='local-ai-goflow-chat'; url=$chatUrl; pid=$health.pid; available=$health.available; model=$health.model; reuse=[bool]$reusable } | ConvertTo-Json
