# Diccionario de datos

| Motor | Entidad o clave | Campos y controles | Uso |
| --- | --- | --- | --- |
| PostgreSQL | users | id UUID PK, email normalizado único, password_hash opcional, role, workshop_id según rol, totp_secret cifrado, session_version | Identidad y revocación |
| PostgreSQL | workshops, workshop_products | Taller UUID, document_id único, producto identificado por workshop_id y SKU normalizado | Organización y catálogo |
| PostgreSQL | motorcycles | id UUID PK, owner_id, workshop_id opcional, placa normalizada única, marca, modelo, odometer_km entero no negativo | Vehículo y ámbito actual |
| PostgreSQL | vehicle_events | id, moto, actor, tipo, categoría, descripción, COP, occurred_at, clave idempotente y hash del contenido | Historial y datos de origen |
| PostgreSQL | service_invoices | id, taller, moto, serie, consecutivo, importe y timestamp. Unicidad por taller, serie y número | Facturación |
| PostgreSQL | user_documents, oidc_identities | Documento único por tipo, jurisdicción y número. Identidad federada por emisor y sujeto | Identificadores |
| PostgreSQL | notification_outbox, projection_outbox | ID, carga o referencia, seguimiento de entrega y vencimiento del reintento | Entrega eventual |
| Redis | session:SHA-256 | userId, expiresAt, mfa, version. 30 min de inactividad, máximo 8 h | Sesión compartida y revocable |
| Redis | cache de vehículos, límites y recuperaciones | Claves de caché versionadas, contadores, tokens de recuperación y OIDC con TTL | Caché, límites y seguridad |
| MongoDB | notifications, reminders, vehicle_documents | Aviso por ID, recordatorio por fecha/kilometraje, documento con binario e índice único por moto/hash | Notificaciones y documentos |
| Cassandra | odometer_readings_by_moto | Clave partición motorcycle_id, orden por recorded_at y reading_id, actor y kilómetros | Historial de kilometraje |
| Cassandra | audit_events_by_day | Día UTC, event_id timeuuid, actor, acción, sujeto y resultado. Inserción condicional | Auditoría |
| ClickHouse | fact_vehicle_events | UUID de evento y moto; propietario, taller nullable, marca, tipo y categoría; importe UInt64 COP y DateTime64 UTC | Consultas OLAP |

## Modelo analítico

La granularidad es **un evento de mantenimiento o gasto por UUID**, proyectado desde PostgreSQL. La fecha UTC, motocicleta, propietario, taller, marca, tipo y categoría son dimensiones. `amount_cop` es la medida aditiva y el conteo se obtiene de los hechos deduplicados. Las particiones son mensuales. La clave física es moto, fecha e ID de evento. `ReplacingMergeTree` conserva versiones durante compactación y las consultas del API usan `FINAL` para consolidarlas en lectura.

El TCO disponible suma los importes registrados. La agregación mensual usa intervalo semiabierto de fechas y una dimensión seleccionada. El recuento de mantenimientos separa preventivos, correctivos y no clasificados. PostgreSQL determina la autorización de cada vehículo al consultar, de acuerdo con su asignación actual.
