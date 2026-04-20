-- Migration 002: V2 entry model preparation
-- Adds nullable/defaulted columns for receipt-based entries, risk scoring, and entry caps.
-- Safe to run on the live DB — all new columns have defaults and do not affect existing data.

-- ticket: v2 entry fields
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS entry_source       VARCHAR(10)    NOT NULL DEFAULT 'code';
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS receipt_identifier VARCHAR(255)   NULL;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS transaction_amount NUMERIC(10, 2) NULL;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS receipt_image_url  VARCHAR(500)   NULL;
ALTER TABLE ticket ADD COLUMN IF NOT EXISTS risk_score         INTEGER        NOT NULL DEFAULT 0;

-- business: entry mode + cap
ALTER TABLE business ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(10) NOT NULL DEFAULT 'code';
ALTER TABLE business ADD COLUMN IF NOT EXISTS entry_cap  INTEGER NULL;

-- user: risk score
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS risk_score INTEGER NOT NULL DEFAULT 0;

-- index for duplicate receipt identifier lookups (used in v2)
CREATE INDEX IF NOT EXISTS idx_ticket_receipt ON ticket(business_id, receipt_identifier);
