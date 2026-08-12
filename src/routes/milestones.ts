import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { getMilestones } from "../lib/milestones.js";

/**
 * Activation milestones for the signed-in user.
 *
 * The dashboard checklist previously read localStorage, so "you already asked a
 * question" was forgotten on a new device or browser — the checklist would tell a
 * returning student to redo a step they had done. Serving it from the server makes
 * it account-scoped, and the same rows are what make the funnel measurable.
 */
export async function milestoneRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/me/milestones", { preHandler: requireAuth }, async (req) => {
    return { milestones: await getMilestones(req.userId!) };
  });
}
