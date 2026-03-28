-- Winnbell DB Migration v2
-- Run once against your SQL Server database.
-- Safe to inspect before running — all destructive steps are noted.

-- ── 1. Rename draw_participant → draw_entry ───────────────────────────────────
EXEC sp_rename 'draw_participant', 'draw_entry';

-- ── 2. Add contribution_amount to draw_entry ─────────────────────────────────
ALTER TABLE draw_entry ADD contribution_amount DECIMAL(10,2) NULL;
-- Backfill existing rows at 80% of fee_at_entry
UPDATE draw_entry SET contribution_amount = ROUND(fee_at_entry * 0.80, 2) WHERE contribution_amount IS NULL;
ALTER TABLE draw_entry ALTER COLUMN contribution_amount DECIMAL(10,2) NOT NULL;

-- ── 3. Enforce one entry per business per draw ────────────────────────────────
-- Remove duplicate rows first (keep the earliest joined_at) before adding the constraint
WITH duplicates AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY draw_id, business_id ORDER BY joined_at ASC) AS rn
  FROM draw_entry
)
DELETE FROM draw_entry WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);

ALTER TABLE draw_entry
  ADD CONSTRAINT UQ_draw_entry_draw_business UNIQUE (draw_id, business_id);

-- ── 4. Add prize_percentage to draw ──────────────────────────────────────────
ALTER TABLE draw ADD prize_percentage DECIMAL(5,2) NOT NULL DEFAULT 80.00;

-- ── 5. Rename prize_amount → prize_pool on draw ───────────────────────────────
-- Recompute prize_pool from draw_entry.contribution_amount before renaming
UPDATE d
SET d.prize_amount = ISNULL((
  SELECT SUM(de.contribution_amount) FROM draw_entry de WHERE de.draw_id = d.id
), 0)
FROM draw d;

EXEC sp_rename 'draw.prize_amount', 'prize_pool', 'COLUMN';

-- ── 6. Drop prize_name from draw ─────────────────────────────────────────────
-- DESTRUCTIVE: prize_name was always identical to name in practice.
-- If your data has distinct values, copy them to draw.name first.
ALTER TABLE draw DROP COLUMN prize_name;

-- ── 7. Add winner_user_id and closed_at to draw ───────────────────────────────
ALTER TABLE draw ADD winner_user_id INT NULL;
ALTER TABLE draw ADD CONSTRAINT FK_draw_winner_user
  FOREIGN KEY (winner_user_id) REFERENCES [user](id);

ALTER TABLE draw ADD closed_at DATETIME2 NULL;

-- ── 8. Rename business_location.user_id → manager_user_id ────────────────────
EXEC sp_rename 'business_location.user_id', 'manager_user_id', 'COLUMN';

-- ── 9. Add updated_at to business_location ───────────────────────────────────
ALTER TABLE business_location ADD updated_at DATETIME2 NULL;

-- ── 10. Add ticket_balance to business (if missing) ──────────────────────────
IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'business' AND COLUMN_NAME = 'ticket_balance'
)
  ALTER TABLE business ADD ticket_balance INT NOT NULL DEFAULT 0;

-- ── 11. Add ticket_id to free_ticket_usage ───────────────────────────────────
ALTER TABLE free_ticket_usage ADD ticket_id INT NULL;
ALTER TABLE free_ticket_usage ADD CONSTRAINT FK_free_ticket_usage_ticket
  FOREIGN KEY (ticket_id) REFERENCES ticket(id);

-- ── 12. Add indexes ───────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ticket_draw_id')
  CREATE INDEX IX_ticket_draw_id ON ticket(draw_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ticket_activated_by_user_id')
  CREATE INDEX IX_ticket_activated_by_user_id ON ticket(activated_by_user_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ticket_business_id')
  CREATE INDEX IX_ticket_business_id ON ticket(business_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_draw_status_date')
  CREATE INDEX IX_draw_status_date ON draw(status, draw_date);
