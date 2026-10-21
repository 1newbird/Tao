param([switch]$Prepare, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Prepare -and $Remove) { throw 'Choose either Prepare or Remove.' }
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
    & cargo build --offline --manifest-path experiments/windows-native-sandbox/Cargo.toml
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $taoHelper = Join-Path $env:CARGO_TARGET_DIR 'debug\tao-native-sandbox-probe.exe'
    if ($Prepare -or $Remove) {
        Write-Host 'Experimental compatibility setup: only the Tao.NativeProbe.Compatibility.v1 SID is changed.'
        Write-Host 'Objects: NT drive-name metadata, non-inheriting drive-root metadata, MountPointManager read access, and NUL read/write.'
        Write-Host 'No root listing/write, inherited root grants, All Application Packages grants, accounts, services, firewall or integrity-label changes.'
        Write-Host 'Remove revokes only matching grants. Windows resets some device objects after reboot; readiness is checked again.'
        $taoOperation = if ($Remove) { '--compat-cleanup' } else { '--compat-prepare' }
        $taoMetadataPath = Join-Path $taoRoot '.tao-release-cache\windows-native-lab'
        & $taoHelper --compat-status --metadata-path $taoMetadataPath | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Compatibility preflight failed before UAC; no system objects were changed.' }
        $taoSetupProcess = Start-Process -FilePath $taoHelper -ArgumentList @($taoOperation,'--metadata-path',('"' + $taoMetadataPath + '"')) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
        if ($taoSetupProcess.ExitCode -ne 0) { throw "Native compatibility setup failed (exit $($taoSetupProcess.ExitCode)). Inspect --compat-status; rerun -Remove to clean owned grants." }
    }
    & $taoHelper --compat-status --metadata-path (Join-Path $taoRoot '.tao-release-cache\windows-native-lab')
    exit $LASTEXITCODE
} finally { Pop-Location }
