-- 0027: cited_count on materials (Course Materials workstream, Part 2).
--
-- How often a document actually got cited in an answer is the strongest available signal
-- that it is useful — stronger than upload recency and stronger than a vote, because it
-- is produced by the product working rather than by someone clicking.
--
-- Denormalised onto materials rather than counted from messages.citations on read: the
-- citations column is JSON, so counting would mean scanning and parsing every message in
-- the course on every library request.
--
-- Incremented fire-and-forget where citation events are already forwarded in the chat
-- route (same discipline as milestones). A failed increment must never fail an answer —
-- the count is a display and ordering signal, not an invariant.
--
-- IMPORTANT: this must never influence RAG chunk ranking. Popularity may order the shelf,
-- never the answer; retrieval stays semantic + course-scoped + moderation-filtered.
ALTER TABLE materials ADD COLUMN IF NOT EXISTS cited_count int NOT NULL DEFAULT 0;

-- Library "most helpful"/"recommended" sorts read this alongside course scoping.
CREATE INDEX IF NOT EXISTS idx_materials_course_cited
  ON materials (course_id, cited_count DESC)
  WHERE deleted_at IS NULL;
