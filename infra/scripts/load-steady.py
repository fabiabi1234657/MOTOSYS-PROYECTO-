"""Exercise the HTTPS stack and sample Docker memory during the workload."""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import threading
import time
from urllib.request import Request, urlopen
from uuid import uuid4

UNITS = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}


def memory(text):
    match = re.fullmatch(r"([\d.]+)(B|KiB|MiB|GiB)", text.split("/")[0].strip())
    if not match:
        raise ValueError("Formato de memoria inesperado: " + text)
    return float(match[1]) * UNITS[match[2]] / 1024**2


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=20)


def load(config):
    context = ssl.create_default_context(cafile=config.cert)
    measurements = defaultdict(list)
    errors = defaultdict(int)
    lock = threading.Lock()
    password = os.environ["MOTOSYS_DEMO_PASSWORD"]

    def call(label, path, token=None, data=None, method=None, headers=None):
        headers = dict(headers or {})
        if token:
            headers["Authorization"] = "Bearer " + token
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = Request(config.url + path, json.dumps(data).encode() if data is not None else None,
                      headers, method=method)
        start = time.monotonic()
        try:
            with urlopen(req, context=context, timeout=12) as response:
                value = json.load(response)
            with lock:
                measurements[label].append((time.monotonic() - start) * 1000)
            return value
        except (OSError, ValueError) as error:
            with lock:
                errors[f"{label}:{getattr(error, 'code', type(error).__name__)}"] += 1
            return None

    login = call("core.login", "/api/core/auth/login",
                 data={"email": "demo.rider@example.invalid", "password": password, "client": "mobile"})
    if not login:
        raise RuntimeError("No se pudo iniciar sesión por el proxy.")
    token = login["accessToken"]
    motorcycle = call("core.motos", "/api/core/motorcycles", token)[0]
    bike = motorcycle["id"]
    ids = []
    for project in (config.data_project, config.apps_project):
        ids.extend(docker("ps", "-q", "--filter", f"label=com.docker.compose.project={project}").split())
    if len(ids) != 10:
        raise RuntimeError(f"Se esperaban diez contenedores en los proyectos, hay {len(ids)}.")
    deadline = time.monotonic() + config.seconds
    peaks = {}
    total_peak = 0
    samples = 0
    trace = []

    def reader(number):
        sequence = 0
        while time.monotonic() < deadline:
            call("core.historial", f"/api/core/motorcycles/{bike}/events", token)
            call("java.notificaciones", "/api/notify/notifications", token)
            call("analytics.tco", f"/api/analytics/motorcycles/{bike}/tco", token)
            if sequence % 4 == number:
                call("analytics.mensual", "/api/analytics/monthly?dimension=category&since=2026-01-01&until=2027-01-01", token)
            if number == 0 and sequence % 10 == 0:
                call("analytics.ml", f"/api/analytics/motorcycles/{bike}/recommendation", token)
            sequence += 1
            time.sleep(0.6)

    def writer():
        kilometers = motorcycle["odometer_km"]
        while time.monotonic() < deadline:
            kilometers += 1
            call("core.odometro", f"/api/core/motorcycles/{bike}/odometer", token,
                 {"kilometers": kilometers}, method="PATCH")
            call("core.gasto", f"/api/core/motorcycles/{bike}/events", token,
                 {"kind": "EXPENSE", "category": "Carga", "description": "Muestra de carga sintética",
                  "amountCop": 2000, "occurredAt": "2026-11-20T18:00:00Z"},
                 headers={"Idempotency-Key": uuid4().hex})
            time.sleep(3)

    with ThreadPoolExecutor(max_workers=3) as executor:
        jobs = [executor.submit(reader, 0), executor.submit(reader, 1), executor.submit(writer)]
        while time.monotonic() < deadline:
            snapshot = {}
            for line in docker("stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}", *ids).splitlines():
                name, usage = line.split("|")
                snapshot[name] = round(memory(usage), 2)
                peaks[name] = max(peaks.get(name, 0), snapshot[name])
            total = sum(snapshot.values())
            total_peak = max(total_peak, total)
            samples += 1
            trace.append({"sample": samples, "total_mib": round(total, 2), "containers": snapshot})
            time.sleep(2)
        for job in jobs:
            job.result()
    states = docker("inspect", "--format", "{{.Name}}|{{.State.Status}}|{{.State.OOMKilled}}|{{.RestartCount}}", *ids).splitlines()
    results = {"duration_requested_s": config.seconds, "memory_samples": samples,
               "peak_simultaneous_mib": round(total_peak, 2), "peak_mib_by_container": peaks,
               "state": states, "errors": dict(errors),
               "routes": {route: {"ok": len(values), "p95_ms": round(sorted(values)[int((len(values)-1)*.95)], 2)}
                          for route, values in measurements.items()}, "trace": trace}
    Path(config.output).write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k,v in results.items() if k != "trace"}, indent=2))
    if errors or any(not state.endswith("|running|false|0") for state in states):
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://127.0.0.1:8443")
    parser.add_argument("--cert", default="infra/tls/localhost.crt")
    parser.add_argument("--data-project", default="motosys-datos")
    parser.add_argument("--apps-project", default="motosys-apps")
    parser.add_argument("--seconds", default=120, type=int)
    parser.add_argument("--output", default="docs/carga-fases-4-5.json")
    config = parser.parse_args()
    if config.seconds < 1:
        parser.error("--seconds debe ser positivo")
    load(config)
