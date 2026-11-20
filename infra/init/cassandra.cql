CREATE KEYSPACE IF NOT EXISTS motosys WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};

CREATE TABLE IF NOT EXISTS motosys.odometer_readings_by_moto (
  motorcycle_id uuid,
  recorded_at timestamp,
  reading_id uuid,
  kilometers int,
  actor_id uuid,
  PRIMARY KEY ((motorcycle_id), recorded_at, reading_id)
) WITH CLUSTERING ORDER BY (recorded_at DESC, reading_id ASC);

CREATE TABLE IF NOT EXISTS motosys.audit_events_by_day (
  event_day date,
  event_id timeuuid,
  actor_id uuid,
  action text,
  subject_id text,
  outcome text,
  PRIMARY KEY ((event_day), event_id)
) WITH CLUSTERING ORDER BY (event_id DESC);
