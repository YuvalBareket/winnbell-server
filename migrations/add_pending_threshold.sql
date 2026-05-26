ALTER TABLE business
  ADD COLUMN IF NOT EXISTS pending_min_transaction_amount NUMERIC(10, 2) NULL
    CHECK (pending_min_transaction_amount IS NULL OR pending_min_transaction_amount > 0);
