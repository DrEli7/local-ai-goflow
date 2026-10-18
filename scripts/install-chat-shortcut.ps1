param([string]$ShortcutName = '本地 AI - Qwen3', [string]$LauncherPath, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This shortcut installer supports Windows only.' }
$packageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$defaultLauncher = Join-Path $PSScriptRoot 'start-chat.ps1'
if (-not $LauncherPath) { $LauncherPath = $defaultLauncher }
if (-not [IO.Path]::IsPathRooted($LauncherPath) -or -not (Test-Path -LiteralPath $LauncherPath -PathType Leaf) -or [IO.Path]::GetExtension($LauncherPath) -ine '.ps1' -or $LauncherPath -match '["\r\n]') { throw 'LauncherPath must explicitly name an existing absolute trusted .ps1 script.' }
$LauncherPath = [IO.Path]::GetFullPath($LauncherPath)
if (-not $ShortcutName.Trim() -or $ShortcutName.Length -gt 80 -or $ShortcutName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $ShortcutName.EndsWith('.') -or $ShortcutName.EndsWith(' ') -or $ShortcutName -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'ShortcutName must be a normal desktop filename without an extension.' }
$desktopDirectory = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopDirectory ($ShortcutName + '.lnk')
$stateDirectory = Join-Path $packageRoot 'state\chat\shortcut-backups'
$iconPath = Join-Path $packageRoot 'state\chat\app.ico'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $LauncherPath + '"'
$ownerDescription = 'local-ai-goflow-chat: ' + $packageRoot

function Assert-UnlinkedPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if (((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Linked shortcut paths are unsupported.' }
        }
        $parentDirectory = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parentDirectory) { break }
        $cursor = $parentDirectory.FullName
    }
}
function Write-AppIcon([string]$Path) {
    Add-Type -AssemblyName System.Drawing
    $bitmap = $null
    $graphics = $null
    $backgroundBrush = $null
    $bubbleBrush = $null
    $background = $null
    $bubble = $null
    $imageBytes = $null
    $writer = $null
    $temporary = $null
    try {
        $bitmap = New-Object Drawing.Bitmap(64, 64)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear([Drawing.Color]::Transparent)
        $backgroundBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(255, 11, 75, 63))
        $bubbleBrush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(255, 251, 253, 248))
        $background = New-Object Drawing.Drawing2D.GraphicsPath
        $background.AddArc(2, 2, 28, 28, 180, 90)
        $background.AddArc(34, 2, 28, 28, 270, 90)
        $background.AddArc(34, 34, 28, 28, 0, 90)
        $background.AddArc(2, 34, 28, 28, 90, 90)
        $background.CloseFigure()
        $graphics.FillPath($backgroundBrush, $background)
        $bubble = New-Object Drawing.Drawing2D.GraphicsPath
        $bubble.AddArc(14, 17, 14, 14, 180, 90)
        $bubble.AddArc(36, 17, 14, 14, 270, 90)
        $bubble.AddArc(36, 29, 14, 14, 0, 90)
        $bubble.AddArc(14, 29, 14, 14, 90, 90)
        $bubble.CloseFigure()
        $graphics.FillPath($bubbleBrush, $bubble)
        $tail = [Drawing.PointF[]]@((New-Object Drawing.PointF(24, 40)), (New-Object Drawing.PointF(21, 49)), (New-Object Drawing.PointF(34, 40)))
        $graphics.FillPolygon($bubbleBrush, $tail)
        foreach ($dotX in @(22, 30, 38)) { $graphics.FillEllipse($backgroundBrush, $dotX, 27, 5, 5) }

        $imageBytes = New-Object IO.MemoryStream
        $bitmap.Save($imageBytes, [Drawing.Imaging.ImageFormat]::Png)
        $png = $imageBytes.ToArray()
        $iconDirectory = Split-Path -Parent $Path
        Assert-UnlinkedPath $Path
        New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null
        Assert-UnlinkedPath $iconDirectory
        $temporary = Join-Path $iconDirectory ('.app-icon-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $writer = New-Object IO.BinaryWriter($stream)
        # One PNG-backed 64x64 ICO entry, supported by modern Windows.
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]1)
        $writer.Write([byte]64)
        $writer.Write([byte]64)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$png.Length)
        $writer.Write([uint32]22)
        $writer.Write([byte[]]$png)
        $writer.Dispose()
        $writer = $null
        Assert-UnlinkedPath $Path
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        foreach ($resource in @($writer, $imageBytes, $bubble, $background, $bubbleBrush, $backgroundBrush, $graphics, $bitmap)) {
            if ($null -ne $resource) { $resource.Dispose() }
        }
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
    }
}
foreach ($safePath in @($LauncherPath, $shortcutPath, $stateDirectory, $iconPath, $powershellExe)) { Assert-UnlinkedPath $safePath }
if (-not (Test-Path -LiteralPath $powershellExe -PathType Leaf)) { throw 'Windows PowerShell was not found.' }
$shell = New-Object -ComObject WScript.Shell
$existing = Test-Path -LiteralPath $shortcutPath
if ($existing) {
    $oldShortcut = $shell.CreateShortcut($shortcutPath)
    if ($oldShortcut.Description -cne $ownerDescription -or [IO.Path]::GetFullPath($oldShortcut.TargetPath) -ine [IO.Path]::GetFullPath($powershellExe)) { throw 'A shortcut with this name exists and is not owned by this package. It was not overwritten; choose a different name or inspect it manually.' }
}
$plan = [ordered]@{ app='local-ai-goflow-chat'; shortcut=$shortcutPath; launcher=$LauncherPath; icon=$iconPath; replacesOwnedShortcut=[bool]$existing; backupDirectory=$stateDirectory; checkOnly=[bool]$CheckOnly }
if ($CheckOnly) { $plan | ConvertTo-Json; return }
Write-AppIcon $iconPath
if ($existing) {
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    Assert-UnlinkedPath $stateDirectory
    $backupPath = Join-Path $stateDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.lnk')
    Copy-Item -LiteralPath $shortcutPath -Destination $backupPath
}
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellExe
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = Split-Path -Parent $LauncherPath
$shortcut.WindowStyle = 7
$shortcut.Description = $ownerDescription
$shortcut.IconLocation = $iconPath + ',0'
$shortcut.Save()
$plan | ConvertTo-Json
