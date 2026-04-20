-- Migration 008: add image_validation_status to ticket table
ALTER TABLE ticket
  ADD COLUMN IF NOT EXISTS image_validation_status VARCHAR(20) NOT NULL DEFAULT 'not_required';

-- Index for admin queries filtering by validation status
CREATE INDEX IF NOT EXISTS idx_ticket_image_status ON ticket(image_validation_status) WHERE image_validation_status != 'not_required';
