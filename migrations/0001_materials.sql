-- 0001: materials (metadata only; file bytes live in R2)
CREATE TABLE IF NOT EXISTS materials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   text NOT NULL,
  course_id       text,
  material_type   text NOT NULL,
  file_name       text NOT NULL,
  r2_key          text NOT NULL,
  content_type    text,
  size_bytes      bigint,
  sha256          text,
  status          text NOT NULL DEFAULT 'READY',
  rejection_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_materials_owner
  ON materials (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_materials_course
  ON materials (course_id) WHERE deleted_at IS NULL;
