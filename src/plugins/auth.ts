import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { verifyToken } from "../jwt.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

/**
 * Browser -> backend auth. Interim: verifies the email/password JWT we issue
 * (Bearer token). Set MOCK_AUTH=true for local dev to attach a mock user.
 * (Clerk remains the design target — Doc 1 Decision 3.5.)
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.mockAuth) {
    req.userId = "mock-user-id";
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ message: "Unauthorized" });
  }

  const userId = verifyToken(header.slice("Bearer ".length));
  if (!userId) {
    return reply.code(401).send({ message: "Invalid or expired token" });
  }
  req.userId = userId;
}
