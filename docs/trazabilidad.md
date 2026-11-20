# Trazabilidad del instructivo 2026-2

Criterios extraídos del instructivo de Programación Avanzada y cotejados con los dos documentos previos de MotoSys. El diseño anterior usa Express como núcleo, FastAPI para notificaciones y Flutter para el cliente móvil. El diseño aprobado cambia a NestJS, Spring Boot, FastAPI para analítica y Expo. Se conservan los flujos de historial vehicular, mantenimiento, gastos, alertas y administración, junto con los escenarios de caché, caída de notificaciones y registro móvil con conectividad limitada.

| Criterio | Caso o demostración | Código o evidencia disponible | Estado |
| --- | --- | --- | --- |
| Tres backends y hexagonal principal | Seguir una operación desde HTTP hasta el motor de datos | `services/core-nestjs/src/domain` | Parcial. El registro idempotente tiene puertos y adaptador PostgreSQL. Faltan la API y los servicios Java y Python. |
| Cinco módulos y tres procesos avanzados | Registrar moto, servicio y gasto, recibir alerta y consultar analítica | `infra/init` | Parcial. Esquemas iniciales. |
| Dos Compose, red y cinco motores | Levantar datos y aplicaciones, leer y escribir en cada motor | `infra/compose.datos.yml` y `infra/scripts/init-network.ps1` | Parcial. Compose de datos validado y cinco healthchecks alcanzados. ClickHouse rechazó el conteo por el límite configurado. |
| Identidad y recuperación | Inicio local, Google y Microsoft, restablecimiento seguro y TOTP administrativo | `password-policy.ts` y tres pruebas unitarias | Parcial. La regla de dominio requiere integración con identidad, Argon2id y una lista efectiva de contraseñas. |
| Sesiones y autorización | Revocar sesión, comprobar caducidades y probar acceso a objetos desde cada API | `access.ts` y tres pruebas unitarias | Parcial. Sin sesiones ni verificación HTTP. |
| Integridad | Forzar altas simultáneas y verificar HTTP 409, reintentar una operación con clave idempotente | `infra/init/postgres.sql` y `infra/init/mongo.js` | Parcial. PostgreSQL rechazó una de dos altas concurrentes con SQLSTATE 23505. Falta comprobar la respuesta HTTP 409. |
| Caché | Medir aciertos, fallos y latencia y comprobar invalidación | Límites de Redis en Compose | Pendiente. |
| Concurrencia y paralelismo | Medir procesos reales de los tres backends con entradas reproducibles | | Pendiente. |
| Operación y recuperación | Cargar datos ficticios, respaldar y restaurar, repetir desde cero | `README.md` | Parcial. Inicio documentado para datos. |
| OpenAPI y pruebas | Adjuntar especificaciones HTTP y demostrar diez pruebas automatizadas como mínimo | Siete pruebas unitarias de dominio y aplicación, y pruebas SQL de integridad | Parcial. Las pruebas unitarias cubren reglas aisladas. |
| Web y APK | Completar la misma tarea en ambos clientes para cada rol y probar recuperación del flujo offline | | Pendiente. |
| Informe y entrega | Once componentes con APA 7, PDF y editable, ZIP, APK y enlace GitHub con commit o etiqueta | Esta matriz de seguimiento | Pendiente. El instructivo fija la entrega en Moodle el 25 de noviembre y la sustentación el 2 de diciembre de 2026. |

