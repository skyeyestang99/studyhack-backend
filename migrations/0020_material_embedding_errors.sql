-- 0020: persist material ingest failures so users and operators can recover.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS embedding_error text;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS last_attempted_at timestamptz;
