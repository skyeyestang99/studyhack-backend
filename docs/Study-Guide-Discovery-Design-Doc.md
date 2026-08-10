# Study Guide Discovery Design Doc

# Problem Context

Study Guides are currently owner-scoped artifacts: a student generates a saved guide for a course, reopens it later, edits it, and can request AI revisions. The next product step is Discovery: students should be able to find useful published Study Guides from their school and course instead of starting from a blank generation every time.

Discovery must preserve the Study Guide trust model. A guide is only discoverable after an explicit publish path, search must respect school and course boundaries, and ranking must not require scanning every saved guide on each request.

# Proposed Solution

Add a Discover surface backed by a Postgres published-guide projection, asynchronous indexing jobs, basic search, save actions, emergency delist support, and beta-grade operational telemetry. Later phases add richer feedback, advanced recommendations, semantic retrieval, and learned ranking. The persisted Study Guide tables remain the source of truth; Discovery reads from a smaller `published_study_guide_index` projection that contains searchable metadata and pointers back to authorized published guide content.

The beta launch should be product-complete enough for real student use: explicit publish/unpublish, course-scoped browse, basic search, published-guide result pages, save actions, emergency delist, a published-guide projection, simple safe ordering, and backend-owned authorization. Hide, recommendations, heavy personalization, semantic search, learned ranking, and complex cache warming are post-beta. Report can ship in beta only if a product/operator owner exists for triage and emergency delist decisions.

# Visual Overview

## System Context

```mermaid
flowchart LR
  Owner["Guide owner"] --> FE["studyhack-frontend"]
  Student["Enrolled student"] --> FE
  Operator["Operator or admin"] --> FE

  FE --> API["studyhack-backend Fastify API"]
  API --> Auth["Clerk auth plus enrollment checks"]
  API --> DB[("Postgres")]
  API --> Cache[("Optional Redis cache")]
  API --> Jobs["study_guide_jobs"]

  Jobs --> Worker["Study Guide worker"]
  Worker --> DB

  DB --> PrivateTables["Private Study Guide tables"]
  DB --> Projection["published_study_guide_index"]
  DB --> UserState["save state and optional reports"]

  API -. "generation and revision only" .-> Agent["studyhack-agent"]
  Agent --> DB
```

## Beta Publish State

```mermaid
stateDiagram-v2
  [*] --> Private
  Private --> PublishedIndexing: owner publishes ready guide
  PublishedIndexing --> PublishedVisible: search_index_guide upserts projection
  PublishedIndexing --> Private: indexing fails before visibility
  PublishedVisible --> Private: owner unpublishes
  PublishedVisible --> Delisted: operator emergency delists
  Delisted --> Private: operator restores to private
```

`Private` maps to `study_guides.discovery_status='private'` and no projection row. `PublishedVisible` maps to `discovery_status='published'` plus one row in `published_study_guide_index`. `Delisted` removes the projection row but keeps the owner's private guide. Delist is operator-controlled: an owner cannot republish a delisted guide until an operator restores it to `private`.

# Current Repo Baseline


## Frontend

The frontend already has a persisted Study Guide workspace:

* `components/course/PersistedStudyGuidePanel.tsx` lists owner-scoped guides for a course, creates new guides, polls queued/generating status, renders the current version, loads historical versions, saves manual edits, and submits concept-scoped AI revisions.
* `types/api.ts` defines Study Guide DTOs for private guide status, versions, concepts, citations, and revision requests.
* There is no Discover UI, published guide result type, search client, save/report flow for published guides, or public/published guide route.

Discovery should therefore be added as a new surface beside the existing private saved-guide workspace, not by replacing the current generation/editing panel.

## Backend

The backend already owns persisted Study Guide state and authorization:

* `src/routes/study-guides.ts` exposes private owner-scoped create/list/get/version/edit/revision endpoints.
* `src/study-guides/service.ts` validates Study Guide input and agent output, persists immutable versions, reauthorizes sources before persistence, enforces idempotency, and returns `404` for cross-user access.
* `migrations/0019_study_guides.sql` creates the core Study Guide tables, immutable version tables, source tables, revision request table, durable job table, idempotency table, and job-run telemetry.
* The `study_guide_jobs` enum already reserves future job types for `publish_guide`, `search_index_guide`, `ranking_refresh`, `recommendation_refresh`, and `cache_warm`.
* `src/worker.ts` currently claims only `generate_guide` and `revise_guide` jobs. It does not process publish, indexing, ranking, recommendation, or cache-warming jobs yet.
* There is no `published_study_guide_index`, Discovery save/report table, Redis integration, publish/unpublish route, Discover route, emergency delist route, or ranking implementation.
* The current schema does include normalized `schools`, `professors`, `courses.school_id`, `courses.professor_id`, and `enrollments`, so Discovery can scope browse/search by school and course without a catalog migration.

Discovery should build on the existing backend ownership boundary: the backend derives the user from auth, verifies enrollment where required, and decides whether a guide is publishable or readable.

## Agent

The agent already supports grounded structured Study Guide generation:

* `src/server.ts` exposes `/study-guide/generate` and `/study-guide/revise` behind internal bearer auth.
* `src/retrieve.ts` provides `retrieveForStudyGuide`, which filters by `courseId` and by owner when retrieval mode is `personal`.
* `src/study.ts` generates strict JSON Study Guide concepts and citations from retrieved course materials.

The first Discovery release should not require the agent on the interactive request path. Optional semantic topic indexing can reuse the existing embedding stack later, but browse/search/recommendation should initially run from backend-managed projection rows and cached result lists.

# Goals and Non-Goals

## Goals

