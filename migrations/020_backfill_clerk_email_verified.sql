-- Clerk verifies emails before allowing sign-in.
-- Any user row that has an external_auth_id (synced from Clerk) but is_email_verified = false
-- was created before this fix and should be considered verified.
UPDATE "user"
SET is_email_verified = true
WHERE external_auth_id IS NOT NULL
  AND is_email_verified = false;
