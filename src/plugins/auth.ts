import type { FastifyReply, FastifyRequest } from "fastify";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { config } from "../config.js";
import { query } from "../db.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

const clerkClient = createClerkClient({ secretKey: config.clerkSecretKey });

// Stable UUID for MOCK_AUTH so it satisfies uuid FKs (enrollments.user_id -> users.id).
export const MOCK_USER_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Resolve our local `users.id` for a Clerk user, creating the row on first
 * sight (upsert-on-first-request). Local id is what every owner_user_id /
 * foreign key points at, so the rest of the app is unaffected by Clerk.
 */
async function resolveLocalUserId(clerkId: string): Promise<string> {
  const existing = await query<{ id: string }>("SELECT id FROM users WHERE clerk_id=$1", [clerkId]);
  if (existing[0]) return existing[0].id;

  // First request from this Clerk user — pull profile + create the local row.
  let email = `${clerkId}@clerk.local`;
  let name: string | null = null;
  try {
    const cu = await clerkClient.users.getUser(clerkId);
    email = cu.primaryEmailAddress?.emailAddress ?? email;
    name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || null;
  } catch {
    // If the lookup fails, fall back to placeholders; the row still gets created.
  }

  const inserted = await query<{ id: string }>(
    `INSERT INTO users (clerk_id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (clerk_id) DO UPDATE SET clerk_id = EXCLUDED.clerk_id
     RETURNING id`,
    [clerkId, email, name],
  );
  return inserted[0].id;
}

/**
 * Browser -> backend auth via Clerk. Verifies the Clerk session token
 * (Authorization: Bearer <token>) and attaches our local user id to req.userId.
 * MOCK_AUTH=true short-circuits to a mock user for tests/local dev.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.mockAuth) {
    // Ensure the mock user row exists so course-scoped FKs work in mock mode.
    await query(
      `INSERT INTO users (id, email, name) VALUES ($1, 'mock@studyhack.local', 'Mock User')
       ON CONFLICT (id) DO NOTHING`,
      [MOCK_USER_ID],
    );
    req.userId = MOCK_USER_ID;
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ message: "Unauthorized" });
  }

  let clerkId: string | undefined;
  try {
    const claims = await verifyToken(header.slice("Bearer ".length), {
      secretKey: config.clerkSecretKey,
    });
    clerkId = claims.sub;
  } catch {
    return reply.code(401).send({ message: "Invalid or expired token" });
  }
  if (!clerkId) {
    return reply.code(401).send({ message: "Invalid token" });
  }

  req.userId = await resolveLocalUserId(clerkId);
}

/** Server-side admin check: the user's email must be in the ADMIN_EMAILS allowlist. */
export async function isAdmin(userId: string): Promise<boolean> {
  if (config.adminEmails.length === 0) return false;
  const rows = await query<{ email: string }>("SELECT email FROM users WHERE id=$1", [userId]);
  const email = rows[0]?.email?.toLowerCase();
  return !!email && config.adminEmails.includes(email);
}

/** Gate for admin-only routes. Chain AFTER requireAuth: preHandler: [requireAuth, requireAdmin]. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.userId || !(await isAdmin(req.userId))) {
    return reply.code(403).send({ message: "admin access required" });
  }
}
