import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { query } from "../db.js";
import { requireEnrollment } from "../lib/access.js";
import {
  ASSESSMENT_TYPES,
  LIBRARY_GROUP_ORDER,
  isMaterialType,
  type MaterialType,
} from "../lib/material-types.js";

/**
 * In-course material library (Part 2).
 *
 * Uploads already default to scope='shared', and enrolled students can already OPEN a
 * shared material via /api/materials/:id/preview — that is what makes citations
 * clickable. So this adds a read SURFACE, not read PERMISSIONS.
 *
 * What was missing is browsing: the only list endpoint filters owner_user_id = caller, so
 * a student joining a course with 46 shared documents saw zero of them. They could not
 * tell whether the course was stocked or empty, could not find a past exam a classmate
 * had already added, and had no way to see that contributing helped anyone.
 *
 * AUTHORIZATION MATRIX (kept here so it is reviewable in one place):
 *
 *   Action                          | Owner | Enrolled classmate | Unenrolled | Anon
 *   --------------------------------|-------|--------------------|------------|-----
 *   List course library (shared)    | yes   | yes                | 403        | 401
 *   List personal materials         | yes   | no                 | no         | no
 *   Preview shared course material  | yes   | yes (already true) | 403        | 401
 *   Preview personal                | yes   | 403                | no         | no
 *   See uploader identity           | n/a   | no                 | no         | no
 *   See ingest error / retry        | yes   | no                 | no         | no
 *   Edit type, unshare, delete      | yes   | 404                | no         | no
 */

/** Fields the library exposes. Deliberately NOT the owner shape — see toLibraryRow. */
interface LibraryRow {
  id: string;
  materialType: string;
  fileName: string;
  pageCount: number | null;
  sizeBytes: number;
  createdAt: string;
  /** Populated by Part 5 (temporal metadata); null until then. */
  academicYear: number | null;
  academicTerm: string | null;
  uploadedByMe: boolean;
  /** Populated by Part 4 (votes/notes); 0/null until then. */
  helpfulCount: number;
  myVote: number | null;
  noteCount: number;
  citedCount: number;
  /** Coarsened for non-owners — see below. */
  status: "READY" | "PROCESSING";
  reportedByMe: boolean;
}

interface LibraryMaterialDbRow {
  id: string;
  material_type: string | null;
  file_name: string;
  size_bytes: number;
  created_at: Date;
  owner_user_id: string | null;
  embedding_status: string | null;
  page_count: number | null;
  cited_count: number;
}

/**
 * Library serializer — deliberately a SEPARATE function from the owner's toResponse().
 *
 * Reusing the owner serializer is how a future field quietly leaks to classmates. That
 * one returns, and this one must never return:
 *   - previewUrl / downloadUrl — presigned R2 URLs. Beyond leaking a direct object URL,
 *     presigning every row would mean 46 signing operations for one library page; the
 *     library links to /preview and signs on demand instead.
 *   - rejectionReason, embeddingError, embeddingAttempts, lastAttemptedAt — someone
 *     else's ingest failures are not a classmate's business.
 *   - owner_user_id — documents stay "a classmate"; only notes carry a name (Part 4).
 *   - content_text — the extracted text of the whole document.
 *
 * Status is coarsened to READY | PROCESSING. A classmate does not need to distinguish
 * VALIDATING from FAILED, and another user's FAILED upload is filtered out entirely
 * rather than shown as broken — a half-ingested file in someone else's list is noise
 * they can do nothing about.
 */
function toLibraryRow(row: LibraryMaterialDbRow, callerId: string): LibraryRow {
  return {
    id: row.id,
    materialType: row.material_type ?? "OTHER",
    fileName: row.file_name,
    pageCount: row.page_count,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
    academicYear: null,
    academicTerm: null,
    uploadedByMe: row.owner_user_id === callerId,
    helpfulCount: 0,
    myVote: null,
    noteCount: 0,
    citedCount: row.cited_count,
    status: row.embedding_status === "done" ? "READY" : "PROCESSING",
    reportedByMe: false,
  };
}

type SortKey = "recommended" | "newest_term" | "most_helpful" | "recent";

const SORTS: Record<SortKey, string> = {
  // Until Part 5's ranking config exists, "recommended" = citations then recency. Both
  // are earned signals rather than self-reported ones.
  recommended: "m.cited_count DESC, m.created_at DESC, m.id",
  newest_term: "m.created_at DESC, m.id",
  most_helpful: "m.cited_count DESC, m.created_at DESC, m.id",
  recent: "m.created_at DESC, m.id",
};

/** Server-side cap: a client asking for 10,000 rows should not get them. */
const MAX_LIMIT = 100;

