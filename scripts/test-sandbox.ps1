$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot '.tao-dev-config.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $env:PATH = "$(Split-Path -Parent $config.nodeExe);$env:PATH"
}
Push-Location $projectRoot
try {
    & node scripts/test-execution.mjs --docker
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $runtimeNode = Join-Path $projectRoot 'src-tauri/resources/node/node.exe'
    if (-not (Test-Path -LiteralPath $runtimeNode)) { $runtimeNode = 'node' }
    & $runtimeNode scripts/verify-runtime-tool-flow.mjs --docker
    exit $LASTEXITCODE
} finally { Pop-Location }
