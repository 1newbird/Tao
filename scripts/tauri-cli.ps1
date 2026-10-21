param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TauriArgs
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.tao-dev-config.json'

if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not (Test-Path -LiteralPath $config.nodeExe) -or -not (Test-Path -LiteralPath $config.cargoExe)) {
        throw 'Saved Node or Rust path is missing. Run scripts\setup-dev.ps1 again.'
    }
    if ($config.localRust) {
        $env:CARGO_HOME = Join-Path $config.toolsRoot 'cargo'
        $env:RUSTUP_HOME = Join-Path $config.toolsRoot 'rustup'
    }
    $env:npm_config_cache = Join-Path $config.toolsRoot 'npm-cache'
    $env:PATH = "$(Split-Path -Parent $config.nodeExe);$(Split-Path -Parent $config.cargoExe);$env:PATH"
    $nodeExe = $config.nodeExe
} else {
    $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    $cargoExe = (Get-Command cargo.exe -ErrorAction SilentlyContinue).Source
    if (-not $nodeExe -or -not $cargoExe) {
        throw 'Node or Rust is unavailable. Run scripts\setup-dev.ps1 from the project root.'
    }
}

$tauriCli = Join-Path $projectRoot 'node_modules\@tauri-apps\cli\tauri.js'
if (-not (Test-Path -LiteralPath $tauriCli)) {
    throw 'Tauri CLI dependency is missing. Run scripts\setup-dev.ps1 from the project root.'
}

Push-Location $projectRoot
try {
    if ($env:OS -eq 'Windows_NT' -and $TauriArgs.Count -gt 0 -and $TauriArgs[0] -eq 'dev') {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\build-windows-sandbox.ps1')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & $nodeExe $tauriCli @TauriArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
