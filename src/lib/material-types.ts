/**
 * Material type taxonomy — single source of truth for the backend.
 *
 * Purpose, not format: "SLIDES" rather than "PPT", because a PDF export of slides is
 * still slides and the old name invited mislabelling.
 */
export const MATERIAL_TYPES = [
  "LECTURE_NOTES",
  "SLIDES",
  "EXAM",
  "QUIZ",
  "HOMEWORK",
  "SOLUTIONS",
  "SYLLABUS",
  "OTHER",
] as const;

export type MaterialType = (typeof MATERIAL_TYPES)[number];

export function isMaterialType(value: unknown): value is MaterialType {
  return typeof value === "string" && (MATERIAL_TYPES as readonly string[]).includes(value);
}

/**
 * Types that count as assessment material for Exam Insights.
 *
 * ⚠️ MUST MATCH the agent's ASSESSMENT_TYPES in studyhack-agent/src/retrieve.ts.
 *
 * They are separate repositories so the list cannot be shared as code, and the two uses
 * are asymmetric in a way that hides disagreement: the backend uses this list to compute
 * the CACHE FINGERPRINT (count + max processed_at of assessment material), while the
 * agent uses its own list to select the corpus it actually analyses.
 *
 * If the lists drift, the failure is silent and confusing rather than loud — the
 * fingerprint stops changing when material the agent does analyse is added (so insights
 * go stale), or changes when material the agent ignores is added (so it recomputes for
 * nothing). Neither throws.
 *
 * SOLUTIONS and QUIZ were added here in migration 0026. Widening the list changes the
 * fingerprint inputs, so every course recomputes its insights once — expected, and
 * cheaper than leaving quizzes out of the feature that most needs them.
 */
export const ASSESSMENT_TYPES = ["EXAM", "QUIZ", "HOMEWORK", "SOLUTIONS"] as const;

/**
 * Display order for the library, deliberately NOT alphabetical.
 *
 * Assessments first: the order teaches contribution priority, because past exams are
 * what make answers professor-specific and are the scarcest thing in the corpus.
 */
export const LIBRARY_GROUP_ORDER: readonly MaterialType[] = [
  "EXAM",
  "QUIZ",
  "SOLUTIONS",
  "HOMEWORK",
  "LECTURE_NOTES",
  "SLIDES",
  "SYLLABUS",
  "OTHER",
];
