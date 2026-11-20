"""Requires a running core and an isolated data project with real PostgreSQL and Redis."""
import base64
import hmac
import json
import os
import struct
import subprocess
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

URL = os.getenv("MOTO_TEST_CORE_URL")
PROJECT = os.getenv("MOTO_TEST_PROJECT")


@unittest.skipUnless(URL and PROJECT, "Set MOTO_TEST_CORE_URL and MOTO_TEST_PROJECT")
class CoreHTTP(unittest.TestCase):
    def call(self, path, body=None, token=None, **headers):
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(URL + path, json.dumps(body).encode() if body is not None else None, headers)
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            with error:
                return error.code, json.load(error)

    def sql(self, sql):
        return subprocess.run(
            ["docker", "exec", "-i", f"{PROJECT}-postgres-1", "psql", "-XqAt",
             "-U", "motosys", "-d", "motosys", "-v", "ON_ERROR_STOP=1"],
            input="SET lock_timeout = '5s'; " + sql, capture_output=True, text=True, check=True, timeout=20,
        ).stdout.strip()

    def cache(self, motorcycle):
        return subprocess.run(
            ["docker", "exec", f"{PROJECT}-redis-1", "redis-cli", "--raw",
             "GET", f"cache:vehicle-events:list:{motorcycle}"],
            capture_output=True, text=True, check=True, timeout=10,
        ).stdout.strip()

    def test_conflict_idempotency_scope_cache_and_logout(self):
        suffix = uuid4().hex
        email = f"core-{suffix}@example.invalid"
        other_email = f"other-{suffix}@example.invalid"
        password = f"contraseña de verificación {suffix}"
        credentials = {"email": email, "password": password}
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(
                lambda address: self.call("/auth/register", dict(credentials, email=address)),
                [email, " " + email.upper() + " "],
            ))
        self.assertEqual(sorted(status for status, _ in results), [201, 409], results)
        account = next(body for status, body in results if status == 201)
        other_status, other = self.call("/auth/register", dict(credentials, email=other_email))
        self.assertEqual(other_status, 201, other)
        self.addCleanup(self.sql, f"DELETE FROM users WHERE id IN ('{account['id']}','{other['id']}');")
        login_status, session = self.call("/auth/login", dict(credentials, client="mobile"))
        self.assertEqual(login_status, 201, session)
        token = session["accessToken"]
        _, other_session = self.call("/auth/login", dict(credentials, email=other_email, client="mobile"))
        other_token = other_session["accessToken"]
        motorcycle = self.sql(
            f"INSERT INTO motorcycles(owner_id, plate, make, model) "
            f"VALUES ('{account['id']}', '{suffix.upper()}', 'Moto', 'Test') RETURNING id;"
        )
        self.addCleanup(self.sql, f"DELETE FROM motorcycles WHERE id='{motorcycle}';")
        self.addCleanup(self.sql, f"DELETE FROM vehicle_events WHERE motorcycle_id='{motorcycle}';")
        self.addCleanup(self.sql, "DELETE FROM notification_outbox WHERE event_id IN "
                        f"(SELECT id FROM vehicle_events WHERE motorcycle_id='{motorcycle}');")
        path = f"/motorcycles/{motorcycle}/events"
        self.assertEqual(self.call(path, token=other_token)[0], 403)
        self.assertEqual(self.call(path, token=token), (200, []))
        self.assertEqual(self.call(path, token=token), (200, []))
        self.assertEqual(json.loads(self.cache(motorcycle))["events"], [])
        event = {"kind": "MAINTENANCE", "category": "Aceite", "description": "Cambio",
                 "amountCop": 12000, "occurredAt": "2026-11-20T15:00:00Z"}
        headers = {"Idempotency-Key": suffix}
        created, record = self.call(path, event, token, **headers)
        self.assertEqual(created, 201, record)
        self.assertEqual(self.cache(motorcycle), "")
        self.assertEqual(self.call(path, event, token, **headers),
                         (200, {"status": "replayed", "eventId": record["eventId"]}))
        self.assertEqual(self.call(path, dict(event, amountCop=13000), token, **headers)[0], 409)
        listed_status, listed = self.call(path, token=token)
        self.assertEqual(listed_status, 200, listed)
        self.assertEqual([item["id"] for item in listed], [record["eventId"]])
        if os.getenv("MOTO_TEST_FALLBACK"):
            for _ in range(20):
                if self.sql("SELECT 1 FROM notification_outbox WHERE delivered_at IS NOT NULL "
                            f"AND event_id='{record['eventId']}';") == "1":
                    break
                time.sleep(1)
            else:
                self.fail("El evento no fue entregado al fallback.")
        self.assertEqual(self.call("/auth/logout", {}, token)[0], 201)
        self.assertEqual(self.call(path, token=token)[0], 401)


    @unittest.skipUnless(os.getenv("MOTO_TEST_CORE_CONTAINER"), "Set MOTO_TEST_CORE_CONTAINER")
    def test_admin_requires_fresh_totp(self):
        suffix = uuid4().hex
        email = f"admin-{suffix}@example.invalid"
        credentials = {"email": email, "password": f"contraseña de verificación {suffix}"}
        status, account = self.call("/auth/register", credentials)
        self.assertEqual(status, 201, account)
        self.addCleanup(self.sql, f"DELETE FROM users WHERE id='{account['id']}';")
        self.sql(f"UPDATE users SET role='SUPER_ADMIN' WHERE id='{account['id']}';")
        login = dict(credentials, client="mobile")
        self.assertEqual(self.call("/auth/login", login)[0], 401)
        provision = subprocess.run(
            ["docker", "exec", os.environ["MOTO_TEST_CORE_CONTAINER"], "node", "src/provision-totp.mjs", email],
            capture_output=True, text=True, check=True, timeout=20,
        )
        secret = parse_qs(urlsplit(provision.stdout.strip()).query)["secret"][0]
        key = base64.b32decode(secret + "=" * (-len(secret) % 8))
        if int(time.time()) % 30 >= 28:
            time.sleep(3)
        digest = hmac.digest(key, struct.pack(">Q", int(time.time()) // 30), "sha1")
        offset = digest[-1] & 15
        number = int.from_bytes(digest[offset:offset + 4], "big") & 0x7fffffff
        code = f"{number % 1000000:06}"
        status, session = self.call("/auth/login", dict(login, totp=code))
        self.assertEqual(status, 201, session)
        self.assertEqual(self.call("/admin/cache-metrics", token=session["accessToken"])[0], 200)
        self.assertEqual(self.call("/auth/login", dict(login, totp=code))[0], 401)