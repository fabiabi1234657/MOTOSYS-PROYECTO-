"""Exercise the phased Compose services against disposable test databases."""
import hashlib
import json
import os
import secrets
import subprocess
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import test_core_http

CORE = os.getenv("MOTO_TEST_CORE_URL")
NOTIFY = os.getenv("MOTO_TEST_NOTIFY_URL")
PROJECT = os.getenv("MOTO_TEST_PROJECT")
CORE_CONTAINER = os.getenv("MOTO_TEST_CORE_CONTAINER")


def request(url, path, body=None, token=None, method=None, headers=None):
    headers = dict(headers or {})
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = Request(url + path, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=12) as response:
            data = response.read()
            if response.headers.get_content_type() == "application/json":
                data = json.loads(data)
            return response.status, data
    except HTTPError as error:
        with error:
            return error.code, error.read()


@unittest.skipUnless(CORE and PROJECT, "Configure MOTO_TEST_CORE_URL and MOTO_TEST_PROJECT")
class Phase2B(unittest.TestCase):
    def sql(self, statement):
        return test_core_http.CoreHTTP().sql(statement)

    def core(self, path, body=None, token=None, **kwargs):
        return request(CORE, path, body, token, **kwargs)

    def docker(self, container, *args):
        return subprocess.run(
            ["docker", "exec", container, *args], capture_output=True,
            check=True, text=True, timeout=20,
        ).stdout.strip()

    def create_rider(self):
        email = f"phase-{uuid4().hex}@example.invalid"
        credentials = {"email": email, "password": "Una frase larga de verificación " + uuid4().hex}
        status, account = self.core("/auth/register", credentials)
        self.assertEqual(status, 201, account)
        status, session = self.core("/auth/login", dict(credentials, client="mobile"))
        self.assertEqual(status, 201, session)
        return credentials, account, session["accessToken"]

    def motorcycle(self, token):
        plate = uuid4().hex[:8]
        data = {"plate": " " + plate + " ", "make": "MotoSys", "model": "Phase"}
        status, moto = self.core("/motorcycles", data, token)
        self.assertEqual(status, 201, moto)
        self.assertEqual(moto["plate"], plate.upper())
        self.assertEqual(self.core("/motorcycles", dict(data, plate=plate.upper()), token)[0], 409)
        return moto["id"]

    def test_odometer_scope_and_projection(self):
        _, _, token = self.create_rider()
        motorcycle = self.motorcycle(token)
        path = f"/motorcycles/{motorcycle}/odometer"
        self.assertEqual(self.core(path, {"kilometers": 8100}, token, method="PATCH")[0], 200)
        self.assertEqual(self.core(path, {"kilometers": 8000}, token, method="PATCH")[0], 409)
        self.assertEqual(self.core("/admin/audit", token=token)[0], 403)
        if os.getenv("MOTO_TEST_CROSS_STORE"):
            for _ in range(25):
                if self.sql("SELECT 1 FROM projection_outbox WHERE kind='odometer' AND delivered_at IS NOT NULL "
                            f"AND payload->>'motorcycleId'='{motorcycle}'") == "1":
                    break
                time.sleep(1)
            else:
                self.fail("No se confirmó la proyección del odómetro.")
            reader = """
              import cassandra from 'cassandra-driver';
              const client = new cassandra.Client({contactPoints:[process.env.CASSANDRA_HOST],
                localDataCenter:process.env.CASSANDRA_DC,keyspace:'motosys'});
              try {
                const result=await client.execute('SELECT kilometers FROM odometer_readings_by_moto WHERE motorcycle_id=?',
                  [cassandra.types.Uuid.fromString(process.argv[1])],{prepare:true});
                console.log(result.first().kilometers);
              } finally { await client.shutdown(); }
            """
            rows = self.docker(CORE_CONTAINER, "node", "--input-type=module", "-e", reader, motorcycle)
            self.assertIn("8100", rows)

    def test_password_reset_consumes_token_and_revokes_existing_session(self):
        credentials, account, token = self.create_rider()
        reset = secrets.token_urlsafe(32)
        key = "password-reset:" + hashlib.sha256(reset.encode()).hexdigest()
        self.assertEqual(self.docker(
            f"{PROJECT}-redis-1", "redis-cli", "SET", key,
            json.dumps({"id": account["id"], "version": 0}), "EX", "900",
        ), "OK")
        password = "Una nueva frase larga para MotoSys " + uuid4().hex
        form = {"token": reset, "password": password}
        self.assertEqual(self.core("/auth/password-reset/confirm", form)[0], 201)
        self.assertEqual(self.core("/auth/password-reset/confirm", form)[0], 400)
        self.assertEqual(self.core("/motorcycles", token=token)[0], 401)
        self.assertEqual(self.core("/auth/login", dict(credentials, client="mobile"))[0], 401)
        self.assertEqual(self.core("/auth/login", dict(credentials, password=password, client="mobile"))[0], 201)

    @unittest.skipUnless(NOTIFY and CORE_CONTAINER, "Configure the Java service and Core container")
    def test_java_reads_session_and_deduplicates_http_and_rabbitmq(self):
        _, account, token = self.create_rider()
        motorcycle = self.motorcycle(token)
        _, _, outsider = self.create_rider()
        def java(path, body=None, bearer=token, **kwargs):
            return request(NOTIFY, path, body, bearer, **kwargs)

        event_form = {"kind": "MAINTENANCE", "category": "Aceite", "description": "Filtro",
                      "amountCop": 12000, "occurredAt": "2026-11-20T15:00:00Z"}
        status, registered = self.core(f"/motorcycles/{motorcycle}/events", event_form, token,
                                       headers={"Idempotency-Key": uuid4().hex})
        self.assertEqual(status, 201, registered)
        event = {"id": registered["eventId"], "kind": "MAINTENANCE",
                 "motorcycle_id": motorcycle, "actor_id": account["id"]}
        for _ in range(25):
            status, rows = java("/notifications")
            self.assertEqual(status, 200, rows)
            if event["id"] in [row["id"] for row in rows]:
                break
            time.sleep(1)
        else:
            self.fail("Java no recibió el evento del núcleo.")
        for _ in range(25):
            if self.sql("SELECT 1 FROM projection_outbox WHERE kind='analytics' AND delivered_at IS NOT NULL "
                        f"AND payload->>'event_id'='{event['id']}'") == "1":
                break
            time.sleep(1)
        else:
            self.fail("ClickHouse no confirmó la ingesta.")
        service_token = self.docker(CORE_CONTAINER, "printenv", "NOTIFICATIONS_TOKEN")
        self.assertEqual(java("/internal/notifications/events", event, bearer=service_token,
                              headers={"Idempotency-Key": event["id"]})[0], 200)
        self.assertEqual(java("/internal/notifications/events", event,
                              headers={"Idempotency-Key": event["id"]})[0], 401)
        queue_event = dict(event, id=str(uuid4()))
        publisher = """
          import amqp from 'amqplib';
          const connection=await amqp.connect(process.env.RABBITMQ_URL);
          const channel=await connection.createConfirmChannel();
          for (const event of JSON.parse(process.argv[1])) {
            channel.sendToQueue('motosys.notifications',Buffer.from(JSON.stringify(event)),{messageId:event.id,persistent:true});
          }
          await channel.waitForConfirms();
          await connection.close();
        """
        self.docker(CORE_CONTAINER, "node", "--input-type=module", "-e", publisher, json.dumps([event, queue_event]))
        for _ in range(15):
            _, rows = java("/notifications")
            if queue_event["id"] in [row["id"] for row in rows]:
                break
            time.sleep(1)
        else:
            self.fail("El consumidor RabbitMQ no guardó el evento.")
        self.assertEqual([row["id"] for row in rows].count(event["id"]), 1)

        path = f"/documents/{motorcycle}"
        multipart = (b'--proof\r\nContent-Disposition: form-data; name="file"; filename="proof.txt"\r\n'
                     b'Content-Type: text/plain\r\n\r\nMotoSys\r\n--proof--\r\n')
        headers = {"Content-Type": "multipart/form-data; boundary=proof"}
        status, metadata = java(path, multipart, headers=headers)
        self.assertEqual(status, 201, metadata)
        self.assertEqual(java(path, multipart, headers=headers)[0], 409)
        self.assertEqual(java(path, bearer=outsider)[0], 403)
        self.assertEqual(java(path + "/" + metadata["id"]), (200, b"MotoSys"))
        self.assertEqual(java(f"/reports/motorcycles/{motorcycle}/csv")[0], 200)
        self.assertTrue(java(f"/reports/motorcycles/{motorcycle}/pdf")[1].startswith(b"%PDF"))
        status, reminder = java("/reminders", {"motorcycleId": motorcycle, "kilometers": 0})
        self.assertEqual(status, 201, reminder)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            _, rows = java("/notifications")
            if "reminder:" + reminder["id"] in [row["id"] for row in rows]:
                break
            time.sleep(1)
        else:
            self.fail("El planificador no notificó el recordatorio de odómetro.")
        self.assertEqual(self.core("/auth/logout", {}, token)[0], 201)
        self.assertEqual(java("/notifications")[0], 401)

