# Database manageability (pre-beta review)

Assessment of the Neon/Postgres schema as real users start populating it. Reviewed
2026-07-12 ahead of the closed beta.

## Overall: healthy
Hot paths are well-indexed and most cascades are correct. Nothing here blocks a
small closed beta. The items below are about staying manageable as data grows.

### Indexing — good coverage (no action needed)
- `enrollments(user_id)`, `enrollments(course_id)`, unique `(user_id, course_id)`
- `materials(owner_user_id)` / `materials(course_id)` (partial, `WHERE deleted_at IS NULL`)
- `material_chunks`: HNSW vector index + `course_id` + `owner` indexes
- `conversations(user_id)`, `messages(conversation_id, created_at)`
- `flashcards(user_id, course_id, due_at)`, `syllabus_events(user_id, course_id)`
- `users(clerk_id)` unique; catalog trigram (pg_trgm) indexes for fuzzy search

### Cascade map (what happens on delete)
- **Delete user** → cascades: conversations (→ messages → feedback), flashcards,
  syllabus_events, and now **enrollments** (added in 0018). Does **not** clean
  `materials` (see gap #1).
- **Delete material** → cascades `material_chunks`. Does **not** delete the R2
  object or handle soft-deletes (see gap #2).
- **Delete course** → still RESTRICTed by conversations/flashcards/syllabus; we
  rarely delete courses, so left as-is.

## Done in this pass (quick wins)
- **0018**: `enrollments` FKs → `ON DELETE CASCADE`, so a beta tester can be
  removed with a single `DELETE FROM users WHERE id = $1` (minus materials).
- **Pool**: added `idleTimeoutMillis` + `connectionTimeoutMillis` so idle
  connections release and unreachable-DB calls fail fast instead of hanging.

## Prioritized follow-ups (not done — deliberately deferred)

### 1. `materials` uses text ids with no FKs — top integrity debt
`materials.owner_user_id` is `text` (not `uuid`, no FK to `users`) and
`materials.course_id` is `text` (not `uuid`, no FK to `courses`). Everywhere else
uses `uuid` + FK. Consequences: orphaned materials on user delete, no referential
integrity, and a type mismatch vs `material_chunks.course_id` (uuid). Values are
already uuid-strings, so a migration is feasible once verified clean:

```sql
-- verify first: SELECT count(*) FROM materials
--   WHERE owner_user_id !~ '^[0-9a-f-]{36}$'
--      OR (course_id IS NOT NULL AND course_id !~ '^[0-9a-f-]{36}$');
ALTER TABLE materials
  ALTER COLUMN owner_user_id TYPE uuid USING owner_user_id::uuid,
  ALTER COLUMN course_id     TYPE uuid USING course_id::uuid;
ALTER TABLE materials
  ADD CONSTRAINT materials_owner_fkey
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  ADD CONSTRAINT materials_course_fkey
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE;
```
Until then, deleting a user leaves orphaned `materials` (+ chunks + R2 objects);
clean up manually with `DELETE FROM materials WHERE owner_user_id = '<uuid>'`.

### 2. No cleanup for soft-deleted materials (storage creep)
Materials are soft-deleted (`deleted_at`), but their `material_chunks` rows (and
the vector index entries) and the **R2 objects** are never reclaimed. Retrieval
already filters them out (`WHERE m.deleted_at IS NULL`), so it's correctness-safe
— but Neon storage + R2 grow unbounded. Add a periodic sweep: hard-delete
materials `deleted_at < now() - interval '30 days'` (cascades chunks) and delete
the matching R2 keys.

### 3. Connection pooling for production
`pool.max = 5` is fine for a single instance. Before scaling instances on Railway,
point `DATABASE_URL` at **Neon's pooled (PgBouncer) endpoint** and raise `max`, or
you'll exhaust Neon's direct-connection limit.

### 4. Observability
No slow-query logging or error monitoring. For the beta, enable Neon's query
insights and add app-level error tracking (see the separate observability task).

## Shared-materials contribution policy (beta)
Materials uploaded to a course join a **shared pool** that answers every enrolled
student's questions, so contribution needs guardrails:
- **Done:** per-course content dedup (sha256 across all owners, so identical files
  aren't stored/embedded twice) and a per-user-per-course upload cap
  (`MAX_MATERIALS_PER_USER_COURSE = 50`) to stop one contributor flooding the pool.
- **Follow-up (not built):** moderation/flagging + attribution for shared
  materials — who can contribute, and how to flag/remove a bad or misleading
  upload before it poisons everyone's tutor. Needed before *open* crowdsourcing;
  for the closed beta, rely on trusted testers + manual `DELETE /materials`.

## Operational notes
- Neon provides point-in-time restore / branching — no separate backup job needed
  for the beta, but confirm PITR retention on the current plan.
- PII stored: user email + name (from Clerk) and uploaded material content. Factor
  into the ToS/privacy page and any future deletion requests.
