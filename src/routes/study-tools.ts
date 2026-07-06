import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { requireEnrollment } from "../lib/access.js";
import { config } from "../config.js";
import {
  MockAgentClient,
  RealAgentClient,
  type AgentClient,
  type StudyToolInput,
} from "../agent/agent-client.js";
import type { AgentEvent } from "../types.js";

const agent: AgentClient = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();

const KINDS: StudyToolInput["kind"][] = ["study_guide", "practice_problems"];

/**
 * Generate a grounded study artifact (guide / practice problems) for a course,
 * streamed in the frontend's named-event SSE framing (event: token|citation|done|error).
 */
export async function studyToolRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/courses/:courseId/study-tools",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { courseId } = req.params as { courseId: string };
      const { kind, topic, count } = (req.body ?? {}) as {
        kind?: string;
        topic?: string;
        count?: number;
      };
      if (!kind || !KINDS.includes(kind as StudyToolInput["kind"])) {
        return reply.code(400).send({ message: `kind must be one of: ${KINDS.join(", ")}` });
      }
      // Only enrolled students can generate tools for a course (400/404/403).
      await requireEnrollment(req.userId!, courseId);

      const origin = req.headers.origin;
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...(origin
          ? {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Credentials": "true",
              Vary: "Origin",
            }
          : {}),
      });
      const emit = (event: string, data: unknown) =>
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      try {
        for await (const ev of agent.studyTool({
          kind: kind as StudyToolInput["kind"],
          courseId,
          userId: req.userId!,
          topic,
          count,
        }) as AsyncIterable<AgentEvent>) {
          if (ev.type === "token") emit("token", ev.content);
          else if (ev.type === "citation") emit("citation", ev);
          else if (ev.type === "error") emit("error", { message: ev.message });
        }
        emit("done", {});
      } catch (err) {
        emit("error", { message: err instanceof Error ? err.message : "study tool error" });
      } finally {
        reply.raw.end();
      }
    },
  );
}
