# MotoSys — Plataforma de Gestión Integral para Motociclistas

Proyecto integrador de **Programación Avanzada** y **Arquitectura de Software** (Ingeniería de Sistemas, Semestre 7 — Institución Universitaria del Putumayo, 2026-2).

- **Autores**: Fabian Andrés Coral García · Jorge Arnulfo Montoya Manchola
- **Repositorio oficial**: [https://github.com/fabiabi1234657/MOTOSYS-PROYECTO-](https://github.com/fabiabi1234657/MOTOSYS-PROYECTO-)
- **Plan técnico completo**: [`docs/plan-arquitectura.md`](docs/plan-arquitectura.md)

---

## Estado de implementación

Los cinco motores, el núcleo NestJS y RabbitMQ se probaron localmente. El inicio federado se probó con un proveedor simulado. La tabla y el árbol siguientes describen la arquitectura objetivo.

## Arquitectura objetivo para equipos de 8 GB

| Capa | Tecnología | Rol / Arquitectura |
| :--- | :--- | :--- |
| **Backend 1 (Principal)** | TypeScript + NestJS | **Arquitectura Hexagonal** · Auth (Local NIST/Argon2id + MFA TOTP + OIDC Google/Microsoft/DevMock), RBAC 3 roles, Motos, Mantenimientos, Gastos, Facturas, Talleres/SKU, Redis Cache-Aside, Circuit Breaker (`opossum`) + `worker_threads`. |
| **Backend 2** | Java 21 + Spring Boot 3 | **Arquitectura MVC** · Notificaciones, Recordatorios (`@Scheduled`), Documentos (MongoDB), RabbitMQ consumer, Reportes PDF/CSV + `ThreadPoolTaskExecutor`. |
| **Backend 3** | Python 3.13 + FastAPI | **Servicio Monolítico ML Paralelo** · Analítica OLAP (ClickHouse) + Predicción de mantenimiento y costos (`scikit-learn`) paralelizado con `ProcessPoolExecutor` / `joblib` + benchmark secuencial vs paralelo. |
| **Frontend Web** | React + Vite + TypeScript + Tailwind | Desplegado en `infra/compose.apps.yml` (Nginx sin privilegios). |
| **App Móvil (APK)** | React Native (Expo + TypeScript) | Fuera de Docker · Paridad funcional para los 3 roles + modo offline con sincronización idempotente. APK publicado en **GitHub Releases**. |
| **5 Motores de Datos** | `infra/compose.datos.yml` | **PostgreSQL 16** (SQL ACID) · **MongoDB 7** (Documental) · **Redis 7** (Clave-Valor) · **Cassandra 4** (Columnas Anchas) · **ClickHouse 24.8** (Analítica OLAP). |

---

## Estructura del Monorepo

```text
MOTOSYS-PROYECTO-/
├── infra/
│   ├── compose.datos.yml           # 5 motores de datos (red externa: motosys_net)
│   ├── compose.apps.yml            # 3 backends + RabbitMQ + OIDC dev + Web
│   ├── .env.example                # Plantilla de variables sin secretos
│   ├── init/                       # Scripts de inicialización SQL, CQL, Mongo, ClickHouse
│   └── scripts/                    # init-network, seed-all, backup/restore
├── services/
│   ├── core-nestjs/                # Backend 1: TS + NestJS (Hexagonal)
│   ├── notify-java/                # Backend 2: Java 21 + Spring Boot 3 (MVC)
│   └── analytics-python/           # Backend 3: Python 3.13 + FastAPI (OLAP + ML)
├── clients/
│   ├── web/                        # Frontend Web (React + TS + Tailwind)
│   └── mobile/                     # App Móvil Android APK (React Native Expo)
├── tests/                          # Suite de >=14 pruebas automatizadas
└── docs/
    ├── plan-arquitectura.md        # Plan de implementación completo
    ├── openapi/                    # Contratos OpenAPI v3 de los 3 backends
    └── diagrams/                   # Diagramas C4, Hexagonal y despliegue
```

---

## Flujo de Trabajo en GitHub (Equipo)

1. Crear ramas por funcionalidad con prefijo del integrante para registrar aportes verificables:
   - `feat/fabian-<modulo>`
   - `feat/jorge-<modulo>`
2. Integrar a `main` mediante Pull Request o merge limpio.
3. **Nunca** subir archivos `.env`, contraseñas, `node_modules/`, `target/`, `.venv/` ni `.apk` en el árbol de Git.
4. Para la entrega final (**25 de noviembre de 2026**):
   - Crear etiqueta `git tag v1.0.0 && git push origin v1.0.0`.
   - Adjuntar el archivo `motosys-v1.0.0.apk` en **GitHub Releases** bajo `v1.0.0`.
   - Subir a Moodle exactamente esa misma versión (ZIP, PDF + editable del informe, APK y enlace + commit/tag).


Consulta [la verificación de datos y núcleo HTTP](docs/fases-1b-2.md) para el arranque del servicio, las variables y las pruebas de estas fases.

Consulta [el cierre del núcleo y el servicio Java](docs/fases-2b-3.md) para las fases 2B y 3.

[Arranque HTTPS, analítica, respaldo y carga](docs/fases-4-5.md) para las fases 4 y 5.
