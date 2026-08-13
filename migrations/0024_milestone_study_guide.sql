-- 0024: add generated_study_guide to the activation milestone vocabulary.
--
-- The funnel already measured reaching the exam-insights payoff, but generating a
-- study guide is the retention hook — the thing a student comes back for rather
-- than just looks at once. Without it the funnel can only show that someone SAW the
-- differentiator, not that they used the feature that keeps them.
--
-- The vocabulary is CHECK-constrained (migration 0023) specifically so a new
-- milestone cannot be introduced by a typo in application code; the cost is that
-- adding a real one requires this migration.
ALTER TABLE user_milestones DROP CONSTRAINT IF EXISTS user_milestones_milestone_check;

ALTER TABLE user_milestones
  ADD CONSTRAINT user_milestones_milestone_check
  CHECK (milestone IN (
    'asked_quick_help',
    'added_course',
    'uploaded_material',
    'viewed_exam_insights',
    'generated_study_guide'
  ));
