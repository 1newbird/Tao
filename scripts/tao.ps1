param(
    [Parameter(Position = 0)]
    [ValidateSet('dev', 'check', 'release')]
    [string]$Task = 'dev'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.tao-dev-config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    throw '尚未准备开发环境。请先运行 scripts\setup-dev.ps1。'
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $config.nodeExe) -or -not (Test-Path -LiteralPath $config.cargoExe)) {
    throw 'Node 或 Rust 路径失效。请重新运行 scripts\setup-dev.ps1。'
}
if ($config.localRust) {
    $env:CARGO_HOME = Join-Path $config.toolsRoot 'cargo'
    $env:RUSTUP_HOME = Join-Path $config.toolsRoot 'rustup'
}
$env:npm_config_cache = Join-Path $config.toolsRoot 'npm-cache'
$env:PATH = "$(Split-Path -Parent $config.nodeExe);$(Split-Path -Parent $config.cargoExe);$env:PATH"
$npm = Join-Path (Split-Path -Parent $config.nodeExe) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npm)) { throw "找不到 npm.cmd：$npm" }
Push-Location $projectRoot
try {
    switch ($Task) {
        'dev' { & $npm run tauri dev }
        'check' { & $npm run check }
        'release' { & $npm run tao:release }
    }
    if ($LASTEXITCODE -ne 0) { throw "Tao $Task 失败，退出码 $LASTEXITCODE" }
} finally { Pop-Location }
