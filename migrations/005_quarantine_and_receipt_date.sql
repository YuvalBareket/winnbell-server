-- Migration 005: add transaction_date + quarantine fields to ticket table
-- Run this against the existing database (do NOT re-run schema.sql).

ALTER TABLE ticket
  ADD COLUMN IF NOT EXISTS transaction_date  DATE      NULL,
  ADD COLUMN IF NOT EXISTS is_quarantined    BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT      NULL,
  ADD COLUMN IF NOT EXISTS quarantined_at    TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_ticket_quarantined ON ticket(draw_id, is_quarantined);
