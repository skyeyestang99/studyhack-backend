import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";

const todo = (ref: string) => ({ error: `Not implemented — see ${ref}` });

/**
 * Material + upload endpoints (Doc 2 §5.5). Direct-to-R2 presigned flow.
 * Stubs only — wire R2 presign + the Inngest pipeline trigger here.
 */
export async function materialsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/materials/upload-url", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.5 — presigned R2 PUT")),
  );
  app.post("/api/materials", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.5 — confirm + trigger pipeline")),
  );
  app.get("/api/materials", { preHandler: requireAuth }, async () => ({
    data: [],
    timestamp: new Date().toISOString(),
  }));
  app.get("/api/materials/:id", { preHandler: requireAuth }, async (_req, reply) =>
    reply.code(501).send(todo("Doc 2 §5.5 — status polling")),
  );
}
