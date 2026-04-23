-- Refresh token storage for JWT refresh rotation
CREATE TABLE IF NOT EXISTS refresh_token (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token_hash   VARCHAR(64) NOT NULL UNIQUE,  -- SHA-256 hex of the token
  expires_at   TIMESTAMP NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_token_user
  ON refresh_token (user_id);

CREATE INDEX IF NOT EXISTS idx_refresh_token_hash
  ON refresh_token (token_hash);
