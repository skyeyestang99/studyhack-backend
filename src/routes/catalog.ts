import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { query, withTransaction } from "../db.js";
import { isUuid } from "../lib/access.js";
import {
  course,
  prof,
  school,
  searchCourses,
  searchProfessors,
  searchResponse,
  searchSchools,
  type CourseRow,
  type ProfRow,
  type SchoolRow,
} from "../lib/fuzzy.js";

const normalize = (value: string) => value.trim().toLowerCase();
// True when a value is present but NOT a valid UUID (empty/undefined is allowed for optional filters).
const invalidUuid = (v: string | undefined | null) =>
  v != null && v !== "" && !isUuid(v);
// Defensively coerce a client-supplied aliases payload into a bounded string[].
const cleanAliases = (a: unknown): string[] =>
  Array.isArray(a)
    ? a
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 25)
    : [];
const creationBlocked = <T>(message: string, matches: T) => ({
  message,
  candidates: matches,
});
const confirmationRequired = <T>(matches: T) => ({
  message: "Confirm creation before creating a new entity.",
  candidates: matches,
});

/** Catalog: schools / professors / courses. Bare arrays + camelCase (frontend contract). */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // --- Schools ---
  app.get("/api/schools", { preHandler: requireAuth }, async (req) => {
    const q = (req.query as { q?: string }).q?.trim();
    if (q) return searchResponse(await searchSchools(q), school);
    return (await query<SchoolRow>("SELECT * FROM schools ORDER BY name")).map(school);
  });
  app.post("/api/schools", { preHandler: requireAuth }, async (req, reply) => {
    const { name, shortName, aliases, location, confirmed } = (req.body ?? {}) as {
      name?: string;
      shortName?: string;
      aliases?: string[];
      location?: string;
      confirmed?: boolean;
    };
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const created = await withTransaction(async (q) => {
      await q("SELECT pg_advisory_xact_lock(hashtext($1))", ["create:schools"]);
      const exact = await q<SchoolRow>(
        "SELECT * FROM schools WHERE lower(trim(name)) = lower($1) LIMIT 1",
        [name.trim()],
      );
      const matches = await searchSchools(name, q);
      if (exact[0] || matches.some((match) => match.strong)) {
        return { blocked: searchResponse(matches, school) };
      }
      if (!confirmed) return { confirm: searchResponse(matches, school) };
      const rows = await q<SchoolRow>(
        "INSERT INTO schools (name, short_name, aliases, location) VALUES ($1,$2,$3,$4) RETURNING *",
        [name.trim(), shortName?.trim() || null, cleanAliases(aliases), location ?? null],
      );
      return { row: rows[0] };
    });
    if ("blocked" in created) {
      return reply
        .code(409)
        .send(creationBlocked("A similar school already exists.", created.blocked));
    }
    if ("confirm" in created) {
      return reply.code(409).send(confirmationRequired(created.confirm));
    }
    return reply.code(201).send(school(created.row));
  });

  // --- Professors (optional ?schoolId) ---
  app.get("/api/professors", { preHandler: requireAuth }, async (req, reply) => {
    const { schoolId, q } = req.query as { schoolId?: string; q?: string };
    if (invalidUuid(schoolId))
      return reply.code(400).send({ message: "schoolId must be a valid UUID" });
    if (schoolId && q?.trim()) {
      return searchResponse(await searchProfessors(schoolId, q), prof);
    }
    const rows = schoolId
      ? await query<ProfRow>("SELECT * FROM professors WHERE school_id=$1 ORDER BY name", [schoolId])
      : await query<ProfRow>("SELECT * FROM professors ORDER BY name");
    return rows.map(prof);
  });
  app.get("/api/schools/:id/professors", { preHandler: requireAuth }, async (req, reply) => {
    const schoolId = (req.params as { id: string }).id;
    if (!isUuid(schoolId))
      return reply.code(400).send({ message: "invalid school id" });
    const q = (req.query as { q?: string }).q?.trim();
    if (q) return searchResponse(await searchProfessors(schoolId, q), prof);
    return (await query<ProfRow>("SELECT * FROM professors WHERE school_id=$1 ORDER BY name", [schoolId])).map(prof);
  });
  app.post("/api/professors", { preHandler: requireAuth }, async (req, reply) => {
    const { name, shortName, aliases, department, schoolId, confirmed } = (req.body ?? {}) as {
      name?: string;
      shortName?: string;
      aliases?: string[];
      department?: string;
      schoolId?: string;
      confirmed?: boolean;
    };
    if (!name?.trim() || !schoolId) return reply.code(400).send({ message: "name and schoolId are required" });
    if (!isUuid(schoolId)) return reply.code(400).send({ message: "schoolId must be a valid UUID" });
    const created = await withTransaction(async (q) => {
      await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`create:professors:${schoolId}`]);
      const exact = await q<ProfRow>(
        `SELECT * FROM professors
         WHERE school_id=$1 AND lower(trim(name))=lower($2)
         LIMIT 1`,
        [schoolId, name.trim()],
      );
      const matches = await searchProfessors(schoolId, name, q);
      if (exact[0] || matches.some((match) => match.strong)) {
        return { blocked: searchResponse(matches, prof) };
      }
      if (!confirmed) return { confirm: searchResponse(matches, prof) };
      const rows = await q<ProfRow>(
        "INSERT INTO professors (name, short_name, aliases, department, school_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [name.trim(), shortName?.trim() || null, cleanAliases(aliases), department ?? null, schoolId],
      );
      return { row: rows[0] };
    });
    if ("blocked" in created) {
      return reply
        .code(409)
        .send(creationBlocked("A similar professor already exists at this school.", created.blocked));
    }
    if ("confirm" in created) {
      return reply.code(409).send(confirmationRequired(created.confirm));
    }
    return reply.code(201).send(prof(created.row));
  });

  // --- Courses: the user's ENROLLED courses ("my courses") ---
  app.get("/api/schools/:id/courses", { preHandler: requireAuth }, async (req, reply) => {
    const schoolId = (req.params as { id: string }).id;
    if (!isUuid(schoolId))
      return reply.code(400).send({ message: "invalid school id" });
    const q = (req.query as { q?: string }).q?.trim();
    if (q) return searchResponse(await searchCourses(q, { schoolId }), course);
    return (
      await query<CourseRow>(
        `SELECT c.*, COALESCE(enrollment_counts.enrollment_count, 0)::int AS enrollment_count
         FROM courses c
         LEFT JOIN (
           SELECT course_id, COUNT(*)::int AS enrollment_count
           FROM enrollments
           GROUP BY course_id
         ) enrollment_counts
           ON enrollment_counts.course_id = c.id
         WHERE c.school_id=$1
         ORDER BY c.code`,
        [schoolId],
      )
    ).map(course);
  });

  app.get("/api/courses", { preHandler: requireAuth }, async (req, reply) => {
    const { schoolId, professorId, q } = req.query as {
      schoolId?: string;
      professorId?: string;
      q?: string;
    };
    if (invalidUuid(schoolId))
      return reply.code(400).send({ message: "schoolId must be a valid UUID" });
    if (invalidUuid(professorId))
      return reply.code(400).send({ message: "professorId must be a valid UUID" });
    if (q?.trim()) {
      return searchResponse(
        await searchCourses(q, { schoolId, professorId, userId: req.userId }),
        course,
      );
    }
    const rows = await query<CourseRow>(
      `SELECT c.*, COALESCE(enrollment_counts.enrollment_count, 0)::int AS enrollment_count
       FROM courses c
       JOIN enrollments e ON e.course_id = c.id
       LEFT JOIN (
         SELECT course_id, COUNT(*)::int AS enrollment_count
         FROM enrollments
         GROUP BY course_id
       ) enrollment_counts
         ON enrollment_counts.course_id = c.id
       WHERE e.user_id = $1
         AND ($2::uuid IS NULL OR c.school_id = $2::uuid)
         AND ($3::uuid IS NULL OR c.professor_id = $3::uuid)
       ORDER BY c.code`,
      [req.userId, schoolId ?? null, professorId ?? null],
    );
    return rows.map(course);
  });
  app.post("/api/courses", { preHandler: requireAuth }, async (req, reply) => {
    const { name, code, schoolId, professorId, confirmed } = (req.body ?? {}) as {
      name?: string; code?: string; schoolId?: string; professorId?: string; confirmed?: boolean;
    };
    if (!name?.trim() || !code?.trim() || !schoolId || !professorId)
      return reply.code(400).send({ message: "name, code, schoolId, professorId are required" });
    if (!isUuid(schoolId) || !isUuid(professorId))
      return reply.code(400).send({ message: "schoolId and professorId must be valid UUIDs" });
    const created = await withTransaction(async (q) => {
      await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`create:courses:${schoolId}`]);
      const codeMatches = await searchCourses(code, { schoolId }, q);
      const nameMatches = normalize(name) === normalize(code) ? [] : await searchCourses(name, { schoolId }, q);
      const matches = [...codeMatches, ...nameMatches].filter(
        (match, index, all) => all.findIndex((other) => other.row.id === match.row.id) === index,
      );
      if (matches.some((match) => match.strong)) {
        return { blocked: searchResponse(matches, course) };
      }
      const existing = await q<CourseRow>(
        "SELECT * FROM courses WHERE school_id=$1 AND upper(replace(code,' ',''))=upper(replace($2,' ','')) LIMIT 1",
        [schoolId, code.trim()],
      );
      if (existing[0]) {
        return { blocked: searchResponse([{ row: existing[0], score: 1, strong: true }], course) };
      }
      if (!confirmed) return { confirm: searchResponse(matches, course) };
      const rows = await q<CourseRow>(
        `INSERT INTO courses (name, code, school_id, professor_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (school_id, upper(replace(code, ' ', ''))) DO UPDATE SET name = EXCLUDED.name
         RETURNING *`,
        [name.trim(), code.trim(), schoolId, professorId],
      );
      await q(
        `INSERT INTO enrollments (user_id, course_id, semester) VALUES ($1,$2,NULL)
         ON CONFLICT (user_id, course_id) DO NOTHING`,
        [req.userId, rows[0].id],
      );
      return { row: rows[0] };
    });
    if ("blocked" in created) {
      return reply
        .code(409)
        .send(creationBlocked("A similar course already exists.", created.blocked));
    }
    if ("confirm" in created) {
      return reply.code(409).send(confirmationRequired(created.confirm));
    }
    return reply.code(201).send(course(created.row));
  });
}
