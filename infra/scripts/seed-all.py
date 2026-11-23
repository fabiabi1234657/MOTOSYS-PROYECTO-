"""Seed test-only records through the running Docker Compose projects."""
import argparse
from datetime import datetime, timedelta, timezone
from getpass import getpass
import json
import os
import re
import subprocess
import uuid

NAMESPACE = uuid.UUID("93a02220-1450-45ef-a935-ddc31bcc1607")


def fixture_id(name):
    return str(uuid.uuid5(NAMESPACE, name))


def command(container, *args, data=None):
    result = subprocess.run(["docker", "exec", "-i", container, *args], input=data,
                            capture_output=True, text=True, encoding="utf-8", timeout=90)
    if result.returncode:
        status = next((line for line in result.stderr.splitlines() if re.fullmatch(r"[A-Z0-9]{5}", line)), "")
        message = f"Falló la carga en {container} (código {result.returncode} {status})."
        raise RuntimeError(message)
    return result.stdout.strip()


CORE_SEED = """
import pg from 'pg';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { encryptTotpSecret } from './src/totp-secret.mjs';
import { PasswordPolicy } from './src/domain/password-policy.ts';
const input = JSON.parse(await new Promise(resolve => {
  let data=''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data+=chunk; });
  process.stdin.on('end', () => resolve(data));
}));
const denylist = (process.env.PASSWORD_DENYLIST ?? '').split(',').filter(Boolean)
  .map(value => value.normalize('NFC').toLowerCase());
const policy = new PasswordPolicy(new Set(['password123456789','123456789012345','qwertyuiopasdfgh',...denylist]));
const hash = p => argon2.hash(policy.validate(p,false),
  {type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});
const demoHash = await hash(input.demoPassword);
const adminHash = input.admin ? await hash(input.admin.password) : null;
const db = new pg.Client({connectionString:process.env.DATABASE_URL});
await db.connect();
let enrollment;
try {
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(784549)");
  if (input.admin) {
    const exists = (await db.query("SELECT 1 FROM users WHERE role='SUPER_ADMIN' LIMIT 1")).rowCount;
    if (!exists) {
      const secret = authenticator.generateSecret(20);
      await db.query("INSERT INTO users(id,email,password_hash,role,totp_secret) VALUES ($1,$2,$3,'SUPER_ADMIN',$4)",
        [input.admin.id,input.admin.email,adminHash,encryptTotpSecret(secret,input.admin.id)]);
      enrollment = authenticator.keyuri(input.admin.email,'MotoSys',secret);
    }
  }
  await db.query("INSERT INTO workshops(id,name,document_id) VALUES ($1,'Taller Demo','DEMO-TALLER') ON CONFLICT(id) DO NOTHING",
    [input.workshop]);
  for (const rider of input.riders) {
    await db.query("INSERT INTO users(id,email,password_hash) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [rider.id,rider.email,demoHash]);
  }
  for (const bike of input.bikes) {
    await db.query("INSERT INTO motorcycles(id,owner_id,workshop_id,plate,make,model,odometer_km) VALUES ($1,$2,$3,$4,$5,'Demo',8000) ON CONFLICT(id) DO NOTHING",
      [bike.id,bike.owner,input.workshop,bike.plate,bike.make]);
  }
  for (const event of input.events) {
    await db.query("INSERT INTO vehicle_events(id,motorcycle_id,actor_id,kind,category,description,amount_cop,occurred_at,idempotency_key,request_hash) VALUES ($1,$2,$3,$4,$5,'Demo', $6,$7,$8,'seed') ON CONFLICT(id) DO NOTHING",
      [event.event_id,event.motorcycle_id,event.owner_id,event.kind,event.category,event.amount_cop,event.occurred_at,"seed:"+event.event_id]);
  }
  await db.query('COMMIT');
  if (enrollment) process.stdout.write(enrollment);
} catch(error) {
  await db.query('ROLLBACK');
  console.error(error.code ?? error.name);
  process.exitCode=1;
} finally {await db.end();}
"""


