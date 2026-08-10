-- 0019: persisted Study Guides, immutable versions, durable jobs, and telemetry.

CREATE TABLE IF NOT EXISTS study_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  course_id uuid NOT NULL REFERENCES courses(id),
  target text NOT NULL,
  retrieval_mode text NOT NULL,
  current_version_id uuid,
  status text NOT NULL DEFAULT 'queued',
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  CHECK (retrieval_mode IN ('personal', 'course')),
  CHECK (status IN ('queued', 'generating', 'ready', 'failed')),
  CHECK ((status = 'failed' AND error_code IS NOT NULL) OR status <> 'failed')
);

CREATE INDEX IF NOT EXISTS idx_study_guides_owner_course_created
  ON study_guides (owner_user_id, course_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_guide_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  origin text NOT NULL,
  base_version_id uuid,
  created_by_user_id uuid REFERENCES users(id),
  title text NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (origin IN ('generated', 'user_edit', 'ai_revision')),
  UNIQUE (guide_id, version_number),
  UNIQUE (id, guide_id)
);

ALTER TABLE study_guide_versions
  DROP CONSTRAINT IF EXISTS fk_study_guide_versions_base_version;
ALTER TABLE study_guide_versions
  ADD CONSTRAINT fk_study_guide_versions_base_version
  FOREIGN KEY (base_version_id, guide_id)
  REFERENCES study_guide_versions(id, guide_id);

ALTER TABLE study_guides
  DROP CONSTRAINT IF EXISTS fk_study_guides_current_version;
ALTER TABLE study_guides
  ADD CONSTRAINT fk_study_guides_current_version
  FOREIGN KEY (current_version_id, id)
  REFERENCES study_guide_versions(id, guide_id);

CREATE TABLE IF NOT EXISTS study_guide_concepts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES study_guide_versions(id) ON DELETE CASCADE,
  logical_concept_id uuid NOT NULL,
  title text NOT NULL,
  category text,
  summary text NOT NULL,
  content_origin text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  CHECK (content_origin IN ('generated', 'user_edit', 'ai_revision')),
  UNIQUE (version_id, logical_concept_id),
  UNIQUE (version_id, sort_order)
);

CREATE TABLE IF NOT EXISTS study_guide_key_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES study_guide_concepts(id) ON DELETE CASCADE,
  content text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  UNIQUE (concept_id, sort_order)
);

CREATE TABLE IF NOT EXISTS study_guide_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES study_guide_concepts(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES materials(id),
  page integer CHECK (page IS NULL OR page > 0),
  snippet text NOT NULL,
  score real NOT NULL CHECK (score >= 0 AND score <= 1),
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  UNIQUE (concept_id, sort_order)
);

CREATE TABLE IF NOT EXISTS study_guide_revision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  base_version_id uuid NOT NULL,
  result_version_id uuid,
  instruction text NOT NULL,
  concept_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK (cardinality(concept_ids) BETWEEN 1 AND 20),
  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CHECK ((status = 'completed' AND result_version_id IS NOT NULL) OR status <> 'completed'),
  FOREIGN KEY (base_version_id, guide_id)
    REFERENCES study_guide_versions(id, guide_id),
  FOREIGN KEY (result_version_id, guide_id)
    REFERENCES study_guide_versions(id, guide_id)
);

CREATE INDEX IF NOT EXISTS idx_study_guide_revisions_guide_created
  ON study_guide_revision_requests (guide_id, created_at DESC);

CREATE TABLE IF NOT EXISTS study_guide_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  scope_type text NOT NULL,
  scope_id uuid NOT NULL,
  guide_id uuid REFERENCES study_guides(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users(id),
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  lease_token uuid,
  locked_by text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (type IN (
    'generate_guide',
    'revise_guide',
    'publish_guide',
    'search_index_guide',
    'ranking_refresh',
    'recommendation_refresh',
    'cache_warm'
  )),
  CHECK (scope_type IN ('guide', 'user', 'course', 'segment')),
  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CHECK (
    (scope_type = 'guide' AND guide_id = scope_id)
    OR (scope_type <> 'guide' AND guide_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_study_guide_jobs_active_dedupe
  ON study_guide_jobs (dedupe_key)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_study_guide_jobs_claim
  ON study_guide_jobs (type, status, priority DESC, run_after, created_at)
  WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS study_guide_idempotency_keys (
  owner_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL,
  operation_type text NOT NULL,
  request_hash text NOT NULL,
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  response_status integer NOT NULL DEFAULT 202,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (operation_type IN ('create', 'manual_edit', 'ai_revision')),
  PRIMARY KEY (owner_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS study_guide_job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES study_guide_jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL,
  queue_wait_ms integer CHECK (queue_wait_ms IS NULL OR queue_wait_ms >= 0),
  retrieval_ms integer CHECK (retrieval_ms IS NULL OR retrieval_ms >= 0),
  generation_ms integer CHECK (generation_ms IS NULL OR generation_ms >= 0),
  validation_ms integer CHECK (validation_ms IS NULL OR validation_ms >= 0),
  persistence_ms integer CHECK (persistence_ms IS NULL OR persistence_ms >= 0),
  total_ms integer CHECK (total_ms IS NULL OR total_ms >= 0),
  retrieved_chunk_count integer CHECK (retrieved_chunk_count IS NULL OR retrieved_chunk_count >= 0),
  eligible_chunk_count integer CHECK (eligible_chunk_count IS NULL OR eligible_chunk_count >= 0),
  cited_source_count integer CHECK (cited_source_count IS NULL OR cited_source_count >= 0),
  citation_coverage real CHECK (citation_coverage IS NULL OR citation_coverage BETWEEN 0 AND 1),
  top_retrieval_score real,
  error_stage text,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (status IN ('running', 'completed', 'failed')),
  UNIQUE (job_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_study_guide_runs_started
  ON study_guide_job_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_study_guide_runs_status_started
  ON study_guide_job_runs (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_study_guide_runs_error_started
  ON study_guide_job_runs (error_code, started_at DESC)
  WHERE status = 'failed';
