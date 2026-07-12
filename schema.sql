-- =============================================================================
-- Winnbell PostgreSQL Schema — Neon
-- Version: 2026-06-09
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

CREATE TYPE entry_source_enum AS ENUM ('code', 'receipt', 'free', 'promo', 'referral');

CREATE TYPE image_validation_enum AS ENUM ('not_required', 'pending', 'passed', 'failed', 'ocr_error');

CREATE TYPE subscription_status_enum AS ENUM ('Active', 'Trialing', 'Past_Due', 'Cancelled', 'Incomplete');

CREATE TYPE billing_interval_enum AS ENUM ('monthly', 'yearly');

CREATE TYPE entry_mode_enum AS ENUM ('receipt', 'code');

CREATE TYPE free_ticket_status_enum AS ENUM ('approved', 'rejected');

-- How a user first arrived (analytics §4). Derived at signup from the link they came through.
CREATE TYPE acquisition_source_enum AS ENUM ('referral', 'promo_code', 'location_flyer', 'direct');


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
  -- Session epoch for INSTANT revocation of stateless internal JWTs. Every minted internal
  -- token carries the epoch it was issued under (claim `se`); the auth middleware rejects any
  -- token whose `se` is below this value. Bumped on password reset / revoke-sessions / account
  -- deletion so a compromised token dies on its very next request (cache is invalidated too),
  -- not after the 1h JWT expiry.
  token_epoch          INTEGER NOT NULL DEFAULT 0,
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
  -- Geo detected at registration: USPS state code for US users (e.g. 'FL'),
  -- ISO country code otherwise (only stored when allowed_states is unrestricted)
  declared_state       VARCHAR(10) NULL,
  -- Each user's own shareable referral code (generated on first invite). How this user was
  -- acquired (channel, referrer, reward state) lives in the user_acquisition table, not here.
  referral_code        VARCHAR(12) UNIQUE,
  -- City resolved from the registration IP (ipinfo) at signup — no user-typed field.
  city                 VARCHAR(120) NULL,
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
  -- One user = one business (a business owner IS a user). UNIQUE makes the 1:1 relationship a
  -- hard DB guarantee so login's business/subscription lookup is provably single-row.
  user_id                         INTEGER NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE RESTRICT,
  name                            TEXT NOT NULL,
  sector                          TEXT NOT NULL CHECK (sector IN ('Food','Coffee','Bakery','Grocery','Retail','Beauty','Health','Gym','Auto','Entertainment','Education','Service','Free')),
  description                     TEXT,
  terms_text                      TEXT,
  logo_url                        TEXT,
  receipt_example_image_url       TEXT,
  -- entry_mode: 'receipt' = user submits receipt; 'code' = business generates codes
  entry_mode                      entry_mode_enum NOT NULL DEFAULT 'receipt',
  -- A specific minimum is MANDATORY (no "no minimum" option). NOT NULL DEFAULT 50 so
  -- every business always has a concrete threshold; pending stays nullable where NULL
  -- unambiguously means "no pending change" (the value itself can never be null).
  min_transaction_amount          NUMERIC(10, 2) NOT NULL DEFAULT 50 CHECK (min_transaction_amount > 0),
  pending_min_transaction_amount  NUMERIC(10, 2) NULL CHECK (pending_min_transaction_amount IS NULL OR pending_min_transaction_amount > 0),
  website_url                     TEXT,
  created_at                      TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Business Locations ────────────────────────────────────────────────────────

