import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { requireEnrollment, isUuid } from "../lib/access.js";
import { query, withTransaction } from "../db.js";
import {
  FeatureError,
  applyManualEdit,
  createGuideWithJob,
  createRevisionRequest,
  featureErrorBody,
  getRevisionForOwner,
  parseCreateBody,
  requestHash,
  requireIdempotencyKey,
  serializeGuide,
  serializeVersion,
} from "../study-guides/service.js";

function sendFeatureError(reply: FastifyReply, err: unknown) {
  if (err instanceof FeatureError) {
    return reply.code(err.statusCode).send(featureErrorBody(err));
  }
  throw err;
}

export async function studyGuideRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/courses/:courseId/study-guides",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { courseId } = req.params as { courseId: string };
        await requireEnrollment(req.userId!, courseId);
        const parsed = parseCreateBody(req.body);
        const idempotencyKey = requireIdempotencyKey(req.headers);
        const result = await createGuideWithJob({
          userId: req.userId!,
          courseId,
          idempotencyKey,
          hash: requestHash({ courseId, ...parsed }),
          ...parsed,
        });
        return reply.code(result.status).send(result.body);
      } catch (err) {
        return sendFeatureError(reply, err);
      }
    },
  );

  app.get(
    "/api/courses/:courseId/study-guides",
    { preHandler: requireAuth },
    async (req) => {
      const { courseId } = req.params as { courseId: string };
      await requireEnrollment(req.userId!, courseId);
      const rows = await query<{
        id: string;
        target: string;
        retrieval_mode: string;
        status: string;
        current_version_id: string | null;
        title: string | null;
        created_at: Date;
        updated_at: Date;
        ready_at: Date | null;
      }>(
        `SELECT g.id, g.target, g.retrieval_mode, g.status, g.current_version_id,
                v.title, g.created_at, g.updated_at, g.ready_at
         FROM study_guides g
         LEFT JOIN study_guide_versions v ON v.id = g.current_version_id
         WHERE g.owner_user_id=$1 AND g.course_id=$2
         ORDER BY g.created_at DESC
         LIMIT 50`,
        [req.userId, courseId],
      );
      return rows.map((row) => ({
        id: row.id,
        courseId,
        target: row.target,
        retrievalMode: row.retrieval_mode,
        status: row.status,
        currentVersionId: row.current_version_id,
        title: row.title,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        readyAt: row.ready_at?.toISOString() ?? null,
      }));
    },
  );

  app.get("/api/study-guides/:guideId", { preHandler: requireAuth }, async (req, reply) => {
    const { guideId } = req.params as { guideId: string };
    if (!isUuid(guideId)) return reply.code(404).send({ message: "Not found" });
    const guide = await serializeGuide(guideId, req.userId!);
    if (!guide) return reply.code(404).send({ message: "Not found" });
    return guide;
  });

  app.delete("/api/study-guides/:guideId", { preHandler: requireAuth }, async (req, reply) => {
    const { guideId } = req.params as { guideId: string };
    if (!isUuid(guideId)) return reply.code(404).send({ message: "Not found" });

    const deleted = await withTransaction(async (q) => {
      await q(
        `UPDATE study_guides
         SET current_version_id=NULL, updated_at=now()
         WHERE id=$1 AND owner_user_id=$2`,
        [guideId, req.userId],
      );
      return q<{ id: string }>(
        `DELETE FROM study_guides
         WHERE id=$1 AND owner_user_id=$2
         RETURNING id`,
        [guideId, req.userId],
      );
    });
    if (deleted.length === 0) return reply.code(404).send({ message: "Not found" });
    return reply.code(204).send();
  });

  app.get(
    "/api/study-guides/:guideId/versions",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { guideId } = req.params as { guideId: string };
      if (!isUuid(guideId)) return reply.code(404).send({ message: "Not found" });
      const rows = await query<{
        id: string;
        version_number: number;
        origin: string;
        base_version_id: string | null;
        created_at: Date;
      }>(
        `SELECT v.id, v.version_number, v.origin, v.base_version_id, v.created_at
         FROM study_guide_versions v
         JOIN study_guides g ON g.id = v.guide_id
         WHERE v.guide_id=$1 AND g.owner_user_id=$2
         ORDER BY v.version_number DESC
         LIMIT 50`,
        [guideId, req.userId],
      );
      return rows.map((row) => ({
        id: row.id,
        guideId,
        versionNumber: row.version_number,
        origin: row.origin,
        baseVersionId: row.base_version_id,
        createdAt: row.created_at.toISOString(),
      }));
    },
  );

  app.get(
    "/api/study-guides/:guideId/versions/:versionId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { guideId, versionId } = req.params as { guideId: string; versionId: string };
      if (!isUuid(guideId) || !isUuid(versionId)) {
        return reply.code(404).send({ message: "Not found" });
      }
      const version = await serializeVersion(versionId, guideId, req.userId!);
      if (!version) return reply.code(404).send({ message: "Not found" });
      return version;
    },
  );

  app.post(
    "/api/study-guides/:guideId/edits",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { guideId } = req.params as { guideId: string };
        if (!isUuid(guideId)) return reply.code(404).send({ message: "Not found" });
        const ifMatch = (req.headers["if-match"] as string | undefined)?.replace(/^"|"$/g, "");
        if (!ifMatch || !isUuid(ifMatch)) {
          return reply.code(400).send({ message: "If-Match current version is required.", code: "IF_MATCH_REQUIRED" });
        }
        const idempotencyKey = requireIdempotencyKey(req.headers);
        const body = (req.body ?? {}) as { operations?: unknown[] };
        const result = await applyManualEdit({
          userId: req.userId!,
          guideId,
          ifMatch,
          idempotencyKey,
          hash: requestHash({ guideId, ifMatch, operations: body.operations }),
          operations: body.operations ?? [],
        });
        return reply.code(result.status).send(result.body);
      } catch (err) {
        return sendFeatureError(reply, err);
      }
    },
  );

  app.post(
    "/api/study-guides/:guideId/revisions",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const { guideId } = req.params as { guideId: string };
        if (!isUuid(guideId)) return reply.code(404).send({ message: "Not found" });
        const body = (req.body ?? {}) as {
          baseVersionId?: string;
          instruction?: string;
          conceptIds?: string[];
        };
        const idempotencyKey = requireIdempotencyKey(req.headers);
        const result = await createRevisionRequest({
          userId: req.userId!,
          guideId,
          baseVersionId: body.baseVersionId ?? "",
          instruction: body.instruction ?? "",
          conceptIds: body.conceptIds ?? [],
          idempotencyKey,
          hash: requestHash({
            guideId,
            baseVersionId: body.baseVersionId,
            instruction: body.instruction,
            conceptIds: body.conceptIds,
          }),
        });
        return reply.code(result.status).send(result.body);
      } catch (err) {
        return sendFeatureError(reply, err);
      }
    },
  );

  app.get(
    "/api/study-guides/:guideId/revisions/:revisionId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { guideId, revisionId } = req.params as { guideId: string; revisionId: string };
      if (!isUuid(guideId) || !isUuid(revisionId)) {
        return reply.code(404).send({ message: "Not found" });
      }
      const revision = await getRevisionForOwner(req.userId!, guideId, revisionId);
      if (!revision) return reply.code(404).send({ message: "Not found" });
      return revision;
    },
  );
}
