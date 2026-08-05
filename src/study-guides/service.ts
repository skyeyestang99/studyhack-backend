import { createHash, randomUUID } from "node:crypto";
import { query, withTransaction, type TxQuery } from "../db.js";
import { HttpError, isUuid } from "../lib/access.js";
import type { StructuredStudyGuide } from "../agent/agent-client.js";

export type RetrievalMode = "personal" | "course";
export type JobType = "generate_guide" | "revise_guide" | "search_index_guide";
export type DiscoveryStatus = "private" | "published" | "delisted";

const MAX_TITLE = 200;
const MAX_SUMMARY = 10_000;
const MAX_KEY_POINT = 2_000;
const MAX_SNIPPET = 2_000;
const IDEMPOTENCY_TTL_DAYS = 1;

export class FeatureError extends HttpError {
  code: string;
  details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    code: string,
    details?: Record<string, unknown>,
  ) {
    super(statusCode, message);
    this.code = code;
    this.details = details;
  }
}

export function featureErrorBody(err: FeatureError) {
  return { message: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) };
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requireIdempotencyKey(headers: { [key: string]: unknown }): string {
  const raw = headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== "string" || key.trim() === "") {
    throw new FeatureError(400, "Idempotency-Key header is required.", "IDEMPOTENCY_KEY_REQUIRED");
  }
  if (key.length > 200) {
    throw new FeatureError(400, "Idempotency-Key is too long.", "IDEMPOTENCY_KEY_INVALID");
  }
  return key;
}

function cleanString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") {
    throw new FeatureError(400, `${field} is required.`, "VALIDATION_ERROR", { field });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new FeatureError(400, `${field} is required.`, "VALIDATION_ERROR", { field });
  }
  if (trimmed.length > max) {
    throw new FeatureError(400, `${field} is too long.`, "VALIDATION_ERROR", { field, max });
  }
  return trimmed;
}

export function parseRetrievalMode(value: unknown): RetrievalMode {
  if (value === "personal" || value === "course") return value;
  throw new FeatureError(400, "retrievalMode must be personal or course.", "VALIDATION_ERROR", {
    field: "retrievalMode",
  });
}

export function parseCreateBody(body: unknown) {
  const input = (body ?? {}) as { target?: unknown; retrievalMode?: unknown };
  return {
    target: cleanString(input.target, "target", MAX_TITLE),
    retrievalMode: parseRetrievalMode(input.retrievalMode),
  };
}

export function normalizeGuide(raw: StructuredStudyGuide): StructuredStudyGuide {
  const title = cleanString(raw.title, "title", MAX_TITLE);
  const summary = cleanString(raw.summary, "summary", MAX_SUMMARY);
  if (!Array.isArray(raw.concepts) || raw.concepts.length < 1 || raw.concepts.length > 20) {
    throw new FeatureError(422, "Agent returned an invalid concept list.", "INVALID_AGENT_OUTPUT");
  }
  const rawSources = Array.isArray(raw.sources) ? raw.sources : [];
  const seenSourceRefs = new Set<string>();
  const sources = rawSources.map((source, sourceIndex) => {
    const ref = cleanString(source.ref, `sources[${sourceIndex}].ref`, MAX_TITLE);
    if (seenSourceRefs.has(ref)) {
      throw new FeatureError(422, "Agent returned duplicate source definitions.", "INVALID_AGENT_OUTPUT", {
        ref,
      });
    }
    seenSourceRefs.add(ref);
    if (!isUuid(source.materialId)) {
      throw new FeatureError(422, "Agent returned an invalid source material.", "INVALID_AGENT_OUTPUT", {
        ref,
      });
    }
    if (source.page !== undefined && (!Number.isInteger(source.page) || source.page <= 0)) {
      throw new FeatureError(422, "Agent returned an invalid source page.", "INVALID_AGENT_OUTPUT", {
        ref,
      });
    }
    if (typeof source.score !== "number" || source.score < 0 || source.score > 1) {
      throw new FeatureError(422, "Agent returned an invalid source score.", "INVALID_AGENT_OUTPUT", {
        ref,
      });
    }
    return {
      ref,
      materialId: source.materialId,
      page: source.page,
      snippet: cleanString(source.snippet, `sources[${sourceIndex}].snippet`, MAX_SNIPPET),
      score: source.score,
    };
  });
  const sourceMap = new Map(sources.map((source) => [source.ref, source]));
  return {
    title,
    summary,
    concepts: raw.concepts.map((concept, conceptIndex) => {
      const keyPoints = concept.keyPoints;
      if (!Array.isArray(keyPoints) || keyPoints.length < 1 || keyPoints.length > 20) {
        throw new FeatureError(422, "Agent returned invalid key points.", "INVALID_AGENT_OUTPUT", {
          conceptIndex,
        });
      }
      const sourceRefs = Array.isArray(concept.sourceRefs) ? concept.sourceRefs : [];
      const normalizedSourceRefs = sourceRefs.map((ref, refIndex) => {
        const cleanRef = cleanString(ref, `concept.sourceRefs[${refIndex}]`, MAX_TITLE);
        if (!sourceMap.has(cleanRef)) {
          throw new FeatureError(422, "Agent returned an unresolved source reference.", "INVALID_AGENT_OUTPUT", {
            ref: cleanRef,
          });
        }
        return cleanRef;
      });
      return {
        logicalConceptId: concept.logicalConceptId,
        title: cleanString(concept.title, "concept.title", MAX_TITLE),
        category:
          typeof concept.category === "string" && concept.category.trim()
            ? concept.category.trim().slice(0, MAX_TITLE)
            : undefined,
        summary: cleanString(concept.summary, "concept.summary", MAX_SUMMARY),
        keyPoints: keyPoints.map((point, pointIndex) =>
          cleanString(point, `concept.keyPoints[${pointIndex}]`, MAX_KEY_POINT),
        ),
        sourceRefs: normalizedSourceRefs,
      };
    }),
    sources,
  };
}

export async function getAuthorizedSourceRows(
  q: TxQuery,
  userId: string,
  courseId: string,
  retrievalMode: RetrievalMode,
  materialIds: string[],
) {
  const uniqueMaterialIds = [...new Set(materialIds)].filter(isUuid);
  if (uniqueMaterialIds.length === 0) {
    return new Map<string, { material_id: string }>();
  }
  const rows = await q<{ material_id: string }>(
    `SELECT id AS material_id
     FROM materials
     WHERE id = ANY($1::uuid[])
       AND course_id = $2
       AND deleted_at IS NULL
       AND ($3::text = 'course' OR owner_user_id = $4)`,
    [uniqueMaterialIds, courseId, retrievalMode, userId],
  );
  return new Map(rows.map((row) => [row.material_id, row]));
}

