import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { withTransaction, type TxQuery } from "../db.js";

interface EntityRef {
  id?: string;
  name?: string;
}
interface CourseInput {
  code: string;
  name: string;
  professor?: EntityRef;
}
interface OnboardingBody {
  school?: EntityRef;
  semester?: string;
  courses?: CourseInput[];
}

const normCode = (code: string) => code.toUpperCase().replace(/\s+/g, "");

/** Resolve a course by (school, normalized code), creating it if missing. */
async function resolveCourse(
  q: TxQuery,
  schoolId: string,
  professorId: string,
  name: string,
  code: string,
): Promise<string> {
  const existing = await q<{ id: string }>(
    "SELECT id FROM courses WHERE school_id=$1 AND upper(replace(code,' ',''))=$2",
    [schoolId, normCode(code)],
  );
  if (existing[0]) return existing[0].id;

  const inserted = await q<{ id: string }>(
    `INSERT INTO courses (name, code, school_id, professor_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (school_id, upper(replace(code,' ',''))) DO NOTHING
     RETURNING id`,
    [name, code, schoolId, professorId],
  );
  if (inserted[0]) return inserted[0].id;

  // Lost a create race — re-select the row the other writer created.
  const again = await q<{ id: string }>(
    "SELECT id FROM courses WHERE school_id=$1 AND upper(replace(code,' ',''))=$2",
    [schoolId, normCode(code)],
  );
  return again[0].id;
}

/**
 * One transactional call that turns the onboarding form into real rows:
 * resolve-or-create school -> professors -> courses (deduped), then enroll
 * the user in each. Idempotent (re-running won't duplicate enrollments).
 */
export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/onboarding", { preHandler: requireAuth }, async (req, reply) => {
    const { school, semester, courses } = (req.body ?? {}) as OnboardingBody;
    const userId = req.userId!;

    if (!school || (!school.id && !school.name?.trim())) {
      return reply.code(400).send({ message: "school (id or name) is required" });
    }
    const validCourses = (courses ?? []).filter((c) => c.code?.trim() && c.name?.trim());
    if (validCourses.length === 0) {
      return reply.code(400).send({ message: "at least one course (code + name) is required" });
    }

    const result = await withTransaction(async (q) => {
      // 1. School
      let schoolId = school.id;
      if (!schoolId) {
        const rows = await q<{ id: string }>(
          "INSERT INTO schools (name) VALUES ($1) RETURNING id",
          [school.name!.trim()],
        );
        schoolId = rows[0].id;
      }

      // Reused when a course is created without a named professor.
      let unknownProfId: string | null = null;
      const ensureUnknownProf = async (): Promise<string> => {
        if (unknownProfId) return unknownProfId;
        const found = await q<{ id: string }>(
          "SELECT id FROM professors WHERE school_id=$1 AND name='Unknown' LIMIT 1",
          [schoolId],
        );
        unknownProfId = found[0]?.id
          ?? (await q<{ id: string }>(
            "INSERT INTO professors (name, school_id) VALUES ('Unknown',$1) RETURNING id",
            [schoolId],
          ))[0].id;
        return unknownProfId;
      };

      const enrolled: { courseId: string; code: string; name: string }[] = [];
      for (const c of validCourses) {
        // 2. Professor
        let professorId = c.professor?.id;
        if (!professorId && c.professor?.name?.trim()) {
          const rows = await q<{ id: string }>(
            "INSERT INTO professors (name, school_id) VALUES ($1,$2) RETURNING id",
            [c.professor.name.trim(), schoolId],
          );
          professorId = rows[0].id;
        }
        if (!professorId) professorId = await ensureUnknownProf();

        // 3. Course (deduped)
        const courseId = await resolveCourse(q, schoolId, professorId, c.name.trim(), c.code.trim());

        // 4. Enroll (idempotent)
        await q(
          `INSERT INTO enrollments (user_id, course_id, semester) VALUES ($1,$2,$3)
           ON CONFLICT (user_id, course_id) DO NOTHING`,
          [userId, courseId, semester ?? null],
        );
        enrolled.push({ courseId, code: c.code.trim(), name: c.name.trim() });
      }

      return { schoolId, enrolled };
    });

    return reply.code(201).send(result);
  });
}
