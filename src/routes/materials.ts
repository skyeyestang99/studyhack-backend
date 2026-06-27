import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { query } from "../db.js";
import { putObject, presignGet, deleteObject } from "../r2.js";

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
  rejection_reason: string | null;
  created_at: Date;
}

// Shape the legacy frontend expects (StudyMaterialResponse).
async function toResponse(row: MaterialRow) {
  const url = await presignGet(row.r2_key); // short-lived presigned GET
  return {
    id: row.id,
    fileName: row.file_name,
    courseName: "", // no catalog yet — filled once courses exist
    courseId: row.course_id ?? "",
    materialType: row.material_type,
    status: row.status,
    previewUrl: url,
    downloadUrl: url,
    contentType: row.content_type,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at.toISOString(),
  };
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
    const materialType = fields.materialType;
    if (!materialType) return reply.code(400).send({ message: "materialType is required" });
    const courseId = fields.courseId || null;

    const id = randomUUID();
    const key = `materials/${req.userId}/${id}/${fileName}`;
    const sha256 = createHash("sha256").update(fileBuf).digest("hex");

    await putObject(key, fileBuf, mime);

    const rows = await query<MaterialRow>(
      `INSERT INTO materials
         (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type, size_bytes, sha256, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'READY')
       RETURNING *`,
      [id, req.userId, courseId, materialType, fileName, key, mime, fileBuf.length, sha256],
    );
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

  // --- Update material type (?materialType=) ---
  app.put("/api/materials/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const materialType = (req.query as { materialType?: string }).materialType;
    if (!materialType) return reply.code(400).send({ message: "materialType is required" });
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
