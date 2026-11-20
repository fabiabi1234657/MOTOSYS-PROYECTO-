$ErrorActionPreference = 'Stop'
$networks = docker network ls --filter 'name=^motosys_net$' --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker no respondió al consultar las redes.' }
if ($networks -notcontains 'motosys_net') {
    docker network create motosys_net
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear motosys_net.' }
}
