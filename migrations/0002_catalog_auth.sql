-- 0002: catalog (schools/professors/courses) + users (email/password auth)

CREATE TABLE IF NOT EXISTS schools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  location    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS professors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  department  text,
  school_id   uuid NOT NULL REFERENCES schools(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  code         text NOT NULL,
  school_id    uuid NOT NULL REFERENCES schools(id),
  professor_id uuid NOT NULL REFERENCES professors(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text UNIQUE NOT NULL,
  password_hash     text NOT NULL,
  name              text,
  subscription_tier text NOT NULL DEFAULT 'FREE',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_professors_school ON professors(school_id);
CREATE INDEX IF NOT EXISTS idx_courses_school ON courses(school_id);

-- Seed one school / professor / course so the UI has real data to work with.
INSERT INTO schools (id, name, location) VALUES
  ('11111111-1111-1111-1111-111111111111', 'UC San Diego', 'La Jolla, CA')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO professors (id, name, department, school_id) VALUES
  ('22222222-2222-2222-2222-222222222222', 'Prof. Demo', 'Mathematics', '11111111-1111-1111-1111-111111111111')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO courses (id, name, code, school_id, professor_id) VALUES
  ('33333333-3333-3333-3333-333333333333', 'Introduction to Differential Equations', 'MATH 20D',
   '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')
  ON CONFLICT (id) DO NOTHING;
