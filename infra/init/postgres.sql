CREATE TABLE workshops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  document_id text NOT NULL UNIQUE
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  password_hash text,
  role text NOT NULL DEFAULT 'RIDER',
  workshop_id uuid REFERENCES workshops,
  CHECK (
    (role = 'WORKSHOP_ADMIN' AND workshop_id IS NOT NULL)
    OR (role IN ('SUPER_ADMIN', 'RIDER') AND workshop_id IS NULL)
  )
);

CREATE TABLE motorcycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users,
  workshop_id uuid REFERENCES workshops,
  plate text NOT NULL UNIQUE CHECK (plate = upper(btrim(plate))),
  make text NOT NULL,
  model text NOT NULL,
  odometer_km integer NOT NULL DEFAULT 0 CHECK (odometer_km >= 0)
);

CREATE TABLE vehicle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  motorcycle_id uuid NOT NULL REFERENCES motorcycles,
  actor_id uuid NOT NULL REFERENCES users,
  kind text NOT NULL CHECK (kind IN ('MAINTENANCE', 'EXPENSE')),
  category text NOT NULL,
  description text NOT NULL,
  amount_cop bigint NOT NULL CHECK (amount_cop >= 0),
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  UNIQUE (actor_id, kind, idempotency_key)
);

CREATE INDEX vehicle_events_motorcycle_date ON vehicle_events (motorcycle_id, occurred_at DESC);

CREATE TABLE user_documents (
  user_id uuid NOT NULL REFERENCES users,
  document_type text NOT NULL CHECK (document_type = upper(btrim(document_type))),
  jurisdiction text NOT NULL CHECK (jurisdiction = upper(btrim(jurisdiction))),
  document_number text NOT NULL CHECK (document_number = upper(btrim(document_number))),
  PRIMARY KEY (document_type, jurisdiction, document_number),
  UNIQUE (user_id, document_type, jurisdiction)
);

CREATE TABLE workshop_products (
  workshop_id uuid NOT NULL REFERENCES workshops,
  sku text NOT NULL CHECK (sku <> '' AND sku = upper(btrim(sku))),
  name text NOT NULL,
  PRIMARY KEY (workshop_id, sku)
);

CREATE TABLE service_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES workshops,
  motorcycle_id uuid NOT NULL REFERENCES motorcycles,
  series text NOT NULL CHECK (series <> '' AND series = upper(btrim(series))),
  invoice_number bigint NOT NULL CHECK (invoice_number > 0),
  amount_cop bigint NOT NULL CHECK (amount_cop >= 0),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workshop_id, series, invoice_number)
);