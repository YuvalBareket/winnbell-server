-- Winnbell PostgreSQL Schema (Neon)
-- This file reflects the CURRENT desired state of the database.
-- For an existing database, run the migrations in /migrations/ instead.

CREATE TABLE IF NOT EXISTS "user" (
  id                SERIAL PRIMARY KEY,
  external_auth_id  TEXT,
  email             TEXT UNIQUE NOT NULL,
  full_name         TEXT,
  password_hash     TEXT,
  role              TEXT        NOT NULL DEFAULT 'User',
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  is_email_verified BOOLEAN     NOT NULL DEFAULT false,
  risk_score        INTEGER     NOT NULL DEFAULT 0,
  risk_clean_entries    INTEGER     NOT NULL DEFAULT 0,
  risk_last_flagged_at  TIMESTAMP   NULL,
  created_at        TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES "user"(id),
  name             TEXT    NOT NULL,
  sector           TEXT,
  description      TEXT,
  terms_text       TEXT,
  logo_url         TEXT,
  is_subscribed    BOOLEAN NOT NULL DEFAULT false,
  is_participating BOOLEAN NOT NULL DEFAULT false,
  entry_mode       VARCHAR(10) NOT NULL DEFAULT 'receipt',
  entry_cap        INTEGER NULL,
  min_transaction_amount NUMERIC(10,2) NULL,
  ticket_balance   INTEGER NOT NULL DEFAULT 0,
  location         TEXT,
  latitude         DECIMAL(10, 8),
  longitude        DECIMAL(11, 8),
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business_location (
  id               SERIAL PRIMARY KEY,
  business_id      INTEGER REFERENCES business(id) ON DELETE CASCADE,
  name             TEXT,
  address          TEXT,
  latitude         DECIMAL(10, 8),
  longitude        DECIMAL(11, 8),
  is_active        BOOLEAN NOT NULL DEFAULT true,
  manager_user_id  INTEGER REFERENCES "user"(id),
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS draw (
  id               SERIAL PRIMARY KEY,
  name             TEXT,
  prize_pool       DECIMAL(10, 2) NOT NULL DEFAULT 0,
  prize_percentage DECIMAL(5, 2)  NOT NULL DEFAULT 80,
  draw_date        TIMESTAMP,
  status           TEXT          NOT NULL DEFAULT 'Upcoming',
  winner_user_id   INTEGER REFERENCES "user"(id),
  winner_ticket_id INTEGER,
  closed_at        TIMESTAMP,
  created_at       TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS draw_entry (
  id                  SERIAL PRIMARY KEY,
  draw_id             INTEGER REFERENCES draw(id),
  business_id         INTEGER REFERENCES business(id),
  fee_at_entry        DECIMAL(10, 2),
  contribution_amount DECIMAL(10, 2),
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (draw_id, business_id)
);

CREATE TABLE IF NOT EXISTS ticket (
  id                    SERIAL PRIMARY KEY,
  code                  VARCHAR(8) UNIQUE NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'Issued',
  entry_source          VARCHAR(10) NOT NULL DEFAULT 'code',
  business_id           INTEGER REFERENCES business(id),
  location_id           INTEGER REFERENCES business_location(id),
  draw_id               INTEGER REFERENCES draw(id),
  activated_by_user_id  INTEGER REFERENCES "user"(id),
  activated_at          TIMESTAMP,
  batch_id              TEXT,
  -- v2 receipt-based entry fields (NULL in MVP)
  receipt_identifier    VARCHAR(255) NULL,
  transaction_amount    NUMERIC(10, 2) NULL,
  transaction_date      DATE NULL,
  receipt_image_url     VARCHAR(500) NULL,
  risk_score            INTEGER NOT NULL DEFAULT 0,
  -- quarantine: silences ticket from draw pool and cap count without deleting it
  is_quarantined        BOOLEAN   NOT NULL DEFAULT FALSE,
  quarantine_reason     TEXT      NULL,
  quarantined_at        TIMESTAMP NULL,
  image_validation_status VARCHAR(20) NOT NULL DEFAULT 'not_required',
  created_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS free_ticket_usage (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES "user"(id),
  activated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscription (
  id                     SERIAL PRIMARY KEY,
  business_id            INTEGER UNIQUE REFERENCES business(id),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id        TEXT,
  status                 TEXT          NOT NULL DEFAULT 'Incomplete',
  current_period_end     TIMESTAMP,
  cancel_at_period_end   BOOLEAN       NOT NULL DEFAULT false,
  fee_at_entry           DECIMAL(10, 2),
  created_at             TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_subscription (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES "user"(id),
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT,
  auth       TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_ticket_code              ON ticket(code);
CREATE INDEX IF NOT EXISTS idx_ticket_draw_user         ON ticket(draw_id, activated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_business          ON ticket(business_id);
CREATE INDEX IF NOT EXISTS idx_ticket_receipt           ON ticket(business_id, receipt_identifier);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_receipt_unique ON ticket(business_id, receipt_identifier) WHERE receipt_identifier IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ticket_quarantined       ON ticket(draw_id, is_quarantined);
CREATE INDEX IF NOT EXISTS idx_bl_business              ON business_location(business_id);
CREATE INDEX IF NOT EXISTS idx_bl_manager               ON business_location(manager_user_id);
CREATE INDEX IF NOT EXISTS idx_draw_status              ON draw(status);
CREATE INDEX IF NOT EXISTS idx_ftu_user                 ON free_ticket_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_push_sub_user            ON push_subscription(user_id);
