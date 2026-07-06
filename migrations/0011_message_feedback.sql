-- 0011: per-message feedback (👍/👎/report) — the quality flywheel + review queue
-- + the data source for per-course answer-accuracy metrics (Doc 04 extension).
CREATE TABLE IF NOT EXISTS message_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  rating      text,                         -- 'up' | 'down'
  reported    boolean NOT NULL DEFAULT false,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

-- Fast lookup for the review queue (reported/flagged answers).
CREATE INDEX IF NOT EXISTS idx_message_feedback_reported
  ON message_feedback (created_at) WHERE reported = true;
