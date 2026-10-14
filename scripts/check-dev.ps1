$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.tao-dev-config.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.localRust) {
        $env:CARGO_HOME = Join-Path $config.toolsRoot 'cargo'
        $env:RUSTUP_HOME = Join-Path $config.toolsRoot 'rustup'
    }
    $env:PATH = "$(Split-Path -Parent $config.nodeExe);$(Split-Path -Parent $config.cargoExe);$env:PATH"
}
Push-Location $projectRoot
try {
    & node node_modules/typescript/bin/tsc --noEmit
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo check --manifest-path src-tauri/Cargo.toml
    exit $LASTEXITCODE
} finally { Pop-Location }
