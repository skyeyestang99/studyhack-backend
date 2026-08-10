-- 0022: remove abandoned Study Guide Discovery schema so environments match (beta C1).
--
-- The Discovery feature was parked (agent #16 / backend #30 / frontend #40 closed;
-- the design doc is preserved in docs/). Its migrations were applied to perf on
-- 2026-08-05 and then deleted from the repo along with the feature branch, which
-- left perf carrying schema that exists nowhere else:
--
--   tables   published_study_guide_index, study_guide_discovery_user_state
--   columns  study_guides.discovery_status, .published_at, .published_version_id,
--            .delisted_at, .delisted_reason
--
-- Production has none of these, and neither would a freshly provisioned database,
-- because the migration files are gone. Perf is the only environment in this
-- state, and its schema is therefore unreproducible.
--
-- That drift is dangerous in the benign-looking direction: a query referencing a
-- Discovery column passes on perf and fails in production. This project has
-- already been bitten by the mirror image — an ingest fix deliberately skipped
-- writing embedding_error because those columns were believed to be
-- Discovery-only, when in fact migration 0020 had added them everywhere.
--
-- Verified before writing: zero references to any of these objects across the
-- backend, agent, and frontend source trees.
--
-- Every statement uses IF EXISTS, so this is a no-op in production and on new
-- databases, and only takes effect on perf.

DROP TABLE IF EXISTS published_study_guide_index;
DROP TABLE IF EXISTS study_guide_discovery_user_state;

ALTER TABLE study_guides DROP COLUMN IF EXISTS discovery_status;
ALTER TABLE study_guides DROP COLUMN IF EXISTS published_at;
ALTER TABLE study_guides DROP COLUMN IF EXISTS published_version_id;
ALTER TABLE study_guides DROP COLUMN IF EXISTS delisted_at;
ALTER TABLE study_guides DROP COLUMN IF EXISTS delisted_reason;

-- Drop the ledger rows for migration files that no longer exist. Leaving them
-- makes schema_migrations describe a repo state that cannot be checked out, which
-- defeats using it to audit whether an environment is up to date.
DELETE FROM schema_migrations
 WHERE name IN (
   '0020_study_guide_discovery.sql',
   '0021_material_status_embedding_sync.sql'
 );
