param([string]$WorkspacePath, [switch]$Prepare, [switch]$Remove)
$ErrorActionPreference = 'Stop'
if ($Prepare -and $Remove) { throw 'Choose either Prepare or Remove.' }
$taoRoot = Split-Path -Parent $PSScriptRoot
$taoHelper = Join-Path $taoRoot 'src-tauri\resources\native\tao-windows-sandbox.exe'
if (-not (Test-Path -LiteralPath $taoHelper)) { throw 'Build the helper first: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-sandbox.ps1' }
$taoMetadataArguments = @()
if ($WorkspacePath) {
    $taoWorkspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
    if (-not (Test-Path -LiteralPath $taoWorkspace -PathType Container)) { throw 'Choose a workspace directory.' }
    $taoMetadataArguments = @('--metadata-path', ('"' + $taoWorkspace.TrimEnd('\') + '"'))
}
if ($Prepare -or $Remove) {
    Write-Host 'Windows native preview: UAC prepares only Tao.WindowsSandbox.Compatibility.v1.'
    Write-Host 'Grants: non-inheriting path/ancestor metadata, MountPointManager read, NUL read/write. No directory listing, file contents, root writes, accounts, services or firewall changes.'
    Write-Host 'Administrator-protected registry records directory grants for cleanup; device permissions may need initialization after reboot.'
    $taoOperation = if ($Remove) { '--compat-cleanup' } else { '--compat-prepare' }
    try {
        $taoSetup = Start-Process -FilePath $taoHelper -ArgumentList (@($taoOperation) + $taoMetadataArguments) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } catch {
        $taoIssue = $_.Exception
        while ($taoIssue) {
            if ($taoIssue.NativeErrorCode -eq 1223) { Write-Host 'Administrator authorization cancelled. No setup/removal was executed.'; exit 1223 }
            $taoIssue = $taoIssue.InnerException
        }
        throw
    }
    if ($taoSetup.ExitCode -ne 0) { throw "Native sandbox initialization failed (exit $($taoSetup.ExitCode)). No local fallback is used; -Remove can retry cleanup." }
}
$taoStatusArguments = @('--compat-status')
if ($WorkspacePath) { $taoStatusArguments += @('--metadata-path',$taoWorkspace) }
& $taoHelper @taoStatusArguments
exit $LASTEXITCODE
