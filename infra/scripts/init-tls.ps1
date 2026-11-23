param([string]$Directory = (Join-Path $PSScriptRoot '../tls'))

$ErrorActionPreference = 'Stop'
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (!$openssl) {
    $gitOpenSsl = Join-Path $env:ProgramFiles 'Git/usr/bin/openssl.exe'
    if (Test-Path -LiteralPath $gitOpenSsl) { $openssl = $gitOpenSsl }
}
if (!$openssl) { throw 'OpenSSL no está disponible. Instala OpenSSL o Git para Windows.' }
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$certificate = Join-Path $Directory 'localhost.crt'
$key = Join-Path $Directory 'localhost.key'
if ((Test-Path $certificate) -and (Test-Path $key)) { return }
if ((Test-Path $certificate) -or (Test-Path $key)) { throw 'El par TLS existe parcialmente.' }
& $openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 -subj '/CN=localhost' `
    -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -keyout $key -out $certificate
if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar el certificado TLS.' }
if (!$IsWindows) { chmod 644 $key } # Docker dev mounts the dedicated key into a non-root container.

