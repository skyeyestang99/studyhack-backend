-- 0023: server-side activation milestones, so the beta's key funnel is measurable.
--
-- The activation question for this beta is "does zero-setup help convert into a
-- course-scoped user" — quick help → add course → upload → see exam insights.
-- That number was only knowable from localStorage on whichever device the student
-- happened to use, which means it reset on a new browser and was invisible to us
-- entirely.
--
-- Deliberately a milestone table (first occurrence per user), not an event log:
--   - the funnel needs "did this user ever reach step N", which is exactly a
--     first-occurrence question, and answering it from a raw event stream means a
--     DISTINCT ON over an ever-growing table;
--   - the primary key makes recording idempotent, so the write path can fire on
--     every request without needing to check first;
--   - it stores no request content, so it cannot quietly become a log of what
--     students asked.
--
-- If per-event analytics is needed later it should be a separate append-only table
-- feeding a real analytics pipeline, not an extension of this one.
CREATE TABLE IF NOT EXISTS user_milestones (
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone  text        NOT NULL,
  first_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, milestone),
  CHECK (milestone IN (
    'asked_quick_help',
    'added_course',
    'uploaded_material',
    'viewed_exam_insights'
  ))
);

-- Funnel queries group by milestone across all users.
CREATE INDEX IF NOT EXISTS idx_user_milestones_milestone
  ON user_milestones (milestone, first_at);
