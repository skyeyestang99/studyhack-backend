-- 0005: material_chunks (RAG vectors) + materials ingestion/embedding fields

CREATE EXTENSION IF NOT EXISTS vector;

-- Per-material processing state, separate from the display `status`:
-- a material can be visible/downloadable BEFORE it is embedded/retrievable
-- (Doc 1: materials-usable-before-embedding).
ALTER TABLE materials ADD COLUMN IF NOT EXISTS scope            text NOT NULL DEFAULT 'shared';   -- 'shared' | 'personal'
ALTER TABLE materials ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending';  -- pending | processing | done | failed
ALTER TABLE materials ADD COLUMN IF NOT EXISTS chunk_count      int  NOT NULL DEFAULT 0;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS content_text     text;          -- extracted full text (cache for re-chunking without re-extraction)
ALTER TABLE materials ADD COLUMN IF NOT EXISTS processed_at     timestamptz;

-- Chunks + embeddings. Scope/course_id/owner_user_id are denormalized from the
-- parent material so retrieval can filter the ANN search without a join.
CREATE TABLE IF NOT EXISTS material_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id   uuid NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  chunk_index   int  NOT NULL,
  content       text NOT NULL,
  embedding     vector(1536),                  -- OpenAI text-embedding-3-small
  scope         text NOT NULL DEFAULT 'shared',-- 'shared' | 'personal'
  course_id     text,                          -- set when scope = 'shared'
  owner_user_id text,                          -- set when scope = 'personal'
  token_count   int,
  page          int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, chunk_index)
);

-- Approximate nearest-neighbour index (cosine) + deterministic scope filters.
CREATE INDEX IF NOT EXISTS idx_material_chunks_embedding
  ON material_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_material_chunks_course
  ON material_chunks (course_id) WHERE scope = 'shared';
CREATE INDEX IF NOT EXISTS idx_material_chunks_owner
  ON material_chunks (owner_user_id) WHERE scope = 'personal';
