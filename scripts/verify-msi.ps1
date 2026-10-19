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

Write-Host "[Tao MSI] Verified $fileCount files, $modelFiles model data files, $([math]::Round($totalBytes / 1MB, 1)) MiB unpacked"
