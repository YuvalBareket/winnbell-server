-- Migration 016: Add max_uses cap to promotional codes
-- Without this, an unlimited number of users can redeem the same promo code.
-- NULL means unlimited (backwards-compatible default for existing codes).

ALTER TABLE promotional_code ADD COLUMN IF NOT EXISTS max_uses INT NULL;
