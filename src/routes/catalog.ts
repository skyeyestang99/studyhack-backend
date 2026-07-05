import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { query } from "../db.js";

interface SchoolRow {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[];
  location: string | null;
  created_at: Date;
}
interface ProfRow {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[];
  department: string | null;
  school_id: string;
  created_at: Date;
}
interface CourseRow { id: string; name: string; code: string; school_id: string; professor_id: string; created_at: Date }

const school = (r: SchoolRow) => ({
  id: r.id,
  name: r.name,
  shortName: r.short_name,
  aliases: r.aliases,
  location: r.location,
  createdAt: r.created_at.toISOString(),
});
const prof = (r: ProfRow) => ({
  id: r.id,
  name: r.name,
  shortName: r.short_name,
  aliases: r.aliases,
  department: r.department,
  schoolId: r.school_id,
  createdAt: r.created_at.toISOString(),
});
const course = (r: CourseRow) => ({ id: r.id, name: r.name, code: r.code, schoolId: r.school_id, professorId: r.professor_id, createdAt: r.created_at.toISOString() });

/** Catalog: schools / professors / courses. Bare arrays + camelCase (frontend contract). */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // --- Schools ---
  app.get("/api/schools", { preHandler: requireAuth }, async () =>
    (await query<SchoolRow>("SELECT * FROM schools ORDER BY name")).map(school),
  );
  app.post("/api/schools", { preHandler: requireAuth }, async (req, reply) => {
    const { name, shortName, aliases, location } = (req.body ?? {}) as {
      name?: string;
      shortName?: string;
      aliases?: string[];
      location?: string;
    };
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const rows = await query<SchoolRow>(
      "INSERT INTO schools (name, short_name, aliases, location) VALUES ($1,$2,$3,$4) RETURNING *",
      [name.trim(), shortName?.trim() || null, aliases ?? [], location ?? null],
    );
    return reply.code(201).send(school(rows[0]));
  });

  // --- Professors (optional ?schoolId) ---
  app.get("/api/professors", { preHandler: requireAuth }, async (req) => {
    const schoolId = (req.query as { schoolId?: string }).schoolId;
    const rows = schoolId
      ? await query<ProfRow>("SELECT * FROM professors WHERE school_id=$1 ORDER BY name", [schoolId])
      : await query<ProfRow>("SELECT * FROM professors ORDER BY name");
    return rows.map(prof);
  });
  app.post("/api/professors", { preHandler: requireAuth }, async (req, reply) => {
    const { name, shortName, aliases, department, schoolId } = (req.body ?? {}) as {
      name?: string;
      shortName?: string;
      aliases?: string[];
      department?: string;
      schoolId?: string;
    };
    if (!name?.trim() || !schoolId) return reply.code(400).send({ message: "name and schoolId are required" });
    const rows = await query<ProfRow>(
      "INSERT INTO professors (name, short_name, aliases, department, school_id) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [name.trim(), shortName?.trim() || null, aliases ?? [], department ?? null, schoolId],
    );
    return reply.code(201).send(prof(rows[0]));
  });

  // --- Courses: the user's ENROLLED courses ("my courses") ---
  app.get("/api/courses", { preHandler: requireAuth }, async (req) => {
    const rows = await query<CourseRow>(
      `SELECT c.* FROM courses c
       JOIN enrollments e ON e.course_id = c.id
       WHERE e.user_id = $1
       ORDER BY c.code`,
      [req.userId],
    );
    return rows.map(course);
  });
  app.post("/api/courses", { preHandler: requireAuth }, async (req, reply) => {
    const { name, code, schoolId, professorId } = (req.body ?? {}) as {
      name?: string; code?: string; schoolId?: string; professorId?: string;
    };
    if (!name?.trim() || !code?.trim() || !schoolId || !professorId)
      return reply.code(400).send({ message: "name, code, schoolId, professorId are required" });
    const rows = await query<CourseRow>(
      "INSERT INTO courses (name, code, school_id, professor_id) VALUES ($1,$2,$3,$4) RETURNING *",
      [name, code, schoolId, professorId],
    );
    return reply.code(201).send(course(rows[0]));
  });
}
