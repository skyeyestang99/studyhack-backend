-- 0021: enforce material embedding-state coherence at the database level (beta C2).
--
-- Background: `embedding_status` is the real source of truth. The API derives the
-- status it shows from it (routes/materials.ts mapStatus), and `materials.status`
-- is only a fallback for legacy rows whose embedding_status is NULL. Those two
-- columns drifted apart historically, which left rows that read one way in SQL
-- and another way in the API — production still has 10 materials stored as
-- status='VALIDATING' alongside embedding_status='failed'.
--
-- Scope is deliberately narrow: constrain what is genuinely invariant, and verify
-- against real data first. Every constraint below was checked against production
-- and perf and matches 0 existing rows, so it cannot reject data we already have.

-- 1. Legacy divergence backfill. Only touches rows where embedding_status already
--    says failed, so it changes no outcome — it stops direct SQL consumers
--    (analytics, exports, manual triage) reading a stale 'VALIDATING'.
UPDATE materials
   SET status = 'FAILED'
 WHERE embedding_status = 'failed'
   AND status <> 'FAILED';

-- 2. embedding_status vocabulary. Prevents a typo'd value silently making a
--    material invisible to the ingest poller, which only looks for 'pending' and
--    'failed'. Anything else is stranded forever with no error surfaced.
ALTER TABLE materials
  ADD CONSTRAINT materials_embedding_status_valid
  CHECK (
    embedding_status IS NULL
    OR embedding_status IN ('pending', 'processing', 'done', 'failed', 'skipped')
  );

-- 3. The important one: 'done' must mean there is something to retrieve.
--    A zero-chunk 'done' is the "success with no content" failure class — the API
--    reports the material as READY and usable while chat can never cite it. The
--    ingest pipeline now raises instead of writing this state; this constraint
--    makes it unrepresentable rather than merely unlikely.
--
--    chunk_count is written in the same transaction as the chunk rows, so it is a
--    faithful proxy for their existence (a CHECK cannot contain a subquery).
ALTER TABLE materials
  ADD CONSTRAINT materials_done_implies_chunks
  CHECK (
    embedding_status <> 'done'
    OR coalesce(chunk_count, 0) > 0
  );
