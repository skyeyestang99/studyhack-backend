import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { requireEnrollment } from "../lib/access.js";
import { recordMilestone } from "../lib/milestones.js";
import { query } from "../db.js";
import { config } from "../config.js";
import { MockAgentClient, RealAgentClient, type ExamInsights } from "../agent/agent-client.js";

const agent = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();

/**
 * Cache exam insights per course.
 *
 * The analysis is one LLM call over the course's whole assessment corpus, so it
 * costs real money and a few seconds. It is also nearly static: the answer only
 * changes when someone adds or removes assessment material. So the cache is
 * keyed on a cheap fingerprint of that material (count + newest processed_at)
 * rather than a timer — a TTL would either serve stale results after an upload
 * or recompute for no reason.
 *
 * In-process only, which is fine while the API runs as a single instance. If the
 * API is scaled out this should move to a table (see the note in the route).
 */
interface CacheEntry {
  fingerprint: string;
  value: ExamInsights;
}
const cache = new Map<string, CacheEntry>();

async function assessmentFingerprint(courseId: string): Promise<string> {
  const rows = await query<{ n: string; latest: Date | null }>(
    `SELECT count(*)::text AS n, max(processed_at) AS latest
       FROM materials
      WHERE course_id = $1
        AND deleted_at IS NULL
        AND material_type IN ('EXAM','HOMEWORK')
        AND embedding_status = 'done'`,
    [courseId],
  );
  const row = rows[0];
  return `${row?.n ?? "0"}:${row?.latest?.toISOString() ?? "none"}`;
}

export async function examInsightsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * "What does this professor actually test?" for one course.
   *
   * This is the product's differentiator: it answers from the instructor's own
   * past assessments, which a general-purpose model cannot do.
   */
  app.get(
    "/api/courses/:courseId/exam-insights",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { courseId } = req.params as { courseId: string };
      // Throws 400/404/403 — same course-scoping guarantee as chat and materials.
      await requireEnrollment(req.userId!, courseId);
      // Final step of the activation funnel; recorded whether or not the result
      // was cached, since the student saw it either way.
      recordMilestone(req.userId!, "viewed_exam_insights");

      const fingerprint = await assessmentFingerprint(courseId);
      const hit = cache.get(courseId);
      if (hit && hit.fingerprint === fingerprint) {
        return { ...hit.value, cached: true };
      }

      try {
        const value = await agent.examInsights(courseId);
        cache.set(courseId, { fingerprint, value });
        return { ...value, cached: false };
      } catch (err) {
        req.log.error({ err, courseId }, "exam insights failed");
        return reply.code(502).send({
          message: "Could not analyse this course's past assessments right now.",
          code: "EXAM_INSIGHTS_UNAVAILABLE",
        });
      }
    },
  );
}
