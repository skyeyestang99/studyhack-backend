-- 0003: switch auth to Clerk. Link users to their Clerk identity; passwords
-- become optional (Clerk-managed users have no local password).

ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_id text;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clerk_id ON users (clerk_id);