CREATE TABLE business_location (
  id               SERIAL PRIMARY KEY,
  business_id      INTEGER NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  name             TEXT,
  address          TEXT,
  -- Optional suite / unit line captured at setup (not part of the geocoded address string).
  suite            TEXT NULL,
  -- Per-location contact phone (each branch can have its own number).
  phone            TEXT NULL,
  latitude         DECIMAL(10, 8),
  longitude        DECIMAL(11, 8),
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Location changes never touch the RUNNING campaign: while the business participates in
  -- the Open campaign, a new location waits here (is_active=false, activate_at_open=true)
  -- and a removed one keeps serving (is_active=true, deactivate_at_open=true). openDrawInTx
  -- promotes both flags at the campaign boundary. Businesses not in the Open campaign
  -- change locations immediately and never set these flags.
  activate_at_open   BOOLEAN NOT NULL DEFAULT FALSE,
  deactivate_at_open BOOLEAN NOT NULL DEFAULT FALSE,
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
  -- Staged plan change applied when the next campaign opens (openDrawInTx). Used by the
  -- founding-to-regular hand-off: the new plan's tier/fee wait here so the campaign that is
  -- already running keeps the terms the business paid for. NULL = no staged change.
  pending_entries_per_location INTEGER NULL CHECK (pending_entries_per_location IS NULL OR pending_entries_per_location > 0),
  pending_fee_at_entry         NUMERIC(10, 2) NULL,
  -- Business opted out of the campaign it already paid for (no refund). Consumed at the
  -- next campaign open: enrollment skips the business, then the flag resets to FALSE.
  skip_next_campaign     BOOLEAN NOT NULL DEFAULT FALSE,
  billing_interval       billing_interval_enum NOT NULL DEFAULT 'monthly',
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Partial index for openDrawInTx: it applies staged plan changes via
-- WHERE pending_entries_per_location IS NOT NULL. Almost every subscription has NULL,
-- so this tiny partial index lets the once-a-month UPDATE skip a full table scan.
CREATE INDEX IF NOT EXISTS idx_subscription_pending_plan
  ON subscription (id)
  WHERE pending_entries_per_location IS NOT NULL;


-- ── Founding Members (one-time early-bird subscription cohort) ────────────────

CREATE TABLE founding_member (
  id                         SERIAL PRIMARY KEY,
  business_id                INTEGER UNIQUE NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  -- Seat number 1..founding_member_cap; cap enforced at runtime against platform_settings.
  -- UNIQUE makes the "claim the lowest free seat" insert race-safe: two concurrent
  -- payments can both see the same seat free, but only one insert commits - the loser's
  -- transaction fails and the Stripe retry claims the next seat.
  seat_number                INTEGER NOT NULL UNIQUE CHECK (seat_number >= 1),
  -- Stripe one-time payment tracking (no stripe_subscription_id — it's a single charge)
  stripe_payment_intent_id   TEXT UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  amount_paid                NUMERIC(10, 2) NOT NULL DEFAULT 1200.00,
  paid_at                    TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at                 TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ── Founding Payment Ledger (append-only payment history) ─────────────────────
-- founding_member holds only the CURRENT membership (business_id is UNIQUE and the
-- row is deleted on cancel), so it cannot retain history across a cancel→repurchase
-- cycle. This ledger records every founding payment and is never deleted, so the
-- plan page can show full payment history. Refund status is read live from Stripe.
CREATE TABLE founding_payment (
  id                         SERIAL PRIMARY KEY,
  -- RESTRICT: this is a financial ledger; deleting a business must never erase payment history.
  business_id                INTEGER NOT NULL REFERENCES business(id) ON DELETE RESTRICT,
  stripe_payment_intent_id   TEXT UNIQUE NOT NULL,
  stripe_checkout_session_id TEXT UNIQUE,
  amount                     NUMERIC(10, 2) NOT NULL,
  -- Total refunded against this payment (recorded when we issue the refund), so the
  -- plan page can show net/refund state without a live Stripe call on every load.
  refunded_amount            NUMERIC(10, 2) NOT NULL DEFAULT 0,
  created_at                 TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_founding_payment_business ON founding_payment (business_id, created_at DESC);


-- ── Subscription Change Log (append-only, shown in the payment history) ───────
-- Under the no-proration billing model, a plan or location change made before the 24th
-- moves no money and creates no Stripe invoice, so it would leave no trace. This ledger
-- records those changes so the payment history can show "Updated your plan from X to Y"
-- rows. Changes that settle money in the charged window are NOT logged here - their
-- settlement invoice already carries the description.
CREATE TABLE subscription_change_log (
  id          SERIAL PRIMARY KEY,
  -- RESTRICT: append-only billing history; deleting a business must never erase it.
  business_id INTEGER NOT NULL REFERENCES business(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subscription_change_log_business ON subscription_change_log (business_id, created_at DESC);


-- ── Draws ─────────────────────────────────────────────────────────────────────

CREATE TABLE draw (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  prize_pool       NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (prize_pool >= 0),
  prize_percentage NUMERIC(5, 2)  NOT NULL DEFAULT 80
                     CHECK (prize_percentage > 0 AND prize_percentage <= 100),
  draw_date        TIMESTAMP NOT NULL,
  status           draw_status_enum NOT NULL DEFAULT 'Upcoming',
  -- Populated by pickDrawWinnerService after the draw closes.
  -- Rejected winner candidates live ONLY in draw_rejected_winner (normalized, FK-safe).
  winner_user_id      INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
  winner_ticket_id    BIGINT NULL,               -- FK added below after ticket table
  winner_confirmed    BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at           TIMESTAMP NULL,            -- set when admin opens the draw
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
  -- Monthly subscription fee captured at enrolment time (revenue snapshot per campaign).
  -- NOT a prize contribution: the prize is set directly by the admin at draw creation,
  -- independent of any entry fees (there is no accumulated pool).
  fee_at_entry        NUMERIC(10, 2) NOT NULL DEFAULT 0,
  -- Per-location entry cap (subscription.entries_per_location) snapshotted at enrolment time.
  -- Read ONLY for historical per-draw capacity logs; live cap source of truth stays on subscription.
  cap_at_entry        INTEGER NULL,
  -- Receipt threshold (business.min_transaction_amount) snapshotted at enrolment time, so a draw's
  -- historical "entry minimum" survives later threshold changes. NULL on legacy rows (backfilled).
  min_transaction_at_entry NUMERIC(10, 2) NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (draw_id, business_id)
);


-- ── Tickets ───────────────────────────────────────────────────────────────────

CREATE TABLE ticket (
  -- BIGSERIAL: the ticket table is the app's fastest-growing table; a 32-bit id would need a
  -- painful full-table rewrite to widen later, so it is 64-bit from day one.
  id                      BIGSERIAL PRIMARY KEY,
  -- 6-char (batch/code mode) or 8-char (receipt/free mode) alphanumeric code
  code                    VARCHAR(10) UNIQUE NOT NULL,
  status                  ticket_status_enum NOT NULL DEFAULT 'Issued',
  entry_source            entry_source_enum NOT NULL DEFAULT 'code',
  business_id             INTEGER REFERENCES business(id) ON DELETE RESTRICT,
  location_id             INTEGER REFERENCES business_location(id) ON DELETE SET NULL,
  draw_id                 INTEGER REFERENCES draw(id) ON DELETE RESTRICT,
  activated_by_user_id    INTEGER REFERENCES "user"(id) ON DELETE RESTRICT,
  activated_at            TIMESTAMP NULL,

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
  anchor_ticket_id        BIGINT NULL REFERENCES ticket(id) ON DELETE SET NULL,

  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Integrity guards. An Activated ticket must know who activated it. A receipt entry must
-- carry its identifier (otherwise it bypasses the idx_ticket_receipt_unique dedup) - EXCEPT
-- sibling tickets of a multi-entry receipt, which intentionally hold NULL and point at the
-- anchor via anchor_ticket_id (only the anchor carries the identifier, or the dedup index
-- would reject the siblings themselves). On migrated DBs, pre-constraint legacy rows were
-- backfilled with 'LEGACY-<id>' identifiers and both constraints VALIDATEd.
ALTER TABLE ticket ADD CONSTRAINT chk_activated_ticket_has_user
  CHECK (status != 'Activated' OR activated_by_user_id IS NOT NULL);
ALTER TABLE ticket ADD CONSTRAINT chk_receipt_has_identifier
  CHECK (entry_source != 'receipt' OR receipt_identifier IS NOT NULL OR anchor_ticket_id IS NOT NULL);

-- Deferred FK: draw.winner_ticket_id -> ticket.id (ticket table now exists)
ALTER TABLE draw
  ADD CONSTRAINT fk_draw_winner_ticket
  FOREIGN KEY (winner_ticket_id) REFERENCES ticket(id) ON DELETE SET NULL;

ALTER TABLE draw
  ADD CONSTRAINT uq_draw_winner_ticket UNIQUE (winner_ticket_id);


-- ── Free Ticket Usage (weekly free entry tracking) ────────────────────────────

-- ONE ROW PER USER. Rejected free-entry attempts are NOT recorded (the user just gets
-- the error and retries once eligible); only the latest APPROVED claim is stored, which
-- is all the weekly-limit check needs. The approved claim is upserted on user_id, so this
-- table is bounded to one row per user forever (no retention job required).
CREATE TABLE free_ticket_usage (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  draw_id          INTEGER NULL REFERENCES draw(id) ON DELETE SET NULL,
  status           free_ticket_status_enum NOT NULL DEFAULT 'approved',
  rejection_reason VARCHAR(50) NULL,
  entries_created  SMALLINT NOT NULL DEFAULT 1,
  claim_ip         INET NULL,
  activated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Below-threshold receipt attempts (anti amount-probing) ───────────────────
-- A receipt rejected for being under a business's minimum is recorded here. If the
-- same receipt identifier is later submitted at a different (qualifying) amount, that
-- is amount manipulation (a genuine receipt has one fixed total) and is penalised.
-- Self-maintaining: each insert opportunistically deletes rows older than 7 days
-- (the detection window), so the table never grows unbounded — no cron required.
CREATE TABLE IF NOT EXISTS receipt_threshold_attempt (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  business_id        INTEGER NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  receipt_identifier VARCHAR(255) NOT NULL,
  attempted_amount   NUMERIC(10,2) NOT NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_receipt_threshold_attempt_lookup
  ON receipt_threshold_attempt (user_id, business_id, receipt_identifier);


-- ── Push Notification Subscriptions ──────────────────────────────────────────

CREATE TABLE push_subscription (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Notification Log ──────────────────────────────────────────────────────────

CREATE TABLE notification_log (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  url        TEXT,
  audience   TEXT NOT NULL DEFAULT 'all',
  sent_count INTEGER NOT NULL DEFAULT 0,
  sent_by    INTEGER REFERENCES "user"(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);


-- ── Refresh Tokens ─────────────────────────────────────────────────────────────

CREATE TABLE refresh_token (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,
  expires_at   TIMESTAMP NOT NULL,
  -- Rotation grace window: set on first use instead of hard-deleting the row. A consumed
  -- token is accepted again for a short grace period (concurrent tabs / PWA windows race
  -- to refresh with the same single-use token); cleanup purges rows consumed beyond grace.
  consumed_at  TIMESTAMP,
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


-- ── Promotional Entries (redemption log: one row per user per promo code) ────
-- Tracks WHO redeemed WHICH code (single-use + max_uses enforcement).
-- The actual draw entry is a ticket row with entry_source = 'promo' —
-- all entries live in the ticket table so the winner pick includes them.

CREATE TABLE promotional_entry (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(100) NOT NULL REFERENCES promotional_code(code) ON DELETE RESTRICT,
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

-- NOTE: no separate index on (code) — the UNIQUE(code) constraint (ticket_code_key)
-- already provides one. A second idx_ticket_code was redundant and was dropped.

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

-- Location cap check: count non-quarantined tickets per location per draw (L1)
CREATE INDEX IF NOT EXISTS idx_ticket_location_cap
  ON ticket (location_id, draw_id, is_quarantined)
  WHERE is_quarantined = FALSE;

-- Location-manager ticket list (getLocationTicketsService, T1-5): paginated
-- ORDER BY created_at DESC per (location, draw). The trailing created_at lets the
-- planner satisfy the ORDER BY from the index instead of a sort at scale.
CREATE INDEX IF NOT EXISTS idx_ticket_location_draw_created
  ON ticket (location_id, draw_id, created_at DESC)
  WHERE is_quarantined = FALSE;

-- Per-user ticket time queries: recent activations by user (L2)
CREATE INDEX IF NOT EXISTS idx_ticket_user_time
  ON ticket (activated_by_user_id, activated_at DESC);

-- Amount-outlier risk signal: AVG(transaction_amount) per business over the last 30 days,
-- run on every receipt submission. Covering (INCLUDE) so the average is index-only.
CREATE INDEX IF NOT EXISTS idx_ticket_business_time
  ON ticket (business_id, activated_at) INCLUDE (transaction_amount);

-- Business Analytics: every Overview/series/core-stats query filters
-- (business_id, created_at range) on countable entries. THE analytics workhorse index.
CREATE INDEX IF NOT EXISTS idx_ticket_business_created
  ON ticket (business_id, created_at DESC)
  WHERE is_quarantined = FALSE AND activated_by_user_id IS NOT NULL;

-- Admin/growth analytics per draw: countable entries by draw + business over time.
CREATE INDEX IF NOT EXISTS idx_ticket_activated
  ON ticket (draw_id, business_id, created_at DESC)
  WHERE activated_by_user_id IS NOT NULL AND is_quarantined = FALSE;

-- DAU/WAU/MAU: countable entries by time alone (no other leading predicate).
CREATE INDEX IF NOT EXISTS idx_ticket_created_at
  ON ticket (created_at DESC)
  WHERE activated_by_user_id IS NOT NULL AND is_quarantined = FALSE;

-- Multi-ticket receipts: sibling lookups by anchor (OCR propagation, admin image decisions).
CREATE INDEX IF NOT EXISTS idx_ticket_anchor
  ON ticket (anchor_ticket_id)
  WHERE anchor_ticket_id IS NOT NULL;

-- ── business ──────────────────────────────────────────────────────────────────

-- Owner lookup (find a user's business) is served by the UNIQUE(user_id) constraint's index;
-- no separate index needed.

-- Partial index for closeDrawService: it applies queued threshold changes via
-- WHERE pending_min_transaction_amount IS NOT NULL. Almost every business has NULL,
-- so this tiny partial index lets the once-a-month UPDATE skip a full table scan.
CREATE INDEX IF NOT EXISTS idx_business_pending_threshold
  ON business (id)
  WHERE pending_min_transaction_amount IS NOT NULL;

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

-- NOTE: no single-column business_id index — idx_draw_entry_business_draw's prefix covers it.
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

-- No extra indexes needed: the table is one row per user, and the UNIQUE(user_id)
-- constraint's index covers the only lookup (the weekly eligibility check by user_id).
-- The old idx_ftu_user_time / idx_ftu_draw_status / idx_ftu_user_approved were dropped
-- when the table became one-row-per-user (rejected rows are no longer stored).

-- ── notification_log ─────────────────────────────────────────────────────────

-- Admin listing: most-recent-first order (L4)
CREATE INDEX IF NOT EXISTS idx_notification_log_created
  ON notification_log (created_at DESC);

-- ── push_subscription ─────────────────────────────────────────────────────────

CREATE INDEX idx_push_sub_user
  ON push_subscription (user_id);

-- ── refresh_token ──────────────────────────────────────────────────────────────

CREATE INDEX idx_refresh_token_user ON refresh_token (user_id);
-- NOTE: no separate token_hash index — the UNIQUE(token_hash) constraint already provides one.
-- Drive the 6-hourly cleanupExpiredRefreshTokens DELETEs (split into two single-column predicates
-- so each is index-driven instead of a full scan).
CREATE INDEX idx_refresh_token_expires ON refresh_token (expires_at);
CREATE INDEX idx_refresh_token_consumed ON refresh_token (consumed_at);

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
CREATE UNIQUE INDEX idx_user_phone_unique ON "user" (phone_number) WHERE phone_number IS NOT NULL;
-- Deleted-account check on OAuth login (auth.service): OR-lookup across both identifiers,
-- filtered to inactive rows only (tiny partial index).
CREATE INDEX IF NOT EXISTS idx_user_inactive_lookup
  ON "user" (external_auth_id, email)
  WHERE is_active = FALSE;

-- =============================================================================
-- Seed Data
-- =============================================================================

-- Seed the single settings row so SELECT always returns a result
INSERT INTO platform_settings (id, global_entry_cap, founding_member_cap, founding_phase_active)
VALUES (1, NULL, 30, TRUE);

-- ── stripe_webhook_event (idempotency) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS stripe_webhook_event (
  event_id    VARCHAR(255) PRIMARY KEY,
  event_type  VARCHAR(100) NOT NULL,
  processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_event_processed ON stripe_webhook_event (processed_at);

-- ── draw_audit_log ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS draw_audit_log (
  id         SERIAL PRIMARY KEY,
  draw_id    INTEGER NOT NULL REFERENCES draw(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  metadata   JSONB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_draw_audit_log_draw ON draw_audit_log (draw_id, created_at DESC);

-- ── draw_rejected_winner ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS draw_rejected_winner (
  id              SERIAL PRIMARY KEY,
  draw_id         INTEGER NOT NULL REFERENCES draw(id) ON DELETE CASCADE,
  ticket_id       BIGINT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  -- Nullable: the audit row must survive even if the user account is hard-deleted (SET NULL).
  user_id         INTEGER NULL REFERENCES "user"(id) ON DELETE SET NULL,
  risk_penalty    INTEGER NOT NULL DEFAULT 10,
  -- Mandatory admin justification for disqualifying this winner (legal/regulatory trail).
  reason          TEXT NULL,
  rejected_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (draw_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_draw_rejected_draw ON draw_rejected_winner (draw_id, rejected_at DESC);

-- ── user_acquisition (how each user arrived — 1:1 with "user", written once at signup) ────────
-- Single home for acquisition attribution + the referral reward state (the referral bonus grant
-- reads/updates referred_by_user_id + referral_rewarded_at here). The user's OWN shareable code
-- stays on "user".referral_code (that's outbound identity, not acquisition).
CREATE TABLE IF NOT EXISTS user_acquisition (
  user_id              INTEGER PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  source               acquisition_source_enum NOT NULL DEFAULT 'direct',  -- referral|promo_code|location_flyer|direct
  location_id          INTEGER NULL REFERENCES business_location(id) ON DELETE SET NULL,  -- which flyer/location (location_flyer)
  promo_code           VARCHAR(100) NULL,                                  -- which promo code (promo_code)
  referred_by_user_id  INTEGER NULL REFERENCES "user"(id) ON DELETE SET NULL,  -- who referred them (referral)
  referral_rewarded_at TIMESTAMP NULL,                                     -- NULL = bonus pending until phone-verified
  created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_acq_source    ON user_acquisition (source);
CREATE INDEX IF NOT EXISTS idx_user_acq_referrer  ON user_acquisition (referred_by_user_id) WHERE referred_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_acq_location  ON user_acquisition (location_id) WHERE location_id IS NOT NULL;

-- ── business_profile_view (business Analytics: Acquisition / profile-view funnel) ─────────────
-- One row per (user, business, location): a logged-in user opening a specific location's profile
-- (views are always logged from the map, which is per location). Repeat opens of the same location
-- just bump last_viewed_at, so "multiple views = one view". Owner self-views are excluded at write time.
CREATE TABLE IF NOT EXISTS business_profile_view (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  location_id     INTEGER NULL REFERENCES business_location(id) ON DELETE SET NULL,
  user_id         INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  first_viewed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_viewed_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, business_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_bpv_business_time ON business_profile_view (business_id, last_viewed_at);
