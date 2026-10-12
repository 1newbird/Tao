$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'src-tauri\target\.tauri'))
$wixRoot = Join-Path $targetRoot 'WixTools314'
$tempRoot = Join-Path $targetRoot 'WixTools314.tmp'
$cacheRoot = Join-Path $projectRoot '.tao-release-cache'
$archive = Join-Path $cacheRoot 'wix.3.14.1.nupkg'
$url = 'https://api.nuget.org/v3-flatcontainer/wix/3.14.1/wix.3.14.1.nupkg'
$expectedSha512 = '5270A1741D218DE02030AD2FE02F908C4521641D4E3B53CBB6D7A73218B84F71D5E7C4C2948A64EACF6748C9B648B4AA22C01A1267413C3F403C2050F679FBD0'
$required = @('candle.exe', 'candle.exe.config', 'darice.cub', 'light.exe', 'light.exe.config', 'wconsole.dll', 'winterop.dll', 'wix.dll', 'WixUIExtension.dll', 'WixUtilExtension.dll')

function Test-WixComplete([string]$root) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return $false }
    foreach ($name in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { return $false }
    }
    return $true
}

if (Test-WixComplete $wixRoot) {
    Write-Host '[Tao WiX] 复用项目本地 WiX 3.14.1 工具'
    exit 0
}

New-Item -ItemType Directory -Path $cacheRoot, $targetRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    Write-Host '[Tao WiX] 从 NuGet 下载 WiX 3.14.1 到 D 盘项目缓存'
    Invoke-WebRequest -Uri $url -OutFile $archive -MaximumRedirection 5
}

$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash
if ($actual -ne $expectedSha512) {
    throw "WiX NuGet 包 SHA-512 校验失败：$archive"
}

if (Test-Path -LiteralPath $tempRoot) {
    $resolved = [System.IO.Path]::GetFullPath($tempRoot)
    if (-not $resolved.StartsWith(($targetRoot + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理项目目录外的临时文件：$resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
try {
    foreach ($entry in $zip.Entries) {
        if (-not $entry.FullName.StartsWith('tools/', [System.StringComparison]::Ordinal)) { continue }
        if ($entry.FullName.EndsWith('/')) { continue }
        $relative = $entry.FullName.Substring(6).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $destination = [System.IO.Path]::GetFullPath((Join-Path $tempRoot $relative))
        if (-not $destination.StartsWith(($tempRoot + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "WiX 压缩包含非法路径：$($entry.FullName)"
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        $sourceStream = $entry.Open()
        try {
            $destinationStream = [System.IO.File]::Create($destination)
            try { $sourceStream.CopyTo($destinationStream) } finally { $destinationStream.Dispose() }
        } finally { $sourceStream.Dispose() }
    }
} finally { $zip.Dispose() }

if (-not (Test-WixComplete $tempRoot)) { throw 'WiX NuGet 包缺少 Tauri 所需的文件' }
if (Test-Path -LiteralPath $wixRoot) {
    $resolved = [System.IO.Path]::GetFullPath($wixRoot)
    if (-not $resolved.StartsWith(($targetRoot + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝清理项目目录外的 WiX 缓存：$resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Move-Item -LiteralPath $tempRoot -Destination $wixRoot
Write-Host "[Tao WiX] 已准备 WiX：$wixRoot"
