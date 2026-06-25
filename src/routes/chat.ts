import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { config } from "../config.js";
import { MockAgentClient, RealAgentClient, type AgentClient } from "../agent/agent-client.js";

const agent: AgentClient = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();

/**
 * Chat endpoint (Doc 2 §5.6). Streams the agent's response as SSE.
 * Today it streams from MockAgentClient; flip USE_MOCK_AGENT=false once the agent is wired.
 */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/chat", { preHandler: requireAuth }, async (req, reply) => {
    const { threadId, message } = (req.body ?? {}) as { threadId?: string; message?: string };
    if (!message) return reply.code(400).send({ error: "message is required" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      for await (const event of agent.chat({
        threadId: threadId ?? "demo",
        message,
        userId: req.userId!,
      })) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "agent error";
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
