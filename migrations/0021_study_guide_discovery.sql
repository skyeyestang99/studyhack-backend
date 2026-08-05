-- 0021: Study Guide Discovery publish state and course-scoped projection.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE study_guide_idempotency_keys
  DROP CONSTRAINT IF EXISTS study_guide_idempotency_keys_operation_type_check;
ALTER TABLE study_guide_idempotency_keys
  ADD CONSTRAINT study_guide_idempotency_keys_operation_type_check
  CHECK (operation_type IN ('create', 'manual_edit', 'ai_revision', 'publish', 'unpublish'));

ALTER TABLE study_guides
  ADD COLUMN IF NOT EXISTS published_version_id uuid,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS discovery_status text NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS delisted_at timestamptz,
  ADD COLUMN IF NOT EXISTS delisted_reason text;

ALTER TABLE study_guides
  DROP CONSTRAINT IF EXISTS chk_study_guides_discovery_status;
ALTER TABLE study_guides
  ADD CONSTRAINT chk_study_guides_discovery_status
  CHECK (discovery_status IN ('private', 'published', 'delisted'));

ALTER TABLE study_guides
  DROP CONSTRAINT IF EXISTS fk_study_guides_published_version_same_guide;
ALTER TABLE study_guides
  ADD CONSTRAINT fk_study_guides_published_version_same_guide
  FOREIGN KEY (published_version_id, id)
  REFERENCES study_guide_versions(id, guide_id);

CREATE TABLE IF NOT EXISTS published_study_guide_index (
  guide_id uuid PRIMARY KEY REFERENCES study_guides(id) ON DELETE CASCADE,
  published_version_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  school_id uuid NOT NULL REFERENCES schools(id),
  course_id uuid NOT NULL REFERENCES courses(id),
  professor_id uuid REFERENCES professors(id),
  school_name text NOT NULL,
  course_code text NOT NULL,
  course_name text,
  professor_name text,
  title text NOT NULL,
  target text,
  summary text NOT NULL,
  topics text[] NOT NULL DEFAULT '{}',
  grounding_indicator text NOT NULL DEFAULT 'general',
  search_vector tsvector NOT NULL DEFAULT ''::tsvector,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_published_index_version_same_guide
    FOREIGN KEY (published_version_id, guide_id)
    REFERENCES study_guide_versions(id, guide_id),
  CHECK (grounding_indicator IN ('grounded', 'partial', 'general'))
);

CREATE OR REPLACE FUNCTION set_published_study_guide_search_vector()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.target, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.course_code, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.professor_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.topics, ' '), '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_published_study_guide_search_vector ON published_study_guide_index;
CREATE TRIGGER trg_published_study_guide_search_vector
BEFORE INSERT OR UPDATE OF title, target, course_code, professor_name, summary, topics
ON published_study_guide_index
FOR EACH ROW
EXECUTE FUNCTION set_published_study_guide_search_vector();

CREATE INDEX IF NOT EXISTS idx_published_guides_course_browse
  ON published_study_guide_index (school_id, course_id, published_at DESC, guide_id DESC);

CREATE INDEX IF NOT EXISTS idx_published_guides_search_vector
  ON published_study_guide_index USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_published_guides_title_trgm
  ON published_study_guide_index USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_published_guides_target_trgm
  ON published_study_guide_index USING gin (target gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_published_guides_summary_trgm
  ON published_study_guide_index USING gin (summary gin_trgm_ops);

CREATE TABLE IF NOT EXISTS study_guide_discovery_user_state (
  user_id uuid NOT NULL REFERENCES users(id),
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  saved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, guide_id)
);
