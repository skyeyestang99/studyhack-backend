-- 0010: persist whether an assistant answer passed numeric verification, so the
-- "checked ✓" badge shows on historical messages too.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
