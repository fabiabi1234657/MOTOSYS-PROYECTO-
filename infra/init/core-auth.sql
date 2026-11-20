ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;

CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  event_id uuid PRIMARY KEY REFERENCES vehicle_events,
  queued_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS notification_outbox_pending
ON notification_outbox(queued_at) WHERE delivered_at IS NULL;
