param([switch]$Release, [switch]$Offline)
$ErrorActionPreference = 'Stop'
$taoRoot = Split-Path -Parent $PSScriptRoot
$taoConfigPath = Join-Path $taoRoot '.tao-dev-config.json'
if (Test-Path -LiteralPath $taoConfigPath) {
    $taoConfig = Get-Content -LiteralPath $taoConfigPath -Raw | ConvertFrom-Json
    if ($taoConfig.localRust) { $env:CARGO_HOME = Join-Path $taoConfig.toolsRoot 'cargo'; $env:RUSTUP_HOME = Join-Path $taoConfig.toolsRoot 'rustup' }
    $env:PATH = "$(Split-Path -Parent $taoConfig.cargoExe);$env:PATH"
}
$env:CARGO_TARGET_DIR = Join-Path $taoRoot '.tao-release-cache\windows-native-target'
$taoPreviousRustFlags = $env:RUSTFLAGS
$taoPreviousEncodedFlags = $env:CARGO_ENCODED_RUSTFLAGS
# This helper ships with the app; a clean Windows computer must not need the
# development machine's Visual C++ redistributable. Scope flags to this build.
if ($env:CARGO_ENCODED_RUSTFLAGS) {
    $env:CARGO_ENCODED_RUSTFLAGS = @($env:CARGO_ENCODED_RUSTFLAGS, '-C', 'target-feature=+crt-static') -join [char]31
} else {
    $env:RUSTFLAGS = "$($env:RUSTFLAGS) -C target-feature=+crt-static".Trim()
}
Push-Location $taoRoot
try {
    $taoArguments = @('build','--locked','--manifest-path','native/windows-sandbox/Cargo.toml')
    if ($Offline) { $taoArguments += '--offline' }
    if ($Release) { $taoArguments += '--release' }
    & cargo @taoArguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $taoMode = if ($Release) { 'release' } else { 'debug' }
    $taoDestination = Join-Path $taoRoot 'src-tauri\resources\native'
    New-Item -ItemType Directory -Path $taoDestination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR "$taoMode\tao-windows-sandbox.exe") -Destination (Join-Path $taoDestination 'tao-windows-sandbox.exe') -Force
    $taoManifestPath = Join-Path $taoRoot 'src-tauri\resources\RELEASE-MANIFEST.json'
    if (Test-Path -LiteralPath $taoManifestPath) {
        # PowerShell 7 may coerce ISO date strings while reading JSON. Update
        # only this hash with Node, preserving the immutable Node build record.
        $taoManifestNode = Join-Path $taoRoot 'src-tauri\resources\node\node.exe'
        if (-not (Test-Path -LiteralPath $taoManifestNode)) { $taoManifestNode = 'node' }
        $taoUpdateManifest = @'
const fs=require('fs'),crypto=require('crypto');
const path=process.argv[1],value=JSON.parse(fs.readFileSync(path,'utf8'));
if(value.nativeSandbox){value.nativeSandbox.sha256=crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex');fs.writeFileSync(path,JSON.stringify(value,null,2)+'\n');}
'@
        & $taoManifestNode -e $taoUpdateManifest $taoManifestPath (Join-Path $taoDestination 'tao-windows-sandbox.exe')
        if ($LASTEXITCODE -ne 0) { throw 'Failed to update native sandbox release hash' }
    }
} finally {
    $env:RUSTFLAGS = $taoPreviousRustFlags
    $env:CARGO_ENCODED_RUSTFLAGS = $taoPreviousEncodedFlags
    Pop-Location
}
