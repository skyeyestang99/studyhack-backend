import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { requireEnrollment, isUuid } from "../lib/access.js";
import { query } from "../db.js";

interface EventRow {
  id: string;
  course_id: string;
  title: string;
  type: string;
  due_at: Date;
  source_material_id: string | null;
}

const TYPES = ["HOMEWORK", "MIDTERM", "FINAL", "READING", "OTHER"];

const toEvent = (r: EventRow) => ({
  id: r.id,
  courseId: r.course_id,
  title: r.title,
  type: r.type,
  dueAt: r.due_at.toISOString(),
  sourceMaterialId: r.source_material_id ?? undefined,
});

/** Exam/deadline tracking for the retention loop (countdowns + reminders). */
export async function syllabusRoutes(app: FastifyInstance): Promise<void> {
  // List the user's events (optionally scoped to a course). Bare array.
  app.get("/api/syllabus-events", { preHandler: requireAuth }, async (req) => {
    const courseId = (req.query as { courseId?: string }).courseId;
    const rows =
      courseId && isUuid(courseId)
        ? await query<EventRow>(
            `SELECT id, course_id, title, type, due_at, source_material_id
             FROM syllabus_events WHERE user_id=$1 AND course_id=$2 ORDER BY due_at`,
            [req.userId, courseId],
          )
        : await query<EventRow>(
            `SELECT id, course_id, title, type, due_at, source_material_id
             FROM syllabus_events WHERE user_id=$1 ORDER BY due_at`,
            [req.userId],
          );
    return rows.map(toEvent);
  });

  // Add an event (exam/deadline) to an enrolled course.
  app.post("/api/syllabus-events", { preHandler: requireAuth }, async (req, reply) => {
    const { courseId, title, type, dueAt } = (req.body ?? {}) as {
      courseId?: string;
      title?: string;
      type?: string;
      dueAt?: string;
    };
    if (!title?.trim()) return reply.code(400).send({ message: "title is required" });
    if (!dueAt || Number.isNaN(Date.parse(dueAt))) {
      return reply.code(400).send({ message: "a valid dueAt date is required" });
    }
    const eventType = type && TYPES.includes(type) ? type : "OTHER";
    await requireEnrollment(req.userId!, courseId); // 400/404/403

    const rows = await query<EventRow>(
      `INSERT INTO syllabus_events (user_id, course_id, title, type, due_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, course_id, title, type, due_at, source_material_id`,
      [req.userId, courseId, title.trim(), eventType, new Date(dueAt).toISOString()],
    );
    return reply.code(201).send(toEvent(rows[0]));
  });

  // Delete one of the user's events.
  app.delete("/api/syllabus-events/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rows = await query<{ id: string }>(
      `DELETE FROM syllabus_events WHERE id=$1 AND user_id=$2 RETURNING id`,
      [id, req.userId],
    );
    if (!rows[0]) return reply.code(404).send({ message: "Not found" });
    return reply.code(204).send();
  });
}
