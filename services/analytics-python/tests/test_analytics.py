import os
import time
from datetime import datetime, timezone

import httpx
import pytest

from app.auth import allowed
from app.ml import benchmark, recommend
from app.main import app


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
    assert recommend([]) is None
    rows = [{"date": f"2026-0{month}-01 00:00:00.000", "amount_cop": 60000} for month in range(1, 7)]
    prediction = recommend(rows)
    assert prediction["expected_cost_cop"] == 60000
    assert prediction["history_events"] == 6
    last = datetime(2026, 6, 1, tzinfo=timezone.utc).date().isoformat()
    assert prediction["next_maintenance_date"] > last


def test_openapi_exposes_olap_recommendations_and_benchmark():
    spec = app.openapi()
    assert spec["openapi"].startswith("3.")
    assert "/analytics/motorcycles/{motorcycle_id}/recommendation" in spec["paths"]
    assert "post" in spec["paths"]["/analytics/ml/benchmark"]


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