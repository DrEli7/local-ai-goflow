param([switch]$CheckOnly, [string]$NodeExe)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This script supports Windows only.' }
$packageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$serverScript = Join-Path $packageRoot 'src\chat-server.mjs'
$statusUrl = 'http://127.0.0.1:18441/api/status'
$response = $null
$reader = $null
try {
    $request = [Net.HttpWebRequest]::Create($statusUrl)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 1500
    $request.ReadWriteTimeout = 1500
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200 -or $response.ContentLength -gt 32768) { throw 'Unexpected status response.' }
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    $buffer = New-Object char[] 1024
    $text = New-Object Text.StringBuilder
    while (($count = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
        if ($text.Length + $count -gt 32768) { throw 'Status response exceeds the allowed size.' }
        [void]$text.Append($buffer, 0, $count)
    }
    $health = $text.ToString() | ConvertFrom-Json
} catch { throw 'No verifiable chat service is reachable. No process was stopped.' }
finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
}

if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) { throw 'The package chat server is missing; refusing to stop a process.' }
$hashStream = [IO.File]::OpenRead($serverScript)
$hashAlgorithm = [Security.Cryptography.SHA256]::Create()
try { $serverHash = [BitConverter]::ToString($hashAlgorithm.ComputeHash($hashStream)).Replace('-', '').ToLowerInvariant() }
finally { $hashStream.Dispose(); $hashAlgorithm.Dispose() }
if ($health.app -cne 'local-ai-goflow-chat' -or $health.version -cne '0.3.0' -or $health.serverHash -cne $serverHash -or $health.pid -isnot [int] -or $health.pid -le 0) { throw 'The running service does not match this package version and hash. No process was stopped.' }
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'NodeExe must name the existing absolute Node executable used at launch.' }
$NodeExe = [IO.Path]::GetFullPath($NodeExe)
$serverProcessId = [int]$health.pid
$processInfo = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $serverProcessId)
if ($null -eq $processInfo -or -not $processInfo.ExecutablePath -or [IO.Path]::GetFullPath($processInfo.ExecutablePath) -ine $NodeExe -or -not $processInfo.CommandLine -or $processInfo.CommandLine -notmatch [regex]::Escape($serverScript)) { throw 'Process identity does not match this package server and Node path. No process was stopped.' }
$plan = [ordered]@{ app='local-ai-goflow-chat'; pid=$serverProcessId; node=$NodeExe; serverHash=$serverHash; checkOnly=[bool]$CheckOnly; stopsOllama=$false }
if (-not $CheckOnly) { Stop-Process -Id $serverProcessId -ErrorAction Stop }
$plan | ConvertTo-Json
