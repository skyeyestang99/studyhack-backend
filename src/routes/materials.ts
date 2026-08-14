import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { recordMilestone } from "../lib/milestones.js";
import {
  consumeQuota,
  quotaErrorBody,
  quotaStatusCode,
  refundQuota,
} from "../lib/quota.js";
import { countPdfPages } from "../lib/pdf-pages.js";
import { MATERIAL_TYPES, isMaterialType } from "../lib/material-types.js";
import { requireEnrollment } from "../lib/access.js";
import { query } from "../db.js";
import {
  deleteObject,
  presignGet,
  putObject,
} from "../r2.js";
import { config } from "../config.js";

interface MaterialRow {
  id: string;
  owner_user_id: string;
  course_id: string | null;
  material_type: string;
  file_name: string;
  r2_key: string;
  content_type: string | null;
  size_bytes: string | null;
  sha256: string | null;
  status: string;
  embedding_status: string | null;
  embedding_attempts: number;
  embedding_error: string | null;
  last_attempted_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
}

// Frontend `status` is derived from embedding progress: an upload that isn't
// embedded yet shows as processing (VALIDATING) so the UI polls until the tutor
// can actually use it; done -> READY; failed -> FAILED.
function mapStatus(embeddingStatus: string | null, fallback: string): string {
  switch (embeddingStatus) {
    case "done":
      return "READY"; // embedded -> actually usable by the tutor
    case "pending":
    case "processing":
      return "VALIDATING";
    case "failed":
    case "skipped":
      // errored OR nothing extractable to embed -> NOT usable; never show READY
      return "FAILED";
    default:
      return fallback; // legacy rows with no embedding_status
  }
}

// Per-user, per-course upload cap: stops one contributor flooding the shared
// class pool that feeds everyone's tutor. (Moderation/flagging of shared
// materials is a separate beta policy — see docs/db-manageability.md.)
const MAX_MATERIALS_PER_USER_COURSE = 50;

/**
 * Hard per-upload page ceiling, enforced before the file enters the ingest queue.
 *
 * Ingestion is serialized, so one pathological document delays every other student's
 * uploads. OCR work per document is separately bounded by OCR_MAX_PAGES_BY_TYPE in the
 * agent, so this is not the only defence — it exists for the extreme case, where even
 * text extraction and chunking would occupy the queue for a long time.
 *
 * Rejecting is kinder than silently truncating: the student can split the file and get
 * everything ingested, rather than wondering why half their notes are unsearchable.
 */
const MAX_PAGES_PER_UPLOAD = Number(process.env.MAX_PAGES_PER_UPLOAD ?? 200);