def seed(data_project, apps_project, admin_email):
    demo = os.getenv("MOTOSYS_DEMO_PASSWORD") or getpass("Contraseña para los dos motociclistas demo: ")
    admin = None
    if admin_email:
        if admin_email in ("demo.rider@example.invalid", "demo.other@example.invalid") or len(admin_email) > 254 or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", admin_email):
            raise ValueError("Usa un correo administrativo explícito distinto a los de demo.")
        admin = {"id": fixture_id("admin"), "email": admin_email,
                 "password": os.getenv("MOTOSYS_ADMIN_PASSWORD") or getpass("Contraseña inicial del administrador: ")}
    workshop = fixture_id("workshop")
    riders = [{"id": fixture_id(name), "email": f"demo.{name}@example.invalid"} for name in ("rider", "other")]
    bikes = [{"id": fixture_id("bike-" + str(i)), "owner": rider["id"],
              "plate": f"DEMO-{i+1}", "make": ("Honda", "Yamaha")[i]}
             for i, rider in enumerate(riders)]
    events = []
    for i, bike in enumerate(bikes):
        for j in range(9):
            date = datetime(2026, 1, 12, tzinfo=timezone.utc) + timedelta(days=j * 26)
            events.append({"event_id": fixture_id(f"event-{i}-{j}"), "motorcycle_id": bike["id"],
                           "owner_id": bike["owner"], "workshop_id": workshop, "make": bike["make"],
                           "kind": "EXPENSE" if j == 8 else "MAINTENANCE",
                           "category": "Combustible" if j == 8 else ("Preventivo" if j % 3 else "Correctivo"),
                           "amount_cop": (i+1)*40000 + 11000*j,
                           "occurred_at": date.isoformat(timespec="milliseconds")})
    enrollment = command(f"{apps_project}-core-nestjs-1", "node", "--input-type=module", "-e", CORE_SEED,
                         data=json.dumps({"demoPassword": demo, "admin": admin,
                                          "workshop": workshop, "riders": riders, "bikes": bikes, "events": events}))
    if enrollment:
        print("Enrolamiento TOTP inicial. Transfiere la URI al autenticador sin guardarla en los logs:")
        print(enrollment)

    notice = {"_id": events[0]["event_id"], "userId": riders[0]["id"], "motorcycleId": bikes[0]["id"],
              "kind": "MAINTENANCE"}
    mongo = 'const row=' + json.dumps(notice) + '; row.createdAt=new Date("2026-01-12"); db.notifications.updateOne({_id:row._id},{$setOnInsert:row},{upsert:true})'
    command(f"{data_project}-mongo-1", "sh", "-ec",
            'exec mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin motosys --eval "$1"',
            "motosys", mongo)
    command(f"{data_project}-redis-1", "redis-cli", "SET", "seed:demo:ready", "1", "EX", "86400")

    cql = f"""INSERT INTO motosys.odometer_readings_by_moto
    (motorcycle_id, recorded_at, reading_id, kilometers, actor_id)
    VALUES ({bikes[0]['id']},'2026-01-12T00:00:00Z',{fixture_id('reading')},8000,{riders[0]['id']}) IF NOT EXISTS;"""
    command(f"{data_project}-cassandra-1", "cqlsh", "--request-timeout=20", "-e", cql)
    clickhouse = f"{data_project}-clickhouse-1"
    cli = 'exec clickhouse-client --host 127.0.0.1 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --max_threads 2 --date_time_input_format best_effort'
    existing = set(command(clickhouse, "sh", "-ec", cli + ' --query "$1"', "motosys",
                           "SELECT event_id FROM motosys.fact_vehicle_events WHERE motorcycle_id IN (" +
                           ",".join("'" + bike["id"] + "'" for bike in bikes) + ")").splitlines())
    fresh = [json.dumps(event) for event in events if event["event_id"] not in existing]
    if fresh:
        command(clickhouse, "sh", "-ec", cli + ' --query "INSERT INTO motosys.fact_vehicle_events FORMAT JSONEachRow"',
                data="\n".join(fresh) + "\n")
    print("Datos demo listos en los cinco motores.")
    print(json.dumps({"bikes": bikes, "riders": riders}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-project", default="motosys-datos")
    parser.add_argument("--apps-project", default="motosys-apps")
    parser.add_argument("--admin-email", type=lambda value: value.strip().lower())
    config = parser.parse_args()
    seed(config.data_project, config.apps_project, config.admin_email)

