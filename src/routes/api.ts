import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";

const todo = (ref: string) => ({ error: `Not implemented — see ${ref}` });

/** Remaining stubs (catalog lives in catalog.ts; auth in auth.ts). */
export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // Bare arrays to match the frontend's useEntities hook.
  app.get("/api/enrollments", { preHandler: requireAuth }, async () => []);
  app.get("/api/projects", { preHandler: requireAuth }, async () => []);

  // Syllabus events not built yet — return an empty list so the dashboard's
  // ExamReminderStrip degrades cleanly instead of 404ing on every load (D1).
  app.get("/api/syllabus-events", { preHandler: requireAuth }, async () => []);

  // Writes not implemented yet (Doc 2 §5.3–5.4)
  app.post("/api/enrollments", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.3")),
  );
  app.post("/api/projects", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.4")),
  );
}