// Shape the legacy frontend expects (StudyMaterialResponse).
async function toResponse(row: MaterialRow) {
  const url = await presignGet(row.r2_key); // short-lived presigned GET
  return {
    id: row.id,
    fileName: row.file_name,
    courseName: "", // no catalog yet — filled once courses exist
    courseId: row.course_id ?? "",
    materialType: row.material_type,
    status: mapStatus(row.embedding_status, row.status),
    previewUrl: url,
    downloadUrl: url,
    contentType: row.content_type,
    rejectionReason: row.rejection_reason,
    embeddingError: row.embedding_error,
    embeddingAttempts: row.embedding_attempts,
    lastAttemptedAt: row.last_attempted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function triggerMaterialIngest(app: FastifyInstance, materialId: string) {
  if (!config.agentUrl) return;

  try {
    const response = await fetch(`${config.agentUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.internalJwtSecret}`,
      },
      body: JSON.stringify({ materialId }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      app.log.error(
        {
          materialId,
          statusCode: response.status,
          responseBody: body.slice(0, 2000),
        },
        "material ingest request failed",
      );
    }
  } catch (err) {
    app.log.error(
      {
        materialId,
        err,
      },
      "material ingest request errored",
    );
  }
}

export async function materialsRoutes(app: FastifyInstance): Promise<void> {
  // --- Upload (multipart: file + courseId + materialType) ---
  app.post("/api/materials/upload", { preHandler: requireAuth }, async (req, reply) => {
    let fileBuf: Buffer | null = null;
    let fileName = "upload";
    let mime = "application/octet-stream";
    const fields: Record<string, string> = {};

    for await (const part of req.parts()) {
      if (part.type === "file") {
        fileName = part.filename || fileName;
        mime = part.mimetype || mime;
        fileBuf = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    if (!fileBuf) return reply.code(400).send({ message: "file is required" });
    if (fileBuf.length === 0) return reply.code(400).send({ message: "file is empty" });

    const ALLOWED_TYPES = MATERIAL_TYPES;
    const materialType = fields.materialType;
    if (!materialType || !isMaterialType(materialType)) {
      return reply
        .code(400)
        .send({ message: `materialType must be one of: ${ALLOWED_TYPES.join(", ")}` });
    }

    // Types the agent's extract() can ingest end-to-end (PDF, Office, text).
    const ALLOWED_EXT = ["pdf", "txt", "md", "docx", "pptx"];
    const ext = fileName.toLowerCase().split(".").pop() ?? "";
    if (!ALLOWED_EXT.includes(ext)) {
      return reply
        .code(400)
        .send({ message: `unsupported file type ".${ext}" (allowed: ${ALLOWED_EXT.join(", ")})` });
    }

    const courseId = fields.courseId || null;
    if (courseId) await requireEnrollment(req.userId!, courseId); // U2: no cross-course upload

    const id = randomUUID();
    const key = `materials/${req.userId}/${id}/${fileName}`;
    const sha256 = createHash("sha256").update(fileBuf).digest("hex");

    // Dedup. Inside a course, materials are shared across the whole class, so
    // dedup the entire course pool by content (ANY owner): 30 students uploading
    // the same lecture PDF must not create 30 duplicate chunk sets that swamp
    // retrieval. Outside a course, dedup per owner.
    const dup = courseId
      ? await query<{ id: string; file_name: string; owner_user_id: string }>(
          `SELECT id, file_name, owner_user_id FROM materials
             WHERE course_id=$1 AND sha256=$2 AND deleted_at IS NULL LIMIT 1`,
          [courseId, sha256],
        )
      : await query<{ id: string; file_name: string; owner_user_id: string }>(
          `SELECT id, file_name, owner_user_id FROM materials
             WHERE owner_user_id=$1 AND course_id IS NULL AND sha256=$2 AND deleted_at IS NULL LIMIT 1`,
          [req.userId, sha256],
        );
    if (dup[0]) {
      const mine = dup[0].owner_user_id === req.userId;
      return reply.code(409).send({
        message: mine
          ? `"${dup[0].file_name}" has already been uploaded.`
          : `"${dup[0].file_name}" is already in this course's shared materials (added by another student).`,
      });
    }

    // Per-user-per-course upload quota (see MAX_MATERIALS_PER_USER_COURSE).
    if (courseId) {
      const [{ count }] = await query<{ count: number }>(
        `SELECT count(*)::int AS count FROM materials
           WHERE owner_user_id=$1 AND course_id=$2 AND deleted_at IS NULL`,
        [req.userId, courseId],
      );
      if (Number(count) >= MAX_MATERIALS_PER_USER_COURSE) {
        return reply.code(429).send({
          message: `Upload limit reached (${MAX_MATERIALS_PER_USER_COURSE} materials per course). Delete some before adding more.`,
        });
      }
    }

    // --- page ceiling: queue protection, before anything is stored or queued ---
    const pages = countPdfPages(fileBuf);
    if (pages !== null && pages > MAX_PAGES_PER_UPLOAD) {
      return reply.code(413).send({
        code: "UPLOAD_TOO_MANY_PAGES",
        message:
          `This file has ${pages} pages, over the ${MAX_PAGES_PER_UPLOAD}-page limit. ` +
          `Please split it and upload the parts separately.`,
        pages,
        limit: MAX_PAGES_PER_UPLOAD,
      });
    }

    // --- daily quotas ---
    const uploadQuota = await consumeQuota(req.userId!, "upload");
    if (!uploadQuota.ok) {
      return reply.code(quotaStatusCode(uploadQuota)).send(quotaErrorBody(uploadQuota));
    }

    // Charge OCR pages up front at an UPPER BOUND of what ingestion could do: the
    // agent will OCR at most min(actual pages, type budget), and only if the PDF has
    // no usable text layer. Over-charging slightly is the safe direction — the
    // alternative is the agent reporting back after the work is already done, which
    // cannot prevent anything.
    const ocrPages = pages === null ? 1 : Math.min(pages, 60);
    const ocrQuota = await consumeQuota(req.userId!, "ocr_page", ocrPages);
    if (!ocrQuota.ok) {
      await refundQuota(req.userId!, "upload");
      return reply.code(quotaStatusCode(ocrQuota)).send(quotaErrorBody(ocrQuota));
    }

    await putObject(key, fileBuf, mime);

    const rows = await query<MaterialRow>(
      `INSERT INTO materials
         (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type, size_bytes, sha256, status, embedding_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VALIDATING','pending')
       RETURNING *`,
      [id, req.userId, courseId, materialType, fileName, key, mime, fileBuf.length, sha256],
    );

    recordMilestone(req.userId!, "uploaded_material");

    // Kick off embedding in the background so the tutor can use the upload
    // shortly — no manual `npm run ingest`. Failures are logged and persisted
    // by the agent so users can retry from the UI.
    void triggerMaterialIngest(app, id);

    return reply.code(201).send(await toResponse(rows[0]));
  });

  // --- List (bare array; optional ?courseId=) ---
  app.get("/api/materials", { preHandler: requireAuth }, async (req) => {
    const courseId = (req.query as { courseId?: string }).courseId;
    const rows = courseId
      ? await query<MaterialRow>(
          `SELECT * FROM materials WHERE owner_user_id=$1 AND course_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC`,
          [req.userId, courseId],
        )
      : await query<MaterialRow>(
          `SELECT * FROM materials WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
          [req.userId],
        );
    return Promise.all(rows.map(toResponse));
  });

  // --- Get one (status polling / preview) ---
  app.get("/api/materials/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<MaterialRow>(
      `SELECT * FROM materials WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,
      [id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Not found" });
    return toResponse(rows[0]);
  });

  app.post("/api/materials/:id/retry", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<MaterialRow>(
      `UPDATE materials
          SET status='VALIDATING',
              embedding_status='pending',
              embedding_error=NULL,
              last_attempted_at=NULL,
              updated_at=now()
        WHERE id=$1
          AND owner_user_id=$2
          AND deleted_at IS NULL
          AND embedding_status IN ('failed', 'skipped')
      RETURNING *`,
      [id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Failed material not found" });

    void triggerMaterialIngest(app, id);
    return toResponse(rows[0]);
  });

  // --- Preview a material the user can access (owner OR enrolled in its course) ---
  // Powers clickable citation "Sources" in chat/study-tools (incl. shared/seed materials).
  app.get("/api/materials/:id/preview", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<MaterialRow>(
      `SELECT * FROM materials WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    const m = rows[0];
    if (!m) return reply.code(404).send({ message: "Not found" });
    if (m.owner_user_id !== req.userId) {
      if (!m.course_id) return reply.code(403).send({ message: "No access" });
      await requireEnrollment(req.userId!, m.course_id); // 403 unless enrolled
    }
    const url = await presignGet(m.r2_key);
    return { id: m.id, fileName: m.file_name, previewUrl: url, contentType: m.content_type };
  });

  app.get("/api/materials/:id/preview-file", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<MaterialRow>(
      `SELECT * FROM materials WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    const m = rows[0];
    if (!m) return reply.code(404).send({ message: "Not found" });
    if (m.owner_user_id !== req.userId) {
      if (!m.course_id) return reply.code(403).send({ message: "No access" });
      await requireEnrollment(req.userId!, m.course_id);
    }
    return reply.redirect(await presignGet(m.r2_key));
  });

  // --- Update material type (?materialType=) ---
  app.put("/api/materials/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const materialType = (req.query as { materialType?: string }).materialType;
    if (!materialType) return reply.code(400).send({ message: "materialType is required" });
    // Previously accepted any string, which is how values outside the vocabulary got
    // into the table in the first place. Migration 0026 adds a CHECK constraint, so an
    // unvalidated value here would now surface as a 500 rather than silently storing.
    if (!isMaterialType(materialType)) {
      return reply
        .code(400)
        .send({ message: `materialType must be one of: ${MATERIAL_TYPES.join(", ")}` });
    }
    const rows = await query<MaterialRow>(
      `UPDATE materials SET material_type=$1, updated_at=now()
       WHERE id=$2 AND owner_user_id=$3 AND deleted_at IS NULL RETURNING *`,
      [materialType, id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Not found" });
    return toResponse(rows[0]);
  });

  // --- Delete (soft-delete row + remove R2 object) ---
  app.delete("/api/materials/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<MaterialRow>(
      `UPDATE materials SET deleted_at=now()
       WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL RETURNING r2_key`,
      [id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Not found" });
    try {
      await deleteObject(rows[0].r2_key);
    } catch {
      // best-effort; row is already soft-deleted
    }
    return reply.code(204).send();
  });
}
