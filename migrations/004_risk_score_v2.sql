-- Add decay-tracking columns to user table
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS risk_clean_entries   INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS risk_last_flagged_at TIMESTAMP NULL;
