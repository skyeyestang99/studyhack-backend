-- 0004: enrollments (user<->course membership) + course dedup

CREATE TABLE IF NOT EXISTS enrollments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  course_id   uuid NOT NULL REFERENCES courses(id),
  semester    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_user   ON enrollments(user_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_course ON enrollments(course_id);

-- Dedup: one course per (school, normalized code).
-- Collapses "MATH 20D" / "math20d" / "MATH20D" within a school.
CREATE UNIQUE INDEX IF NOT EXISTS idx_courses_school_code
  ON courses (school_id, upper(replace(code, ' ', '')));
