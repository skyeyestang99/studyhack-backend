import { query } from "../db.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string | undefined | null): boolean =>
  typeof s === "string" && UUID_RE.test(s);

/** Error carrying an HTTP status code — Fastify's default handler honors `statusCode`. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpError";
  }
}

/**
 * Authorize a user for a course: courseId must be a valid UUID (400), the course
 * must exist (404), and the user must be enrolled (403). Returns {id, name}.
 * This is the access-policy gate for course-scoped actions (chat, upload).
 */
export async function requireEnrollment(
  userId: string,
  courseId: string | undefined | null,
): Promise<{ id: string; name: string }> {
  if (!isUuid(courseId)) throw new HttpError(400, "a valid courseId is required");
  const course = await query<{ id: string; name: string }>(
    "SELECT id, name FROM courses WHERE id = $1",
    [courseId],
  );
  if (!course[0]) throw new HttpError(404, "course not found");
  const enrolled = await query<{ one: number }>(
    "SELECT 1 AS one FROM enrollments WHERE user_id = $1 AND course_id = $2 LIMIT 1",
    [userId, courseId],
  );
  if (!enrolled[0]) throw new HttpError(403, "you are not enrolled in this course");
  return course[0];
}
