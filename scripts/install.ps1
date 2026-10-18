param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

# User-invoked Windows installation. No login, billing or permission settings.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'The installer currently supports Windows only.' }
$packageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$profileRoot = [Environment]::GetFolderPath('UserProfile')
$codexRoot = Join-Path $profileRoot '.codex'
$pluginTarget = Join-Path $codexRoot 'plugins\local-ai-goflow'
$ownerMarker = Join-Path $pluginTarget '.local-ai-goflow-owned'
$marketplacePath = Join-Path $profileRoot '.agents\plugins\marketplace.json'
$agentsPath = Join-Path $codexRoot 'AGENTS.md'
$utf8 = New-Object Text.UTF8Encoding($false)

function Assert-SafePath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked installation paths are unsupported.' }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Write-SafeText([string]$Path, [string]$Text) {
    Assert-SafePath $Path
    $parentPath = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
    Assert-SafePath $parentPath
    $temporary = Join-Path $parentPath ('.local-ai-goflow-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $Text, $utf8)
        Assert-SafePath $Path
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

foreach ($p in @($packageRoot, $profileRoot, $pluginTarget, $marketplacePath, $agentsPath)) { Assert-SafePath $p }
if ($env:CODEX_HOME -and [IO.Path]::GetFullPath($env:CODEX_HOME).TrimEnd('\') -ine $codexRoot.TrimEnd('\')) {
    throw 'Custom CODEX_HOME is unsupported by this guarded Windows alpha.'
}
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$nodeExe = $nodeCommand.Source
$codexCommand = Get-Command codex -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
$nodeVersion = & $nodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 or later is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $packageRoot 'node_modules\@modelcontextprotocol\server\package.json') -PathType Leaf)) {
    throw 'Run npm ci --ignore-scripts before installation.'
}
if (-not (Test-Path -LiteralPath (Join-Path $codexRoot 'goflow\scripts\client.mjs') -PathType Leaf)) {
    throw 'Install and configure the trusted user-level GoFlow client first.'
}
if ((Test-Path -LiteralPath $pluginTarget) -and -not (Test-Path -LiteralPath $ownerMarker -PathType Leaf)) {
    throw 'The plugin directory exists and is not owned by this installer.'
}
$marketplace = [pscustomobject]@{ name='goflow-local'; plugins=@() }
if (Test-Path -LiteralPath $marketplacePath) {
    $marketplace = [IO.File]::ReadAllText($marketplacePath) | ConvertFrom-Json
    if ($marketplace.name -ne 'goflow-local' -or $marketplace.plugins -isnot [Array]) {
        throw 'An unrelated personal marketplace exists. No files have been changed.'
    }
}
foreach ($entry in @($marketplace.plugins)) {
    if ($entry -isnot [pscustomobject] -or $entry.name -isnot [string] -or $entry.source -isnot [pscustomobject]) {
        throw 'The personal marketplace schema is unsupported. No files have been changed.'
    }
}
$existing = @($marketplace.plugins | Where-Object name -EQ 'local-ai-goflow')
if ($existing.Count -gt 1 -or ($existing.Count -eq 1 -and $existing[0].source.path -ne './.codex/plugins/local-ai-goflow')) {
    throw 'A conflicting plugin source exists. No files have been changed.'
}
$begin = '<!-- LOCAL_AI_GOFLOW BEGIN v0.1.0 -->'
$end = '<!-- LOCAL_AI_GOFLOW END v0.1.0 -->'
$rule = [IO.File]::ReadAllText((Join-Path $packageRoot 'assets\global-defaults.md')).Trim()
$agents = if (Test-Path -LiteralPath $agentsPath) { [IO.File]::ReadAllText($agentsPath) } else { '' }
$pattern = '(?s)' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
$beginCount = [regex]::Matches($agents, [regex]::Escape($begin)).Count
$endCount = [regex]::Matches($agents, [regex]::Escape($end)).Count
$blocks = [regex]::Matches($agents, $pattern)
if ($beginCount -ne $endCount -or $beginCount -gt 1 -or $blocks.Count -ne $beginCount) {
    throw 'The global rule markers are ambiguous. No files have been changed.'
}
$updatedAgents = if ($blocks.Count -eq 1) {
    $agents.Substring(0, $blocks[0].Index) + $rule + $agents.Substring($blocks[0].Index + $blocks[0].Length)
} else { $agents.TrimEnd() + "`r`n`r`n" + $rule + "`r`n" }

$plan = [ordered]@{ plugin='local-ai-goflow@goflow-local'; source=$packageRoot; target=$pluginTarget; node=$nodeExe; globalDefaults=$true; checkOnly=[bool]$CheckOnly }
foreach ($relative in @('.local-ai-goflow-owned', '.codex-plugin\plugin.json', '.mcp.json', 'skills\local-ai-goflow\SKILL.md', 'client.mjs')) {
    Assert-SafePath (Join-Path $pluginTarget $relative)
}
Assert-SafePath (Join-Path $packageRoot 'state\installation-receipt.json')
if ($CheckOnly) { $plan | ConvertTo-Json; return }

New-Item -ItemType Directory -Path $pluginTarget -Force | Out-Null
Write-SafeText $ownerMarker 'Owned by the local-ai-goflow installer.'
Write-SafeText (Join-Path $pluginTarget '.codex-plugin\plugin.json') ([IO.File]::ReadAllText((Join-Path $packageRoot '.codex-plugin\plugin.json')))
Write-SafeText (Join-Path $pluginTarget 'skills\local-ai-goflow\SKILL.md') ([IO.File]::ReadAllText((Join-Path $packageRoot 'skills\local-ai-goflow\SKILL.md')))
$mcp = [ordered]@{ mcpServers=[ordered]@{ local_ai_goflow=[ordered]@{
    command=$nodeExe; args=@((Join-Path $packageRoot 'src\server.mjs')); startup_timeout_sec=20; tool_timeout_sec=600
} } }
Write-SafeText (Join-Path $pluginTarget '.mcp.json') ($mcp | ConvertTo-Json -Depth 8)
$clientUri = ([Uri](Join-Path $packageRoot 'scripts\client.mjs')).AbsoluteUri
Write-SafeText (Join-Path $pluginTarget 'client.mjs') ('import ' + (ConvertTo-Json -InputObject $clientUri -Compress) + ';' + "`n")
if ($existing.Count -eq 0) {
    $marketplace.plugins = @($marketplace.plugins) + @([ordered]@{
        name='local-ai-goflow'; source=[ordered]@{ source='local'; path='./.codex/plugins/local-ai-goflow' }
        policy=[ordered]@{ installation='AVAILABLE'; authentication='ON_INSTALL' }; category='Productivity'
    })
}
Write-SafeText $marketplacePath ($marketplace | ConvertTo-Json -Depth 30)
$installOutput = & $codexCommand.Source plugin add 'local-ai-goflow@goflow-local' --json
if ($LASTEXITCODE -ne 0) { throw 'Codex registration failed. Prepared files remain for inspection; global rules were not changed.' }
Write-SafeText $agentsPath $updatedAgents
Write-SafeText (Join-Path $packageRoot 'state\installation-receipt.json') ($plan | ConvertTo-Json)
$plan | ConvertTo-Json
