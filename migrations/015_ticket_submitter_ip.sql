-- Migration 015: Capture submitter IP on receipt entries
-- Used for fraud ring detection: multiple accounts sharing an IP
-- submitting the same or related receipts is a strong collusion signal.

ALTER TABLE ticket ADD COLUMN IF NOT EXISTS submitter_ip INET NULL;
