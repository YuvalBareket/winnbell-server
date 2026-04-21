-- Platform-wide settings (single row, upserted by admin)
CREATE TABLE IF NOT EXISTS platform_settings (
  id                INTEGER PRIMARY KEY DEFAULT 1,  -- always row 1
  global_entry_cap  INTEGER NULL,                   -- NULL = unlimited
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a default row so SELECT always returns a row
INSERT INTO platform_settings (id, global_entry_cap)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;
