import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { requireEnrollment } from "../lib/access.js";
import { recordMilestone } from "../lib/milestones.js";
import { ASSESSMENT_TYPES } from "../lib/material-types.js";
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
        AND material_type = ANY($2::text[])
        AND embedding_status = 'done'`,
    [courseId, [...ASSESSMENT_TYPES]],
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

      /**
       * Records the funnel's payoff step, but ONLY when there is something to see.
       *
       * The panel fetches on mount, so recording on request meant every visit to a
       * course home counted — including courses with no past assessments, where the
       * student saw an empty state. That inflated the one metric meant to prove the
       * differentiator lands, which is worse than not measuring it: it would have
       * reported success regardless of whether the feature worked.
       *
       * Cached responses still count. The student saw real content either way; only
       * emptiness disqualifies it.
       */
      const recordIfSubstantive = (value: { topics?: unknown[] }) => {
        if ((value.topics?.length ?? 0) > 0) {
          recordMilestone(req.userId!, "viewed_exam_insights");
        }
      };

      const fingerprint = await assessmentFingerprint(courseId);
      const hit = cache.get(courseId);
      if (hit && hit.fingerprint === fingerprint) {
        recordIfSubstantive(hit.value);
        return { ...hit.value, cached: true };
      }

      try {
        const value = await agent.examInsights(courseId);
        /**
         * Do not cache an empty analysis for a course that HAS assessment material.
         *
         * Emptiness is the correct answer when there is nothing to analyse, and
         * caching that is free. But if the model returns no topics for a course
         * that does have past assessments — a transient upstream failure, or an
         * answer whose citations all failed to resolve — caching it would pin the
         * student to "no insights" until they happened to upload something new,
         * which reads as the feature being broken. Recomputing is the cheaper
         * mistake.
         */
        const worthCaching = value.topics.length > 0 || value.assessmentCount === 0;
        if (worthCaching) cache.set(courseId, { fingerprint, value });
        recordIfSubstantive(value);
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