async function insertSnapshot(
  q: TxQuery,
  input: {
    guideId: string;
    userId: string | null;
    versionNumber: number;
    origin: "generated" | "user_edit" | "ai_revision";
    baseVersionId: string | null;
    courseId: string;
    retrievalMode: RetrievalMode;
    guide: StructuredStudyGuide;
  },
) {
  const sourceByRef = new Map(input.guide.sources.map((source) => [source.ref, source]));
  const authorizedSources = await getAuthorizedSourceRows(
    q,
    input.userId ?? "",
    input.courseId,
    input.retrievalMode,
    input.guide.sources.map((source) => source.materialId),
  );
  for (const source of input.guide.sources) {
    if (!authorizedSources.has(source.materialId)) {
      throw new FeatureError(422, "Agent returned an unauthorized source.", "UNAUTHORIZED_SOURCE", {
        materialId: source.materialId,
      });
    }
  }

  const [version] = await q<{ id: string }>(
    `INSERT INTO study_guide_versions
       (guide_id, version_number, origin, base_version_id, created_by_user_id, title, summary)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [
      input.guideId,
      input.versionNumber,
      input.origin,
      input.baseVersionId,
      input.userId,
      input.guide.title,
      input.guide.summary,
    ],
  );
  if (!version) throw new FeatureError(500, "Could not create guide version.", "PERSISTENCE_FAILED");

  for (const [conceptIndex, concept] of input.guide.concepts.entries()) {
    const logicalConceptId =
      concept.logicalConceptId && isUuid(concept.logicalConceptId)
        ? concept.logicalConceptId
        : randomUUID();
    const [conceptRow] = await q<{ id: string }>(
      `INSERT INTO study_guide_concepts
         (version_id, logical_concept_id, title, category, summary, content_origin, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [
        version.id,
        logicalConceptId,
        concept.title,
        concept.category ?? null,
        concept.summary,
        input.origin,
        conceptIndex,
      ],
    );
    if (!conceptRow) {
      throw new FeatureError(500, "Could not create guide concept.", "PERSISTENCE_FAILED");
    }

    for (const [pointIndex, point] of concept.keyPoints.entries()) {
      await q(
        `INSERT INTO study_guide_key_points (concept_id, content, sort_order)
         VALUES ($1,$2,$3)`,
        [conceptRow.id, point, pointIndex],
      );
    }

    let sourceIndex = 0;
    for (const ref of concept.sourceRefs) {
      const source = sourceByRef.get(ref);
      if (!source) {
        throw new FeatureError(422, "Agent returned an unresolved source reference.", "INVALID_AGENT_OUTPUT", {
          ref,
        });
      }
      await q(
        `INSERT INTO study_guide_sources
           (concept_id, material_id, page, snippet, score, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [conceptRow.id, source.materialId, source.page ?? null, source.snippet, source.score, sourceIndex],
      );
      sourceIndex += 1;
    }
  }

  return version.id;
}

export async function createGuideWithJob(input: {
  userId: string;
  courseId: string;
  target: string;
  retrievalMode: RetrievalMode;
  idempotencyKey: string;
  hash: string;
}) {
  return withTransaction(async (q) => {
    const existing = await q<{ operation_type: string; request_hash: string; response_status: number; response_body: unknown }>(
      `SELECT operation_type, request_hash, response_status, response_body
       FROM study_guide_idempotency_keys
       WHERE owner_user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].operation_type === "create" && existing[0].request_hash === input.hash) {
        return { replay: true, status: existing[0].response_status, body: existing[0].response_body };
      }
      throw new FeatureError(409, "Idempotency key was reused for a different request.", "IDEMPOTENCY_KEY_REUSED");
    }

    const [guide] = await q<{ id: string; created_at: Date }>(
      `INSERT INTO study_guides (owner_user_id, course_id, target, retrieval_mode, status)
       VALUES ($1,$2,$3,$4,'queued')
       RETURNING id, created_at`,
      [input.userId, input.courseId, input.target, input.retrievalMode],
    );
    if (!guide) throw new FeatureError(500, "Could not create study guide.", "PERSISTENCE_FAILED");

    await q(
      `INSERT INTO study_guide_jobs
         (type, scope_type, scope_id, guide_id, owner_user_id, dedupe_key, payload)
       VALUES ('generate_guide','guide',$1,$1,$2,$3,$4::jsonb)`,
      [
        guide.id,
        input.userId,
        `generate:${guide.id}`,
        JSON.stringify({
          guideId: guide.id,
          userId: input.userId,
          courseId: input.courseId,
          target: input.target,
          retrievalMode: input.retrievalMode,
        }),
      ],
    );

    const body = {
      guideId: guide.id,
      courseId: input.courseId,
      target: input.target,
      retrievalMode: input.retrievalMode,
      status: "queued",
      createdAt: guide.created_at.toISOString(),
    };
    await q(
      `INSERT INTO study_guide_idempotency_keys
         (owner_user_id, idempotency_key, operation_type, request_hash, guide_id, response_status, response_body, expires_at)
       VALUES ($1,$2,'create',$3,$4,202,$5::jsonb,now() + ($6 || ' days')::interval)`,
      [input.userId, input.idempotencyKey, input.hash, guide.id, JSON.stringify(body), IDEMPOTENCY_TTL_DAYS],
    );
    return { replay: false, status: 202, body };
  });
}

