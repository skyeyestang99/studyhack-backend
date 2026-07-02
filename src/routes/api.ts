import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { query } from "../db.js";

const todo = (ref: string) => ({ error: `Not implemented — see ${ref}` });

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

    const deleted = await query<{ id: string }>(
      `DELETE FROM enrollments
       WHERE user_id = $1 AND course_id = $2
       RETURNING id`,
      [req.userId, courseId],
    );
    if (deleted.length === 0) {
      return reply.code(404).send({ message: "Enrollment not found" });
    }

    return reply.code(204).send();
  });
  app.post("/api/projects", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.4")),
  );
}
