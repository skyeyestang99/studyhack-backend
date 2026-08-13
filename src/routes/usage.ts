import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { usageSummary } from "../lib/quota.js";

/**
 * Today's usage and limits for the signed-in user.
 *
 * Powers Settings → Usage, and lets the client show a meter before a request is
 * refused rather than only discovering a limit by hitting it. Deliberately reports
 * limits as well as counts: "12 of 20" is actionable, "12" is trivia.
 */
export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/me/usage", { preHandler: requireAuth }, async (req) => {
    return usageSummary(req.userId!);
  });
}
