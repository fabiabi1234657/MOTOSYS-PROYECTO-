# Diccionario de datos de MotoSys

## PostgreSQL

PostgreSQL es la fuente de verdad de cuentas, talleres, motocicletas y operaciones económicas. Los identificadores UUID se comparten con los motores secundarios.

| Tabla | Claves, datos y reglas |
| --- | --- |
| `users` | `id` UUID generado, `email` texto normalizado y único, `password_hash` texto opcional, `role` texto obligatorio y `workshop_id` UUID requerido solo para administradores de taller. |
| `workshops` | `id` UUID generado, `name` texto y `document_id` texto único. |
| `user_documents` | `user_id` referencia a cuenta. Tipo, jurisdicción y número son textos en mayúsculas y forman la clave. Ejemplo ficticio `CC / CO / DEMO001`. |
| `motorcycles` | `id` UUID generado, `owner_id` referencia a cuenta, `workshop_id` referencia opcional, placa única en mayúsculas, marca y modelo como texto, odómetro entero no negativo. |
| `workshop_products` | `workshop_id` referencia a taller, SKU normalizado y nombre como texto. Clave por taller y SKU. |
| `service_invoices` | UUID generado, referencias obligatorias a taller y vehículo, serie normalizada, consecutivo entero positivo, importe entero en COP y fecha de emisión con zona horaria. Unicidad por taller, serie y consecutivo. |
| `vehicle_events` | UUID generado, referencias al vehículo y actor, tipo `MAINTENANCE` o `EXPENSE`, categoría y descripción como texto, importe entero en COP y fecha con zona horaria. Clave idempotente única por actor y tipo. El hash de la solicitud permite distinguir reintentos de cambios de contenido. |

## MongoDB

Las colecciones iniciales tienen índices para consultar notificaciones por usuario y fecha, seleccionar recordatorios por estado y vencimiento, y evitar la duplicación de un documento por motocicleta y hash de archivo. El contrato de documentos y los estados definitivos dependen del servicio Java pendiente.

## Cassandra

`odometer_readings_by_moto` agrupa por UUID del vehículo y ordena por fecha de lectura descendente. Cada lectura guarda UUID de lectura, kilometraje entero y UUID del actor. `audit_events_by_day` agrupa por fecha y ordena por `timeuuid`; almacena actor, acción, sujeto y resultado. Las tablas existen. Los permisos de escritura y el adaptador de auditoría permanecen pendientes.

## Redis

El motor tiene persistencia AOF y límite de 64 MiB para datos. El diseño prevé espacios de claves independientes para sesión y caché, con caducidades definidas por cada operación. La aplicación aún carece de productores y consumidores para esos espacios.

## ClickHouse

`fact_vehicle_events` tiene como grano un evento de mantenimiento o gasto originado en PostgreSQL. Las dimensiones son fecha UTC, vehículo, propietario, taller opcional, marca, tipo y categoría. El importe entero en COP es la medida. La partición es mensual y la clave de ordenamiento usa vehículo, fecha e identificador del evento. La ingesta y la reconciliación con PostgreSQL permanecen pendientes.
