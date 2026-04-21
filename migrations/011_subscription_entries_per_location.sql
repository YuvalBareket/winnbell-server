-- Add per-location entry cap to subscription
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS entries_per_location INTEGER NULL;

-- Backfill existing active subscriptions from business.entry_cap
UPDATE subscription s
SET entries_per_location = b.entry_cap
FROM business b
WHERE s.business_id = b.id AND b.entry_cap IS NOT NULL;