export async function persistGeneratedGuide(input: {
  guideId: string;
  userId: string;
  courseId: string;
  retrievalMode: RetrievalMode;
  guide: StructuredStudyGuide;
  jobId?: string;
  leaseToken?: string;
}) {
  const guide = normalizeGuide(input.guide);
  return withTransaction(async (q) => {
    if (input.jobId && input.leaseToken) {
      const [job] = await q<{ id: string }>(
        `SELECT id FROM study_guide_jobs
         WHERE id=$1 AND lease_token=$2 AND status='running'
         FOR UPDATE`,
        [input.jobId, input.leaseToken],
      );
      if (!job) throw new FeatureError(409, "Worker lease is no longer active.", "LEASE_LOST");
    }
    const [row] = await q<{ id: string; current_version_id: string | null }>(
      `SELECT id, current_version_id FROM study_guides
       WHERE id=$1 AND owner_user_id=$2
       FOR UPDATE`,
      [input.guideId, input.userId],
    );
    if (!row) throw new FeatureError(404, "Not found", "NOT_FOUND");
    if (row.current_version_id) return row.current_version_id;

    const versionId = await insertSnapshot(q, {
      guideId: input.guideId,
      userId: null,
      versionNumber: 1,
      origin: "generated",
      baseVersionId: null,
      courseId: input.courseId,
      retrievalMode: input.retrievalMode,
      guide,
    });
    await q(
      `UPDATE study_guides
       SET current_version_id=$1, status='ready', ready_at=now(), updated_at=now(),
           error_code=NULL, error_message=NULL
       WHERE id=$2`,
      [versionId, input.guideId],
    );
    return versionId;
  });
}

export async function markInitialGuideFailed(
  guideId: string,
  errorCode: string,
  errorMessage: string,
) {
  await query(
    `UPDATE study_guides
     SET status='failed', error_code=$2, error_message=$3, updated_at=now()
     WHERE id=$1 AND current_version_id IS NULL`,
    [guideId, errorCode, errorMessage.slice(0, 500)],
  );
}

export async function serializeGuide(guideId: string, userId: string) {
  const guides = await query<{
    id: string;
    owner_user_id: string;
    course_id: string;
    target: string;
    retrieval_mode: RetrievalMode;
    current_version_id: string | null;
    discovery_status: DiscoveryStatus;
    published_version_id: string | null;
    published_at: Date | null;
    status: string;
    error_code: string | null;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
    ready_at: Date | null;
    title: string | null;
    summary: string | null;
    version_number: number | null;
    version_created_at: Date | null;
  }>(
    `SELECT g.*, v.title, v.summary, v.version_number, v.created_at AS version_created_at
     FROM study_guides g
     LEFT JOIN study_guide_versions v ON v.id = g.current_version_id
     WHERE g.id=$1 AND g.owner_user_id=$2`,
    [guideId, userId],
  );
  const guide = guides[0];
  if (!guide) return null;
  if (!guide.current_version_id) {
    return {
      id: guide.id,
      courseId: guide.course_id,
      target: guide.target,
      retrievalMode: guide.retrieval_mode,
      status: guide.status,
      errorCode: guide.error_code,
      errorMessage: guide.error_message,
      currentVersionId: null,
      discoveryStatus: guide.discovery_status ?? "private",
      publishedVersionId: guide.published_version_id,
      publishedAt: guide.published_at?.toISOString() ?? null,
      createdAt: guide.created_at.toISOString(),
      updatedAt: guide.updated_at.toISOString(),
    };
  }
  return {
    id: guide.id,
    courseId: guide.course_id,
    target: guide.target,
    retrievalMode: guide.retrieval_mode,
    status: guide.status,
    errorCode: guide.error_code,
    errorMessage: guide.error_message,
    currentVersionId: guide.current_version_id,
    discoveryStatus: guide.discovery_status ?? "private",
    publishedVersionId: guide.published_version_id,
    publishedAt: guide.published_at?.toISOString() ?? null,
    currentVersion: await serializeVersion(guide.current_version_id, guide.id, userId),
    createdAt: guide.created_at.toISOString(),
    updatedAt: guide.updated_at.toISOString(),
    readyAt: guide.ready_at?.toISOString() ?? null,
  };
}

export async function serializeVersion(versionId: string, guideId: string, userId: string) {
  const versions = await query<{
    id: string;
    guide_id: string;
    version_number: number;
    origin: string;
    base_version_id: string | null;
    title: string;
    summary: string;
    created_at: Date;
  }>(
    `SELECT v.*
     FROM study_guide_versions v
     JOIN study_guides g ON g.id = v.guide_id
     WHERE v.id=$1 AND v.guide_id=$2 AND g.owner_user_id=$3`,
    [versionId, guideId, userId],
  );
  const version = versions[0];
  if (!version) return null;
  const concepts = await query<{
    id: string;
    logical_concept_id: string;
    title: string;
    category: string | null;
    summary: string;
    content_origin: string;
    sort_order: number;
  }>(
    `SELECT id, logical_concept_id, title, category, summary, content_origin, sort_order
     FROM study_guide_concepts
     WHERE version_id=$1
     ORDER BY sort_order`,
    [version.id],
  );
  const conceptIds = concepts.map((concept) => concept.id);
  const keyPoints = conceptIds.length
    ? await query<{ concept_id: string; content: string; sort_order: number }>(
        `SELECT concept_id, content, sort_order
         FROM study_guide_key_points
         WHERE concept_id = ANY($1::uuid[])
         ORDER BY sort_order`,
        [conceptIds],
      )
    : [];
  const sources = conceptIds.length
    ? await query<{
        concept_id: string;
        material_id: string;
        page: number | null;
        snippet: string;
        score: number;
        sort_order: number;
      }>(
        `SELECT concept_id, material_id, page, snippet, score, sort_order
         FROM study_guide_sources
         WHERE concept_id = ANY($1::uuid[])
         ORDER BY sort_order`,
        [conceptIds],
      )
    : [];
  return {
    id: version.id,
    guideId: version.guide_id,
    versionNumber: version.version_number,
    origin: version.origin,
    baseVersionId: version.base_version_id,
    title: version.title,
    summary: version.summary,
    concepts: concepts.map((concept) => ({
      id: concept.id,
      logicalConceptId: concept.logical_concept_id,
      title: concept.title,
      category: concept.category,
      summary: concept.summary,
      contentOrigin: concept.content_origin,
      keyPoints: keyPoints
        .filter((point) => point.concept_id === concept.id)
        .map((point) => point.content),
      sources: sources
        .filter((source) => source.concept_id === concept.id)
        .map((source) => ({
          materialId: source.material_id,
          page: source.page,
          snippet: source.snippet,
          score: source.score,
        })),
    })),
    createdAt: version.created_at.toISOString(),
  };
}

type SnapshotConcept = {
  logicalConceptId: string;
  title: string;
  category?: string;
  summary: string;
  keyPoints: string[];
  sourceRefs: string[];
};

export type VersionSnapshot = {
  id: string;
  guideId: string;
  versionNumber: number;
  title: string;
  summary: string;
  concepts: SnapshotConcept[];
  sources: StructuredStudyGuide["sources"];
};

