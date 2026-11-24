import os
from asyncio import Semaphore
from types import SimpleNamespace
import time
from datetime import datetime, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import allowed
from app.ml import benchmark, recommend
from app.main import app, get_account


def test_role_scope_checks_current_assignments():
    motorcycle = {"owner_id": "rider", "workshop_id": "shop"}
    assert allowed({"role": "RIDER", "id": "rider"}, motorcycle)
    assert not allowed({"role": "RIDER", "id": "other"}, motorcycle)
    assert allowed({"role": "WORKSHOP_ADMIN", "workshop_id": "shop"}, motorcycle)
    assert not allowed({"role": "WORKSHOP_ADMIN", "workshop_id": "elsewhere"}, motorcycle)
    assert not allowed({"role": "WORKSHOP_ADMIN", "workshop_id": None}, dict(motorcycle, workshop_id=None))
    assert allowed({"role": "SUPER_ADMIN"}, motorcycle)


def test_parallel_benchmark_predicts_same_values():
    result = benchmark(200, 2)
    assert result["random_state"] == 42
    assert result["matching_predictions"]
    assert result["sequential_ms"] > 0
    assert result["parallel_ms"] > 0


def test_recommendation_uses_actual_history():
    assert recommend([])["source"] == "catalog_baseline"
    rows = [{"date": f"2026-0{month}-01 00:00:00.000", "amount_cop": 60000} for month in range(1, 7)]
    prediction = recommend(rows)
    assert prediction["expected_cost_cop"] == 60000
    assert prediction["history_events"] == 6
    assert prediction["source"] == "ml_random_forest"
    last = datetime(2026, 6, 1, tzinfo=timezone.utc).date().isoformat()
    assert prediction["next_maintenance_date"] > last


def test_openapi_exposes_olap_recommendations_and_benchmark():
    spec = app.openapi()
    assert spec["openapi"].startswith("3.")
    assert "/analytics/motorcycles/{motorcycle_id}/recommendation" in spec["paths"]
    assert "post" in spec["paths"]["/analytics/ml/benchmark"]


def test_catalog_requires_auth_and_returns_curated_models(monkeypatch):
    client = TestClient(app)
    try:
        assert client.get("/analytics/catalog").status_code == 401
        monkeypatch.setitem(app.dependency_overrides, get_account, lambda: {"role": "RIDER", "id": "rider"})
        response = client.get("/analytics/catalog")
    finally:
        client.close()
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == len({(row["make"], row["model"]) for row in rows}) == 36
    assert any(row["make"] == "Honda" and row["model"] == "CB125F" for row in rows)
    assert all(row["oil_interval_km"] > 0 and row["expected_cost_cop"] > 0 for row in rows)


def test_recommendation_without_history_uses_reference_date_and_cost():
    from datetime import date, timedelta

    prediction = recommend([], {"make": "HONDA", "model": "cb 125f", "odometer_km": 8000})
    assert prediction["next_maintenance_date"] == (date.today() + timedelta(days=90)).isoformat()
    assert prediction["model_reference"] == "Honda CB125F"
    assert prediction["expected_cost_cop"] == 65000
    assert prediction["recommended_km_interval"] == 3000


@pytest.mark.parametrize("count,source", [(2, "catalog_baseline"), (6, "ml_random_forest")])
def test_recommendation_http_returns_expected_source(monkeypatch, count, source):
    async def fetchrow(*_args):
        return {"owner_id": "rider", "workshop_id": None, "make": "Honda", "model": "CB125F", "odometer_km": 8000}

    async def query(*_args, **_kwargs):
        return [{"date": f"2026-0{month}-01 00:00:00", "amount_cop": 65000} for month in range(count, 0, -1)]

    monkeypatch.setitem(app.dependency_overrides, get_account, lambda: {"role": "RIDER", "id": "rider"})
    monkeypatch.setattr(app.state, "pg", SimpleNamespace(fetchrow=fetchrow), raising=False)
    monkeypatch.setattr(app.state, "olap", SimpleNamespace(query=query), raising=False)
    monkeypatch.setattr(app.state, "ml_gate", Semaphore(1), raising=False)
    client = TestClient(app)
    try:
        response = client.get("/analytics/motorcycles/12345678-1234-4321-9876-123456789abc/recommendation")
    finally:
        client.close()

    assert response.status_code == 200, response.text
    prediction = response.json()
    assert prediction["source"] == source
    assert prediction["history_events"] == count
    assert prediction["model_reference"] == "Honda CB125F"
    assert prediction["recommended_km_interval"] == 3000
    if count == 2:
        assert prediction["next_maintenance_date"] == "2026-05-02"


