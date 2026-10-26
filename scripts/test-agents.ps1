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
    & node --experimental-strip-types scripts/test-agent-profiles.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node scripts/test-runtime-policy.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --test scripts/test-web-tools.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --test scripts/test-mcp-tools.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --test scripts/test-document-tools.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node scripts/test-execution.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node scripts/test-capability-status.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --test scripts/test-multi-agent.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $runtimeNode = Join-Path $projectRoot 'src-tauri/resources/node/node.exe'
    if (-not (Test-Path -LiteralPath $runtimeNode)) { $runtimeNode = 'node' }
    & node --experimental-strip-types --test scripts/test-context.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --experimental-strip-types --test scripts/test-skills.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & node --experimental-strip-types --test scripts/test-skill-install.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $runtimeNode scripts/verify-runtime-tool-flow.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & cargo test --manifest-path src-tauri/Cargo.toml --lib
    exit $LASTEXITCODE
} finally { Pop-Location }
