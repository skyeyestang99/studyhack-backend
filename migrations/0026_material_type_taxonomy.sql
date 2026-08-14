-- 0026: material type taxonomy (Course Materials workstream, Part 1).
--
-- The previous allow-list — HOMEWORK, PPT, EXAM, NOTES, SYLLABUS — had three problems:
--
--  1. It mixed PURPOSE with FORMAT. "PPT" describes a file format; everything else
--     describes what the document is for. Renaming to SLIDES makes the axis consistent
--     and stops a PDF of slides being mislabelled.
--  2. No QUIZ. Quizzes are the most common small assessment, so they were being filed as
--     EXAM (inflating "past exams") or as HOMEWORK/NOTES — in which case they vanished
--     from Exam Insights entirely, which is the feature that most needs them.
--  3. No SOLUTIONS. A solutions PDF is assessment material and belongs in the insights
--     corpus; filed as NOTES it was invisible to it.
--
-- Run before the library work because every later part renders these types, and the
-- backfill only gets larger with each day of uploads.
--
-- No CHECK constraint existed on material_type before now, which is why bad values
-- could accumulate; one is added at the end so this cannot drift again.

-- 1. Backfill the two renames. Purely mechanical: same meaning, new name.
UPDATE materials SET material_type = 'SLIDES'        WHERE material_type = 'PPT';
UPDATE materials SET material_type = 'LECTURE_NOTES' WHERE material_type = 'NOTES';

-- 2. Anything outside the new vocabulary becomes OTHER rather than blocking the
--    constraint. Real rows exist from before validation was tightened, and failing the
--    migration on legacy data would just mean nobody runs it.
UPDATE materials
   SET material_type = 'OTHER'
 WHERE material_type IS NOT NULL
   AND material_type NOT IN (
     'LECTURE_NOTES','SLIDES','EXAM','QUIZ','HOMEWORK','SOLUTIONS','SYLLABUS','OTHER'
   );

-- 3. material_chunks does NOT carry material_type, so nothing to backfill there — the
--    agent joins to materials for it. Verified before writing this.

ALTER TABLE materials DROP CONSTRAINT IF EXISTS materials_material_type_valid;
ALTER TABLE materials
  ADD CONSTRAINT materials_material_type_valid
  CHECK (
    material_type IS NULL
    OR material_type IN (
      'LECTURE_NOTES','SLIDES','EXAM','QUIZ','HOMEWORK','SOLUTIONS','SYLLABUS','OTHER'
    )
  );

-- Exam Insights and the library both filter on assessment types, so this index earns
-- its keep on the hot path for both.
CREATE INDEX IF NOT EXISTS idx_materials_course_type
  ON materials (course_id, material_type)
  WHERE deleted_at IS NULL;