@pytest.mark.skipif(not os.getenv("MOTOSYS_DEMO_PASSWORD"), reason="Requiere Compose inicializado")
def test_e2e_reads_real_clickhouse_and_revokes_redis_session():
    password = os.environ["MOTOSYS_DEMO_PASSWORD"]
    core = os.getenv("MOTO_E2E_CORE", "http://core-nestjs:3000")
    analytics = os.getenv("MOTO_E2E_ANALYTICS", "http://127.0.0.1:3002")
    with httpx.Client(timeout=12) as http:
        def login(email):
            response = http.post(core + "/auth/login",
                                 json={"email": email, "password": password, "client": "mobile"})
            response.raise_for_status()
            return {"Authorization": "Bearer " + response.json()["accessToken"]}

        rider = login("demo.rider@example.invalid")
        other = login("demo.other@example.invalid")
        motorcycle = http.get(core + "/motorcycles", headers=rider).json()[0]["id"]
        path = analytics + f"/analytics/motorcycles/{motorcycle}"
        result = http.get(path + "/tco", headers=rider)
        assert result.status_code == 200, result.text
        assert result.json()["events"] >= 9
        assert http.get(path + "/tco", headers=other).status_code == 403
        counts = http.get(path + "/maintenance", headers=rider).json()
        assert counts["preventive"] >= 5 and counts["corrective"] >= 3
        grouping = http.get(analytics + "/analytics/monthly", headers=rider,
                            params={"dimension": "make", "since": "2026-01-01", "until": "2027-01-01"})
        assert grouping.status_code == 200, grouping.text
        assert {row["bucket"] for row in grouping.json()} == {"Honda"}
        result = http.get(path + "/recommendation", headers=rider)
        assert result.status_code == 200, result.text
        assert result.json()["expected_cost_cop"] > 0
        assert http.post(analytics + "/analytics/ml/benchmark", headers=rider, json={}).status_code == 403
        assert http.post(core + "/auth/logout", headers=rider, json={}).status_code == 201
        assert http.get(path + "/tco", headers=rider).status_code == 401

@pytest.mark.skipif(not os.getenv("MOTOSYS_TEST_ADMIN_TOTP"), reason="Requiere superadministrador demo")
def test_admin_benchmark_over_http():
    import base64
    import hmac
    import struct

    secret = os.environ["MOTOSYS_TEST_ADMIN_TOTP"]
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    if int(time.time()) % 30 >= 28:
        time.sleep(3)
    digest = hmac.digest(key, struct.pack(">Q", int(time.time()) // 30), "sha1")
    offset = digest[-1] & 15
    code = (int.from_bytes(digest[offset:offset+4], "big") & 0x7fffffff) % 1000000
    with httpx.Client(timeout=15) as http:
        login = http.post(os.getenv("MOTO_E2E_CORE", "http://core-nestjs:3000") + "/auth/login", json={
            "email": "phase45.admin@example.invalid", "password": os.environ["MOTOSYS_ADMIN_PASSWORD"],
            "client": "mobile", "totp": f"{code:06d}",
        })
        assert login.status_code == 201
        token = login.json()["accessToken"]
        outcome = http.post(os.getenv("MOTO_E2E_ANALYTICS", "http://127.0.0.1:3002") + "/analytics/ml/benchmark",
                            json={"samples": 1200, "workers": 2},
                            headers={"Authorization": "Bearer " + token})
        assert outcome.status_code == 200, outcome.text
        result = outcome.json()
        assert result["matching_predictions"]
        print("Benchmark:", result)