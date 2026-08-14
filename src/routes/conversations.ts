import type { FastifyInstance, FastifyReply } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { config } from "../config.js";
import { query, withTransaction } from "../db.js";
import { MAX_QUESTION_CHARS, requireEnrollment } from "../lib/access.js";
import { MockAgentClient, RealAgentClient, type AgentClient } from "../agent/agent-client.js";
import type { AgentEvent } from "../types.js";

const agent: AgentClient = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();

interface ConvRow {
  id: string;
  course_id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  course_name: string | null;
}

const toConversation = (r: ConvRow) => ({
  id: r.id,
  courseId: r.course_id,
  courseName: r.course_name ?? "",
  title: r.title ?? "",
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/** Load a conversation owned by the user (with courseName), or null. */
async function loadOwned(id: string, userId: string): Promise<ConvRow | null> {
  const rows = await query<ConvRow>(
    `SELECT c.id, c.course_id, c.title, c.created_at, c.updated_at, co.name AS course_name
     FROM conversations c
     LEFT JOIN courses co ON co.id = c.course_id
     WHERE c.id = $1 AND c.user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** Run the agent for `question`, stream to the client in the frontend's SSE
 * framing (event: token|citation|done|error), and persist the assistant message. */
async function streamAnswer(
  reply: FastifyReply,
  conv: ConvRow,
  question: string,
  userId: string,
  origin?: string,
  imageDataUrl?: string,
): Promise<void> {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // reply.raw bypasses the @fastify/cors onSend hook, so echo CORS here or
    // the browser blocks reading the streamed response.
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin",
        }
      : {}),
  });
  const write = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let answer = "";
  let mode: string | null = null;
  let verified = false;
  const citations: unknown[] = [];
  try {
    // Prior turns (excluding the current question, which is the last message),
    // capped to the most recent few, so follow-ups keep context (multi-turn).
    const histRows = await query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY created_at`,
      [conv.id],
    );
    const history = histRows
      .slice(0, -1)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    for await (const ev of agent.chat({
      threadId: conv.id,
      message: question,
      courseId: conv.course_id,
      userId,
      history,
      imageDataUrl,
    }) as AsyncIterable<AgentEvent>) {
      if (ev.type === "token") {
        answer += ev.content;
        write("token", ev.content); // data = JSON string; frontend JSON.parses it
      } else if (ev.type === "mode") {
        mode = ev.mode;
        write("mode", { mode: ev.mode, topSource: ev.topSource });
      } else if (ev.type === "verification") {
        verified = true;
        write("verification", { status: ev.status, detail: ev.detail });
      } else if (ev.type === "citation") {
        citations.push(ev);
        write("citation", ev);
        // Records that this document was actually useful in an answer — the strongest
        // available signal, because the product produced it rather than someone
        // self-reporting. Fire-and-forget: a failed increment must never damage an
        // answer that is mid-stream. Same discipline as milestone recording.
        //
        // NOTE: cited_count orders the LIBRARY only. It must never influence RAG chunk
        // ranking — popularity may order the shelf, never the answer.
        const citedMaterialId = (ev as { materialId?: string }).materialId;
        if (citedMaterialId) {
          void query(
            "UPDATE materials SET cited_count = cited_count + 1 WHERE id = $1",
            [citedMaterialId],
          ).catch((err: unknown) => {
            console.warn(
              `cited_count not incremented for ${citedMaterialId}:`,
              err instanceof Error ? err.message : err,
            );
          });
        }
      } else if (ev.type === "error") {
        write("error", { message: ev.message });
      }
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO messages (conversation_id, role, content, citations, mode, verified)
       VALUES ($1,'assistant',$2,$3,$4,$5) RETURNING id`,
      [conv.id, answer, citations.length ? JSON.stringify(citations) : null, mode, verified],
    );
    await query("UPDATE conversations SET updated_at=now() WHERE id=$1", [conv.id]);
    write("done", { messageId: inserted[0]?.id });
  } catch (err) {
    write("error", { message: err instanceof Error ? err.message : "agent error" });
  } finally {
    reply.raw.end();
  }
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // List the user's conversations (frontend filters by course client-side).
  app.get("/api/conversations", { preHandler: requireAuth }, async (req) => {
    const rows = await query<ConvRow>(
      `SELECT c.id, c.course_id, c.title, c.created_at, c.updated_at, co.name AS course_name
       FROM conversations c
       LEFT JOIN courses co ON co.id = c.course_id
       WHERE c.user_id = $1
       ORDER BY c.updated_at DESC`,
      [req.userId],
    );
    return rows.map(toConversation);
  });

  // Create a conversation from the first question (stores it as the first user message).
  app.post("/api/conversations", { preHandler: requireAuth }, async (req, reply) => {
    const { courseId, questionText } = (req.body ?? {}) as {
      courseId?: string;
      questionText?: string;
    };
    if (!questionText?.trim()) {
      return reply.code(400).send({ message: "questionText is required" });
    }
    if (questionText.trim().length > MAX_QUESTION_CHARS) {
      return reply
        .code(400)
        .send({ message: `question is too long (max ${MAX_QUESTION_CHARS} characters)` });
    }
    // Validates courseId shape (400) + existence (404) + enrollment (403)
    // BEFORE any insert, so a bad courseId can never poison the row/list.
    await requireEnrollment(req.userId!, courseId);
    const title = questionText.trim().slice(0, 80);
    const conv = await withTransaction(async (q) => {
      const [c] = await q<{ id: string }>(
        `INSERT INTO conversations (user_id, course_id, title) VALUES ($1,$2,$3) RETURNING id`,
        [req.userId, courseId, title],
      );
      await q(
        `INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)`,
        [c.id, questionText.trim()],
      );
      return c;
    });
    const row = await loadOwned(conv.id, req.userId!);
    return reply.code(201).send(toConversation(row!));
  });

  // Messages in a conversation.
  app.get("/api/conversations/:id/messages", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await loadOwned(id, req.userId!))) return reply.code(404).send({ message: "Not found" });
    const rows = await query<{
      id: string;
      role: string;
      content: string;
      citations: unknown;
      mode: string | null;
      verified: boolean | null;
      created_at: Date;
    }>(
      `SELECT id, role, content, citations, mode, verified, created_at FROM messages
       WHERE conversation_id=$1 ORDER BY created_at`,
      [id],
    );
    return rows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at.toISOString(),
      citations: m.citations ?? undefined,
      mode: m.mode ?? undefined,
      verified: m.verified ?? undefined,
    }));
  });

  // Stream the answer to the conversation's latest user question (first turn).
  app.post("/api/conversations/:id/stream", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = await loadOwned(id, req.userId!);
    if (!conv) return reply.code(404).send({ message: "Not found" });
    await requireEnrollment(req.userId!, conv.course_id); // revoked-access defense
    const [last] = await query<{ content: string }>(
      `SELECT content FROM messages WHERE conversation_id=$1 AND role='user'
       ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    if (!last) return reply.code(400).send({ message: "no question to answer" });
    const { imageDataUrl } = (req.body ?? {}) as { imageDataUrl?: string };
    await streamAnswer(reply, conv, last.content, req.userId!, req.headers.origin, imageDataUrl);
  });

  // Follow-up: add a user message, then stream the answer.
  app.post("/api/conversations/:id/messages", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = await loadOwned(id, req.userId!);
    if (!conv) return reply.code(404).send({ message: "Not found" });
    await requireEnrollment(req.userId!, conv.course_id); // revoked-access defense
    const { content } = (req.body ?? {}) as { content?: string };
    if (!content?.trim()) return reply.code(400).send({ message: "content is required" });
    if (content.trim().length > MAX_QUESTION_CHARS) {
      return reply
        .code(400)
        .send({ message: `message is too long (max ${MAX_QUESTION_CHARS} characters)` });
    }
    const { imageDataUrl } = (req.body ?? {}) as { imageDataUrl?: string };
    await query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1,'user',$2)`,
      [id, content.trim()],
    );
    await streamAnswer(reply, conv, content.trim(), req.userId!, req.headers.origin, imageDataUrl);
  });

  // Rate / report an assistant answer (👍/👎/report) — the quality-signal loop.
  app.post(
    "/api/conversations/:id/messages/:messageId/feedback",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { id, messageId } = req.params as { id: string; messageId: string };
      if (!(await loadOwned(id, req.userId!))) return reply.code(404).send({ message: "Not found" });
      const owns = await query<{ id: string }>(
        `SELECT id FROM messages WHERE id=$1 AND conversation_id=$2 AND role='assistant'`,
        [messageId, id],
      );
      if (!owns[0]) return reply.code(404).send({ message: "Message not found" });

      const { rating, reported, reason } = (req.body ?? {}) as {
        rating?: string;
        reported?: boolean;
        reason?: string;
      };
      if (rating && rating !== "up" && rating !== "down") {
        return reply.code(400).send({ message: "rating must be 'up' or 'down'" });
      }
      await query(
        `INSERT INTO message_feedback (message_id, user_id, rating, reported, reason)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (message_id, user_id) DO UPDATE SET
           rating   = COALESCE(EXCLUDED.rating, message_feedback.rating),
           reported = message_feedback.reported OR EXCLUDED.reported,
           reason   = COALESCE(EXCLUDED.reason, message_feedback.reason),
           updated_at = now()`,
        [messageId, req.userId, rating ?? null, reported ?? false, reason ?? null],
      );
      return reply.code(204).send();
    },
  );

  // Delete a conversation (cascades messages).
  app.delete("/api/conversations/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<{ id: string }>(
      `DELETE FROM conversations WHERE id=$1 AND user_id=$2 RETURNING id`,
      [id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Not found" });
    return reply.code(204).send();
  });
}
