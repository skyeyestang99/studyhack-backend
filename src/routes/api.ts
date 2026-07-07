import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { query } from "../db.js";

const todo = (ref: string) => ({ error: `Not implemented — see ${ref}` });
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remaining stubs (catalog lives in catalog.ts; auth in auth.ts). */
export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Bare arrays to match the frontend's useEntities hook.
  app.get("/api/enrollments", { preHandler: requireAuth }, async () => []);
  app.get("/api/projects", { preHandler: requireAuth }, async () => []);

  // Writes not implemented yet (Doc 2 §5.3–5.4)
  app.post("/api/enrollments", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.3")),
  );
  app.delete("/api/enrollments", { preHandler: requireAuth }, async (req, reply) => {
    const courseId = (req.query as { courseId?: string }).courseId?.trim();
    if (!courseId) {
      return reply.code(400).send({ message: "courseId is required" });
    }
    if (!uuidPattern.test(courseId)) {
      return reply.code(400).send({ message: "courseId must be a valid UUID" });
    }

    await query(
      `DELETE FROM enrollments
       WHERE user_id = $1 AND course_id = $2`,
      [req.userId, courseId],
    );

    return reply.code(204).send();
  });
  app.post("/api/projects", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.4")),
  );
}
