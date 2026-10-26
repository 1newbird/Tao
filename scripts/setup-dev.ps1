param(
    [string]$ToolsRoot,
    [switch]$CheckOnly,
    [switch]$UseChinaMirror
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.tao-dev-config.json'
if (-not $ToolsRoot) {
    $ToolsRoot = if (Test-Path 'D:\') { 'D:\TaoDev' } else { Join-Path $env:LOCALAPPDATA 'TaoDev' }
}
$ToolsRoot = [System.IO.Path]::GetFullPath($ToolsRoot)

function Write-Step([string]$message) { Write-Host "[Tao 环境] $message" }
function Get-Executable([string]$name) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}
function Assert-ExitCode([string]$description) {
    if ($LASTEXITCODE -ne 0) { throw "$description 失败，退出码 $LASTEXITCODE" }
}
function Get-UsableNode {
    $candidates = @((Join-Path $ToolsRoot 'node-v22.19.0-win-x64\node.exe'), (Get-Executable 'node.exe'))
    foreach ($candidate in $candidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
        $versionText = (& $candidate --version 2>$null)
        if ($versionText -match '^v(\d+)\.(\d+)\.(\d+)$') {
            $version = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
            if ($version -ge [version]'22.19.0') {
                return @{ Path = $candidate; Version = $versionText }
            }
        }
    }
    return $null
}
function Get-UsableRust {
    $candidates = @((Join-Path $ToolsRoot 'cargo\bin\rustc.exe'), (Get-Executable 'rustc.exe'))
    foreach ($candidate in $candidates) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { continue }
        $previousCargoHome = $env:CARGO_HOME
        $previousRustupHome = $env:RUSTUP_HOME
        try {
            if ($candidate.StartsWith($ToolsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                $env:CARGO_HOME = Join-Path $ToolsRoot 'cargo'
                $env:RUSTUP_HOME = Join-Path $ToolsRoot 'rustup'
            }
            try { $details = (& $candidate -vV 2>$null) -join "`n" }
            catch { $details = '' }
        } finally {
            $env:CARGO_HOME = $previousCargoHome
            $env:RUSTUP_HOME = $previousRustupHome
        }
        if ($details -match '(?m)^host: x86_64-pc-windows-msvc$') {
            $cargo = Join-Path (Split-Path -Parent $candidate) 'cargo.exe'
            if (Test-Path -LiteralPath $cargo) { return @{ Rustc = $candidate; Cargo = $cargo } }
        }
    }
    return $null
}
function Get-Msvc {
    $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { return $null }
    $installations = @(& $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    foreach ($installation in $installations) {
        if (-not $installation) { continue }
        $toolRoot = Join-Path $installation 'VC\Tools\MSVC'
        if (-not (Test-Path -LiteralPath $toolRoot)) { continue }
        foreach ($version in @(Get-ChildItem -LiteralPath $toolRoot -Directory | Sort-Object Name -Descending)) {
            $cl = Join-Path $version.FullName 'bin\Hostx64\x64\cl.exe'
            $link = Join-Path $version.FullName 'bin\Hostx64\x64\link.exe'
            if ((Test-Path -LiteralPath $cl) -and (Test-Path -LiteralPath $link)) { return $installation }
        }
    }
    return $null
}
function Get-WindowsSdk {
    $roots = @('C:\Program Files (x86)\Windows Kits\10')
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots')) {
        $registered = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).KitsRoot10
        if ($registered) { $roots += $registered }
    }
    foreach ($root in ($roots | Select-Object -Unique)) {
        $libRoot = Join-Path $root 'Lib'
        if (-not (Test-Path -LiteralPath $libRoot)) { continue }
        foreach ($version in @(Get-ChildItem -LiteralPath $libRoot -Directory | Sort-Object Name -Descending)) {
            $um = Join-Path $version.FullName 'um\x64'
            if ((Test-Path (Join-Path $um 'kernel32.lib')) -and (Test-Path (Join-Path $um 'dbghelp.lib'))) {
                return $version.Name
            }
        }
    }
    return $null
}
function Test-WebView2 {
    $clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    foreach ($key in @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientId",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$clientId"
    )) {
        $version = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).pv
        if ($version -and $version -ne '0.0.0.0') { return $true }
    }
    foreach ($application in @('C:\Program Files (x86)\Microsoft\EdgeWebView\Application', 'C:\Program Files\Microsoft\EdgeWebView\Application', (Join-Path $env:LOCALAPPDATA 'Microsoft\EdgeWebView\Application'))) {
        if ((Test-Path -LiteralPath $application) -and (Get-ChildItem -LiteralPath $application -Directory -ErrorAction SilentlyContinue | Where-Object {
            Test-Path -LiteralPath (Join-Path $_.FullName 'msedgewebview2.exe')
        } | Select-Object -First 1)) { return $true }
    }
    return $false
}
function Download-File([string]$url, [string]$path) {
    if (Test-Path -LiteralPath $path) { return }
    Write-Step "下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $path
}
function Install-Node {
    $version = '22.19.0'
    $archiveName = "node-v$version-win-x64.zip"
    $downloads = Join-Path $ToolsRoot 'downloads'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    $archive = Join-Path $downloads $archiveName
    $baseUrl = "https://nodejs.org/dist/v$version"
    Download-File "$baseUrl/$archiveName" $archive
    $checksums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt").Content
    $line = @($checksums -split "`n" | Where-Object { $_ -match "\s+$([regex]::Escape($archiveName))\s*$" } | Select-Object -First 1)
    if (-not $line -or $line[0] -notmatch '^([a-fA-F0-9]{64})') { throw "找不到 $archiveName 的官方校验值" }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $Matches[1]) { throw "Node 下载包 SHA-256 校验失败：$archive" }
    Expand-Archive -LiteralPath $archive -DestinationPath $ToolsRoot -Force
    return Join-Path $ToolsRoot "node-v$version-win-x64\node.exe"
}
function Install-Msvc {
    $downloads = Join-Path $ToolsRoot 'downloads'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    $installer = Join-Path $downloads 'vs_BuildTools.exe'
    Download-File 'https://aka.ms/vs/17/release/vs_BuildTools.exe' $installer
    $installPath = Join-Path $ToolsRoot 'VisualStudio\BuildTools2022'
    Write-Step '安装 C++ Build Tools 和 Windows SDK；Windows 可能要求管理员授权。'
    $arguments = @('--wait', '--passive', '--norestart', '--nocache', '--installPath', "`"$installPath`"", '--add', 'Microsoft.VisualStudio.Workload.VCTools', '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100', '--includeRecommended')
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    if ($process.ExitCode -eq 3010) { throw 'C++ Build Tools 已安装，但需要重启 Windows。重启后重新运行本脚本。' }
    if ($process.ExitCode -ne 0) { throw "C++ Build Tools 安装失败，退出码 $($process.ExitCode)" }
}
function Install-WebView2 {
    $downloads = Join-Path $ToolsRoot 'downloads'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    $installer = Join-Path $downloads 'MicrosoftEdgeWebview2Setup.exe'
    Download-File 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' $installer
    Write-Step '安装 Microsoft Edge WebView2 Runtime'
    $process = Start-Process -FilePath $installer -ArgumentList @('/silent', '/install') -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "WebView2 安装失败，退出码 $($process.ExitCode)" }
}
function Ensure-PiModelData([string]$npm) {
    $aiRoot = Join-Path $projectRoot 'vendor\pi\packages\ai'
    $dataDir = Join-Path $aiRoot 'src\providers\data'
    $manifest = Join-Path $dataDir '.manifest.json'
    if (-not (Test-Path -LiteralPath $manifest)) {
        $package = Get-Content -LiteralPath (Join-Path $aiRoot 'package.json') -Raw | ConvertFrom-Json
        $downloads = Join-Path $ToolsRoot 'downloads'
        New-Item -ItemType Directory -Force -Path $downloads | Out-Null
        Write-Step "获取 Pi $($package.version) 的固定模型数据快照"
        $packOutput = @(& $npm pack "$($package.name)@$($package.version)" --pack-destination $downloads --silent)
        Assert-ExitCode 'Pi 模型数据包下载'
        $archiveName = @($packOutput | Where-Object { $_ -match '^[a-zA-Z0-9._-]+\.tgz$' } | Select-Object -Last 1)
        if (-not $archiveName) { throw 'npm pack 未返回模型数据包文件名。' }
        $archive = Join-Path $downloads $archiveName[0]
        $entries = @(& tar.exe -tf $archive | Where-Object { $_ -like 'package/dist/providers/data/*' })
        Assert-ExitCode '读取 Pi 模型数据包'
        if ($entries.Count -lt 2 -or @($entries | Where-Object { $_ -notmatch '^package/dist/providers/data/(?:\.manifest|[a-z0-9-]+)\.json$' }).Count -gt 0) {
            throw 'Pi 模型数据包内容不符合预期。'
        }
        New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
        & tar.exe -xf $archive -C $dataDir --strip-components=4 package/dist/providers/data
        Assert-ExitCode '解压 Pi 模型数据'
    }
    Write-Step '验证 Pi 模型数据快照'
    & $npm --prefix $aiRoot run check:model-data
    Assert-ExitCode 'Pi 模型数据验证'
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw '本脚本只支持 Windows x64。' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw '本脚本只支持 Windows x64。'
}
Write-Step "项目目录：$projectRoot"
Write-Step "工具目录：$ToolsRoot"
$node = Get-UsableNode
$rust = Get-UsableRust
$msvc = Get-Msvc
$sdk = Get-WindowsSdk
$webview = Test-WebView2
Write-Step "Node：$(if ($node) { "$($node.Version) $($node.Path)" } else { '缺失或低于 22.19.0' })"
Write-Step "Rust MSVC：$(if ($rust) { $rust.Rustc } else { '缺失' })"
Write-Step "MSVC：$(if ($msvc) { $msvc } else { '缺失' })"
Write-Step "Windows SDK：$(if ($sdk) { $sdk } else { '缺失' })"
Write-Step "WebView2：$(if ($webview) { '已安装' } else { '缺失' })"
Write-Step "Git：$(if (Get-Executable 'git.exe') { '已安装' } else { '未安装；克隆仓库及 Git Diff 需要 Git' })"
if ($CheckOnly) { return }

New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
if (-not $msvc -or -not $sdk) {
    Install-Msvc
    $msvc = Get-Msvc
    $sdk = Get-WindowsSdk
    if (-not $msvc -or -not $sdk) { throw 'C++ 编译器或 Windows SDK 仍未就绪。请重启 Windows 后重新运行本脚本。' }
}
if (-not $webview) {
    Install-WebView2
    if (-not (Test-WebView2)) { throw 'WebView2 安装完成后仍未检测到，请重启 Windows 后重新运行本脚本。' }
}
if (-not $node) {
    $nodeExe = Install-Node
    $node = Get-UsableNode
    if (-not $node -or $node.Path -ne $nodeExe) { throw 'Node 安装后验证失败。' }
}
if (-not $rust) {
    $env:RUSTUP_HOME = Join-Path $ToolsRoot 'rustup'
    $env:CARGO_HOME = Join-Path $ToolsRoot 'cargo'
    if ($UseChinaMirror) {
        $env:RUSTUP_DIST_SERVER = 'https://rsproxy.cn'
        $env:RUSTUP_UPDATE_ROOT = 'https://rsproxy.cn/rustup'
        Write-Step 'Rust 组件下载使用 RsProxy 镜像'
    }
    $downloads = Join-Path $ToolsRoot 'downloads'
    New-Item -ItemType Directory -Force -Path $downloads | Out-Null
    $rustupInstaller = Join-Path $downloads 'rustup-init.exe'
    Download-File 'https://win.rustup.rs/x86_64' $rustupInstaller
    Write-Step '安装 Rust stable MSVC 到 D 盘工具目录（或指定的 ToolsRoot）'
    & $rustupInstaller -y --no-modify-path --profile minimal --default-toolchain stable-x86_64-pc-windows-msvc
    Assert-ExitCode 'Rust 安装'
    $rust = Get-UsableRust
    if (-not $rust) { throw 'Rust 安装后未找到 x86_64-pc-windows-msvc 工具链。' }
}

$env:PATH = "$(Split-Path -Parent $node.Path);$(Split-Path -Parent $rust.Cargo);$env:PATH"
$env:npm_config_cache = Join-Path $ToolsRoot 'npm-cache'
$rustIsLocal = $rust.Cargo.StartsWith($ToolsRoot, [System.StringComparison]::OrdinalIgnoreCase)
if ($rustIsLocal) {
    $env:CARGO_HOME = Join-Path $ToolsRoot 'cargo'
    $env:RUSTUP_HOME = Join-Path $ToolsRoot 'rustup'
}
if ($UseChinaMirror -and $rustIsLocal) {
    $cargoConfig = Join-Path $env:CARGO_HOME 'config.toml'
    if (-not (Test-Path -LiteralPath $cargoConfig)) {
        @'
[source.crates-io]
replace-with = "rsproxy-sparse"
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
'@ | Set-Content -LiteralPath $cargoConfig -Encoding utf8
    }
}
$config = @{ toolsRoot = $ToolsRoot; nodeExe = $node.Path; cargoExe = $rust.Cargo; localRust = $rustIsLocal }

Push-Location $projectRoot
try {
    $npm = Join-Path (Split-Path -Parent $node.Path) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { throw "找不到 npm.cmd：$npm" }
    Write-Step '安装 Tao 根目录依赖（npm ci）'
    & $npm ci
    Assert-ExitCode 'Tao 依赖安装'
    Write-Step '安装 Tao Runtime 文档解析依赖'
    & $npm ci --prefix src-tauri/runtime --ignore-scripts
    Assert-ExitCode 'Tao Runtime 依赖安装'
    Push-Location (Join-Path $projectRoot 'vendor\pi')
    try {
        Write-Step '安装 Pi 固定快照依赖（npm ci --ignore-scripts）'
        & $npm ci --ignore-scripts
        Assert-ExitCode 'Pi 依赖安装'
    } finally { Pop-Location }
    foreach ($path in @('vendor\pi\node_modules\tsx\dist\preflight.cjs', 'vendor\pi\node_modules\tsx\dist\loader.mjs')) {
        if (-not (Test-Path -LiteralPath $path)) { throw "Pi Runtime 缺少文件：$path" }
    }
    Ensure-PiModelData $npm
    # Tauri validates configured resource paths even for a debug build.
    New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'src-tauri\resources') | Out-Null
    Write-Step '检查 Tao Runtime JavaScript 语法'
    & $node.Path --check 'src-tauri\runtime\tao-runtime.mjs'
    Assert-ExitCode 'Tao Runtime 语法检查'
    Write-Step '运行 TypeScript 和 Rust 检查'
    & $npm run check
    Assert-ExitCode 'Tao 类型与 Rust 检查'
    Write-Step '验证 Pi SDK 对工作区的读取能力'
    & $node.Path 'scripts\verify-pi-workspace.mjs' $projectRoot
    Assert-ExitCode 'Pi 工作区验证'
} finally { Pop-Location }
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Step '开发环境已就绪。启动：powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\tao.ps1 dev'