export async function loadSnapshot(q: TxQuery, versionId: string, guideId: string): Promise<VersionSnapshot> {
  const [version] = await q<{
    id: string;
    guide_id: string;
    version_number: number;
    title: string;
    summary: string;
  }>(
    `SELECT id, guide_id, version_number, title, summary
     FROM study_guide_versions
     WHERE id=$1 AND guide_id=$2`,
    [versionId, guideId],
  );
  if (!version) throw new FeatureError(404, "Not found", "NOT_FOUND");
  const concepts = await q<{
    id: string;
    logical_concept_id: string;
    title: string;
    category: string | null;
    summary: string;
    sort_order: number;
  }>(
    `SELECT id, logical_concept_id, title, category, summary, sort_order
     FROM study_guide_concepts
     WHERE version_id=$1
     ORDER BY sort_order`,
    [version.id],
  );
  const conceptRowIds = concepts.map((concept) => concept.id);
  const keyPoints = conceptRowIds.length
    ? await q<{ concept_id: string; content: string; sort_order: number }>(
        `SELECT concept_id, content, sort_order
         FROM study_guide_key_points
         WHERE concept_id = ANY($1::uuid[])
         ORDER BY sort_order`,
        [conceptRowIds],
      )
    : [];
  const sources = conceptRowIds.length
    ? await q<{
        concept_id: string;
        material_id: string;
        page: number | null;
        snippet: string;
        score: number;
        sort_order: number;
      }>(
        `SELECT concept_id, material_id, page, snippet, score, sort_order
         FROM study_guide_sources
         WHERE concept_id = ANY($1::uuid[])
         ORDER BY sort_order`,
        [conceptRowIds],
      )
    : [];
  const sourceRefFor = (conceptId: string, sortOrder: number) => `${conceptId}:${sortOrder}`;
  return {
    id: version.id,
    guideId: version.guide_id,
    versionNumber: version.version_number,
    title: version.title,
    summary: version.summary,
    concepts: concepts.map((concept) => ({
      logicalConceptId: concept.logical_concept_id,
      title: concept.title,
      category: concept.category ?? undefined,
      summary: concept.summary,
      keyPoints: keyPoints
        .filter((point) => point.concept_id === concept.id)
        .map((point) => point.content),
      sourceRefs: sources
        .filter((source) => source.concept_id === concept.id)
        .map((source) => sourceRefFor(concept.id, source.sort_order)),
    })),
    sources: sources.map((source) => ({
      ref: sourceRefFor(source.concept_id, source.sort_order),
      materialId: source.material_id,
      page: source.page ?? undefined,
      snippet: source.snippet,
      score: source.score,
    })),
  };
}

function applyManualOperations(
  snapshot: VersionSnapshot,
  operations: unknown[],
): StructuredStudyGuide {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 20) {
    throw new FeatureError(400, "operations must contain 1-20 items.", "VALIDATION_ERROR", {
      field: "operations",
    });
  }
  const next: StructuredStudyGuide = {
    title: snapshot.title,
    summary: snapshot.summary,
    concepts: snapshot.concepts.map((concept) => ({ ...concept })),
    sources: [...snapshot.sources],
  };

  for (const raw of operations) {
    const op = raw as {
      type?: string;
      conceptId?: string;
      title?: unknown;
      category?: unknown;
      summary?: unknown;
      keyPoints?: unknown;
    };
    if (op.type === "updateGuide") {
      if (op.title !== undefined) next.title = cleanString(op.title, "title", MAX_TITLE);
      if (op.summary !== undefined) next.summary = cleanString(op.summary, "summary", MAX_SUMMARY);
      continue;
    }
    if (op.type !== "updateConcept" || !isUuid(op.conceptId)) {
      throw new FeatureError(400, "Unsupported edit operation.", "VALIDATION_ERROR");
    }
    const concept = next.concepts.find((item) => item.logicalConceptId === op.conceptId);
    if (!concept) {
      throw new FeatureError(400, "Unknown conceptId.", "VALIDATION_ERROR", {
        conceptId: op.conceptId,
      });
    }
    const citationInvalidating =
      op.summary !== undefined || op.keyPoints !== undefined;
    if (op.title !== undefined) concept.title = cleanString(op.title, "concept.title", MAX_TITLE);
    if (op.category !== undefined) {
      concept.category =
        typeof op.category === "string" && op.category.trim()
          ? op.category.trim().slice(0, MAX_TITLE)
          : undefined;
    }
    if (op.summary !== undefined) {
      concept.summary = cleanString(op.summary, "concept.summary", MAX_SUMMARY);
    }
    if (op.keyPoints !== undefined) {
      if (!Array.isArray(op.keyPoints) || op.keyPoints.length < 1 || op.keyPoints.length > 20) {
        throw new FeatureError(400, "keyPoints must contain 1-20 items.", "VALIDATION_ERROR", {
          field: "keyPoints",
        });
      }
      concept.keyPoints = op.keyPoints.map((point, index) =>
        cleanString(point, `keyPoints[${index}]`, MAX_KEY_POINT),
      );
    }
    if (citationInvalidating) {
      const removedRefs = new Set(concept.sourceRefs);
      concept.sourceRefs = [];
      next.sources = next.sources.filter((source) => !removedRefs.has(source.ref));
    }
  }
  return normalizeGuide(next);
}

