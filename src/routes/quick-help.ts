import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { config } from "../config.js";
import { MAX_QUESTION_CHARS } from "../lib/access.js";
import { recordMilestone } from "../lib/milestones.js";
import { MockAgentClient, RealAgentClient, type AgentClient } from "../agent/agent-client.js";

const agent: AgentClient = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();

/**
 * Quick Help — homework help with zero setup.
 *
 * Every other tutoring path requires a course: pick a school, find or create a
 * professor, create the course, enrol, upload material, then ask. That is a lot
 * of work to demand before a student has any evidence the product is useful, and
 * the thing they are comparing it against answers immediately with no setup at
 * all. This endpoint removes the wall so the first question can be asked in
 * seconds.
 *
 * Deliberately NOT course-scoped, so:
 *   - no requireEnrollment, because there is no course to be enrolled in;
 *   - the agent receives no courseId, skips retrieval, and answers in "general"
 *     mode. The response carries that mode so the client can be explicit that
 *     the answer is not grounded in the student's own class material.
 *
 * That distinction is the point rather than a limitation: an unsourced general
 * answer is what a generic chatbot gives, and it is what makes the course-scoped
 * upgrade legible ("this answer isn't from your class — add your course and it
 * will be"). Conversion is earned after the student has been helped once.
 *
 * Still behind requireAuth: this calls a paid model, so it needs an account to
 * attribute cost and abuse to. Signing in is much cheaper friction than
 * constructing a course.
 */
export async function quickHelpRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/quick-help", { preHandler: requireAuth }, async (req, reply) => {
    const { message, history, imageDataUrl } = (req.body ?? {}) as {
      message?: string;
      history?: { role: "user" | "assistant"; content: string }[];
      imageDataUrl?: string;
    };

    if (!message?.trim()) return reply.code(400).send({ error: "message is required" });
    if (message.length > MAX_QUESTION_CHARS) {
      return reply
        .code(400)
        .send({ error: `message is too long (max ${MAX_QUESTION_CHARS} characters)` });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(req.headers.origin
        ? {
            "Access-Control-Allow-Origin": req.headers.origin,
            "Access-Control-Allow-Credentials": "true",
            Vary: "Origin",
          }
        : {}),
    });

    // Step 1 of the activation funnel. Recorded server-side because the client had
    // only localStorage, which reset on a new device and was invisible to us — and
    // quick-help -> course conversion is the beta's key number.
    recordMilestone(req.userId!, "asked_quick_help");

    try {
      for await (const event of agent.chat({
        threadId: `quick-${req.userId}`,
        message,
        // No courseId on purpose — see the note above.
        userId: req.userId!,
        history: Array.isArray(history) ? history.slice(-6) : undefined,
        imageDataUrl,
      })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "agent error";
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message: detail })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
