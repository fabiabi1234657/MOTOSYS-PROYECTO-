# Analítica e infraestructura de MotoSys

## Arranque manual

1. Copia `infra/.env.example` a `infra/.env` si aún no existe y configura las contraseñas y las URL de conexión. Conserva las contraseñas originales si reutilizas volúmenes. Sustituye las contraseñas de PostgreSQL, MongoDB, Redis, ClickHouse y RabbitMQ. Refleja los valores en las URL de conexión. Configura también `NOTIFICATIONS_TOKEN` con al menos 32 caracteres y `TOTP_ENCRYPTION_KEY` con 64 dígitos hexadecimales aleatorios. El Compose publica HTTPS en `127.0.0.1:8443` por defecto.
2. Desde la raíz del repositorio ejecuta estos comandos con Docker Desktop en modo Linux.

```powershell
./infra/scripts/init-network.ps1
./infra/scripts/init-tls.ps1
docker compose --env-file infra/.env -f infra/compose.datos.yml up -d --wait
docker compose --env-file infra/.env -f infra/compose.datos.yml exec -T cassandra cqlsh -f /opt/motosys/schema.cql
Get-Content -Raw infra/init/core-auth.sql | docker compose --env-file infra/.env -f infra/compose.datos.yml exec -T postgres psql -U motosys -d motosys -v ON_ERROR_STOP=1
docker compose --env-file infra/.env -f infra/compose.apps.yml --profile notifications up -d --build --wait
```

El TLS de desarrollo se genera con OpenSSL. Cuando uses la CLI, confía solo en el certificado de esta instancia con `curl.exe --cacert infra/tls/localhost.crt https://localhost:8443/health`. El certificado local caduca a los 30 días. Para un entorno compartido, monta un par emitido para tu nombre de DNS mediante `TLS_DIRECTORY`. Usa ese mismo origen en `OIDC_PUBLIC_ORIGIN` y registra el retorno del proveedor. La ruta raíz del proxy indica qué APIs están disponibles. Los clientes de la Fase 6 aún tienen su propia entrega.

| API | Ruta HTTPS |
| --- | --- |
| NestJS | `https://localhost:8443/api/core/openapi.json` |
| Spring Boot | `https://localhost:8443/api/notify/v3/api-docs` |
| FastAPI | `https://localhost:8443/api/analytics/docs` |

## Datos de demostración

Ejecuta `python infra/scripts/seed-all.py --admin-email tu-correo@example.com` en una instancia de pruebas. El script pide contraseñas sin mostrarlas. El correo indicado crea el primer superadministrador si aún no existe uno y devuelve el URI de enrolamiento TOTP. Mantén ese URI fuera del historial y de archivos compartidos. Omite `--admin-email` para cargar solamente datos ficticios. Los motociclistas de prueba usan `demo.rider@example.invalid` y `demo.other@example.invalid`, con la contraseña demo que ingresaste.

El script utiliza UUID estables para PostgreSQL, MongoDB, Cassandra y ClickHouse y renueva el marcador de prueba de Redis. Configura `--data-project` y `--apps-project` si usaste nombres de Compose distintos. La creación del administrador usa un bloqueo transaccional y requiere un correo que aún esté disponible.

## API analítica

- `GET /api/analytics/motorcycles/{id}/tco` suma gastos y mantenimientos registrados.
- `GET /api/analytics/monthly?dimension=category&since=2026-01-01&until=2027-01-01` agrega importes mensuales por `category`, `make` o `workshop`. El inicio se incluye y el fin se excluye.
- `GET /api/analytics/motorcycles/{id}/maintenance` cuenta preventivos, correctivos y eventos sin clasificar. Reconoce categorías exactas en español e inglés sin distinguir mayúsculas.
- `GET /api/analytics/motorcycles/{id}/recommendation` usa el historial del vehículo. Requiere seis mantenimientos y calcula una fecha y un costo estimados. Es una estimación exploratoria, sensible al tamaño y a la calidad del historial.
- `POST /api/analytics/ml/benchmark` requiere `SUPER_ADMIN`. Recibe `{"samples":1200,"workers":2}` y devuelve tiempos con uno y dos hilos sobre la misma entrada reproducible, más una comprobación de equivalencia de predicciones.

Las sesiones usan las mismas reglas de expiración, revocación y roles que el núcleo. Los GET de FastAPI aceptan Bearer o la cookie segura del núcleo. Java conserva su contrato Bearer. Si el benchmark usa cookie, debe incluir `X-CSRF-Token`. El API determina la autorización a partir del estado actual de PostgreSQL. ClickHouse usa `FINAL` para consolidar copias devueltas por la proyección asíncrona. El ejecutor admite un trabajo de ML a la vez y comparte la memoria del proceso entre los hilos de joblib.

## ClickHouse con volúmenes de fases anteriores

El perfil de memoria desactiva la escritura de los historiales `system.metric_log` y `system.asynchronous_metric_log`. Las tablas de métricas en vivo siguen disponibles. Si restauras o reutilizas un volumen que ya contiene los dos historiales, pausa sus compactaciones después de iniciar ClickHouse. Conserva los datos históricos.

```powershell
foreach ($table in @('metric_log','asynchronous_metric_log')) {
    $client = 'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -q "$1"'
    $exists = docker compose --env-file infra/.env -f infra/compose.datos.yml exec -T clickhouse sh -ec $client motosys "EXISTS TABLE system.$table"
    if ($exists -eq '1') {
        docker compose --env-file infra/.env -f infra/compose.datos.yml exec -T clickhouse sh -ec $client motosys "SYSTEM STOP MERGES system.$table"
    }
}
```

