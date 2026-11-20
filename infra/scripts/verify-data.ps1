param([string]$Project = 'motosys-datos')

$ErrorActionPreference = 'Stop'

function Invoke-Engine {
    param([string]$Service, [string[]]$Command)
    $result = docker exec "${Project}-${Service}-1" @Command
    if ($LASTEXITCODE -ne 0) { throw "Falló la prueba de $Service." }
    $result
}

Invoke-Engine postgres @('psql', '-XAt', '-U', 'motosys', '-d', 'motosys', '-v', 'ON_ERROR_STOP=1', '-c',
    "BEGIN; CREATE TEMP TABLE motosys_probe (value int); INSERT INTO motosys_probe VALUES (7); SELECT value FROM motosys_probe; ROLLBACK;") |
    ForEach-Object { if ($_ -eq '7') { 'PostgreSQL: escritura y lectura verificadas' } }

$probe = [guid]::NewGuid().ToString('N')
Invoke-Engine mongo @('sh', '-ec', 'exec mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin motosys --eval "$1"', 'motosys',
    "const c=db.getCollection('probe_$probe'); try { c.insertOne({value:7}); if (c.findOne().value !== 7) throw Error(7); } finally { c.drop(); }")
'MongoDB: escritura y lectura verificadas'

Invoke-Engine redis @('redis-cli', '--raw', 'EVAL',
    "redis.call('SET',KEYS[1],'7','EX',30); local value=redis.call('GET',KEYS[1]); redis.call('DEL',KEYS[1]); return value", '1', "probe:$probe") |
    ForEach-Object { if ($_ -eq '7') { 'Redis: escritura y lectura verificadas' } else { throw 'Redis devolvió un valor inesperado.' } }

Invoke-Engine cassandra @('cqlsh', '--request-timeout=15', '-f', '/opt/motosys/schema.cql')
$id = [guid]::NewGuid()
$reading = [guid]::NewGuid()
try {
    $result = Invoke-Engine cassandra @('cqlsh', '--request-timeout=15', '-e',
        "INSERT INTO motosys.odometer_readings_by_moto (motorcycle_id, recorded_at, reading_id, kilometers) VALUES ($id, '2026-01-01T00:00:00Z', $reading, 7777); SELECT kilometers FROM motosys.odometer_readings_by_moto WHERE motorcycle_id=$id;")
    if (($result -join ' ') -notmatch '\b7777\b') { throw 'Cassandra devolvió un valor inesperado.' }
    'Cassandra: escritura y lectura verificadas'
} finally {
    Invoke-Engine cassandra @('cqlsh', '--request-timeout=15', '-e',
        "DELETE FROM motosys.odometer_readings_by_moto WHERE motorcycle_id=$id;")
}

$clickhouseCommand = @('sh', '-ec', 'exec timeout 30 clickhouse-client --host 127.0.0.1 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery -q "$1"', 'motosys')
$table = "motosys.probe_$probe"
try {
    $result = Invoke-Engine clickhouse ($clickhouseCommand + @(
        "CREATE TABLE $table (category String, amount UInt32) ENGINE=MergeTree ORDER BY category; INSERT INTO $table VALUES ('Taller', 11), ('Taller', 19); SELECT sum(amount) FROM $table GROUP BY category SETTINGS max_threads=2; SELECT count() FROM motosys.fact_vehicle_events SETTINGS max_threads=2;"))
    if ($result[0] -ne '30') { throw 'ClickHouse devolvió una suma inesperada.' }
    'ClickHouse: escritura persistente, agregado OLAP y consulta de la tabla verificadas'
} finally {
    Invoke-Engine clickhouse ($clickhouseCommand + @("DROP TABLE IF EXISTS $table;"))
}

$ids = docker ps -q --filter "label=com.docker.compose.project=$Project"
if ($LASTEXITCODE -ne 0 -or !$ids) { throw 'No se encontraron los contenedores para medir memoria.' }
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' $ids
if ($LASTEXITCODE -ne 0) { throw 'No se pudo medir memoria.' }
