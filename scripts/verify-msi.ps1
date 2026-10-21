param(
    [Parameter(Mandatory = $true)]
    [string]$MsiPath
)

$ErrorActionPreference = 'Stop'
$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($resolvedMsi, 0)

function Get-LongName([string]$value) {
    $name = ($value -split '\|')[-1]
    return ($name -split ':')[0]
}

$directories = @{}
$view = $database.OpenView('SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`')
$view.Execute()
try {
    while ($record = $view.Fetch()) {
        $directories[$record.StringData(1)] = @{
            Parent = $record.StringData(2)
            Name = Get-LongName $record.StringData(3)
        }
    }
} finally { $view.Close() }

$components = @{}
$view = $database.OpenView('SELECT `Component`, `Directory_` FROM `Component`')
$view.Execute()
try {
    while ($record = $view.Fetch()) {
        $components[$record.StringData(1)] = $record.StringData(2)
    }
} finally { $view.Close() }

function Get-DirectoryPath([string]$id) {
    $parts = New-Object System.Collections.Generic.List[string]
    $seen = @{}
    while ($id -and $directories.ContainsKey($id)) {
        if ($seen.ContainsKey($id)) { throw "Directory cycle in MSI: $id" }
        $seen[$id] = $true
        $directory = $directories[$id]
        if ($directory.Name -and $directory.Name -ne '.' -and $directory.Name -ne 'SourceDir') {
            $parts.Insert(0, $directory.Name)
        }
        $id = $directory.Parent
    }
    return ($parts -join '\')
}

$required = @(
    'tao.exe',
    'node\node.exe',
    'node\BUILD-MANIFEST.json',
    'node\npm.cmd',
    'node\npx.cmd',
    'node\node_modules\npm\bin\npm-cli.js',
    'native\tao-windows-sandbox.exe',
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.md',
    'pi\LICENSE',
    'node\LICENSE',
    'runtime\tao-runtime.mjs',
    'runtime\policy.mjs',
    'runtime\multi-agent.mjs',
    'runtime\context.mjs',
    'runtime\prompt-policy.mjs',
    'runtime\execution.mjs',
    'runtime\execution-policy.mjs',
    'runtime\execution-tools.mjs',
    'runtime\windows-sandbox.mjs',
    'runtime\sandbox-node.mjs',
    'runtime\sandbox-worker.mjs',
    'runtime\compaction-policy.mjs',
    'runtime\docs\tools.md',
    'runtime\docs\collaboration.md',
    'runtime\docs\permissions.md',
    'runtime\docs\customization.md',
    'pi\packages\coding-agent\src\index.ts',
    'pi\node_modules\tsx\dist\preflight.cjs',
    'pi\node_modules\tsx\dist\loader.mjs',
    'pi\packages\coding-agent\src\core\tools\grep.ts',
    'pi\packages\coding-agent\src\core\tools\find.ts',
    'pi\packages\coding-agent\src\utils\tools-manager.ts',
    'pi\packages\coding-agent\src\core\exec.ts',
    'RELEASE-MANIFEST.json'
)
$found = @{}
$presentPaths = @{}
$requiredNames = @{}
foreach ($suffix in $required) { $requiredNames[($suffix -split '\\')[-1]] = $true }
$modelFiles = 0
$fileCount = 0
$totalBytes = [long]0
$view = $database.OpenView('SELECT `FileName`, `Component_`, `FileSize` FROM `File`')
$view.Execute()
try {
    while ($record = $view.Fetch()) {
        $fileCount++
        $totalBytes += [long]$record.IntegerData(3)
        $componentId = $record.StringData(2)
        if (-not $components.ContainsKey($componentId)) { throw "Missing MSI component: $componentId" }
        $name = Get-LongName $record.StringData(1)
        if (-not $requiredNames.ContainsKey($name) -and -not $name.EndsWith('.json', [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $path = (Get-DirectoryPath $components[$componentId]) + '\' + $name
        $presentPaths[$path] = $true
        foreach ($suffix in $required) {
            if ($path.EndsWith(('\' + $suffix), [System.StringComparison]::OrdinalIgnoreCase)) {
                $found[$suffix] = $path
            }
        }
        if ($path -match '\\pi\\packages\\ai\\src\\providers\\data\\[^\\]+\.json$') {
            $modelFiles++
        }
    }
} finally { $view.Close() }

if (-not $found.ContainsKey('tao.exe')) { throw 'MSI is missing tao.exe' }
$appDirectory = Split-Path -Path $found['tao.exe'] -Parent
foreach ($suffix in $required) {
    # Root LICENSE must not be satisfied by a dependency's nested LICENSE.
    $expectedPath = Join-Path -Path $appDirectory -ChildPath $suffix
    if (-not $presentPaths.ContainsKey($expectedPath)) { throw "MSI is missing required resource: $suffix" }
    Write-Host "[Tao MSI] $suffix -> $expectedPath"
}
if ($modelFiles -lt 1) { throw 'MSI is missing Pi model data' }

# A file-table check alone cannot prove the uninstall lifecycle was linked.
$view = $database.OpenView('SELECT `Type`, `Source`, `Target` FROM `CustomAction` WHERE `Action` = ''RemoveTaoSandboxCompatibility''')
$view.Execute()
try {
    $record = $view.Fetch()
    if (-not $record -or $record.IntegerData(1) -ne 3074 -or $record.StringData(2) -ne 'TaoSandboxRemovalHelper' -or $record.StringData(3) -ne '--compat-cleanup --if-initialized') {
        throw 'MSI sandbox removal must use its embedded helper, deferred and elevated, with checked return status'
    }
} finally { $view.Close() }
$view = $database.OpenView('SELECT `Condition`, `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''RemoveTaoSandboxCompatibility''')
$view.Execute()
try {
    $record = $view.Fetch()
    if (-not $record -or $record.StringData(1) -ne 'REMOVE~="ALL" AND NOT UPGRADINGPRODUCTCODE') { throw 'MSI must preserve sandbox grants during upgrades' }
    $taoCleanupSequence = $record.IntegerData(2)
} finally { $view.Close() }
$view = $database.OpenView('SELECT `Sequence` FROM `InstallExecuteSequence` WHERE `Action` = ''RemoveFiles''')
$view.Execute()
try {
    $record = $view.Fetch()
    if (-not $record -or $taoCleanupSequence -ge $record.IntegerData(1)) { throw 'Sandbox cleanup must run before removing application files' }
} finally { $view.Close() }
Write-Host '[Tao MSI] Verified embedded sandbox cleanup and upgrade-preserving condition'
$view = $database.OpenView('SELECT `Data` FROM `Binary` WHERE `Name` = ''TaoSandboxRemovalHelper''')
$view.Execute()
try {
    $record = $view.Fetch()
    if (-not $record -or $record.DataSize(1) -le 0 -or $record.DataSize(1) -gt 4MB) { throw 'MSI is missing its embedded sandbox helper' }
    # ReadStream format 1 is a BSTR with one byte per character, not UTF-8.
    $taoEmbeddedBytes = [Text.Encoding]::GetEncoding(28591).GetBytes($record.ReadStream(1, $record.DataSize(1), 1))
    $taoHasher = [Security.Cryptography.SHA256]::Create()
    try { $taoEmbeddedHash = ([BitConverter]::ToString($taoHasher.ComputeHash($taoEmbeddedBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $taoHasher.Dispose() }
    $taoExpectedHelper = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\resources\native\tao-windows-sandbox.exe'
    if ($taoEmbeddedHash -ne (Get-FileHash -LiteralPath $taoExpectedHelper -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'MSI embedded cleanup helper differs from the verified resource' }
    Write-Host "[Tao MSI] Embedded sandbox helper SHA-256: $taoEmbeddedHash"
} finally { $view.Close() }

Write-Host "[Tao MSI] Verified $fileCount files, $modelFiles model data files, $([math]::Round($totalBytes / 1MB, 1)) MiB unpacked"
