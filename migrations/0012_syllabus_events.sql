-- 0012: syllabus events (exam / homework / reading deadlines) — powers the
-- exam countdown + reminders (retention loop). Per-student for now.
CREATE TABLE IF NOT EXISTS syllabus_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id          uuid NOT NULL REFERENCES courses(id),
  title              text NOT NULL,
  type               text NOT NULL DEFAULT 'OTHER',  -- HOMEWORK|MIDTERM|FINAL|READING|OTHER
  due_at             timestamptz NOT NULL,
  source_material_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_syllabus_events_user_course
  ON syllabus_events (user_id, course_id, due_at);