export async function applyManualEdit(input: {
  userId: string;
  guideId: string;
  ifMatch: string;
  idempotencyKey: string;
  hash: string;
  operations: unknown[];
}) {
  return withTransaction(async (q) => {
    const existing = await q<{ operation_type: string; request_hash: string; response_status: number; response_body: unknown }>(
      `SELECT operation_type, request_hash, response_status, response_body
       FROM study_guide_idempotency_keys
       WHERE owner_user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].operation_type === "manual_edit" && existing[0].request_hash === input.hash) {
        return { status: existing[0].response_status, body: existing[0].response_body };
      }
      throw new FeatureError(409, "Idempotency key was reused for a different request.", "IDEMPOTENCY_KEY_REUSED");
    }

    const [guide] = await q<{
      id: string;
      course_id: string;
      retrieval_mode: RetrievalMode;
      current_version_id: string | null;
    }>(
      `SELECT id, course_id, retrieval_mode, current_version_id
       FROM study_guides
       WHERE id=$1 AND owner_user_id=$2
       FOR UPDATE`,
      [input.guideId, input.userId],
    );
    if (!guide || !guide.current_version_id) {
      throw new FeatureError(404, "Not found", "NOT_FOUND");
    }
    if (guide.current_version_id !== input.ifMatch) {
      throw new FeatureError(409, "The guide changed before this update was applied.", "VERSION_CONFLICT", {
        currentVersionId: guide.current_version_id,
      });
    }
    const snapshot = await loadSnapshot(q, guide.current_version_id, guide.id);
    const next = applyManualOperations(snapshot, input.operations);
    const versionId = await insertSnapshot(q, {
      guideId: guide.id,
      userId: input.userId,
      versionNumber: snapshot.versionNumber + 1,
      origin: "user_edit",
      baseVersionId: snapshot.id,
      courseId: guide.course_id,
      retrievalMode: guide.retrieval_mode,
      guide: next,
    });
    await q(
      `UPDATE study_guides SET current_version_id=$1, updated_at=now() WHERE id=$2`,
      [versionId, guide.id],
    );
    const body = { guideId: guide.id, versionId, status: "ready" };
    await q(
      `INSERT INTO study_guide_idempotency_keys
         (owner_user_id, idempotency_key, operation_type, request_hash, guide_id, response_status, response_body, expires_at)
       VALUES ($1,$2,'manual_edit',$3,$4,201,$5::jsonb,now() + ($6 || ' days')::interval)`,
      [input.userId, input.idempotencyKey, input.hash, guide.id, JSON.stringify(body), IDEMPOTENCY_TTL_DAYS],
    );
    return { status: 201, body };
  });
}

export async function createRevisionRequest(input: {
  userId: string;
  guideId: string;
  baseVersionId: string;
  instruction: string;
  conceptIds: string[];
  idempotencyKey: string;
  hash: string;
}) {
  if (!isUuid(input.baseVersionId)) {
    throw new FeatureError(400, "baseVersionId must be a valid UUID.", "VALIDATION_ERROR");
  }
  if (input.conceptIds.length < 1 || input.conceptIds.length > 20 || input.conceptIds.some((id) => !isUuid(id))) {
    throw new FeatureError(400, "conceptIds must contain 1-20 UUIDs.", "VALIDATION_ERROR");
  }
  const instruction = cleanString(input.instruction, "instruction", MAX_SUMMARY);
  return withTransaction(async (q) => {
    const existing = await q<{ operation_type: string; request_hash: string; response_status: number; response_body: unknown }>(
      `SELECT operation_type, request_hash, response_status, response_body
       FROM study_guide_idempotency_keys
       WHERE owner_user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].operation_type === "ai_revision" && existing[0].request_hash === input.hash) {
        return { status: existing[0].response_status, body: existing[0].response_body };
      }
      throw new FeatureError(409, "Idempotency key was reused for a different request.", "IDEMPOTENCY_KEY_REUSED");
    }

    const [guide] = await q<{ id: string; current_version_id: string | null }>(
      `SELECT id, current_version_id
       FROM study_guides
       WHERE id=$1 AND owner_user_id=$2
       FOR UPDATE`,
      [input.guideId, input.userId],
    );
    if (!guide || !guide.current_version_id) throw new FeatureError(404, "Not found", "NOT_FOUND");
    if (guide.current_version_id !== input.baseVersionId) {
      throw new FeatureError(409, "The guide changed before this revision was requested.", "VERSION_CONFLICT", {
        currentVersionId: guide.current_version_id,
      });
    }

    const [revision] = await q<{ id: string }>(
      `INSERT INTO study_guide_revision_requests
         (guide_id, owner_user_id, base_version_id, instruction, concept_ids)
       VALUES ($1,$2,$3,$4,$5::uuid[])
       RETURNING id`,
      [guide.id, input.userId, input.baseVersionId, instruction, input.conceptIds],
    );
    if (!revision) throw new FeatureError(500, "Could not create revision.", "PERSISTENCE_FAILED");
    await q(
      `INSERT INTO study_guide_jobs
         (type, scope_type, scope_id, guide_id, owner_user_id, dedupe_key, payload)
       VALUES ('revise_guide','guide',$1,$1,$2,$3,$4::jsonb)`,
      [
        guide.id,
        input.userId,
        `revise:${revision.id}`,
        JSON.stringify({
          revisionId: revision.id,
          guideId: guide.id,
          userId: input.userId,
          baseVersionId: input.baseVersionId,
          instruction,
          conceptIds: input.conceptIds,
        }),
      ],
    );
    const body = {
      revisionId: revision.id,
      guideId: guide.id,
      baseVersionId: input.baseVersionId,
      status: "queued",
    };
    await q(
      `INSERT INTO study_guide_idempotency_keys
         (owner_user_id, idempotency_key, operation_type, request_hash, guide_id, response_status, response_body, expires_at)
       VALUES ($1,$2,'ai_revision',$3,$4,202,$5::jsonb,now() + ($6 || ' days')::interval)`,
      [input.userId, input.idempotencyKey, input.hash, guide.id, JSON.stringify(body), IDEMPOTENCY_TTL_DAYS],
    );
    return { status: 202, body };
  });
}

