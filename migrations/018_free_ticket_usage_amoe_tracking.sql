-- ── Migration 018: Improve free_ticket_usage for AMOE tracking ────────────────
--
-- Adds draw_id, status, rejection_reason, and entries_created to free_ticket_usage
-- so that rejected AMOE attempts are recorded (not just successes), and each row
-- is linked to the campaign it belongs to.
--
-- Also fixes the entry_source bug where free tickets were stored as 'code' (the
-- default) instead of 'free'. This migration does NOT backfill existing rows —
-- pre-migration free tickets will remain as 'code'. Going forward all new free
-- ticket insertions explicitly set entry_source = 'free'.

ALTER TABLE free_ticket_usage
  ADD COLUMN draw_id          INTEGER NULL REFERENCES draw(id) ON DELETE SET NULL,
  ADD COLUMN status           VARCHAR(20) NOT NULL DEFAULT 'approved'
                                CHECK (status IN ('approved', 'rejected')),
  ADD COLUMN rejection_reason VARCHAR(50) NULL,
  ADD COLUMN entries_created  SMALLINT NOT NULL DEFAULT 1;

-- Index for analytics: AMOE request rate per draw
CREATE INDEX idx_ftu_draw_status
  ON free_ticket_usage (draw_id, status, activated_at)
  WHERE draw_id IS NOT NULL;
