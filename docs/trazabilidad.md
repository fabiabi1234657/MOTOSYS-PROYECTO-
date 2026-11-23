# Matriz de trazabilidad de MotoSys

| Requisito | Caso de uso | Módulo o API | Prueba | Evidencia |
| --- | --- | --- | --- | --- |
| RF01 | Acceder, cerrar sesión y recuperar acceso | Core /auth | OIDC simulado, Argon2id, revocación, MFA, token único | tests/integration/test_core_http.py y test_phases_2b_3.py |
| RF02 | Registrar motocicleta y kilometraje propio | Core /motorcycles | Placa duplicada, RBAC, proyección del odómetro | test_phases_2b_3.py |
| RF03 | Registrar y consultar un gasto o mantenimiento | Core /motorcycles/{id}/events | Alta 201, reenvío 200, conflicto 409, invalidación | test_core_http.py |
| RF04 | Consultar taller, registrar SKU y emitir factura | Core /workshops | Conflicto de SKU y factura | test_core_http.py |
| RF05 | Gestionar notificaciones, documentos, recordatorios e informes | Notify /notifications, /documents, /reminders y /reports | Deduplicación HTTP y AMQP, documento 409, aviso por odómetro, CSV/PDF | test_phases_2b_3.py y ReportControllerTest.java |
| RF06 | Verificar auditoría y uso de caché | Core /admin/audit y /admin/cache-metrics | Denegación a RIDER y evento en Cassandra | test_core_http.py y test_phases_2b_3.py |
| RF07 | Analizar costos, frecuencia y mantenimiento esperado | Analytics /analytics | pytest E2E con Redis, PostgreSQL y ClickHouse, benchmark | services/analytics-python/tests y fases-4-5.md |
| RF08 | Registrar sin conexión y reintentar | Expo, AsyncStorage y Core | Conservación de Idempotency-Key y retención de conflicto | clients/mobile/test/offline.test.mjs |
| RNF01 | Arrancar y recuperar datos | Dos Compose y motosys_net | Cinco motores con escritura/lectura y restauración de seis volúmenes | fases-4-5.md |
| RNF02 | Acotar uso de recursos | Docker stats, pool Node, executor Java, joblib | 1.175 solicitudes sin errores en 120 s, pico 2,10 GiB | carga-fases-4-5.json |
| RNF03 | Operar desde Web y Android | React/Vite, Expo, contratos compartidos | Build Web, recorrido Edge HTTPS, typecheck, pruebas móviles y firma del APK | docs/fase-6.md y docs/evidence |
| RNF04 | Navegar con tecnología asistiva | Foco, etiquetas, aria-live y accesibilidad nativa | Revisión estructural. Auditoría completa pendiente | docs/brand-guide.md |
