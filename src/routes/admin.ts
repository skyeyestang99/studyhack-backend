import type { FastifyInstance } from "fastify";
import { requireAuth, requireAdmin, isAdmin } from "../plugins/auth.js";
import { query } from "../db.js";

interface FeedbackRow {
  id: string;
  rating: string | null;
  reported: boolean;
  reason: string | null;
  created_at: Date;
  answer: string;
  mode: string | null;
  verified: boolean | null;
  course_name: string | null;
}

/**
 * Admin review queue for flagged/low-rated answers. Auth is server-side:
 * requireAuth (Clerk) + requireAdmin (email in ADMIN_EMAILS allowlist).
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Lets the frontend decide whether to show the admin UI (real gate is below).
  app.get("/api/admin/status", { preHandler: requireAuth }, async (req) => ({
    admin: await isAdmin(req.userId!),
  }));

  app.get(
    "/api/admin/feedback",
    { preHandler: [requireAuth, requireAdmin] },
    async () => {
      const rows = await query<FeedbackRow>(
        `SELECT f.id, f.rating, f.reported, f.reason, f.created_at,
                m.content AS answer, m.mode, m.verified,
                co.name AS course_name
         FROM message_feedback f
         JOIN messages m ON m.id = f.message_id
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN courses co ON co.id = c.course_id
         WHERE f.reported = true OR f.rating = 'down'
         ORDER BY f.created_at DESC
         LIMIT 200`,
      );
      return rows.map((r) => ({
        id: r.id,
        rating: r.rating,
        reported: r.reported,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
        answer: r.answer,
        mode: r.mode,
        verified: r.verified ?? false,
        courseName: r.course_name ?? "",
      }));
    },
  );
}