* Let students browse published Study Guides for an enrolled course.
* Add explicit publish and unpublish workflows for ready private guides.
* Keep private guides private until publication is requested and indexed.
* Use a published projection so browse queries do not join the full Study Guide content graph.
* Enforce school, course, enrollment, publication, and emergency delist boundaries in the backend.
* Add operational observability for publish-to-index latency, query latency, zero-result rate, and indexing failures.

## Non-Goals

* Cross-school public search in the beta launch.
* Recommendations, semantic search, learned ranking, or collaborative filtering in the beta launch.
* A machine-learned ranking model before sufficient unbiased interaction data exists.
* Publishing private or failed guides.
* Using Discovery to bypass material, enrollment, publication, delist, or ownership checks.

# Phasing

## Beta Launch

The beta launch is the first production-facing Discovery release. It must be safe enough for real users and useful enough that students can find shared guides without knowing the exact title.

* Owner-only publish/unpublish for ready Study Guides.
* Course Discover for enrolled students.
* Basic search over title, target, course code, professor, summary, and topics using Postgres full-text search and `pg_trgm` typo tolerance enabled by migration.
* Published-guide open/read flow with published-version semantics.
* Save action. Report action only if beta has an explicit triage owner.
* `published_study_guide_index` projection.
* Simple ordering by text relevance for search and `published_at DESC` for browse.
* Backend-derived school/course authorization.
* Synchronous unpublish visibility removal.
* Operational metrics for publish-to-index latency, search latency, zero-result rate, indexing failures, reports if enabled, and unpublish-to-invisible latency.
* Redis read-through caching is optional for beta. If provisioned, it must be safe to bypass; indexed Postgres queries remain the fallback.

## Post-Beta Search and Ranking

Improve search quality and ranking after beta usage data reveals real query patterns.

* Autocomplete.
* Trigram search if not shipped in beta.
* Redis read-through caching if not shipped in beta.
* Hide action.
* Impression/open analytics with signed result context.
* Ranking signal refresh from interaction data.
* Hybrid ranking across lexical, trigram, and optional semantic channels.
* Lightweight personalization.
* Recommended lists.
* Semantic topic search if lexical/trigram search is insufficient.

## Later Ranking Platform

Add advanced ranking only after enough unbiased usage data exists.

* Offline ranking evaluation with Recall@50, NDCG@10, MRR, and A/B tests.
* Learned ranking or LambdaMART.
* Exploration/bandit strategies, if ever justified.

# Design

## 1. User Experience

### Publish vs Discover

Publish and Discover are separate product surfaces:

* **Publish** is an owner action on the student's current private Study Guide. It opens a publish dialog, lets the owner set title/description, validates publish safety, snapshots the `published_version_id`, and creates or refreshes the Discovery projection.
* **Discover** is a consumer browsing/search surface. It shows already-published guides from other students, lets the current user search, open, save, and optionally report them, and never mutates the current user's private Study Guide unless the user explicitly copies a published guide into their own workspace.

The top-bar `Publish` button belongs to the current guide's owner workflow. The top-bar `Discover` button switches the workspace into the Discovery browse/search view. Pressing `Discover` must not publish the current guide. Pressing `Publish Guide` must not run a recommendation/search query; it only changes the publication state of the current guide and enqueues indexing.

Beta supports only **course-only** visibility: a published guide is discoverable only to students authorized for the same course. Do not expose a disabled `Public / Anyone on StudyHack` option in the beta publish dialog; add broader visibility only after cross-school/global discovery policy, abuse handling ownership, and citation privacy rules are finalized.

Discovery appears in the Study Guide area as:

* **Beta Course Discover:** published guides for the current course.
* **Beta Search:** query box that understands course codes, professor names, targets, topics, and common spelling/formatting differences.
* **Post-Beta Recommended:** a shared ranked list for the student's school or course, lightly adjusted for enrolled courses, professor matches, recent targets, saves, and hides.

In beta, each result card shows title, course, target, professor when known, top topics, publish age, source/grounding indicator, and whether the current user has saved it. Smoothed open/save counts and hide state can be hidden until later phases.

Study Guide titles are display metadata, not identity. Discovery and private guide lists must allow duplicate titles because many students will naturally publish guides named "Midterm 1", "Final Review", or similar. The backend identifies guides by `guide_id`; it should not add a title uniqueness constraint for beta. The frontend disambiguates duplicate-looking guides by showing secondary metadata such as target, course, professor when known, created/ready/published date, retrieval mode, and status.

Opening a result creates an authorized read of the published guide. Saving a published guide is a bookmark pointer only, not a fork. If the guide is later unpublished or delisted, saved users lose access unless a future copy/fork feature creates an independent private guide.

Frontend implementation should add separate Discovery DTOs and API client calls instead of overloading the private `StudyGuide` DTO. Published results are summaries; opening a result returns the immutable version referenced by `published_version_id`, while any future copy/fork action is a separate product decision.

### Publish Sequence

```mermaid
sequenceDiagram
  actor Owner
  participant FE as Frontend
  participant API as Backend API
  participant DB as Postgres
  participant Worker as Study Guide Worker

  Owner->>FE: Click Publish Guide
  FE->>API: POST /api/study-guides/:guideId/publish
  API->>DB: Verify owner and ready status
  API->>DB: Check publish rate and course cap
  API->>DB: Verify citations are course-shareable
  API->>DB: Apply deterministic quality gate
  API->>DB: Set published_version_id and discovery_status
  API->>DB: Enqueue search_index_guide
  API-->>FE: publicationStatus = indexing
  Worker->>DB: Claim search_index_guide
  Worker->>DB: Upsert published_study_guide_index
  Worker->>DB: Mark job completed
  FE->>API: Refresh current publication status
  API-->>FE: visible in Discovery
```

### Discover Search and Open Sequence

