-- Migration 014: Promo code registry
-- Only codes explicitly created by an admin are valid.
-- Prevents users from fabricating codes by changing the URL parameter.

CREATE TABLE IF NOT EXISTS promotional_code (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(100) NOT NULL UNIQUE,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
