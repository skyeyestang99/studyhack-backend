-- 0014: server-side fuzzy search support for catalog entities.
-- pg_trgm powers similarity(), the % operator, and GIN trigram indexes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_schools_name_trgm
  ON schools USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_schools_short_name_trgm
  ON schools USING gin (short_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_professors_name_trgm
  ON professors USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_professors_short_name_trgm
  ON professors USING gin (short_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_courses_name_trgm
  ON courses USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_courses_code_trgm
  ON courses USING gin (code gin_trgm_ops);
