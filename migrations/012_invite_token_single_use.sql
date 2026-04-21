-- Migration 012: Make manager invite tokens single-use
-- Adds invite_token_hash (SHA-256 hex of the JWT) and invite_used_at to business_location.
-- When an invite is generated the hash is stored; when it is redeemed the hash is cleared
-- and invite_used_at is stamped — any subsequent attempt to use the same token is rejected.

ALTER TABLE business_location
  ADD COLUMN IF NOT EXISTS invite_token_hash VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS invite_used_at TIMESTAMP NULL;
