-- Migration 013: Promotional entry tracking
-- One row per (promo_code, user_id) pair — enforces one-use-per-account-per-code.
-- The code is a plain string (e.g. 'PROMO_LAUNCH2025'). Multiple users can use the same
-- promo code, but each user can only use it once.

CREATE TABLE IF NOT EXISTS promotional_entry (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(100) NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES "user"(id),
  draw_id      INTEGER NOT NULL REFERENCES draw(id),
  created_at   TIMESTAMP DEFAULT NOW(),
  UNIQUE(code, user_id)
);

CREATE INDEX IF NOT EXISTS idx_promotional_entry_user ON promotional_entry(user_id);