export async function getRevisionForOwner(userId: string, guideId: string, revisionId: string) {
  const rows = await query<{
    id: string;
    guide_id: string;
    base_version_id: string;
    result_version_id: string | null;
    status: string;
    error_code: string | null;
    created_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT r.id, r.guide_id, r.base_version_id, r.result_version_id, r.status,
            r.error_code, r.created_at, r.started_at, r.completed_at
     FROM study_guide_revision_requests r
     JOIN study_guides g ON g.id = r.guide_id
     WHERE r.id=$1 AND r.guide_id=$2 AND g.owner_user_id=$3`,
    [revisionId, guideId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    guideId: row.guide_id,
    baseVersionId: row.base_version_id,
    resultVersionId: row.result_version_id,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

export async function persistRevision(input: {
  revisionId: string;
  guideId: string;
  userId: string;
  baseVersionId: string;
  guide: StructuredStudyGuide;
  jobId?: string;
  leaseToken?: string;
}) {
  const revised = normalizeGuide(input.guide);
  return withTransaction(async (q) => {
    if (input.jobId && input.leaseToken) {
      const [job] = await q<{ id: string }>(
        `SELECT id FROM study_guide_jobs
         WHERE id=$1 AND lease_token=$2 AND status='running'
         FOR UPDATE`,
        [input.jobId, input.leaseToken],
      );
      if (!job) throw new FeatureError(409, "Worker lease is no longer active.", "LEASE_LOST");
    }
    const [guide] = await q<{
      id: string;
      course_id: string;
      retrieval_mode: RetrievalMode;
      current_version_id: string | null;
    }>(
      `SELECT id, course_id, retrieval_mode, current_version_id
       FROM study_guides
       WHERE id=$1 AND owner_user_id=$2
       FOR UPDATE`,
      [input.guideId, input.userId],
    );
    if (!guide || guide.current_version_id !== input.baseVersionId) {
      await q(
        `UPDATE study_guide_revision_requests
         SET status='failed', error_code='BASE_VERSION_STALE', completed_at=now()
         WHERE id=$1 AND guide_id=$2`,
        [input.revisionId, input.guideId],
      );
      throw new FeatureError(409, "Base version is no longer current.", "BASE_VERSION_STALE");
    }
    const snapshot = await loadSnapshot(q, input.baseVersionId, input.guideId);
    const revisedConceptIds = revised.concepts.map((concept) => concept.logicalConceptId);
    const requested = new Set(revisedConceptIds);
    if (requested.size !== revisedConceptIds.length) {
      throw new FeatureError(422, "Agent returned duplicate revised concepts.", "INVALID_AGENT_OUTPUT");
    }
    const expected = new Set(
      (
        await q<{ concept_ids: string[] }>(
          `SELECT concept_ids FROM study_guide_revision_requests
           WHERE id=$1 AND guide_id=$2 AND owner_user_id=$3 FOR UPDATE`,
          [input.revisionId, input.guideId, input.userId],
        )
      )[0]?.concept_ids ?? [],
    );
    if (
      requested.size !== expected.size ||
      [...requested].some((id) => !id || !expected.has(id))
    ) {
      throw new FeatureError(422, "Agent revised an unexpected concept set.", "INVALID_AGENT_OUTPUT");
    }

    const byId = new Map(revised.concepts.map((concept) => [concept.logicalConceptId, concept]));
    const selectedSnapshotRefs = new Set(
      snapshot.concepts
        .filter((concept) => expected.has(concept.logicalConceptId))
        .flatMap((concept) => concept.sourceRefs),
    );
    const next: StructuredStudyGuide = {
      title: snapshot.title,
      summary: snapshot.summary,
      concepts: snapshot.concepts.map((concept) => byId.get(concept.logicalConceptId) ?? concept),
      sources: [
        ...snapshot.sources.filter((source) => !selectedSnapshotRefs.has(source.ref)),
        ...revised.sources,
      ],
    };
    const versionId = await insertSnapshot(q, {
      guideId: input.guideId,
      userId: null,
      versionNumber: snapshot.versionNumber + 1,
      origin: "ai_revision",
      baseVersionId: snapshot.id,
      courseId: guide.course_id,
      retrievalMode: guide.retrieval_mode,
      guide: normalizeGuide(next),
    });
    await q(
      `UPDATE study_guides SET current_version_id=$1, updated_at=now() WHERE id=$2`,
      [versionId, input.guideId],
    );
    await q(
      `UPDATE study_guide_revision_requests
       SET status='completed', result_version_id=$1, completed_at=now()
       WHERE id=$2 AND guide_id=$3`,
      [versionId, input.revisionId, input.guideId],
    );
    return versionId;
  });
}

function clampDiscoverLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, 50);
}

async function ensurePublishableCitations(q: TxQuery, guideId: string, versionId: string, courseId: string) {
  const [row] = await q<{
    citation_count: number;
    ineligible_count: number;
  }>(
    `SELECT
       COUNT(s.material_id)::int AS citation_count,
       COUNT(s.material_id) FILTER (
         WHERE m.id IS NULL
            OR m.course_id <> $3::text
            OR m.scope <> 'shared'
            OR m.deleted_at IS NOT NULL
            OR m.status <> 'READY'
       )::int AS ineligible_count
     FROM study_guide_concepts c
     LEFT JOIN study_guide_sources s ON s.concept_id = c.id
     LEFT JOIN materials m ON m.id = s.material_id
     WHERE c.version_id=$2
       AND EXISTS (
         SELECT 1 FROM study_guide_versions v
         WHERE v.id=$2 AND v.guide_id=$1
       )`,
    [guideId, versionId, courseId],
  );
  if ((row?.ineligible_count ?? 0) > 0) {
    throw new FeatureError(
      422,
      "This guide contains citations that are not course-shareable.",
      "PUBLISH_CITATIONS_NOT_SHAREABLE",
      { ineligibleCitationCount: row.ineligible_count },
    );
  }
}

async function ensurePublishableStructure(q: TxQuery, guideId: string, versionId: string) {
  const [row] = await q<{
    concept_count: number;
    key_point_count: number;
  }>(
    `SELECT
       COUNT(DISTINCT c.id)::int AS concept_count,
       COUNT(k.id)::int AS key_point_count
     FROM study_guide_versions v
     LEFT JOIN study_guide_concepts c ON c.version_id = v.id
     LEFT JOIN study_guide_key_points k ON k.concept_id = c.id
     WHERE v.id=$1 AND v.guide_id=$2
     GROUP BY v.id`,
    [versionId, guideId],
  );
  if (!row || row.concept_count < 1 || row.key_point_count < 1) {
    throw new FeatureError(
      422,
      "This guide is missing required structured content.",
      "PUBLISH_STRUCTURE_INVALID",
    );
  }
}

export async function upsertPublishedProjection(
  q: TxQuery,
  guideId: string,
  publication?: { title?: string; summary?: string },
) {
  await q(
    `INSERT INTO published_study_guide_index
       (guide_id, published_version_id, owner_user_id, school_id, course_id,
        professor_id, school_name, course_code, course_name, professor_name,
        title, target, summary, topics, grounding_indicator, published_at)
     SELECT
       g.id,
       g.published_version_id,
       g.owner_user_id,
       c.school_id,
       g.course_id,
       c.professor_id,
       s.name,
       c.code,
       c.name,
       p.name,
       COALESCE(NULLIF($2, ''), v.title),
       g.target,
       COALESCE(NULLIF($3, ''), v.summary),
       COALESCE(
         array_remove(array_agg(DISTINCT COALESCE(NULLIF(sc.category, ''), sc.title)), NULL),
         '{}'::text[]
       ) AS topics,
       CASE WHEN COUNT(src.id) > 0 THEN 'grounded' ELSE 'general' END AS grounding_indicator,
       g.published_at
     FROM study_guides g
     JOIN study_guide_versions v ON v.id = g.published_version_id AND v.guide_id = g.id
     JOIN courses c ON c.id = g.course_id
     JOIN schools s ON s.id = c.school_id
     LEFT JOIN professors p ON p.id = c.professor_id
     LEFT JOIN study_guide_concepts sc ON sc.version_id = v.id
     LEFT JOIN study_guide_sources src ON src.concept_id = sc.id
     WHERE g.id=$1
       AND g.status='ready'
       AND g.discovery_status='published'
       AND g.published_version_id IS NOT NULL
     GROUP BY g.id, v.id, c.id, s.id, p.id
     ON CONFLICT (guide_id) DO UPDATE SET
       published_version_id=EXCLUDED.published_version_id,
       owner_user_id=EXCLUDED.owner_user_id,
       school_id=EXCLUDED.school_id,
       course_id=EXCLUDED.course_id,
       professor_id=EXCLUDED.professor_id,
       school_name=EXCLUDED.school_name,
       course_code=EXCLUDED.course_code,
       course_name=EXCLUDED.course_name,
       professor_name=EXCLUDED.professor_name,
       title=EXCLUDED.title,
       target=EXCLUDED.target,
       summary=EXCLUDED.summary,
       topics=EXCLUDED.topics,
       grounding_indicator=EXCLUDED.grounding_indicator,
       published_at=EXCLUDED.published_at,
       updated_at=now()`,
    [guideId, publication?.title?.trim() ?? null, publication?.summary?.trim() ?? null],
  );
}

export async function publishStudyGuide(input: {
  userId: string;
  guideId: string;
  idempotencyKey: string;
  hash: string;
  title?: string;
  summary?: string;
}) {
  return withTransaction(async (q) => {
    const existing = await q<{ operation_type: string; request_hash: string; response_status: number; response_body: unknown }>(
      `SELECT operation_type, request_hash, response_status, response_body
       FROM study_guide_idempotency_keys
       WHERE owner_user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].operation_type === "publish" && existing[0].request_hash === input.hash) {
        return { status: existing[0].response_status, body: existing[0].response_body };
      }
      throw new FeatureError(409, "Idempotency key was reused for a different request.", "IDEMPOTENCY_KEY_REUSED");
    }

    const [guide] = await q<{
      id: string;
      course_id: string;
      status: string;
      current_version_id: string | null;
      discovery_status: DiscoveryStatus;
    }>(
      `SELECT id, course_id, status, current_version_id, discovery_status
       FROM study_guides
       WHERE id=$1 AND owner_user_id=$2
       FOR UPDATE`,
      [input.guideId, input.userId],
    );
    if (!guide) throw new FeatureError(404, "Not found", "NOT_FOUND");
    if (guide.discovery_status === "delisted") {
      throw new FeatureError(409, "A delisted guide cannot be published.", "GUIDE_DELISTED");
    }
    if (guide.status !== "ready" || !guide.current_version_id) {
      throw new FeatureError(409, "Only ready guides can be published.", "GUIDE_NOT_READY");
    }

    await ensurePublishableStructure(q, guide.id, guide.current_version_id);
    await ensurePublishableCitations(q, guide.id, guide.current_version_id, guide.course_id);

    const [updated] = await q<{ published_version_id: string; published_at: Date }>(
      `UPDATE study_guides
       SET discovery_status='published',
           published_version_id=$1,
           published_at=COALESCE(published_at, now()),
           updated_at=now()
       WHERE id=$2 AND owner_user_id=$3
       RETURNING published_version_id, published_at`,
      [guide.current_version_id, guide.id, input.userId],
    );
    if (!updated) throw new FeatureError(500, "Could not publish guide.", "PERSISTENCE_FAILED");

    await q(
      `INSERT INTO study_guide_jobs
         (type, scope_type, scope_id, guide_id, owner_user_id, dedupe_key, priority, payload)
       VALUES ('search_index_guide','guide',$1,$1,$2,$3,-10,$4::jsonb)
       ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING`,
      [
        guide.id,
        input.userId,
        `search-index:${guide.id}`,
        JSON.stringify({
          guideId: guide.id,
          userId: input.userId,
          title: input.title?.trim() ?? null,
          summary: input.summary?.trim() ?? null,
        }),
      ],
    );

    const body = {
      guideId: guide.id,
      publishedVersionId: updated.published_version_id,
      publicationStatus: "indexing",
      publishedAt: updated.published_at.toISOString(),
    };
    await q(
      `INSERT INTO study_guide_idempotency_keys
         (owner_user_id, idempotency_key, operation_type, request_hash, guide_id, response_status, response_body, expires_at)
       VALUES ($1,$2,'publish',$3,$4,202,$5::jsonb,now() + ($6 || ' days')::interval)`,
      [input.userId, input.idempotencyKey, input.hash, guide.id, JSON.stringify(body), IDEMPOTENCY_TTL_DAYS],
    );
    return { status: 202, body };
  });
}

