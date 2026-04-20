-- Migration 007: enforce uniqueness of receipt_identifier per business at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_receipt_unique
  ON ticket(business_id, receipt_identifier)
  WHERE receipt_identifier IS NOT NULL;
