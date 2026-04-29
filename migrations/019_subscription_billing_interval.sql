-- Add billing_interval to subscription table
ALTER TABLE subscription
  ADD COLUMN billing_interval VARCHAR(10) NOT NULL DEFAULT 'monthly'
    CHECK (billing_interval IN ('monthly', 'yearly'));
