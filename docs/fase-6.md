# Clientes y entrega de MotoSys

## Web desde cero

Desde la raíz, copia `infra/.env.example` a `infra/.env` y configura los secretos indicados en [la guía de infraestructura](fases-4-5.md). Con Docker Desktop en modo Linux:

```powershell
./infra/scripts/init-network.ps1
./infra/scripts/init-tls.ps1
docker compose --env-file infra/.env -f infra/compose.datos.yml up -d --wait
docker compose --env-file infra/.env -f infra/compose.datos.yml exec -T cassandra cqlsh -f /opt/motosys/schema.cql
Get-Content -Raw infra/init/core-auth.sql | docker compose --env-file infra/.env -f infra/compose.datos.yml exec -T postgres psql -U motosys -d motosys -v ON_ERROR_STOP=1
docker compose --env-file infra/.env -f infra/compose.apps.yml --profile notifications up -d --build --wait
python infra/scripts/seed-all.py --admin-email tu-correo@example.com
```

Abre `https://localhost:8443` con el certificado de esa instancia en tu almacén de confianza. Web, API y cookies comparten origen. Java admite la cookie únicamente en rutas de usuario y comprueba CSRF para mutaciones. Los callbacks OIDC registrados son `/auth/oidc/<proveedor>/callback`. Para recuperar contraseña desde esta Web, configura SMTP y apunta `RESET_PUBLIC_URL` al origen Web. En móvil se puede pegar el token del enlace de recuperación.

## Android

Expo SDK 54 usa React Native 0.81. Desde un teléfono, la URL debe ser un origen HTTPS accesible en la red, por ejemplo `https://motosys.tu-dominio.example:8443`. Configura `HTTPS_BIND` para exponer el puerto en LAN, monta con `TLS_DIRECTORY` un certificado válido para ese nombre o IP y usa una cadena que Android confíe. El certificado que genera el asistente local cubre localhost y 127.0.0.1. El cliente valida HTTPS.

```powershell
cd clients/mobile
npm ci
npm run typecheck
npm test
npx --no-install expo export --platform android --output-dir dist/android-js --max-workers 2
```

Para generar el instalable local, configura `ANDROID_HOME` con Android SDK 36, Build Tools 36.0.0, NDK 27.1.12297006 y CMake 3.22.1, y `JAVA_HOME` con un JDK. Desde `clients/mobile`:

```powershell
npx --no-install expo prebuild --platform android --no-install
cd android
.\gradlew.bat --no-daemon --no-parallel --max-workers=2 "-Dorg.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m" "-PreactNativeArchitectures=arm64-v8a" :app:assembleRelease
```

La compilación produjo `clients/mobile/android/app/build/outputs/apk/release/app-release.apk`. Se copió el instalable local a [artifacts/MotoSys-1.0.0-arm64.apk](../artifacts/MotoSys-1.0.0-arm64.apk). Apksigner verificó la firma v2. El paquete es `co.motosys.mobile`, versión 1.0.0, Android mínimo API 24 y destino API 36. SHA-256 `28F78B155B10FBE4A6B6CA5C72B10E406B56A82B992DC9DA798D7990438C5317`. La plantilla local usa la firma de desarrollo y la arquitectura ARM64, adecuada para verificación del cliente de demostración. El perfil EAS alternativo genera APK con `npx eas-cli build --platform android --profile preview` en una cuenta Expo configurada.

El APK compiló con dos trabajadores Gradle. ADB no detectó dispositivos conectados. La verificación en teléfono queda pendiente.

En Android el registro se guarda antes del envío. Al recuperar conexión se usa la misma clave idempotente. Un conflicto queda visible en la cola. La sesión usa SecureStore y los pendientes se separan por servidor y cuenta.

## Entrega

La fuente del informe es `informe-proyecto.md` y se exporta con `docs/tools/export-report.py` usando python-docx y ReportLab. El checklist de revisión contempla el commit de cada integrante, la etiqueta v1.0.0, la publicación del APK en Release y el ZIP exacto para Moodle. Esos pasos se coordinan por separado.


## Verificaciones de la entrega local

Edge en modo headless abrió la Web por HTTPS, inició sesión con un motociclista de prueba, consultó el historial, registró un mantenimiento, consultó Java con la cookie Web, rechazó la mutación sin CSRF y creó un recordatorio con CSRF. Consultó TCO y cerró la sesión. No se registraron errores de JavaScript. Las [capturas](evidence/) contienen datos ficticios. Los tres contratos [OpenAPI](openapi/) se exportaron desde el proxy.

El informe editable y el PDF incluyen 11 componentes, cinco figuras y la matriz de trazabilidad. La evidencia acumulada comprende 32 pruebas automatizadas previas y de esta fase más el recorrido Web en Edge. La federación real con Google y Microsoft, el correo con SMTP real, la instalación en un teléfono, la auditoría completa WCAG 2.2 AA y la validación física en un equipo de 8 GB requieren pruebas adicionales.