export async function unpublishStudyGuide(input: {
  userId: string;
  guideId: string;
  idempotencyKey: string;
  hash: string;
}) {
  return withTransaction(async (q) => {
    const existing = await q<{ operation_type: string; request_hash: string; response_status: number; response_body: unknown }>(
      `SELECT operation_type, request_hash, response_status, response_body
       FROM study_guide_idempotency_keys
       WHERE owner_user_id=$1 AND idempotency_key=$2`,
      [input.userId, input.idempotencyKey],
    );
    if (existing[0]) {
      if (existing[0].operation_type === "unpublish" && existing[0].request_hash === input.hash) {
        return { status: existing[0].response_status, body: existing[0].response_body };
      }
      throw new FeatureError(409, "Idempotency key was reused for a different request.", "IDEMPOTENCY_KEY_REUSED");
    }

    const [guide] = await q<{ id: string }>(
      `SELECT id FROM study_guides WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`,
      [input.guideId, input.userId],
    );
    if (!guide) throw new FeatureError(404, "Not found", "NOT_FOUND");

    await q(
      `UPDATE study_guides
       SET discovery_status='private',
           published_version_id=NULL,
           published_at=NULL,
           updated_at=now()
       WHERE id=$1 AND owner_user_id=$2 AND discovery_status <> 'delisted'`,
      [input.guideId, input.userId],
    );
    await q(`DELETE FROM published_study_guide_index WHERE guide_id=$1`, [input.guideId]);

    const body = { guideId: input.guideId, publicationStatus: "private" };
    await q(
      `INSERT INTO study_guide_idempotency_keys
         (owner_user_id, idempotency_key, operation_type, request_hash, guide_id, response_status, response_body, expires_at)
       VALUES ($1,$2,'unpublish',$3,$4,200,$5::jsonb,now() + ($6 || ' days')::interval)`,
      [input.userId, input.idempotencyKey, input.hash, input.guideId, JSON.stringify(body), IDEMPOTENCY_TTL_DAYS],
    );
    return { status: 200, body };
  });
}