```mermaid
sequenceDiagram
  actor Student
  participant FE as Frontend
  participant API as Backend API
  participant Cache as Optional Redis
  participant DB as Postgres

  Student->>FE: Search or browse Discover
  FE->>API: GET discover/search endpoint
  API->>DB: Derive authorized school and courses
  API->>DB: Verify enrollment for course filter
  API->>Cache: Read cached cursor page if enabled
  alt Cache hit
    Cache-->>API: Candidate result page plus next cursor
  else Cache miss
    API->>DB: Query published_study_guide_index
    API->>Cache: Store shared cursor page if enabled
  end
  API-->>FE: Published guide summaries
  Student->>FE: Open guide
  FE->>API: GET /api/study-guides/:guideId/published
  API->>DB: Verify published visibility and enrollment
  API-->>FE: Published version content
```

## 2. Publish Boundary

Discovery indexes only guides that satisfy all of these conditions:

* guide status is `ready`;
* the current version has valid structured content and citations;
* the owner explicitly published it, or a future product policy marks it publishable;
* the guide has not been manually delisted;
* guide course belongs to the same school scope used by Discover;
* guide is not deleted, unpublished, or otherwise removed;
* every citation in the published view is backed by course-shareable material;
* the guide passes the deterministic beta quality gate.

Publishing is a separate workflow from guide generation. Generation creates private study artifacts; publishing creates a discoverable artifact and an indexing job.

The backend should add explicit publish metadata rather than inferring publication from `study_guides.status`. A ready guide is still private until a publish action or policy creates the published projection.

Citation authorization for publishing is stricter than private guide generation. A private guide may cite material uploaded by its owner under `retrievalMode=personal`; publishing that guide must not leak a private PDF name, snippet, or page reference to classmates. In beta, if a guide contains citations that are not eligible for course sharing, the publish request is rejected. Citation-level redaction is deferred.

### Citation Shareability Predicate and Audit

Do not use `study_guides.retrieval_mode` as the publish eligibility predicate. It describes how the guide was generated, not whether each cited material can be shown to classmates.

Using the current backend schema, a cited material is course-shareable for beta only if all of these are true:

```sql
materials.id = study_guide_sources.material_id
AND materials.course_id = study_guides.course_id::text
AND materials.scope = 'shared'
AND materials.deleted_at IS NULL
AND materials.status = 'READY'
```

This is the exact beta predicate because the current materials schema has `scope='shared'|'personal'`, but no dedicated material-level publish/share field. That means `scope='shared'` is a conservative existing-schema proxy for course sharing, not a general-purpose product policy for broader public Discovery. If product needs owner-controlled sharing or cross-school/global sharing, add an explicit material-level field in a separate migration after that requirement is defined.

Before enabling publish in beta, run a one-time audit over existing ready guides to estimate how many would pass this predicate:

```sql
WITH ready_guides AS (
  SELECT id, course_id, retrieval_mode
  FROM study_guides
  WHERE status = 'ready'
),
citation_eligibility AS (
  SELECT
    g.id AS guide_id,
    g.retrieval_mode,
    COUNT(s.material_id) AS citation_count,
    COUNT(s.material_id) FILTER (
      WHERE m.id IS NOT NULL
        AND m.course_id = g.course_id::text
        AND m.scope = 'shared'
        AND m.deleted_at IS NULL
        AND m.status = 'READY'
    ) AS eligible_citation_count
  FROM ready_guides g
  JOIN study_guide_versions v ON v.id = g.current_version_id AND v.guide_id = g.id
  JOIN study_guide_concepts c ON c.version_id = v.id
  LEFT JOIN study_guide_sources s ON s.concept_id = c.id
  LEFT JOIN materials m ON m.id = s.material_id
  GROUP BY g.id, g.retrieval_mode
)
SELECT
  retrieval_mode,
  COUNT(*) AS ready_guides,
  COUNT(*) FILTER (WHERE citation_count > 0 AND citation_count = eligible_citation_count) AS publish_eligible_guides,
  COUNT(*) FILTER (WHERE citation_count = 0 OR citation_count <> eligible_citation_count) AS blocked_guides
FROM citation_eligibility
GROUP BY retrieval_mode;
```

If this audit shows that most ready guides are blocked, beta should either launch with publish prompts that explain which citations must be replaced or add a narrower "publish without ineligible citations" product flow. Do not silently publish guides with private or deleted citations.

### Published Version Divergence

Publishing snapshots `published_version_id`. The owner can continue editing or requesting AI revisions after publication, so `current_version_id` may diverge from `published_version_id`.

Beta uses an explicit update model:

* Discovery always serves `published_version_id`, never the latest private version.
* If `current_version_id != published_version_id`, the owner UI shows a "Published version out of date" indicator.
* The owner can click `Update published version` to rerun publish validation against the current version, update `published_version_id`, and enqueue `search_index_guide`.
* Manual edits and AI revisions do not auto-republish. This avoids accidentally exposing private edits or citations.
* Unpublish clears the publication pointer and removes the projection row.

### Publish Quality Gate

Beta does not compute a ranking quality score, but it must prevent obviously low-value guides from topping course browse by recency. Publish validation applies deterministic gates before indexing.

Initial beta defaults are configurable:

* at least 3 concepts;
* each published concept has a non-empty title, summary, and at least 2 key points;
* guide summary is at least 100 characters after trimming;
* at least 70% of concepts have one or more course-shareable citations;
* the guide has at least 2 total course-shareable citations;
* no cited material is deleted or outside the guide's course.

If a guide fails the gate, publish returns `422 PUBLISH_QUALITY_GATE_FAILED` with safe details such as missing concept count or citation coverage. These gates are product defaults, not ranking signals.

### Publish Rate and Course Caps

