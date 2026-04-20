-- Migration 009: make receipt the default entry mode
-- Update existing businesses still on 'code' mode to 'receipt'
UPDATE business SET entry_mode = 'receipt' WHERE entry_mode = 'code';

-- Update column default for future inserts
ALTER TABLE business ALTER COLUMN entry_mode SET DEFAULT 'receipt';
