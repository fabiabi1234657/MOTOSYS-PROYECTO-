import cassandra from 'cassandra-driver';

const { Uuid, TimeUuid, LocalDate } = cassandra.types;

export function startProjections(db) {
  const host = process.env.CASSANDRA_HOST;
  const chUrl = process.env.CLICKHOUSE_URL;
  const cql = host ? new cassandra.Client({
    contactPoints: [host], localDataCenter: process.env.CASSANDRA_DC ?? 'datacenter1',
    keyspace: 'motosys', socketOptions: { connectTimeout: 2500, readTimeout: 3000 },
  }) : null;
  const enabled = [...(cql ? ['audit','odometer'] : []), ...(chUrl ? ['analytics'] : [])];

  async function project(row) {
    const p = row.payload;
    if (row.kind === 'odometer') {
      await cql.execute(`INSERT INTO odometer_readings_by_moto
        (motorcycle_id, recorded_at, reading_id, kilometers, actor_id) VALUES (?,?,?,?,?) IF NOT EXISTS`,
      [Uuid.fromString(p.motorcycleId), new Date(p.recordedAt), Uuid.fromString(p.readingId),
        p.kilometers, Uuid.fromString(p.actorId)], { prepare: true });
    } else if (row.kind === 'audit') {
      const seed = Buffer.from(row.id.replaceAll('-', ''), 'hex');
      const eventId = TimeUuid.fromDate(new Date(p.recordedAt), seed.readUInt16BE(8) % 10000,
        seed.subarray(0, 6), seed.subarray(6, 8));
      await cql.execute(`INSERT INTO audit_events_by_day
        (event_day,event_id,actor_id,action,subject_id,outcome) VALUES (?,?,?,?,?,?) IF NOT EXISTS`,
      [LocalDate.fromString(p.recordedAt.slice(0, 10)), eventId, Uuid.fromString(p.actorId),
        p.action, p.subjectId, p.outcome], { prepare: true });
    } else {
      const url = new URL(chUrl);
      url.searchParams.set('query', 'INSERT INTO motosys.fact_vehicle_events FORMAT JSONEachRow');
      url.searchParams.set('date_time_input_format', 'best_effort');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'X-ClickHouse-User': process.env.CLICKHOUSE_USER ?? 'motosys',
          'X-ClickHouse-Key': process.env.CLICKHOUSE_PASSWORD ?? '' },
        body: JSON.stringify(p), signal: AbortSignal.timeout(4000), redirect: 'error',
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error('ClickHouse rechazó la proyección.');
    }
  }

  let working;
  async function run() {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: [row] } = await client.query(`SELECT id, kind, payload FROM projection_outbox
        WHERE delivered_at IS NULL AND next_attempt <= now() AND kind=ANY($1)
        ORDER BY next_attempt, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [enabled]);
      if (row) {
        try {
          await project(row);
          await client.query('UPDATE projection_outbox SET delivered_at=now() WHERE id=$1', [row.id]);
        } catch {
          await client.query(`UPDATE projection_outbox SET next_attempt=now()+interval '10 seconds' WHERE id=$1`, [row.id]);
          process.stderr.write('Proyección pendiente de reintento.\n');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const timer = enabled.length ? setInterval(() => {
    if (working) return;
    working = run().catch(() => process.stderr.write('Outbox de proyecciones no disponible.\n'))
      .finally(() => { working = undefined; });
  }, 500) : null;
  timer?.unref();

  return {
    async auditReader(day) {
      if (!cql) throw Object.assign(new Error('Auditoría no disponible.'), { statusCode: 503 });
      const result = await cql.execute(`SELECT event_id,actor_id,action,subject_id,outcome
        FROM audit_events_by_day WHERE event_day=? LIMIT 100`, [LocalDate.fromString(day)], { prepare: true });
      return result.rows.map(row => ({
        eventId: row.event_id.toString(), actorId: row.actor_id.toString(),
        action: row.action, subjectId: row.subject_id, outcome: row.outcome,
      }));
    },
    async stop() {
      if (timer) clearInterval(timer);
      await working;
      if (cql) await cql.shutdown();
    },
  };
}