Beta prevents one student from occupying the entire first page through repeated publishing.

Initial beta defaults are configurable:

* at most 5 visible published guides per owner per course;
* at most 10 publish or unpublish actions per owner per hour;
* repeated publish/update requests for the same guide reuse the active `search_index_guide` dedupe key.

If the owner hits the course cap, publish returns `409 COURSE_PUBLISH_CAP_EXCEEDED`. If the owner hits the action rate limit, publish/unpublish returns `429 PUBLISH_RATE_LIMITED`.

## 3. Data Model

Study Guide content remains normalized in the existing `study_guides`, `study_guide_versions`, `study_guide_concepts`, `study_guide_key_points`, and `study_guide_sources` tables. Discovery adds projection and interaction tables.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE study_guide_versions
  ADD CONSTRAINT uq_study_guide_versions_id_guide
    UNIQUE (id, guide_id);

ALTER TABLE study_guides
  ADD COLUMN published_version_id uuid,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN discovery_status text NOT NULL DEFAULT 'private',
  ADD COLUMN delisted_at timestamptz,
  ADD COLUMN delisted_reason text,
  ADD CONSTRAINT chk_study_guides_discovery_status
    CHECK (discovery_status IN ('private', 'published', 'delisted')),
  ADD CONSTRAINT fk_study_guides_published_version_same_guide
    FOREIGN KEY (published_version_id, id)
    REFERENCES study_guide_versions(id, guide_id);

