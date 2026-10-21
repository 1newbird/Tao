param([string]$Image = 'node:22-bookworm-slim')
$ErrorActionPreference = 'Stop'
if ($Image -notmatch '^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$') { throw 'Invalid image reference.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop and enable Linux containers first.' }
$endpointJson = & docker context inspect --format '{{json .Endpoints.docker.Host}}'
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the current Docker context.' }
$endpoint = $endpointJson | ConvertFrom-Json
if ($endpoint -notmatch '^(npipe:|unix:)') { throw 'Tao supports a local Docker daemon only.' }
$dockerMode = & docker --host $endpoint info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or $dockerMode -ne 'linux') { throw 'Start Docker Desktop with Linux containers, then retry.' }
& docker --host $endpoint pull $Image
if ($LASTEXITCODE -ne 0) { throw 'Docker image preparation failed.' }
Write-Host "Tao sandbox image ready: $Image"
Write-Host 'Choose the Docker backend in the agent profile. Model services remain outside the tool container.'