export async function listDiscoverGuides(input: {
  userId: string;
  courseId: string;
  q?: unknown;
  limit?: unknown;
}) {
  const limit = clampDiscoverLimit(input.limit);
  const qText = typeof input.q === "string" ? input.q.trim() : "";
  const params: unknown[] = [input.userId, input.courseId, limit];
  let searchSql = "";
  let orderSql = "i.published_at DESC, i.guide_id DESC";
  if (qText) {
    params.push(qText);
    searchSql = `
       AND (
         i.search_vector @@ plainto_tsquery('english', $4)
         OR i.title ILIKE '%' || $4 || '%'
         OR i.target ILIKE '%' || $4 || '%'
         OR i.summary ILIKE '%' || $4 || '%'
       )`;
    orderSql = "ts_rank(i.search_vector, plainto_tsquery('english', $4)) DESC, i.published_at DESC, i.guide_id DESC";
  }

  const rows = await query<{
    guide_id: string;
    published_version_id: string;
    title: string;
    course_code: string;
    target: string;
    professor_name: string | null;
    topics: string[];
    grounding_indicator: string;
    published_at: Date;
    saved_at: Date | null;
  }>(
    `SELECT i.guide_id, i.published_version_id, i.title, i.course_code, i.target,
            i.professor_name, i.topics, i.grounding_indicator, i.published_at,
            state.saved_at
     FROM published_study_guide_index i
     JOIN study_guides g ON g.id = i.guide_id
     JOIN enrollments e ON e.course_id = i.course_id AND e.user_id = $1
     LEFT JOIN study_guide_discovery_user_state state
       ON state.guide_id = i.guide_id AND state.user_id = $1
     WHERE i.course_id=$2
       AND g.status='ready'
       AND g.discovery_status='published'
       ${searchSql}
     ORDER BY ${orderSql}
     LIMIT $3`,
    params,
  );

  return {
    results: rows.map((row) => ({
      guideId: row.guide_id,
      publishedVersionId: row.published_version_id,
      title: row.title,
      courseCode: row.course_code,
      target: row.target,
      professorName: row.professor_name,
      topics: row.topics,
      groundingIndicator: row.grounding_indicator,
      publishedAt: row.published_at.toISOString(),
      saved: !!row.saved_at,
    })),
  };
}

export async function serializePublishedGuide(guideId: string, userId: string) {
  const [published] = await query<{
    guide_id: string;
    course_id: string;
    target: string;
    published_version_id: string;
    published_at: Date;
  }>(
    `SELECT i.guide_id, i.course_id, i.target, i.published_version_id, i.published_at
     FROM published_study_guide_index i
     JOIN study_guides g ON g.id = i.guide_id
     JOIN enrollments e ON e.course_id = i.course_id AND e.user_id = $2
     WHERE i.guide_id=$1
       AND g.status='ready'
       AND g.discovery_status='published'`,
    [guideId, userId],
  );
  if (!published) return null;

  const version = await serializePublishedVersion(published.published_version_id, guideId);
  if (!version) return null;
  return {
    id: published.guide_id,
    courseId: published.course_id,
    target: published.target,
    publishedVersionId: published.published_version_id,
    publishedAt: published.published_at.toISOString(),
    version,
  };
}

async function serializePublishedVersion(versionId: string, guideId: string) {
  const versions = await query<{
    id: string;
    guide_id: string;
    version_number: number;
    origin: string;
    base_version_id: string | null;
    title: string;
    summary: string;
    created_at: Date;
  }>(
    `SELECT *
     FROM study_guide_versions
     WHERE id=$1 AND guide_id=$2`,
    [versionId, guideId],
  );
  const version = versions[0];
  if (!version) return null;
  const concepts = await query<{
    id: string;
    logical_concept_id: string;
    title: string;
    category: string | null;
    summary: string;
    content_origin: string;
    sort_order: number;
  }>(
    `SELECT id, logical_concept_id, title, category, summary, content_origin, sort_order
     FROM study_guide_concepts
     WHERE version_id=$1
     ORDER BY sort_order`,
    [version.id],
  );
  const conceptIds = concepts.map((concept) => concept.id);
  const keyPoints = conceptIds.length
    ? await query<{ concept_id: string; content: string; sort_order: number }>(
        `SELECT concept_id, content, sort_order
         FROM study_guide_key_points
         WHERE concept_id = ANY($1::uuid[])
         ORDER BY sort_order`,
        [conceptIds],
      )
    : [];
  const sources = conceptIds.length
    ? await query<{
        concept_id: string;
        material_id: string;
        page: number | null;
        snippet: string;
        score: number;
        sort_order: number;
      }>(
        `SELECT src.concept_id, src.material_id, src.page, src.snippet, src.score, src.sort_order
         FROM study_guide_sources src
         JOIN materials m ON m.id = src.material_id
         JOIN study_guides g ON g.id = $2
         WHERE src.concept_id = ANY($1::uuid[])
           AND m.course_id = g.course_id::text
           AND m.scope = 'shared'
           AND m.deleted_at IS NULL
           AND m.status = 'READY'
         ORDER BY src.sort_order`,
        [conceptIds, guideId],
      )
    : [];
  return {
    id: version.id,
    guideId: version.guide_id,
    versionNumber: version.version_number,
    origin: version.origin,
    baseVersionId: version.base_version_id,
    title: version.title,
    summary: version.summary,
    concepts: concepts.map((concept) => ({
      id: concept.id,
      logicalConceptId: concept.logical_concept_id,
      title: concept.title,
      category: concept.category,
      summary: concept.summary,
      contentOrigin: concept.content_origin,
      keyPoints: keyPoints
        .filter((point) => point.concept_id === concept.id)
        .map((point) => point.content),
      sources: sources
        .filter((source) => source.concept_id === concept.id)
        .map((source) => ({
          materialId: source.material_id,
          page: source.page,
          snippet: source.snippet,
          score: source.score,
        })),
    })),
    createdAt: version.created_at.toISOString(),
  };
}