CREATE TABLE published_study_guide_index (
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
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(target, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(school_name, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(course_code, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(course_name, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(professor_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
    setweight(to_tsvector('english', array_to_string(topics, ' ')), 'B')
  ) STORED,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_published_index_version_same_guide
    FOREIGN KEY (published_version_id, guide_id)
    REFERENCES study_guide_versions(id, guide_id)
);

CREATE INDEX idx_published_guides_course_browse
  ON published_study_guide_index (school_id, course_id, published_at DESC, guide_id DESC);

CREATE INDEX idx_published_guides_school_browse
  ON published_study_guide_index (school_id, published_at DESC, guide_id DESC);

CREATE INDEX idx_published_guides_search_vector
  ON published_study_guide_index USING gin (search_vector);

CREATE INDEX idx_published_guides_topics
  ON published_study_guide_index USING gin (topics);

CREATE INDEX idx_published_guides_title_trgm
  ON published_study_guide_index USING gin (title gin_trgm_ops);

CREATE INDEX idx_published_guides_course_code_trgm
  ON published_study_guide_index USING gin (course_code gin_trgm_ops);

CREATE INDEX idx_published_guides_professor_trgm
  ON published_study_guide_index USING gin (professor_name gin_trgm_ops);
```

`study_guides.discovery_status` is the source of truth. The projection contains only currently visible published rows. Unpublish and delist delete the projection row before returning success. Beta does not assume a staffed moderation queue or a full review workflow. Reports create operational signals; an admin/operator can manually set `discovery_status='delisted'` as an emergency safety action.

`published_study_guide_index.owner_user_id`, `school_id`, `course_id`, `professor_id`, `school_name`, `course_code`, `course_name`, and `professor_name` are intentionally duplicated from joined tables for read performance, bounded filtering, card rendering, and search. The indexing job is responsible for keeping them consistent with the source rows.

`search_vector` is generated by Postgres from projection text fields. The indexing job writes `title`, `target`, `school_name`, `course_code`, `course_name`, `professor_name`, `summary`, and `topics`; Postgres maintains the derived vector so direct metadata updates cannot silently leave FTS stale.

User state is stored separately so saving a published guide does not rewrite Study Guide content.

```sql
CREATE TABLE study_guide_discovery_user_state (
  user_id uuid NOT NULL REFERENCES users(id),
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  saved_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, guide_id)
);
```

`DELETE /save` deletes the bookmark row. It does not set `saved_at=NULL`. If post-beta hide ships, hide should use explicit hide state instead of overloading a missing bookmark.

If report ships in beta, use an explicit report table rather than a generic analytics event stream:

```sql
CREATE TABLE study_guide_discovery_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id uuid NOT NULL REFERENCES study_guides(id) ON DELETE CASCADE,
  reporter_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  details text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_discovery_reports_guide_created
  ON study_guide_discovery_reports (guide_id, created_at DESC);
```

Open/impression analytics are post-beta unless there is a concrete ranking experiment that needs them.

The existing migration already permits Discovery job types in `study_guide_jobs`, but the beta worker implementation only needs `search_index_guide`.

### Data Relationship Diagram

```mermaid
erDiagram
  users ||--o{ study_guides : owns
  courses ||--o{ study_guides : contains
  schools ||--o{ courses : offers
  professors ||--o{ courses : teaches
  study_guides ||--o{ study_guide_versions : has
  study_guide_versions ||--o{ study_guide_concepts : contains
  study_guide_concepts ||--o{ study_guide_sources : cites
  study_guides ||--o| published_study_guide_index : projects
  users ||--o{ study_guide_discovery_user_state : saves
  study_guides ||--o{ study_guide_discovery_user_state : saved_by
  study_guides ||--o{ study_guide_discovery_reports : receives
  users ||--o{ study_guide_discovery_reports : reports

  study_guides {
    uuid id
    uuid owner_user_id
    uuid course_id
    uuid current_version_id
    uuid published_version_id
    text discovery_status
    timestamptz published_at
    timestamptz delisted_at
  }

  published_study_guide_index {
    uuid guide_id
    uuid published_version_id
    uuid school_id
    uuid course_id
    uuid professor_id
    text school_name
    text course_code
    text course_name
    text professor_name
    text title
    text target
    text summary
    text_array topics
    tsvector search_vector
    timestamptz published_at
  }

  study_guide_discovery_user_state {
    uuid user_id
    uuid guide_id
    timestamptz saved_at
  }

  study_guide_discovery_reports {
    uuid id
    uuid guide_id
    uuid reporter_user_id
    text reason
    timestamptz created_at
  }
```

## 4. APIs

List endpoints do not use offset pagination. They return an opaque `nextCursor` derived from the last row's stable sort tuple. Clients send that cursor back unchanged. The backend caps `limit` at 50 even if the client requests more.

```http
GET /api/courses/:courseId/study-guides/discover?limit=25&cursor=opaque
```

Returns published guides for one enrolled course. Requires enrollment in `courseId`. Pagination is keyset-based over `(published_at, guide_id)` and `limit` is capped at 50.

```http
GET /api/study-guides/discover/search?schoolId=uuid&courseId=uuid&q=smith%20cse101%20midterm&limit=25&cursor=opaque
```

Searches within the user's authorized school scopes. `schoolId` is an optional requested filter; the backend derives the authorized school set from the authenticated user's enrollments. If `schoolId` is omitted, search covers all authorized schools. If `schoolId` is present but not in the authorized set, the backend rejects the request with `403`. If the user has zero enrollments, search returns `200` with an empty result set. `courseId` is optional, but if present the backend verifies enrollment before applying it. Pagination is keyset-based over the search sort tuple and `limit` is capped at 50.

```http
GET /api/study-guides/:guideId/published
```

Returns the published version of one discoverable guide. Requires the viewer to be authorized for the guide's course.

```http
PUT /api/study-guides/:guideId/save
DELETE /api/study-guides/:guideId/save
```

Adds or removes the published guide from the current user's saved list. This is a consumer action and does not modify the original guide. `PUT` upserts one bookmark row with `saved_at=now()`. `DELETE` removes that row; it does not leave a row with `saved_at=NULL`.

```http
POST /api/study-guides/:guideId/report
```

Optional beta endpoint. Create only if report triage ownership exists.

```http
POST /api/study-guides/:guideId/publish
Idempotency-Key: <client-generated-key>
```

Publishes the current ready version, stores publish metadata, and enqueues `search_index_guide`. Owner-only in beta.

If the guide is already published and the owner's current version differs from `published_version_id`, this same endpoint acts as `Update published version`: it reruns publish validation against the current version, updates `published_version_id`, and reindexes the projection. It never auto-publishes edits or revisions without this explicit owner action.

Returns a publication state such as:

```json
{
  "guideId": "guide-uuid",
  "publishedVersionId": "version-uuid",
  "publicationStatus": "indexing"
}
```

The guide is considered published after metadata commits, but it is discoverable only after the projection is indexed. Publish-to-searchable latency is tracked operationally.

```http
POST /api/study-guides/:guideId/unpublish
Idempotency-Key: <client-generated-key>
```

Removes the guide from Discovery and invalidates affected caches without deleting the owner's private guide.

Unpublish must remove visibility synchronously by setting `study_guides.discovery_status='private'`, clearing `published_version_id` and `published_at`, and deleting the projection row before returning success. Cache cleanup can be asynchronous, but stale cache entries must either be invalidated immediately or filtered by a backend visibility check before response.

```http
POST /api/admin/study-guides/:guideId/undelist
Idempotency-Key: <client-generated-key>
```

Operator-only. Restores a manually delisted guide to `discovery_status='private'`, keeps it out of Discovery, and allows the owner to republish after the normal publish validation path. Owners cannot bypass delist by publishing a new version of the same guide while it remains delisted.

These routes do not exist today; they are required before any guide can enter Discovery.

## 5. Query Pipeline

The beta course browse path is deliberately bounded:

```text
derive authorized courses
-> reject 403 if courseId is not in authorized courses
-> read published rows from published_study_guide_index
-> rely on publish-time quality gate and per-owner course cap
-> seek after cursor over (published_at, guide_id)
-> order by published_at DESC, guide_id DESC
-> return up to limit, max 50, plus next cursor
```

Beta search uses indexed lexical retrieval:

```text
normalize query
-> parse deterministic entities
-> derive authorized school set from enrollments, or return empty if none
-> apply school/course/publication/delist hard filters
-> retrieve lexical candidates
-> retrieve trigram candidates for typo-tolerant title/course/professor matches
-> seek after cursor over (lexical_relevance, published_at, guide_id)
-> order by lexical_relevance DESC, published_at DESC, guide_id DESC
-> optionally read/write shared cache
-> return up to limit, max 50, plus next cursor
```

Normalization lowercases, trims whitespace, and normalizes course-code spacing. Beta can match professor display names directly; alias tables and ambiguous entity resolution are post-beta unless the current catalog already provides the needed alias data.

## 6. Ranking

Beta browse ranking should be simple and explainable:

```text
ORDER BY published_at DESC, guide_id DESC
```

Beta search ranking combines lexical relevance with recency:

```text
ORDER BY lexical_relevance DESC, published_at DESC, guide_id DESC
```

Post-beta ranking may combine lexical, trigram, semantic, content quality, freshness, and interaction signals. Exact fusion and reranking formulas should be defined in a separate ranking RFC after usage data and evaluation sets exist.

Course, school, publication status, delist status, publish quality gates, and per-owner course caps are hard filters. They are not ranking weights.

## 7. Personalization

Personalization is not part of beta ranking except for marking guides the user has saved. Post-beta personalization happens after a shared ranked page is loaded from cache. It may boost or suppress only within the top result window based on:

* courses the student is enrolled in;
* matching professor;
* recent targets such as midterm, final, or week number;
* guides already saved by the user;
* guides hidden by the user, if hide is added.

The system does not maintain full per-user result caches. This keeps cache reuse high and limits privacy risk.

## 8. Caching

Redis is optional for beta. Beta endpoints must work from indexed Postgres reads with page-size limits. If Redis is provisioned for beta, it stores shared Discover and search responses only; recommendation and autocomplete caches are post-beta. Postgres remains the source of truth.

Suggested keys:

```text
discover:v1:schools:{authorizedSchoolHash}:course:{courseId}:sort:{sort}:cursor:{cursorHash}:limit:{limit}
discover-search:v1:{normalizedQueryHash}:schools:{authorizedSchoolHash}:course:{courseId}:cursor:{cursorHash}:limit:{limit}
```

Initial TTLs:

* Browse results: 5-15 minutes.
* Search results: 5 minutes.
* Empty results: 30-60 seconds.

When Redis is enabled, invalidate affected keys when a guide is published, unpublished, delisted, reindexed, or when course/professor metadata changes. If Redis is unavailable, fall back to indexed Postgres queries. Never fall back to full-table scans.

## 9. External Recommendation API Evaluation

Because StudyHack may not have engineering bandwidth to maintain hand-written ranking and recommendation algorithms, managed recommendation/search APIs should be evaluated explicitly. They are not allowed to decide visibility or authorization, but they may reduce post-beta maintenance if Discovery grows beyond simple indexed search.

Beta still launches with deterministic Postgres search and browse because it has cold-start data, strict course/enrollment filters, and private citation constraints. A managed provider becomes useful after StudyHack has enough published guides and user interactions to justify catalog sync, event sync, privacy review, and provider fallback.

| Provider | Price shape | Scale | Pros | Cons | Fit |
| --- | --- | --- | --- | --- | --- |
| Recombee | Free tier; paid self-serve starts around `$99/month`; higher tiers scale by interactions, recommendation requests, active users, and catalog items. | Self-serve to millions of users/items; custom plans for high volume. | Recommendation-focused, not purely commerce; supports content-based, collaborative, popularity fallback, filters, and boosters. Lower maintenance than building ranking ML. | Requires catalog/event sync; third-party processing of user behavior; StudyHack must mirror course/enrollment filters before calling it. | Best post-beta recommendation-only candidate. |
| Amazon Personalize | Training around `$0.24/training-hour`; real-time recommendations start around `$0.0556/1k` requests at high-volume tiers; active campaigns can incur minimum provisioned TPS billing. | AWS-managed, high scale, autoscaling inference. | General managed recommendation ML; supports personalized ranking, similar items, trending, and batch recommendations. | More ML ops than Recombee; cold start; idle campaign cost; requires AWS/event pipeline maturity. | Good later if StudyHack is AWS-heavy and reaches meaningful interaction volume. |
| Algolia Search/Recommend | Search free tier then roughly `$0.50/1k` to `$1.75/1k` search requests depending on plan; Recommend free tier then roughly `$0.60/1k`; record storage also matters. | Mature low-latency global search infrastructure. | Strong search, typo tolerance, analytics, ranking tools, and recommendations in one vendor. Reduces maintenance if search quality becomes the main problem. | Vendor lock-in; cost grows with traffic and indexed records; Recommend is more product-discovery oriented. | Best candidate if StudyHack wants to outsource search plus discovery, not just recommendations. |
| Google AI Commerce Search / Retail Recommendations | Recommendations prediction roughly `$0.27/1k` for first 20M monthly predictions; training/tuning around `$2.50/node-hour`; commerce search/browse can be materially more expensive. | Very high Google-managed scale. | Powerful managed search/recommendation and personalization stack. | Commerce/product catalog assumptions fit Study Guides poorly; expensive and heavier than beta needs. | Not recommended unless Discovery becomes marketplace-scale. |

Provider integration rules:

* StudyHack always applies school, course, enrollment, publication, delist, and citation-privacy filters before sending candidates or item IDs to a provider.
* The provider can rerank or recommend only within authorized, visible published guides.
* StudyHack keeps `published_study_guide_index` as the deterministic fallback if the provider is unavailable or produces empty results.
* Do not send private material names, citation snippets, prompts, or personal-only source metadata to a provider without a privacy review.

Decision: beta should not hand-write a complex recommendation algorithm, but it also should not depend on a recommendation provider before there is interaction data. Keep beta ranking simple, instrument saves/reports/search behavior, and run a post-beta vendor spike comparing Recombee, Algolia, and Amazon Personalize against the deterministic Postgres baseline.

## 10. Background Jobs

Interactive browse/search requests run synchronously against indexed Postgres and, in later phases, Redis. Background jobs are used only for work that can happen outside the request path:

* `search_index_guide`

This job type uses the existing `study_guide_jobs` table introduced for persisted Study Guide generation. An active deduplication key ensures that at most one search_index_guide job is queued or running for a given guide. Repeated publish or reindex requests are merged into the existing job until it completes.

Beta does not need the full lane-aware scheduler. It needs the current worker to process `search_index_guide` with lower priority than `generate_guide` and `revise_guide`, respect attempts/backoff/dedupe keys, use a simple global indexing concurrency limit, and keep publish indexing out of request transactions.

Per-course and per-user fairness are deferred until observed workload demonstrates starvation. `publish_guide`, `ranking_refresh`, `recommendation_refresh`, and `cache_warm` remain future job types; beta publish commits metadata synchronously and enqueues only `search_index_guide`.

Agent calls should remain out of the interactive Discover path. If semantic search is added, embeddings should be computed asynchronously during indexing and stored in the projection or an adjacent index table.

## 11. Abuse Handling and Safety

Beta should not pretend to have a full moderation product if there is no review team or defined workflow. It still needs safety controls. Before inserting or refreshing `published_study_guide_index`, the backend verifies:

* the guide owner is still allowed to publish the guide;
* the selected version being published or reindexed belongs to the guide and is valid;
* citations point to course-shareable materials;
* the guide has not been manually delisted;
* any reported guide can be manually delisted from Discovery without deleting the owner's private guide.

Reports and future hide actions can become ranking signals later. In beta, a report does not imply an automatic state transition unless product defines that policy. The minimal supported response is an operator/admin action that sets `discovery_status='delisted'`, records `delisted_at` and `delisted_reason`, and immediately excludes the guide from indexed Discover responses after cache invalidation.

## 12. Observability

Beta observability focuses on operational health and basic product quality:

* publish-to-index latency;
* indexing success/failure rate;
* Discover query latency p50/p95;
* search latency p50/p95;
* zero-result rate;
* save count and report count if report ships;
* stale projection count, if cheap to compute;
* unpublish-to-invisible latency.

Later ranking observability should record enough data to debug ranking without storing prompt text or private source contents:

* query, normalized query hash, authorized school set hash, course, cursor bucket, rank, and ranking version;
* cache hit/miss and fallback-to-Postgres rate;
* indexed-but-not-visible count by delist reason;
* Recall@50, NDCG@10, and MRR from offline evaluation sets.

Future ranking changes should include a ranking version so metrics can compare old and new behavior.

# Alternatives Considered

| Approach | Decision | Reason |
| --- | --- | --- |
| Scan and rank all saved Study Guides per request | Reject | Does not scale and risks mixing private, unpublished, or unauthorized guides into candidate generation. |
| Popularity-only ranking | Reject | Creates a rich-get-richer loop and hides new high-quality guides. |
| Fully personalized ranking | Defer | Low cache reuse, privacy concerns, cold-start problems, and higher operational cost. |
| Collaborative filtering | Reject for beta | Interaction data will be sparse and biased early on. |
| Learning-to-rank model | Defer | Requires enough unbiased labels, a training pipeline, monitoring, and A/B testing. |
| External search service | Defer | Postgres FTS, trigram search, projection tables, and optional Redis are sufficient for beta. |
| Managed recommendation APIs | Defer | Amazon Personalize, Recombee, Algolia Recommend, and Google Retail-style services require catalog/event pipelines and enough interaction data; they can be evaluated post-beta in a separate vendor RFC. |

# Rollout Plan

1. Beta backend migration: add publish metadata, `discovery_status` source-of-truth fields, `published_study_guide_index`, save state, optional reports, search vector, and operational indexes.
2. Beta backend routes: add owner-only publish/unpublish, enrolled course Discover, basic search, published-guide open/read, save/unsave, optional report, and emergency delist.
3. Beta worker: add `search_index_guide` handling to upsert projection rows; Postgres computes generated search vectors.
4. Beta frontend: add a course Discover/search surface, result cards, open published guide, save action, optional report action, and publish/unpublish controls on owned ready guides.
5. Beta observability: add publish-to-index latency, indexing failures, browse/search latency, zero-result rate, save/report counts, and unpublish-to-invisible latency.
6. Post-beta: add hide, autocomplete, broader Redis caching if not already enabled, signed impression tokens, hybrid ranking, personalization, recommendations, semantic retrieval, offline ranking evaluation, and A/B testing.

# Acceptance Criteria

## Authorization and Isolation

1. A guide with `discovery_status='private'` never appears in any browse or search response.
2. A guide with `status='failed'` or a non-ready status never appears, regardless of `discovery_status`.
3. A guide with `discovery_status='delisted'` never appears.
4. A guide belonging to a course the viewer is not enrolled in never appears.
5. A guide belonging to a different school than the viewer's authorized scope never appears.
6. `GET /api/study-guides/:guideId/published` returns `404`, not `403`, for a non-owner when the guide is private, unpublished, or delisted. The response must not reveal whether the guide exists.
7. The owner can still read their own guide through the existing private endpoints after unpublish or delist.
8. A `schoolId` query parameter cannot widen results beyond the school scope derived from the caller's enrollments.
9. A `courseId` query parameter is rejected if the caller is not enrolled in that course.
10. A caller with zero enrollments receives an empty result set with `200`, not an error.
11. A caller enrolled at more than one school gets deterministic, documented behavior for both browse and search.
12. Publish and unpublish are owner-only; a non-owner attempt returns `404`.
13. Delist is operator/admin-only; a non-privileged caller receives `404`.
14. No Discover response exposes a citation snippet, material filename, or page reference for material the viewer is not authorized to read.

## Publish

15. Publishing a ready guide sets `discovery_status='published'`, sets `published_version_id` to the current version, and sets `published_at`.
16. The publish response returns `publicationStatus='indexing'`, and the guide is not discoverable until the projection row exists.
17. Publishing a queued, generating, or failed guide is rejected with a stable error code.
18. Publishing a guide whose current version fails structural validation is rejected with a stable error code.
19. Publishing a guide containing citations that are not course-shareable is rejected with a distinct error code from criterion 18, and the message identifies that citations are the cause.
20. Publish replays the stored response for the same `Idempotency-Key` plus identical request hash.
21. Publish returns `409 IDEMPOTENCY_KEY_REUSED` for the same key with a different request hash or operation type.
22. Repeated publish calls before indexing completes produce exactly one `search_index_guide` job while the active dedupe key holds.
23. Publishing a guide that was previously delisted is rejected.

## Unpublish and Delist

24. Unpublish sets `discovery_status='private'`, clears `published_version_id` and `published_at`, and deletes the projection row. All changes are committed before the response returns.
25. Immediately after the unpublish response, the guide is absent from browse and search with no eventual-consistency window.
26. Unpublish does not delete the owner's guide, versions, concepts, key points, or sources.
27. Delist sets `discovery_status='delisted'`, records `delisted_at` and `delisted_reason`, and deletes the projection row synchronously.
28. A delisted guide remains fully readable by its owner through private endpoints.
29. Unpublish and delist are both idempotent; a repeat call succeeds without error.

## Published vs. Current Version

30. Editing or AI-revising a published guide does not change the content Discover serves.
31. The owner can observe that the published version differs from the current version.
32. Republishing advances `published_version_id` and refreshes the projection's title, summary, and topics.

Note: criteria 30-32 assume explicit republish. If auto-republish-on-edit is chosen instead, replace criteria 31-32 with: every new version enqueues reindex, and the effect on `published_at` ordering is defined and tested.

## Browse

33. Course browse returns only published guides for the requested enrolled course.
34. Results are ordered by `published_at DESC, guide_id DESC`.
35. Page size is capped at a documented maximum; a larger requested size is clamped, not rejected.
36. A course with no published guides returns an empty list with `200`.
37. Each result includes title, course code, target, professor name, which is nullable, topics, publish age, grounding indicator, and the caller's saved flag without a per-result join to courses or professors.
38. Paginating while new guides publish does not duplicate or drop results because browse uses keyset pagination over `(published_at, guide_id)`.

## Search

39. A query matching the title returns the guide.
40. A query matching the target returns the guide.
41. Course-code queries match across formatting variants such as `cse101`, `CSE 101`, and `cse 101`.
42. A query matching the professor's name returns the guide.
43. A query matching summary text returns the guide.
44. A query matching a topic returns the guide.
45. School, course, publication, and delist filters are applied before ranking, not as ranking weights.
46. Results are ordered by lexical relevance, then `published_at DESC, guide_id DESC`.
47. An empty or whitespace-only query has documented behavior, either browse-equivalent or explicit rejection.
48. Typo tolerance behaves per the trigram decision, and the on/off state is documented rather than environment-dependent.
49. No query, however malformed, returns a guide the caller is unauthorized to see.

## Save

50. `PUT /save` records save state for the caller and the guide appears in their saved list.
51. `DELETE /save` removes it.
52. Both are idempotent.
53. Saving does not modify the guide, its versions, or any owner-owned data.
54. The saved flag is reflected in browse and search results for that caller.
55. After the owner unpublishes, a previously saved guide returns `404` and is excluded from the saved list or explicitly flagged as unavailable in the saved list.

## Report

56. The endpoint exists only when a named triage owner is assigned.
57. A report persists reporter, guide, reason, optional details, and timestamp.
58. A report does not automatically change `discovery_status`.
59. Repeat reports from the same user for the same guide are handled per a documented rule, either deduped or permitted.
60. Reports are queryable by an operator for triage.

## Abuse Prevention and Quality Floor

61. A per-user cap on published guides per course is enforced; exceeding it returns a stable error code.
62. A publish/unpublish rate limit is enforced per user.
63. A guide below the minimum quality thresholds, including concept count, citation coverage, and summary length, is rejected at publish with a stable error code.

## Indexing and Jobs

64. `search_index_guide` upserts the projection with correct denormalized `school_id`, `course_id`, `professor_id`, `course_code`, and `professor_name`.
65. `search_vector` is generated from title, target, summary, topics, course code, and professor name on every projection write.
66. Indexing failure leaves `discovery_status` unchanged and the guide non-discoverable. It never becomes partially visible.
67. Indexing retries with backoff and records a terminal failure with a safe error code after exhausting attempts.
68. At most one `search_index_guide` job is queued or running per guide.
69. `search_index_guide` is claimed at lower priority than `generate_guide` and `revise_guide`.
70. No Discover browse, search, or open request invokes the agent.

## Caching

71. A cache miss falls back to an indexed Postgres query, never a full table scan.
72. All Discover endpoints function correctly with Redis unavailable.
73. A stale cached cursor page never returns an unpublished or delisted guide, either through immediate invalidation or a visibility recheck before response.
74. Cache keys are scoped by authorized school set, course, normalized query hash, sort, cursor, and limit. There are no per-user result caches.

## Data Integrity

75. `study_guides.published_version_id` and `published_study_guide_index.published_version_id` are both constrained to reference a version belonging to the same guide with composite foreign keys.
76. Deleting a guide cascades removal of its projection row, save state, and reports.
77. The projection contains no row for any guide whose `discovery_status` is not `published`, verifiable by a reconciliation query returning zero.
78. `search_vector` cannot silently diverge from the projection's text columns.

## Observability

79. Publish-to-index latency is recorded at p50/p95.
80. Indexing success and failure rates are recorded, grouped by safe error code.
81. Browse and search latency is recorded at p50/p95.
82. Search zero-result rate is recorded.
83. Unpublish-to-invisible latency is recorded.
84. Save count, and report count if reports ship, are recorded.
85. An alert fires when publish-to-index latency exceeds a stated threshold.
86. An alert fires when the indexing failure rate exceeds a stated threshold.
87. An alert fires when the projection/source-of-truth drift count from criterion 77 is non-zero.
88. No log, metric, or dashboard field contains prompt text, citation snippets, or private material filenames.

## Backward Compatibility

89. All existing private Study Guide endpoints behave unchanged.
90. Existing chat, flashcard, and streaming `/study-tools` endpoints are unaffected.
91. The existing `PersistedStudyGuidePanel` continues to function with Discover disabled or absent.

# Open Questions

* What exact user action publishes a guide, and should instructors have approval controls?
* Who owns report triage and emergency delist decisions during beta?
* Should post-beta search include semantic topic search, or only FTS plus trigram search?
* If beta enables Redis, what Redis instance owns Study Guide cache keys in production?
