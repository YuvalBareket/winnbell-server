-- Migration 001: Replace is_active with is_subscribed + is_participating
-- Run this if you have NOT already applied these changes to your Neon database.

ALTER TABLE business RENAME COLUMN is_active TO is_subscribed;
ALTER TABLE business ADD COLUMN IF NOT EXISTS is_participating BOOLEAN NOT NULL DEFAULT false;
