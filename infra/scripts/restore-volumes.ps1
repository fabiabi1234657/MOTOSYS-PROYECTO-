param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9_-]*$')][string]$DataProject,
    [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')][string]$AppsProject
)

$ErrorActionPreference = 'Stop'
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $sourcePath 'manifest.json') | ConvertFrom-Json
$required = @('postgres', 'mongo', 'redis', 'cassandra', 'clickhouse')
$allowed = $required + 'rabbitmq'
if ($manifest.version -ne 1) { throw 'Versión del respaldo no compatible.' }
$existing = @(docker volume ls -q)
if ($LASTEXITCODE -ne 0) { throw 'Docker no respondió.' }
$seen = @{}
$jobs = foreach ($entry in $manifest.entries) {
    $role = $entry.volume
    if ($role -cnotin $allowed -or $seen.ContainsKey($role) -or $entry.archive -cne "$role.tar.gz") {
        throw 'Manifiesto inválido.'
    }
    $seen[$role] = $true
    $project = $DataProject
    if ($role -eq 'rabbitmq') {
        if (!$AppsProject) { throw 'El respaldo incluye RabbitMQ y requiere -AppsProject.' }
        $project = $AppsProject
    }
    $target = "${project}_$role"
    if ($target -in $existing) { throw "El volumen $target ya existe. Usa un proyecto nuevo." }
    $archive = Join-Path $sourcePath $entry.archive
    if ((Get-FileHash -LiteralPath $archive).Hash -ne $entry.sha256) { throw "Checksum incorrecto: $archive." }
    @{ Role = $role; Project = $project; Target = $target }
}
foreach ($role in $required) {
    if (!$seen.ContainsKey($role)) { throw "El manifiesto no incluye $role." }
}

foreach ($job in $jobs) {
    docker volume create --label "com.docker.compose.project=$($job.Project)" `
        --label "com.docker.compose.volume=$($job.Role)" $job.Target | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo crear $($job.Target)." }
    docker run --rm --network none --mount "type=volume,src=$($job.Target),dst=/target" `
        --mount "type=bind,src=$sourcePath,dst=/backup,readonly" --entrypoint sh redis:7.4.1-alpine `
        -ec 'test -z "$(ls -A /target)"; tar -xzf "$1" -C /target' motosys "/backup/$($job.Role).tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "No se pudo recuperar $($job.Target)." }
}
Write-Output 'Volúmenes restaurados. Arranca con los nombres de proyecto indicados y las credenciales originales.'
