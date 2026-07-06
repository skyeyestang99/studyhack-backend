import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { requireEnrollment, isUuid } from "../lib/access.js";
import { query } from "../db.js";
import { config } from "../config.js";
import {
  MockAgentClient,
  RealAgentClient,
  type AgentClient,
} from "../agent/agent-client.js";

const agent: AgentClient = config.useMockAgent ? new MockAgentClient() : new RealAgentClient();

const MASTERED_INTERVAL_DAYS = 21;

interface CardRow {
  id: string;
  front: string;
  back: string;
  due_at: Date;
  interval_days: number;
  ease: number;
  reps: number;
}

const toCard = (r: CardRow) => ({
  id: r.id,
  front: r.front,
  back: r.back,
  dueAt: r.due_at.toISOString(),
  intervalDays: r.interval_days,
  reps: r.reps,
});

/** SM-2-lite scheduling from a self-rated grade. */
function schedule(
  card: { ease: number; interval_days: number; reps: number },
  grade: "again" | "good" | "easy",
) {
  let { ease, interval_days: interval, reps } = card;
  if (grade === "again") {
    reps = 0;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 3;
    else interval = Math.round(interval * ease);
    if (grade === "easy") {
      interval = Math.round(interval * 1.3);
      ease += 0.15;
    } else {
      ease = Math.max(1.3, ease - 0.02);
    }
  }
  const dueAt = new Date(Date.now() + interval * 86_400_000);
  return { ease, interval, reps, dueAt };
}

export async function flashcardRoutes(app: FastifyInstance): Promise<void> {
  // Generate a set of grounded flashcards for a course.
  app.post(
    "/api/courses/:courseId/flashcards/generate",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { courseId } = req.params as { courseId: string };
      const { topic, count } = (req.body ?? {}) as { topic?: string; count?: number };
      await requireEnrollment(req.userId!, courseId);
      const cards = await agent.flashcards({
        courseId,
        userId: req.userId!,
        topic,
        count: count ?? 10,
      });
      if (cards.length === 0) {
        return reply.code(422).send({ message: "No flashcards could be generated." });
      }
      // Bulk insert.
      const values: string[] = [];
      const params: unknown[] = [];
      cards.forEach((c, i) => {
        values.push(`($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`);
        params.push(req.userId, courseId, c.front, c.back);
      });
      await query(
        `INSERT INTO flashcards (user_id, course_id, front, back) VALUES ${values.join(",")}`,
        params,
      );
      return reply.code(201).send({ created: cards.length });
    },
  );

  // List cards for a course (?due=1 for only-due).
  app.get("/api/courses/:courseId/flashcards", { preHandler: requireAuth }, async (req) => {
    const { courseId } = req.params as { courseId: string };
    const dueOnly = (req.query as { due?: string }).due === "1";
    if (!isUuid(courseId)) return [];
    const rows = await query<CardRow>(
      `SELECT id, front, back, due_at, interval_days, ease, reps
       FROM flashcards
       WHERE user_id=$1 AND course_id=$2 ${dueOnly ? "AND due_at <= now()" : ""}
       ORDER BY due_at`,
      [req.userId, courseId],
    );
    return rows.map(toCard);
  });

  // Progress stats.
  app.get(
    "/api/courses/:courseId/flashcards/stats",
    { preHandler: requireAuth },
    async (req) => {
      const { courseId } = req.params as { courseId: string };
      if (!isUuid(courseId)) return { total: 0, due: 0, mastered: 0 };
      const [row] = await query<{ total: string; due: string; mastered: string }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE due_at <= now()) AS due,
                count(*) FILTER (WHERE interval_days >= $3) AS mastered
         FROM flashcards WHERE user_id=$1 AND course_id=$2`,
        [req.userId, courseId, MASTERED_INTERVAL_DAYS],
      );
      return {
        total: Number(row?.total ?? 0),
        due: Number(row?.due ?? 0),
        mastered: Number(row?.mastered ?? 0),
      };
    },
  );

  // Review a card — reschedule via SM-2-lite.
  app.post("/api/flashcards/:id/review", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { grade } = (req.body ?? {}) as { grade?: string };
    if (grade !== "again" && grade !== "good" && grade !== "easy") {
      return reply.code(400).send({ message: "grade must be again|good|easy" });
    }
    const rows = await query<CardRow>(
      `SELECT id, front, back, due_at, interval_days, ease, reps
       FROM flashcards WHERE id=$1 AND user_id=$2`,
      [id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Not found" });
    const next = schedule(
      { ease: rows[0].ease, interval_days: rows[0].interval_days, reps: rows[0].reps },
      grade,
    );
    await query(
      `UPDATE flashcards SET ease=$1, interval_days=$2, reps=$3, due_at=$4 WHERE id=$5`,
      [next.ease, next.interval, next.reps, next.dueAt.toISOString(), id],
    );
    return reply.code(204).send();
  });
}
