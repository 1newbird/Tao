param([switch]$Smoke, [switch]$CleanupOnly, [switch]$Compatibility)
$ErrorActionPreference = 'Stop'
$taoRoot = Split-Path -Parent $PSScriptRoot
$taoConfigPath = Join-Path $taoRoot '.tao-dev-config.json'
if (Test-Path -LiteralPath $taoConfigPath) {
    $taoConfig = Get-Content -LiteralPath $taoConfigPath -Raw | ConvertFrom-Json
    if ($taoConfig.localRust) {
        $env:CARGO_HOME = Join-Path $taoConfig.toolsRoot 'cargo'
        $env:RUSTUP_HOME = Join-Path $taoConfig.toolsRoot 'rustup'
    }
    $env:PATH = "$(Split-Path -Parent $taoConfig.nodeExe);$(Split-Path -Parent $taoConfig.cargoExe);$env:PATH"
}
$env:CARGO_TARGET_DIR = Join-Path $taoRoot '.tao-release-cache\windows-native-target'
Push-Location $taoRoot
try {
    if ($CleanupOnly) {
        $taoLabRoot = [IO.Path]::GetFullPath((Join-Path $taoRoot '.tao-release-cache\windows-native-lab'))
        if (-not (Test-Path -LiteralPath $taoLabRoot)) { exit 0 }
        foreach ($taoRun in Get-ChildItem -LiteralPath $taoLabRoot -Directory -Filter 'run-*') {
            $taoRunPath = [IO.Path]::GetFullPath($taoRun.FullName)
            if (-not $taoRunPath.StartsWith($taoLabRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or ($taoRun.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid experiment directory.' }
            $taoJournals = @(Get-ChildItem -LiteralPath (Join-Path $taoRunPath 'state') -Filter '*.json')
            if ($taoJournals.Count -eq 0) { continue }
            $taoHelper = Join-Path $taoRunPath 'bin\tao-native-sandbox-probe.exe'
            $taoActiveHelpers = @(Get-CimInstance Win32_Process -Filter "Name='tao-native-sandbox-probe.exe'")
            if ($taoActiveHelpers | Where-Object { $_.ExecutablePath -eq $taoHelper }) { throw "Experiment still running: $taoRunPath" }
            & $taoHelper --cleanup
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        Write-Host 'Owned experiment journals cleaned. No local accounts or firewall rules were created by this prototype.'
        exit 0
    }
    & cargo build --offline --manifest-path experiments/windows-native-sandbox/Cargo.toml
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host 'Research only: creates disposable AppContainer profiles and ACL entries on generated test folders; no local users or firewall rules.'
    $taoTestArguments = @('scripts/test-windows-native.mjs')
    if ($Smoke) { $taoTestArguments += '--smoke' }
    if ($Compatibility) { $taoTestArguments += '--compatibility' }
    & node @taoTestArguments
    exit $LASTEXITCODE
} finally { Pop-Location }
