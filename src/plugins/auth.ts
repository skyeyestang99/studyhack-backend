import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Browser -> backend auth. Doc 1 Decision 3.5 (Option B): the backend validates
 * the Clerk session directly. Set MOCK_AUTH=true for local dev without Clerk.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.mockAuth) {
    req.userId = "mock-user-id";
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  // TODO: verify the Clerk session token (e.g. @clerk/backend `verifyToken`)
  // and set req.userId to the local users.id. Until then, fail loud in non-mock mode.
  return reply.code(501).send({
    error: "Clerk verification not wired yet — set MOCK_AUTH=true for local dev",
  });
}
