CREATE TABLE IF NOT EXISTS motosys.fact_vehicle_events (
  event_id UUID,
  motorcycle_id UUID,
  owner_id UUID,
  workshop_id Nullable(UUID),
  make LowCardinality(String),
  kind LowCardinality(String),
  category LowCardinality(String),
  amount_cop UInt64,
  occurred_at DateTime64(3, 'UTC')
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (motorcycle_id, occurred_at, event_id);
