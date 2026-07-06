-- 0013: flashcards + spaced-repetition scheduling (retention loop).
CREATE TABLE IF NOT EXISTS flashcards (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id      uuid NOT NULL REFERENCES courses(id),
  front          text NOT NULL,
  back           text NOT NULL,
  due_at         timestamptz NOT NULL DEFAULT now(),
  interval_days  integer NOT NULL DEFAULT 0,
  ease           real NOT NULL DEFAULT 2.5,
  reps           integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flashcards_due ON flashcards (user_id, course_id, due_at);
