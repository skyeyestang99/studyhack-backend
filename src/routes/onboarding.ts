import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth.js";
import { withTransaction, type TxQuery } from "../db.js";
import {
  course as mapCourse,
  prof as mapProfessor,
  school as mapSchool,
  searchCourses,
  searchProfessors,
  searchResponse,
  searchSchools,
  type CourseRow,
  type ProfRow,
  type SchoolRow,
} from "../lib/fuzzy.js";

interface EntityRef {
  id?: string;
  name?: string;
  confirmed?: boolean;
}
interface CourseInput {
  id?: string;
  code: string;
  name: string;
  confirmed?: boolean;
  professor?: EntityRef;
}
interface OnboardingBody {
  school?: EntityRef;
  semester?: string;
  courses?: CourseInput[];
}

const normCode = (code: string) => code.toUpperCase().replace(/\s+/g, "");

type BlockedCreate = {
  blocked: {
    message: string;
    candidates: unknown;
  };
};

const isBlocked = (value: unknown): value is BlockedCreate =>
  Boolean(value && typeof value === "object" && "blocked" in value);

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
    const validCourses = (courses ?? []).filter((c) => c.id || (c.code?.trim() && c.name?.trim()));
    if (validCourses.length === 0) {
      return reply.code(400).send({ message: "at least one course (code + name) is required" });
    }

    const result = await withTransaction(async (q) => {
      // 1. School
      let schoolId = school.id;
      if (!schoolId) {
        const normalizedName = school.name!.trim();
        const existing = await q<{ id: string }>(
          "SELECT id FROM schools WHERE lower(trim(name))=lower($1) LIMIT 1",
          [normalizedName],
        );
        schoolId = existing[0]?.id;
        if (!schoolId) {
          await q("SELECT pg_advisory_xact_lock(hashtext($1))", ["create:schools"]);
          const matches = await searchSchools(normalizedName, q);
          if (matches.some((match) => match.strong)) {
            return {
              blocked: {
                message: "A similar school already exists.",
                candidates: searchResponse(matches, mapSchool),
              },
            };
          }
          if (!school.confirmed) {
            return {
              blocked: {
                message: "Confirm school creation before saving onboarding.",
                candidates: searchResponse(matches, mapSchool),
              },
            };
          }
          const rows = await q<SchoolRow>(
            "INSERT INTO schools (name) VALUES ($1) RETURNING id",
            [normalizedName],
          );
          schoolId = rows[0].id;
        }
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
        if (c.id) {
          const existing = await q<CourseRow>("SELECT * FROM courses WHERE id=$1 LIMIT 1", [c.id]);
          if (!existing[0]) {
            return {
              blocked: {
                message: "Selected course no longer exists.",
                candidates: searchResponse([], mapCourse),
              },
            };
          }
          await q(
            `INSERT INTO enrollments (user_id, course_id, semester) VALUES ($1,$2,$3)
             ON CONFLICT (user_id, course_id) DO NOTHING`,
            [userId, c.id, semester ?? null],
          );
          enrolled.push({ courseId: c.id, code: existing[0].code, name: existing[0].name });
          continue;
        }

        // 2. Professor
        let professorId = c.professor?.id;
        if (!professorId && c.professor?.name?.trim()) {
          const normalizedName = c.professor.name.trim();
          const existing = await q<{ id: string }>(
            `SELECT id FROM professors
             WHERE school_id=$1 AND lower(trim(name))=lower($2)
             LIMIT 1`,
            [schoolId, normalizedName],
          );
          professorId = existing[0]?.id;
          if (!professorId) {
            await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`create:professors:${schoolId}`]);
            const matches = await searchProfessors(schoolId, normalizedName, q);
            if (matches.some((match) => match.strong)) {
              return {
                blocked: {
                  message: "A similar professor already exists at this school.",
                  candidates: searchResponse(matches, mapProfessor),
                },
              };
            }
            if (!c.professor.confirmed) {
              return {
                blocked: {
                  message: "Confirm professor creation before saving onboarding.",
                  candidates: searchResponse(matches, mapProfessor),
                },
              };
            }
            const rows = await q<ProfRow>(
              "INSERT INTO professors (name, school_id) VALUES ($1,$2) RETURNING id",
              [normalizedName, schoolId],
            );
            professorId = rows[0].id;
          }
        }
        if (!professorId) professorId = await ensureUnknownProf();

        // 3. Course (deduped by exact normalized code; fuzzy-guarded before create)
        const exactCourse = await q<{ id: string }>(
          "SELECT id FROM courses WHERE school_id=$1 AND upper(replace(code,' ',''))=$2",
          [schoolId, normCode(c.code)],
        );
        let courseId = exactCourse[0]?.id;
        if (!courseId) {
          await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`create:courses:${schoolId}`]);
          const codeMatches = await searchCourses(c.code, { schoolId }, q);
          const nameMatches = normCode(c.code) === normCode(c.name)
            ? []
            : await searchCourses(c.name, { schoolId }, q);
          const matches = [...codeMatches, ...nameMatches].filter(
            (match, index, all) =>
              all.findIndex((other) => other.row.id === match.row.id) === index,
          );
          if (matches.some((match) => match.strong)) {
            return {
              blocked: {
                message: "A similar course already exists.",
                candidates: searchResponse(matches, mapCourse),
              },
            };
          }
          if (!c.confirmed) {
            return {
              blocked: {
                message: "Confirm course creation before saving onboarding.",
                candidates: searchResponse(matches, mapCourse),
              },
            };
          }
          courseId = await resolveCourse(q, schoolId, professorId, c.name.trim(), c.code.trim());
        }

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

    if (isBlocked(result)) {
      return reply.code(409).send(result.blocked);
    }
    return reply.code(201).send(result);
  });
}
