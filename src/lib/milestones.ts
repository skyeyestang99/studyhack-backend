import { query } from "../db.js";

/**
 * Activation milestones for the beta funnel: quick help → add course → upload →
 * see exam insights.
 */
export type Milestone =
  | "asked_quick_help"
  | "added_course"
  | "uploaded_material"
  | "viewed_exam_insights"
  /** The retention hook: generating a guide, not merely seeing the feature. */
  | "generated_study_guide";

/**
 * Record that a user reached a milestone, once.
 *
 * Fire-and-forget by design: measurement must never be able to fail a student's
 * request. A failed insert is logged and swallowed — losing one funnel data point
 * is strictly better than turning a successful answer into an error.
 *
 * ON CONFLICT DO NOTHING keeps first_at as the FIRST time, which is the whole
 * point: the funnel asks when someone first reached a step, not how often they
 * repeat it.
 */
export function recordMilestone(userId: string, milestone: Milestone): void {
  void query(
    `INSERT INTO user_milestones (user_id, milestone)
     VALUES ($1, $2)
     ON CONFLICT (user_id, milestone) DO NOTHING`,
    [userId, milestone],
  ).catch((err: unknown) => {
    console.warn(
      `milestone ${milestone} not recorded for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

/** Milestones a user has reached, for driving the setup checklist. */
export async function getMilestones(userId: string): Promise<Milestone[]> {
  const rows = await query<{ milestone: Milestone }>(
    "SELECT milestone FROM user_milestones WHERE user_id=$1",
    [userId],
  );
  return rows.map((r) => r.milestone);
}
