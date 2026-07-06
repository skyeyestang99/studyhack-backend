-- 0008: retry bookkeeping for the background embed worker.
-- The agent's poller retries embedding_status='failed' materials up to a cap;
-- this column tracks attempts so a permanently-bad file stops retrying.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS embedding_attempts int NOT NULL DEFAULT 0;
