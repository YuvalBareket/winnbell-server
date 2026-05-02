-- =============================================================================
-- Winnbell PostgreSQL Schema — Neon
-- =============================================================================
-- Fresh-install script. Pass the entire file to Neon to recreate the database.
-- Tables are defined in FK dependency order.
-- All enum-like columns are guarded with CHECK constraints.
-- Every frequently-queried column or FK has an explicit index.
-- =============================================================================


-- ── Users ─────────────────────────────────────────────────────────────────────

CREATE TABLE "user" (
  id                   SERIAL PRIMARY KEY,
  -- Clerk user ID for Clerk-managed accounts; NULL for local (email/password) accounts
  external_auth_id     TEXT UNIQUE,
  email                TEXT UNIQUE NOT NULL,
  full_name            TEXT,
  -- NULL for Clerk-managed accounts (password lives in Clerk)
  password_hash        TEXT,
  role                 TEXT NOT NULL DEFAULT 'User'
                         CHECK (role IN ('User', 'Business', 'Admin')),
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  is_email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Fraud risk scoring: 0–9 = low, 10–14 = medium (image required), 15+ = high (throttled + quarantined)
  risk_score           INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
  risk_clean_entries   INTEGER NOT NULL DEFAULT 0 CHECK (risk_clean_entries >= 0),
  risk_last_flagged_at TIMESTAMP NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Business ──────────────────────────────────────────────────────────────────

CREATE TABLE business (
  id                     SERIAL PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  name                   TEXT NOT NULL,
  sector                 TEXT,
  description            TEXT,
  terms_text             TEXT,
  logo_url               TEXT,
  receipt_example_image_url TEXT,
  is_subscribed          BOOLEAN NOT NULL DEFAULT FALSE,
  is_participating       BOOLEAN NOT NULL DEFAULT FALSE,
  -- entry_mode: 'receipt' = user submits receipt; 'code' = business generates codes
  entry_mode             VARCHAR(10) NOT NULL DEFAULT 'receipt'
                           CHECK (entry_mode IN ('receipt', 'code')),
  -- Per-business entry cap (set by Stripe tier on subscription activation).
  -- NULL = no per-business cap; the global cap from platform_settings still applies.
  entry_cap              INTEGER NULL CHECK (entry_cap IS NULL OR entry_cap > 0),
  min_transaction_amount NUMERIC(10, 2) NULL CHECK (min_transaction_amount IS NULL OR min_transaction_amount > 0),
  -- ticket_balance: tracks how many code-mode tickets have been issued (legacy MVP counter)
  ticket_balance         INTEGER NOT NULL DEFAULT 0 CHECK (ticket_balance >= 0),
  -- Legacy single-location fields (used by admin panel create flow).
  -- Multi-location businesses use the business_location table instead.
  location               TEXT,
  latitude               DECIMAL(10, 8),
  longitude              DECIMAL(11, 8),
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Business Locations ────────────────────────────────────────────────────────

CREATE TABLE business_location (
  id               SERIAL PRIMARY KEY,
  business_id      INTEGER NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  name             TEXT,
  address          TEXT,
  latitude         DECIMAL(10, 8),
  longitude        DECIMAL(11, 8),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Location manager (a Business-role user assigned via invite link)
  manager_user_id  INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
  -- Single-use invite token enforcement:
  -- SHA-256 hash of the JWT invite token; cleared on first redemption.
  invite_token_hash VARCHAR(64) NULL,
  invite_used_at   TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Draws ─────────────────────────────────────────────────────────────────────

CREATE TABLE draw (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  prize_pool       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (prize_pool >= 0),
  prize_percentage NUMERIC(5, 2)  NOT NULL DEFAULT 80
                     CHECK (prize_percentage > 0 AND prize_percentage <= 100),
  draw_date        TIMESTAMP NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Upcoming'
                     CHECK (status IN ('Upcoming', 'Open', 'Closed')),
  -- Populated by pickDrawWinnerService after the draw closes
  winner_user_id   INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
  winner_ticket_id INTEGER NULL,              -- FK added below after ticket table
  closed_at        TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Draw Entries (businesses enrolled in a draw) ──────────────────────────────

CREATE TABLE draw_entry (
  id                  SERIAL PRIMARY KEY,
  draw_id             INTEGER NOT NULL REFERENCES draw(id) ON DELETE CASCADE,
  business_id         INTEGER NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  -- Monthly subscription fee captured at enrolment time (for audit)
  fee_at_entry        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- Their share of the prize pool = fee_at_entry × prize_percentage / 100
  contribution_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (draw_id, business_id)
);


-- ── Tickets ───────────────────────────────────────────────────────────────────

CREATE TABLE ticket (
  id                      SERIAL PRIMARY KEY,
  -- 6-char (batch/code mode) or 8-char (receipt/free mode) alphanumeric code
  code                    VARCHAR(10) UNIQUE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'Issued'
                            CHECK (status IN ('Issued', 'Activated')),
  entry_source            VARCHAR(10) NOT NULL DEFAULT 'code'
                            CHECK (entry_source IN ('code', 'receipt', 'free', 'promo')),
  business_id             INTEGER REFERENCES business(id) ON DELETE RESTRICT,
  location_id             INTEGER REFERENCES business_location(id) ON DELETE SET NULL,
  draw_id                 INTEGER REFERENCES draw(id) ON DELETE RESTRICT,
  activated_by_user_id    INTEGER REFERENCES "user"(id) ON DELETE RESTRICT,
  activated_at            TIMESTAMP NULL,
  -- Batch ID for admin-generated code bundles (e.g. BATCH_42_1712345678901)
  batch_id                TEXT NULL,

  -- Receipt-entry fields (NULL for code/free/promo tickets) ──────────────────
  receipt_identifier      VARCHAR(255) NULL,
  transaction_amount      NUMERIC(10, 2) NULL CHECK (transaction_amount IS NULL OR transaction_amount > 0),
  transaction_date        DATE NULL,
  receipt_image_url       VARCHAR(500) NULL,
  -- Risk score snapshot at submission time (user score, not a running total)
  risk_score              INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
  -- Submitter IP captured at receipt submission (fraud ring detection)
  submitter_ip            INET NULL,

  -- Quarantine: ticket excluded from draw pool and cap count ─────────────────
  is_quarantined          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Reason codes: high_risk_user | ocr_pending | ocr_validation_failed |
  --               ocr_error_pending_review | shared_receipt_suspected
  quarantine_reason       TEXT NULL,
  quarantined_at          TIMESTAMP NULL,

  -- OCR validation lifecycle ──────────────────────────────────────────────────
  image_validation_status VARCHAR(20) NOT NULL DEFAULT 'not_required'
                            CHECK (image_validation_status IN
                              ('not_required', 'pending', 'passed', 'failed', 'ocr_error')),

  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Deferred FK: draw.winner_ticket_id → ticket.id (ticket table now exists)
ALTER TABLE draw
  ADD CONSTRAINT fk_draw_winner_ticket
  FOREIGN KEY (winner_ticket_id) REFERENCES ticket(id) ON DELETE SET NULL;


-- ── Free Ticket Usage (weekly free entry tracking) ────────────────────────────

CREATE TABLE free_ticket_usage (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  draw_id          INTEGER NULL REFERENCES draw(id) ON DELETE SET NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'approved'
                     CHECK (status IN ('approved', 'rejected')),
  rejection_reason VARCHAR(50) NULL,
  entries_created  SMALLINT NOT NULL DEFAULT 1,
  activated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Subscriptions ─────────────────────────────────────────────────────────────

CREATE TABLE subscription (
  id                     SERIAL PRIMARY KEY,
  business_id            INTEGER UNIQUE NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id        TEXT,
  status                 TEXT NOT NULL DEFAULT 'Incomplete'
                           CHECK (status IN ('Active', 'Trialing', 'Past_Due', 'Cancelled', 'Incomplete')),
  current_period_end     TIMESTAMP,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Monthly fee captured at subscription creation (used for draw contribution calculations)
  fee_at_entry           NUMERIC(10, 2) NULL,
  -- Stripe tier: number of entries the business can earn per location per draw
  entries_per_location   INTEGER NULL CHECK (entries_per_location IS NULL OR entries_per_location > 0),
  billing_interval       VARCHAR(10) NOT NULL DEFAULT 'monthly'
                           CHECK (billing_interval IN ('monthly', 'yearly')),
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Push Notification Subscriptions ──────────────────────────────────────────

CREATE TABLE push_subscription (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Refresh Tokens ─────────────────────────────────────────────────────────────

CREATE TABLE refresh_token (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  expires_at   TIMESTAMP NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Platform Settings (single-row config table) ───────────────────────────────

CREATE TABLE platform_settings (
  -- Always row id=1. Use ON CONFLICT (id) DO UPDATE to upsert.
  id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- NULL = no platform-wide cap; if the row is missing the app defaults to 500
  global_entry_cap INTEGER NULL CHECK (global_entry_cap IS NULL OR global_entry_cap > 0),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Seed the single settings row so SELECT always returns a result
INSERT INTO platform_settings (id, global_entry_cap)
VALUES (1, NULL);


-- ── Promotional Codes (admin-created registry) ────────────────────────────────

CREATE TABLE promotional_code (
  id         SERIAL PRIMARY KEY,
  -- 3-100 chars, letters/numbers/hyphens/underscores only (enforced in service layer)
  code       VARCHAR(100) NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL = unlimited redemptions; positive integer = hard cap
  max_uses   INTEGER NULL CHECK (max_uses IS NULL OR max_uses > 0),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Promotional Entries (one row per user per promo code) ─────────────────────

CREATE TABLE promotional_entry (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(100) NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  draw_id    INTEGER NOT NULL REFERENCES draw(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  -- One redemption per (code, user) pair — prevents same user using same code twice
  UNIQUE (code, user_id)
);


-- =============================================================================
-- Indexes
-- =============================================================================

-- ── ticket ────────────────────────────────────────────────────────────────────

-- Primary lookup: redeem flow (already unique, this is an explicit name for clarity)
CREATE INDEX idx_ticket_code
  ON ticket (code);

-- User's ticket list per draw (getMyTickets, pickWinner)
CREATE INDEX idx_ticket_draw_user
  ON ticket (draw_id, activated_by_user_id);

-- Business ticket list
CREATE INDEX idx_ticket_business_draw
  ON ticket (business_id, draw_id);

-- Cap enforcement: count non-quarantined tickets per business per draw
CREATE INDEX idx_ticket_cap_check
  ON ticket (business_id, draw_id, is_quarantined);

-- Receipt duplicate check + unique enforcement
-- Partial unique index: only one ticket per (business, receipt_identifier)
CREATE UNIQUE INDEX idx_ticket_receipt_unique
  ON ticket (business_id, receipt_identifier)
  WHERE receipt_identifier IS NOT NULL;

-- Quarantine filter (admin views, draw pool exclusion)
CREATE INDEX idx_ticket_quarantine
  ON ticket (draw_id, is_quarantined)
  WHERE is_quarantined = TRUE;

-- Velocity & throttle queries: COUNT by user + source + time window
CREATE INDEX idx_ticket_velocity
  ON ticket (activated_by_user_id, entry_source, activated_at);

-- Rapid submission signal: same user + business + time window
CREATE INDEX idx_ticket_rapid
  ON ticket (activated_by_user_id, business_id, entry_source, activated_at);

-- Sequential guessing signal: same user + business, recent
CREATE INDEX idx_ticket_sequential
  ON ticket (activated_by_user_id, business_id, activated_at);

-- Batch admin lookup
CREATE INDEX idx_ticket_batch
  ON ticket (batch_id)
  WHERE batch_id IS NOT NULL;

-- ── business ──────────────────────────────────────────────────────────────────

-- Participating business queries (map/search)
CREATE INDEX idx_business_participating
  ON business (is_subscribed, is_participating);

-- ── business_location ─────────────────────────────────────────────────────────

CREATE INDEX idx_bl_business
  ON business_location (business_id);

CREATE INDEX idx_bl_manager
  ON business_location (manager_user_id)
  WHERE manager_user_id IS NOT NULL;

-- Spatial queries (nearby search uses lat/lon on active locations)
CREATE INDEX idx_bl_spatial
  ON business_location (is_active, latitude, longitude);

-- ── draw ──────────────────────────────────────────────────────────────────────

-- "Find open draw" is the most frequent draw query
CREATE INDEX idx_draw_status_date
  ON draw (status, draw_date);

-- ── draw_entry ────────────────────────────────────────────────────────────────

CREATE INDEX idx_draw_entry_business
  ON draw_entry (business_id);

CREATE INDEX idx_draw_entry_draw
  ON draw_entry (draw_id);

-- ── free_ticket_usage ─────────────────────────────────────────────────────────

-- Eligibility check: latest usage per user (ORDER BY activated_at DESC LIMIT 1)
CREATE INDEX idx_ftu_user_time
  ON free_ticket_usage (user_id, activated_at DESC);

-- Analytics: AMOE request rate per draw (approved vs rejected)
CREATE INDEX idx_ftu_draw_status
  ON free_ticket_usage (draw_id, status, activated_at)
  WHERE draw_id IS NOT NULL;

-- ── subscription ──────────────────────────────────────────────────────────────

-- Idempotency guard and webhook lookup
CREATE INDEX idx_subscription_stripe_id
  ON subscription (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- ── push_subscription ─────────────────────────────────────────────────────────

CREATE INDEX idx_push_sub_user
  ON push_subscription (user_id);

-- ── refresh_token ──────────────────────────────────────────────────────────────

CREATE INDEX idx_refresh_token_user ON refresh_token (user_id);
CREATE INDEX idx_refresh_token_hash ON refresh_token (token_hash);

-- ── promotional_entry ─────────────────────────────────────────────────────────

-- User's promo entries per draw (UNION in getUserTicketsService)
CREATE INDEX idx_promo_entry_user_draw
  ON promotional_entry (user_id, draw_id);

-- max_uses count: COUNT uses per code
CREATE INDEX idx_promo_entry_code
  ON promotional_entry (code);
