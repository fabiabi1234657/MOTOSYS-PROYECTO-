param(
    [Parameter(Mandatory)][string]$Destination,
    [string]$DataProject = 'motosys-datos',
    [string]$AppsProject = 'motosys-apps'
)

$ErrorActionPreference = 'Stop'
$engineVolumes = [ordered]@{ postgres=$DataProject; mongo=$DataProject; redis=$DataProject; cassandra=$DataProject; clickhouse=$DataProject }
$available = @(docker volume ls -q)
if ($LASTEXITCODE -ne 0) { throw 'Docker no respondió.' }
if ($available -contains "${AppsProject}_rabbitmq") { $engineVolumes['rabbitmq'] = $AppsProject }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Usa un directorio de respaldo nuevo.' }

foreach ($item in $engineVolumes.GetEnumerator()) {
    $volume = "$($item.Value)_$($item.Key)"
    docker volume inspect $volume --format '{{.Name}}' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Volumen inexistente: $volume." }
    $running = docker ps -q --filter "volume=$volume"
    if ($LASTEXITCODE -ne 0 -or $running) { throw "Detén los servicios que usan $volume antes de respaldar." }
}

New-Item -ItemType Directory -Path $destinationPath | Out-Null
$entries = foreach ($item in $engineVolumes.GetEnumerator()) {
    $role = $item.Key
    $volume = "$($item.Value)_$role"
    docker run --rm --network none --mount "type=volume,src=$volume,dst=/source,readonly" `
        --mount "type=bind,src=$destinationPath,dst=/backup" --entrypoint tar redis:7.4.1-alpine `
        -czf "/backup/$role.tar.gz" -C /source .
    if ($LASTEXITCODE -ne 0) { throw "No se pudo respaldar $volume." }
    @{ volume = $role; archive = "$role.tar.gz"; sha256 = (Get-FileHash -LiteralPath (Join-Path $destinationPath "$role.tar.gz")).Hash }
}

@{ version = 1; createdUtc = [DateTime]::UtcNow.ToString('o'); entries = @($entries) } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $destinationPath 'manifest.json') -Encoding utf8
Write-Output "Respaldo guardado en $destinationPath."
