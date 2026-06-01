-- =============================================================================
-- Winnbell PostgreSQL Schema — Neon
-- Version: 2026-05-27
-- =============================================================================
-- Fresh-install script. Pass the entire file to Neon to recreate the database.
-- Tables are defined in FK dependency order.
-- All enum-like columns use PostgreSQL ENUM types (no CHECK constraints).
-- Every frequently-queried column or FK has an explicit index.
-- =============================================================================


-- =============================================================================
-- ENUM Types
-- =============================================================================

CREATE TYPE user_role_enum AS ENUM ('User', 'Business', 'Admin', 'Manager');

CREATE TYPE draw_status_enum AS ENUM ('Upcoming', 'Open', 'Closed');

CREATE TYPE ticket_status_enum AS ENUM ('Issued', 'Activated');

CREATE TYPE entry_source_enum AS ENUM ('code', 'receipt', 'free', 'promo');

CREATE TYPE image_validation_enum AS ENUM ('not_required', 'pending', 'passed', 'failed', 'ocr_error');

CREATE TYPE subscription_status_enum AS ENUM ('Active', 'Trialing', 'Past_Due', 'Cancelled', 'Incomplete');

CREATE TYPE billing_interval_enum AS ENUM ('monthly', 'yearly');

CREATE TYPE entry_mode_enum AS ENUM ('receipt', 'code');

CREATE TYPE refund_status_enum AS ENUM ('none', 'partial', 'full');

CREATE TYPE free_ticket_status_enum AS ENUM ('approved', 'rejected');


-- =============================================================================
-- Tables
-- =============================================================================

-- ── Users ─────────────────────────────────────────────────────────────────────

