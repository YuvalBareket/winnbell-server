# Winnbell Backup & Restore Runbook

Last updated: 2026-07-31. The backup job itself is `.github/workflows/prod-backup.yml` in this repo.

## What is backed up, where, how often

| What | Source | Schedule | Destination | Retention |
|---|---|---|---|---|
| Full app database | Neon prod | nightly 03:00 UTC | backup bucket `daily/` (encrypted) | 35 days |
| Full app database (monthly) | Neon prod | 1st of month | backup bucket `monthly/` (encrypted) | ~13 months |
| Auth identities (password hashes, Google links) | Supabase prod, `auth` schema | nightly | same as above | same |
| Receipt images + legal PDFs | app R2 bucket | Sundays | backup bucket `receipts-mirror/` | forever (copy, never deletes) |

Layered with what the providers give us:
- Neon point-in-time restore covers fine-grained rewind inside its history window (check Neon console -> Settings -> History retention; keep it at the plan maximum).
- The GitHub Actions backups cover total loss of the Neon / Supabase / Cloudflare accounts, because the backup bucket lives in a DIFFERENT account.

## One-time setup (do once, ~30 min)

1. Create the backup bucket somewhere OUTSIDE the app's Cloudflare account: Backblaze B2 (recommended, ~free at our size) or R2 in a second Cloudflare account. Create an access key scoped to that bucket.
2. In the app Cloudflare account, create a READ-ONLY R2 API token for the receipts bucket (the mirror job only reads).
3. Pick a strong `BACKUP_ENCRYPTION_PASSPHRASE`. Store it OFFLINE with the other recovery codes. If this passphrase is lost, every backup is unreadable - it is as important as the backups themselves.
4. Add the GitHub Actions secrets listed at the top of `prod-backup.yml` (repo Settings -> Secrets and variables -> Actions). The Supabase URL must be the DIRECT connection string (port 5432), not the transaction pooler.
5. Commit + push the workflow, then run it once manually: Actions tab -> prod-backup -> Run workflow (tick "force receipts sync" for the first full mirror).
6. Confirm in the backup bucket: `daily/<today>/neon-prod.dump.gpg`, `daily/<today>/supabase-auth.dump.gpg`, and `receipts-mirror/` populated.
7. Make sure GitHub notification emails for failed Actions are ON (they are by default for the repo owner).

## Monthly ritual (10 minutes)

Download the latest `monthly/` pair to an external drive kept offline. This copy survives even a simultaneous compromise of every online account.

## Quarterly test restore (do NOT skip - an untested backup is a hope)

1. Download + decrypt the latest daily Neon dump (see decrypt below).
2. In Neon, create a fresh branch or scratch project (NEVER restore over prod).
3. `pg_restore -d "<scratch-connection-string>" --no-owner --no-privileges neon-prod.dump`
4. Sanity: `SELECT count(*) FROM "user"; SELECT count(*) FROM ticket; SELECT count(*) FROM draw;` - compare rough magnitudes to prod.
5. Delete the scratch branch.

## Decrypting a backup

    gpg -d --batch --passphrase "<BACKUP_ENCRYPTION_PASSPHRASE>" neon-prod.dump.gpg > neon-prod.dump

## Restore procedures

### Scenario A - bad data change on Neon (wrong script, bad migration), noticed within the history window
Use Neon point-in-time restore (console -> Restore) to a branch just before the incident; verify on the branch; then promote/copy. Fastest and most precise - prefer this over dumps when available.

### Scenario B - Neon database lost entirely
1. Create a new Neon project (or use the surviving account).
2. Decrypt the newest daily (or monthly) `neon-prod.dump.gpg`.
3. `pg_restore -d "<new-connection-string>" --no-owner --no-privileges neon-prod.dump`
4. Point Render's `DATABASE_URL` at the new instance and redeploy.
5. Expected loss: at most 24h of data (nightly cadence). Reconciliation helpers: `reconcileSubscriptionsWithStripe` self-heals subscription state from Stripe on boot.

### Scenario C - Supabase project lost (nobody can log in)
1. Create a new Supabase project; enable the same auth providers (email, Google with the same OAuth client).
2. Decrypt `supabase-auth.dump.gpg`.
3. Restore the auth data into the new project (data-only, the schema already exists):
   `pg_restore -d "<new-supabase-direct-url>" --data-only --schema=auth --disable-triggers supabase-auth.dump`
   If conflicts arise, restore just the essential tables in order: `auth.users`, then `auth.identities`.
4. Update env: SUPABASE_URL / keys on Render + Vercel; update Site URL + redirect URLs in the new project; re-enter the Google provider secret.
5. Password hashes restore intact (bcrypt) - users keep their passwords. Google sign-in keeps working because `auth.identities` carries the provider links.
6. Note: the internal DB's `user.supabase_id` mapping stays valid only if `auth.users.id` UUIDs are restored verbatim (they are, with a data-only restore).

### Scenario D - app R2 bucket deleted (receipts + legal PDFs gone)
1. Create a new R2 bucket; update `R2_BUCKET` / keys on Render.
2. Copy the mirror back: `rclone copy dest:<backup-bucket>/receipts-mirror src:<new-bucket>`
3. Loss window: receipts uploaded since the last Sunday mirror. Ticket rows and OCR results live in the DB and are unaffected; legal PDFs can also be regenerated per draw from the admin (Rules PDF button).

## Design notes

- The receipts mirror uses `rclone copy`, never `sync --delete`: deletions in the app bucket do NOT propagate, so the mirror also protects against malicious/accidental mass deletion.
- Backups are encrypted client-side (gpg AES256) before upload - the backup provider never sees plaintext user data.
- The daily prune only runs after verifying today's upload landed.
- pg_dump uses the Postgres 18 client (prod Neon is PG18; a newer client can also dump the older Supabase server, never the reverse).
