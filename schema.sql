-- Winnbell PostgreSQL Schema (Neon)
-- Run this once against your Neon database to create all tables.

CREATE TABLE IF NOT EXISTS "user" (
  id                SERIAL PRIMARY KEY,
  external_auth_id  TEXT,
  email             TEXT UNIQUE NOT NULL,
  full_name         TEXT,
  password_hash     TEXT,
  role              TEXT        NOT NULL DEFAULT 'User',
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  is_email_verified BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS business (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER REFERENCES "user"(id),
  name           TEXT    NOT NULL,
  sector         TEXT,
  description    TEXT,
  terms_text     TEXT,
  logo_url       TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT false,
  ticket_balance INTEGER NOT NULL DEFAULT 0,
  location       TEXT,
  latitude       DECIMAL(10, 8),
  longitude      DECIMAL(11, 8),
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
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
  status                TEXT      NOT NULL DEFAULT 'Issued',
  business_id           INTEGER REFERENCES business(id),
  location_id           INTEGER REFERENCES business_location(id),
  draw_id               INTEGER REFERENCES draw(id),
  activated_by_user_id  INTEGER REFERENCES "user"(id),
  activated_at          TIMESTAMP,
  batch_id              TEXT,
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
CREATE INDEX IF NOT EXISTS idx_ticket_code          ON ticket(code);
CREATE INDEX IF NOT EXISTS idx_ticket_draw_user     ON ticket(draw_id, activated_by_user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_business      ON ticket(business_id);
CREATE INDEX IF NOT EXISTS idx_bl_business          ON business_location(business_id);
CREATE INDEX IF NOT EXISTS idx_bl_manager           ON business_location(manager_user_id);
CREATE INDEX IF NOT EXISTS idx_draw_status          ON draw(status);
CREATE INDEX IF NOT EXISTS idx_ftu_user             ON free_ticket_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_push_sub_user        ON push_subscription(user_id);