CREATE TABLE "user" (
  id                   SERIAL PRIMARY KEY,
  -- Supabase user ID for Supabase-managed accounts; NULL for local (email/password) accounts
  external_auth_id     TEXT UNIQUE,
  email                TEXT UNIQUE NOT NULL,
  full_name            TEXT,
  -- NULL for Supabase-managed accounts (password lives in Supabase)
  password_hash        TEXT,
  role                 user_role_enum NOT NULL DEFAULT 'User',
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  is_email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  registration_ip      INET NULL,
  -- Fraud risk scoring: 0-9 = low, 10-19 = medium (image required), 20+ = high (throttled + quarantined)
  risk_score           INTEGER NOT NULL DEFAULT 0 CHECK (risk_score >= 0),
  risk_clean_entries   INTEGER NOT NULL DEFAULT 0 CHECK (risk_clean_entries >= 0),
  risk_last_flagged_at TIMESTAMP NULL,
  risk_last_decayed_at TIMESTAMP NULL,
  risk_flags           TEXT[] NULL,
  phone_number       VARCHAR(20) NULL,
  is_phone_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  -- ISO 3166-1 alpha-2 country code detected at registration (geo-restriction)
  declared_state       VARCHAR(10) NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Phone OTP ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS phone_otp (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,
  code         VARCHAR(6) NOT NULL,
  expires_at   TIMESTAMP NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Business ──────────────────────────────────────────────────────────────────

CREATE TABLE business (
  id                              SERIAL PRIMARY KEY,
  user_id                         INTEGER NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  name                            TEXT NOT NULL,
  sector                          TEXT NOT NULL CHECK (sector IN ('Food','Coffee','Bakery','Grocery','Retail','Beauty','Health','Gym','Auto','Entertainment','Education','Service','Free')),
  description                     TEXT,
  terms_text                      TEXT,
  logo_url                        TEXT,
  receipt_example_image_url       TEXT,
  -- entry_mode: 'receipt' = user submits receipt; 'code' = business generates codes
  entry_mode                      entry_mode_enum NOT NULL DEFAULT 'receipt',
  min_transaction_amount          NUMERIC(10, 2) NULL CHECK (min_transaction_amount IS NULL OR min_transaction_amount > 0),
  pending_min_transaction_amount  NUMERIC(10, 2) NULL CHECK (pending_min_transaction_amount IS NULL OR pending_min_transaction_amount > 0),
  website_url                     TEXT,
  phone                           TEXT,
  created_at                      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMP NOT NULL DEFAULT NOW()
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
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Subscriptions ─────────────────────────────────────────────────────────────
-- Single source of truth for subscription state.
-- Use status IN ('Active', 'Trialing') instead of business.is_subscribed.

CREATE TABLE subscription (
  id                     SERIAL PRIMARY KEY,
  business_id            INTEGER UNIQUE NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id        TEXT,
  status                 subscription_status_enum NOT NULL DEFAULT 'Incomplete',
  current_period_end     TIMESTAMP,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  -- Monthly fee captured at subscription creation (used for draw contribution calculations)
  fee_at_entry           NUMERIC(10, 2) NULL,
  -- Max entries per location per draw. Single source of truth - not duplicated in business.entry_cap.
  entries_per_location   INTEGER NULL CHECK (entries_per_location IS NULL OR entries_per_location > 0),
  billing_interval       billing_interval_enum NOT NULL DEFAULT 'monthly',
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Founding Members (one-time early-bird subscription cohort) ────────────────

CREATE TABLE founding_member (
  id                         SERIAL PRIMARY KEY,
  business_id                INTEGER UNIQUE NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  -- Seat number 1..founding_member_cap; enforced at runtime against platform_settings
  seat_number                INTEGER NOT NULL CHECK (seat_number >= 1),
  -- Stripe one-time payment tracking (no stripe_subscription_id — it's a single charge)
  stripe_payment_intent_id   TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  amount_paid                NUMERIC(10, 2) NOT NULL DEFAULT 1000.00,
  paid_at                    TIMESTAMP NOT NULL DEFAULT NOW(),
  -- Refund tracking
  refund_status              refund_status_enum NOT NULL DEFAULT 'none',
  refund_amount              NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at                 TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Draws ─────────────────────────────────────────────────────────────────────

CREATE TABLE draw (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  prize_pool       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (prize_pool >= 0),
  prize_percentage NUMERIC(5, 2)  NOT NULL DEFAULT 80
                     CHECK (prize_percentage > 0 AND prize_percentage <= 100),
  draw_date        TIMESTAMP NOT NULL,
  status           draw_status_enum NOT NULL DEFAULT 'Upcoming',
  -- Populated by pickDrawWinnerService after the draw closes
  winner_user_id   INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
  winner_ticket_id INTEGER NULL,              -- FK added below after ticket table
  opened_at        TIMESTAMP NULL,            -- set when admin opens the draw
  closed_at        TIMESTAMP NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Draw Entries (businesses enrolled in a draw) ──────────────────────────────
-- Business enrollment in a draw.
-- Delete Upcoming rows on cancellation to prevent orphaned contributions.

CREATE TABLE draw_entry (
  id                  SERIAL PRIMARY KEY,
  draw_id             INTEGER NOT NULL REFERENCES draw(id) ON DELETE CASCADE,
  business_id         INTEGER NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  -- Monthly subscription fee captured at enrolment time (for audit)
  fee_at_entry        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- Their share of the prize pool = fee_at_entry x prize_percentage / 100
  contribution_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (draw_id, business_id)
);


-- ── Tickets ───────────────────────────────────────────────────────────────────

CREATE TABLE ticket (
  id                      SERIAL PRIMARY KEY,
  -- 6-char (batch/code mode) or 8-char (receipt/free mode) alphanumeric code
  code                    VARCHAR(10) UNIQUE NOT NULL,
  status                  ticket_status_enum NOT NULL DEFAULT 'Issued',
  entry_source            entry_source_enum NOT NULL DEFAULT 'code',
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
  -- Risk points added to the user's score as a result of this specific entry
  risk_score_delta        SMALLINT NOT NULL DEFAULT 0,
  -- Submitter IP captured at receipt submission (fraud ring detection)
  submitter_ip            INET NULL,

  -- Quarantine: ticket excluded from draw pool and cap count ─────────────────
  is_quarantined          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Reason codes: high_risk_user | ocr_pending | ocr_validation_failed |
  --               ocr_error_pending_review | shared_receipt_suspected
  quarantine_reason       TEXT NULL,
  quarantined_at          TIMESTAMP NULL,

  -- OCR validation lifecycle ──────────────────────────────────────────────────
  image_validation_status image_validation_enum NOT NULL DEFAULT 'not_required',

  -- Risk flags: array of flag codes explaining the risk score
  risk_flags              TEXT[] NULL,

  -- Multi-ticket receipt: secondary tickets point back to the first (anchor) ticket
  anchor_ticket_id        INTEGER NULL REFERENCES ticket(id) ON DELETE SET NULL,

  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Deferred FK: draw.winner_ticket_id -> ticket.id (ticket table now exists)
ALTER TABLE draw
  ADD CONSTRAINT fk_draw_winner_ticket
  FOREIGN KEY (winner_ticket_id) REFERENCES ticket(id) ON DELETE SET NULL;


-- ── Free Ticket Usage (weekly free entry tracking) ────────────────────────────

CREATE TABLE free_ticket_usage (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  draw_id          INTEGER NULL REFERENCES draw(id) ON DELETE SET NULL,
  status           free_ticket_status_enum NOT NULL DEFAULT 'approved',
  rejection_reason VARCHAR(50) NULL,
  entries_created  SMALLINT NOT NULL DEFAULT 1,
  claim_ip         INET NULL,
  activated_at     TIMESTAMP NOT NULL DEFAULT NOW()
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
  id                    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- NULL = no platform-wide cap; if the row is missing the app defaults to 500
  global_entry_cap      INTEGER NULL CHECK (global_entry_cap IS NULL OR global_entry_cap > 0),
  -- NULL or empty array = all states allowed; otherwise restrict signups to listed states
  allowed_states        TEXT[] NULL,
  -- Founding partner program: max seats (default 30) and active toggle
  founding_member_cap   INTEGER NOT NULL DEFAULT 30 CHECK (founding_member_cap >= 1),
  founding_phase_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);


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

-- ── founding_member ───────────────────────────────────────────────────────────

-- Enforce unique seat numbers (gaps allowed after cancellations — lowest available is re-assigned)
CREATE UNIQUE INDEX idx_founding_member_seat ON founding_member (seat_number);
CREATE INDEX idx_founding_member_business    ON founding_member (business_id);

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

CREATE INDEX idx_draw_entry_business_draw
  ON draw_entry (business_id, draw_id);

-- ── subscription ──────────────────────────────────────────────────────────────

-- Idempotency guard and webhook lookup
CREATE INDEX idx_subscription_stripe_id
  ON subscription (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX idx_subscription_status_business
  ON subscription (business_id, status);

-- ── free_ticket_usage ─────────────────────────────────────────────────────────

-- Eligibility check: latest usage per user (ORDER BY activated_at DESC LIMIT 1)
CREATE INDEX idx_ftu_user_time
  ON free_ticket_usage (user_id, activated_at DESC);

-- Analytics: AMOE request rate per draw (approved vs rejected)
CREATE INDEX idx_ftu_draw_status
  ON free_ticket_usage (draw_id, status, activated_at)
  WHERE draw_id IS NOT NULL;

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


-- ── phone_otp ────────────────────────────────────────────────────────────────

CREATE INDEX idx_phone_otp_phone_time ON phone_otp (phone_number, created_at);
CREATE INDEX idx_phone_otp_user ON phone_otp (user_id);

-- ── user (query support) ─────────────────────────────────────────────────────

CREATE INDEX idx_user_role ON "user" (role);

-- =============================================================================
-- Seed Data
-- =============================================================================

-- Seed the single settings row so SELECT always returns a result
INSERT INTO platform_settings (id, global_entry_cap, founding_member_cap, founding_phase_active)
VALUES (1, NULL, 30, TRUE);