export async function courseMaterialsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/courses/:courseId/materials",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { courseId } = req.params as { courseId: string };
      // Same 400/404/403 contract as chat and exam insights.
      await requireEnrollment(req.userId!, courseId);

      const q = req.query as {
        type?: string;
        q?: string;
        sort?: string;
        limit?: string;
        offset?: string;
      };

      const typeFilter = q.type && isMaterialType(q.type) ? q.type : undefined;
      if (q.type && !typeFilter) {
        return reply.code(400).send({ message: `unknown material type: ${q.type}` });
      }
      const sort: SortKey = (
        ["recommended", "newest_term", "most_helpful", "recent"] as const
      ).includes(q.sort as SortKey)
        ? (q.sort as SortKey)
        : "recommended";
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || 50));
      const offset = Math.max(0, Number(q.offset) || 0);
      const search = q.q?.trim() ? `%${q.q.trim()}%` : null;

      /**
       * One round trip for the rows.
       *
       * pageCount comes from max(page) over material_chunks rather than a new column:
       * the value is already derivable, and a denormalised column would need backfilling
       * and could drift from the chunks after a re-ingest.
       *
       * The shared/deleted predicates appear here AND in retrieval. Part 4 moves them
       * into one helper so a moderation filter cannot be added to one and forgotten in
       * the other.
       */
      const rows = await query<LibraryMaterialDbRow>(
        `SELECT m.id, m.material_type, m.file_name, m.size_bytes, m.created_at,
                m.owner_user_id, m.embedding_status, m.cited_count,
                pc.page_count
           FROM materials m
           LEFT JOIN (
             SELECT material_id, max(page) AS page_count
               FROM material_chunks GROUP BY material_id
           ) pc ON pc.material_id = m.id
          WHERE m.course_id = $1
            AND m.deleted_at IS NULL
            AND m.scope = 'shared'
            -- Someone else's failed upload is absent, not shown as broken. The owner
            -- still sees it (with the error and a retry) in "My uploads".
            AND (m.embedding_status <> 'failed' OR m.owner_user_id = $2::text)
            AND ($3::text IS NULL OR m.material_type = $3::text)
            AND ($4::text IS NULL OR m.file_name ILIKE $4::text)
          ORDER BY ${SORTS[sort]}
          LIMIT $5 OFFSET $6`,
        [courseId, req.userId, typeFilter ?? null, search, limit, offset],
      );

      /**
       * Summary over the WHOLE shared library, not the current page — it describes what
       * backs the course, so it must not change when someone pages or filters.
       */
      const [summaryRow] = await query<{
        counts: Record<string, number> | null;
        total_pages: string;
        contributor_count: string;
        last_added_at: Date | null;
      }>(
        `SELECT
           (SELECT jsonb_object_agg(material_type, n)
              FROM (SELECT material_type, count(*)::int AS n
                      FROM materials
                     WHERE course_id = $1 AND deleted_at IS NULL AND scope = 'shared'
                       AND material_type IS NOT NULL
                     GROUP BY material_type) t) AS counts,
           (SELECT coalesce(sum(pc.page_count), 0)::text
              FROM materials m
              JOIN (SELECT material_id, max(page) AS page_count
                      FROM material_chunks GROUP BY material_id) pc
                ON pc.material_id = m.id
             WHERE m.course_id = $1 AND m.deleted_at IS NULL AND m.scope = 'shared') AS total_pages,
           (SELECT count(DISTINCT owner_user_id)::text
              FROM materials
             WHERE course_id = $1 AND deleted_at IS NULL AND scope = 'shared') AS contributor_count,
           (SELECT max(created_at)
              FROM materials
             WHERE course_id = $1 AND deleted_at IS NULL AND scope = 'shared') AS last_added_at`,
        [courseId],
      );

      const counts = summaryRow?.counts ?? {};
      const assessmentCount = ASSESSMENT_TYPES.reduce(
        (sum, t) => sum + (counts[t] ?? 0),
        0,
      );

      return {
        summary: {
          counts,
          assessmentCount,
          totalPages: Number(summaryRow?.total_pages ?? 0),
          contributorCount: Number(summaryRow?.contributor_count ?? 0),
          /** Part 5 fills this once terms are captured. */
          termSpan: null as string | null,
          lastAddedAt: summaryRow?.last_added_at?.toISOString() ?? null,
          /**
           * Three or more assessments is the threshold at which Exam Insights stops
           * saying "this shows emphasis, not a reliable trend" — the same number the
           * panel already uses, so the library and the feature agree.
           */
          insightsReady: assessmentCount >= 3,
          /** Group order for the client, so display priority is decided server-side. */
          groupOrder: LIBRARY_GROUP_ORDER as readonly MaterialType[],
        },
        materials: rows.map((r) => toLibraryRow(r, req.userId!)),
        page: { limit, offset, sort, type: typeFilter ?? null },
      };
    },
  );
}
