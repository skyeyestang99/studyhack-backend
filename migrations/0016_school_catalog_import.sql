-- 0016: metadata needed for importing a canonical U.S. school catalog.
-- source/source_id lets us repeatedly import official datasets without
-- duplicating schools that users or earlier seeds already created.
-- (short_name / aliases columns were already added in 0014_catalog_aliases.)

ALTER TABLE schools ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS source_id text;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schools_source_source_id
  ON schools(source, source_id);
