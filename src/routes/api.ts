import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";

const ok = (data: unknown) => ({ data, timestamp: new Date().toISOString() });
const todo = (ref: string) => ({ error: `Not implemented — see ${ref}` });

/**
 * Catalog / enrollment / project endpoints. Stubs only — fill in per Doc 2 §5.2–5.4.
 * Each route already enforces auth so the contract (scoping) is correct from day one.
 */
export async function apiRoutes(app: FastifyInstance): Promise<void> {
  // --- Catalog (Doc 2 §5.2) ---
  app.get("/api/schools", { preHandler: requireAuth }, async () => ok([]));
  app.post("/api/schools", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.2")),
  );
  // Bare array (legacy frontend contract) so the upload dialog's course dropdown works.
  // TODO: back with the real catalog (Doc 2 §5.2).
  app.get("/api/courses", { preHandler: requireAuth }, async () => []);
  app.get("/api/courses/:id/offerings", { preHandler: requireAuth }, async () => ok([]));
  app.post("/api/offerings", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.2")),
  );

  // --- Enrollment (Doc 2 §5.3) ---
  app.get("/api/enrollments", { preHandler: requireAuth }, async () => ok([]));
  app.post("/api/enrollments", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.3")),
  );

  // --- Projects (Doc 2 §5.4) ---
  app.get("/api/projects", { preHandler: requireAuth }, async () => ok([]));
  app.post("/api/projects", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.4")),
  );
}
