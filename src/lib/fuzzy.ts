import { query, type TxQuery } from "../db.js";

export const STRONG_MATCH_THRESHOLD = 0.65;
const DEFAULT_LIMIT = 5;

type QueryFn = typeof query | TxQuery;

export interface SchoolRow {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[];
  location: string | null;
  created_at: Date;
}

export interface ProfRow {
  id: string;
  name: string;
  short_name: string | null;
  aliases: string[];
  department: string | null;
  school_id: string;
  created_at: Date;
}

export interface CourseRow {
  id: string;
  name: string;
  code: string;
  school_id: string;
  professor_id: string;
  created_at: Date;
}

export interface RankedRow<T> {
  row: T;
  score: number;
  strong: boolean;
}

export const school = (r: SchoolRow) => ({
  id: r.id,
  name: r.name,
  shortName: r.short_name,
  aliases: r.aliases,
  location: r.location,
  createdAt: r.created_at.toISOString(),
});

export const prof = (r: ProfRow) => ({
  id: r.id,
  name: r.name,
  shortName: r.short_name,
  aliases: r.aliases,
  department: r.department,
  schoolId: r.school_id,
  createdAt: r.created_at.toISOString(),
});

export const course = (r: CourseRow) => ({
  id: r.id,
  name: r.name,
  code: r.code,
  schoolId: r.school_id,
  professorId: r.professor_id,
  createdAt: r.created_at.toISOString(),
});

export function searchResponse<T, U>(
  matches: RankedRow<T>[],
  map: (row: T) => U,
) {
  return {
    matches: matches.map(({ row, score, strong }) => ({
      item: map(row),
      score,
      strong,
    })),
    canCreate: !matches.some((match) => match.strong),
    threshold: STRONG_MATCH_THRESHOLD,
  };
}

export function hasStrongMatch(matches: RankedRow<unknown>[]): boolean {
  return matches.some((match) => match.strong);
}

const normalizeQuery = (input: string) => input.trim();

export async function searchSchools(
  search: string,
  q: QueryFn = query,
  limit = DEFAULT_LIMIT,
): Promise<RankedRow<SchoolRow>[]> {
  const term = normalizeQuery(search);
  if (!term) return [];
  const rows = await q<SchoolRow & { score: number }>(
    `SELECT s.*,
            GREATEST(
              CASE WHEN lower(trim(s.name)) = lower($1) THEN 1 ELSE similarity(s.name, $1) END,
              CASE WHEN lower(trim(COALESCE(s.short_name, ''))) = lower($1) THEN 1 ELSE similarity(COALESCE(s.short_name, ''), $1) END,
              COALESCE((
                SELECT max(similarity(alias, $1))
                FROM unnest(s.aliases) AS alias
              ), 0)
            ) AS score
       FROM schools s
      WHERE s.name % $1
         OR COALESCE(s.short_name, '') % $1
         OR EXISTS (
              SELECT 1
              FROM unnest(s.aliases) AS alias
              WHERE alias % $1 OR lower(alias) = lower($1)
            )
      ORDER BY score DESC, s.name ASC
      LIMIT $2`,
    [term, limit],
  );
  return rows.map(({ score, ...row }) => ({
    row,
    score: Number(score),
    strong: Number(score) >= STRONG_MATCH_THRESHOLD,
  }));
}

export async function searchProfessors(
  schoolId: string,
  search: string,
  q: QueryFn = query,
  limit = DEFAULT_LIMIT,
): Promise<RankedRow<ProfRow>[]> {
  const term = normalizeQuery(search);
  if (!schoolId || !term) return [];
  const rows = await q<ProfRow & { score: number }>(
    `SELECT p.*,
            GREATEST(
              CASE WHEN lower(trim(p.name)) = lower($2) THEN 1 ELSE similarity(p.name, $2) END,
              CASE WHEN lower(trim(COALESCE(p.short_name, ''))) = lower($2) THEN 1 ELSE similarity(COALESCE(p.short_name, ''), $2) END,
              COALESCE((
                SELECT max(similarity(alias, $2))
                FROM unnest(p.aliases) AS alias
              ), 0)
            ) AS score
       FROM professors p
      WHERE p.school_id = $1
        AND (
          p.name % $2
          OR COALESCE(p.short_name, '') % $2
          OR EXISTS (
               SELECT 1
               FROM unnest(p.aliases) AS alias
               WHERE alias % $2 OR lower(alias) = lower($2)
             )
        )
      ORDER BY score DESC, p.name ASC
      LIMIT $3`,
    [schoolId, term, limit],
  );
  return rows.map(({ score, ...row }) => ({
    row,
    score: Number(score),
    strong: Number(score) >= STRONG_MATCH_THRESHOLD,
  }));
}

export async function searchCourses(
  search: string,
  options: { schoolId?: string; professorId?: string; userId?: string } = {},
  q: QueryFn = query,
  limit = DEFAULT_LIMIT,
): Promise<RankedRow<CourseRow>[]> {
  const term = normalizeQuery(search);
  if (!term) return [];
  const rows = await q<CourseRow & { score: number }>(
    `SELECT c.*,
            GREATEST(
              CASE WHEN lower(trim(c.name)) = lower($1) THEN 1 ELSE similarity(c.name, $1) END,
              CASE
                WHEN upper(replace(c.code, ' ', '')) = upper(replace($1, ' ', '')) THEN 1
                ELSE similarity(c.code, $1)
              END
            ) AS score
       FROM courses c
       LEFT JOIN enrollments e
         ON e.course_id = c.id
        AND e.user_id = $4
      WHERE ($2::uuid IS NULL OR c.school_id = $2::uuid)
        AND ($3::uuid IS NULL OR c.professor_id = $3::uuid)
        AND ($4::uuid IS NULL OR e.user_id = $4::uuid)
        AND (c.name % $1 OR c.code % $1 OR upper(replace(c.code, ' ', '')) = upper(replace($1, ' ', '')))
      ORDER BY score DESC, c.code ASC
      LIMIT $5`,
    [
      term,
      options.schoolId ?? null,
      options.professorId ?? null,
      options.userId ?? null,
      limit,
    ],
  );
  return rows.map(({ score, ...row }) => ({
    row,
    score: Number(score),
    strong: Number(score) >= STRONG_MATCH_THRESHOLD,
  }));
}