## Respaldo y restauración

Detén los proyectos para obtener una copia en frío. El respaldo incluye los cinco motores y RabbitMQ si su volumen existe.

```powershell
docker compose --env-file infra/.env -f infra/compose.apps.yml --profile notifications stop
docker compose --env-file infra/.env -f infra/compose.datos.yml stop
./infra/scripts/backup-volumes.ps1 -Destination infra/backups/motosys-demo
./infra/scripts/restore-volumes.ps1 -Source infra/backups/motosys-demo -DataProject motosys-recuperado-datos -AppsProject motosys-recuperado-apps
```

La restauración verifica SHA-256 y exige proyectos con volúmenes nuevos. Arranca los Compose restaurados con `-p`, los nombres usados al restaurar, las mismas credenciales y las mismas versiones de imágenes. Mantén separados los entornos que reutilicen la red externa para evitar nombres de servicio duplicados. Guarda los archivos de respaldo y los secretos originales en almacenamiento protegido. Las claves de sesión y los datos de cuentas están incluidos en los volúmenes.

## Pruebas reproducibles

Ejecuta `python -m pytest` desde `services/analytics-python` tras instalar `requirements.txt` en Python 3.13. La prueba E2E requiere los datos demo y las variables `MOTOSYS_DEMO_PASSWORD`, `MOTO_E2E_CORE` y `MOTO_E2E_ANALYTICS` si los destinos difieren de los predeterminados del contenedor.

La carga se ejecuta desde la raíz con la contraseña demo en `MOTOSYS_DEMO_PASSWORD`. La prueba escribe eventos y actualiza el odómetro del escenario ficticio; ejecuta el comando sobre un entorno aislado.

```powershell
python infra/scripts/load-steady.py --seconds 120 --output docs/carga-fases-4-5.json
```

El generador usa 127.0.0.1 para evitar la espera de conexión IPv6 en hosts donde localhost se resuelve primero a IPv6. La medición contempla el pico simultáneo de los diez contenedores y el máximo individual observado, además de errores y latencia p95 por ruta. El uso de Docker se mide aparte de la memoria de Windows, WSL y otros procesos.


## Verificación inicial

Los límites declarados son 2144 MiB para datos y 1136 MiB para las aplicaciones, un total de 3280 MiB para diez contenedores. Cassandra quedó configurada en 768 MiB y FastAPI en 256 MiB. ClickHouse tiene 768 MiB de contenedor y 640 MiB de presupuesto interno.

Pasaron seis pruebas pytest en Docker. Se comprobó el acceso de la moto propia, el 403 de la otra cuenta, la agrupación de ClickHouse, la recomendación, la revocación de sesión y el benchmark administrativo. Con 1200 muestras, la ejecución de referencia tomó 402,76 ms con un hilo y 294,48 ms con dos (1,37 veces más rápida), con predicciones equivalentes. Una prueba HTTPS adicional validó la cookie Secure y HttpOnly del núcleo y su uso en FastAPI.


Con el presupuesto previo de 512 MiB internos, el registro de consultas de ClickHouse mostró errores 241 en la agregación y en la ingesta durante la prueba. El perfil final reserva 640 MiB internos dentro de un contenedor de 768 MiB. La pausa de compactaciones en volúmenes anteriores conserva el historial, y los volúmenes nuevos no generan esas tablas históricas.

## Carga sostenida medida

La corrida definitiva mantuvo dos lectores y un escritor durante 120 segundos a través de HTTPS. Se completaron 1175 solicitudes sin errores HTTP, reinicios ni OOM. Se obtuvieron 30 muestras de `docker stats`.

El pico simultáneo fue **2148,63 MiB** (2,10 GiB). Los picos individuales pueden ocurrir en instantes diferentes.

| Contenedor | Pico observado (MiB) | Límite (MiB) |
| --- | ---: | ---: |
| ClickHouse | 347,50 | 768 |
| Cassandra | 728,90 | 768 |
| PostgreSQL | 66,41 | 192 |
| Redis | 10,48 | 96 |
| MongoDB | 269,40 | 320 |
| Nginx | 3,10 | 48 |
| FastAPI | 110,70 | 256 |
| NestJS | 214,90 | 256 |
| Spring Boot | 309,20 | 320 |
| RabbitMQ | 183,30 | 256 |

Docker tenía 12 CPU y 15,58 GiB disponibles durante la prueba. La medición verifica el consumo de los contenedores con sus límites configurados. La memoria de Windows y WSL queda fuera de la muestra.

La traza y las latencias p95 por ruta están en [el registro de carga](carga-fases-4-5.json).


## Restauración verificada

Se respaldaron seis volúmenes en frío y se verificaron sus SHA-256 durante la restauración en proyectos nuevos. Los cinco motores restaurados pasaron lectura y escritura, incluido un agregado de ClickHouse. PostgreSQL conservó los 18 eventos de semilla, Redis conservó su marcador y RabbitMQ recuperó la cola durable `motosys.notifications`. Las proyecciones acumuladas antes del respaldo figuraban entregadas, con 165 de 165 en ClickHouse, 165 de 165 en Cassandra y 165 de 165 notificaciones.

Se detuvieron tanto el entorno de carga como el restaurado y se conservaron los volúmenes.
