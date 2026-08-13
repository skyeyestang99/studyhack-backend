import { query } from "../db.js";
import { Sentry } from "../instrument.js";

/** Metered operations. `ocr_page` is counted in pages, everything else in actions. */
export type UsageKind =
  | "quick_help"
  | "course_chat"
  | "study_guide"
  | "exam_insights"
  | "upload"
  | "ocr_page"
  | "escalation";

export type Tier = "FREE" | "STUDENT" | "TERM" | "BETA";

/**
 * What to do when the quota system ITSELF fails (database unreachable, etc).
 *
 * The axis is per-operation cost-boundedness, not environment. Tying it to APP_ENV
 * would make the behaviour depend on which env file you are in rather than on the
 * actual risk:
 *
 *   - `deny`  — a single action is unbounded. An upload can be 500 OCR pages, and
 *               because ingestion is serialized (agent PR #16) it also blocks every
 *               other student's ingestion behind it.
 *   - `allow` — a single action costs ~$0.0005. Refusing to tutor because a usage
 *               counter is unavailable is a self-inflicted outage.
 *
 * The result is that a database blip degrades to "tutoring still works, large uploads
 * pause", which is the correct degradation for a study tool during finals.
 */
const FAIL_POLICY: Record<UsageKind, "deny" | "allow"> = {
  upload: "deny",
  ocr_page: "deny",
  quick_help: "allow",
  course_chat: "allow",
  study_guide: "allow",
  exam_insights: "allow",
  escalation: "allow",
};

export type QuotaResult =
  | { ok: true; tier: Tier; used: number; limit: number }
  | {
      ok: false;
      reason: "exceeded";
      tier: Tier;
      used: number;
      limit: number;
      resetsAt: string;
    }
  | { ok: false; reason: "unavailable"; kind: UsageKind };

/** Start of the next UTC day — when a daily counter resets. */
function nextResetIso(): string {
  const now = new Date();
  const reset = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return reset.toISOString();
}

export async function resolveTier(userId: string): Promise<Tier> {
  const rows = await query<{ tier: Tier }>("SELECT tier FROM users WHERE id=$1", [userId]);
  // A user row that somehow lacks a tier gets the most restrictive one rather than
  // the most generous — the failure should cost us nothing.
  return rows[0]?.tier ?? "FREE";
}

/**
 * Reserve `amount` units of `kind` for a user, atomically.
 *
 * Authoritative, not fire-and-forget: unlike milestone recording, being wrong here
 * has a cost, so the caller must act on the result.
 *
 * The increment and the limit check happen in ONE statement. Checking first and
 * incrementing after would let two concurrent requests both read `used = limit - 1`
 * and both proceed — which is exactly the pattern a script abuses. The WHERE clause
 * on the upsert's DO UPDATE means the row is only incremented if it stays within the
 * limit, and RETURNING tells us whether it did.
 *
 * Call BEFORE writeHead on a streaming route. Once headers are sent a 429 is no longer
 * expressible and the client sees a truncated stream instead of a reason.
 */
export async function consumeQuota(
  userId: string,
  kind: UsageKind,
  amount = 1,
): Promise<QuotaResult> {
  try {
    const tier = await resolveTier(userId);

    const limitRows = await query<{ daily_limit: number }>(
      "SELECT daily_limit FROM plan_limits WHERE tier=$1 AND kind=$2",
      [tier, kind],
    );
    // No row means this tier/kind pair was never priced. Deny rather than default to
    // unlimited, so forgetting to seed a limit cannot silently open a hole.
    if (!limitRows[0]) {
      return { ok: false, reason: "exceeded", tier, used: 0, limit: 0, resetsAt: nextResetIso() };
    }
    const limit = limitRows[0].daily_limit;

    const rows = await query<{ amount: number }>(
      // INSERT ... SELECT ... WHERE rather than VALUES, so the limit guards BOTH
      // paths. With plain VALUES the initial insert is unguarded — only the
      // ON CONFLICT branch checks the limit — so the first request of each day
      // always succeeded and a limit of 0 did not deny at all. Caught by test.
      // Explicit casts are required: with bare parameters Postgres deduces $3 both as
      // the amount column type and as the comparison operand and rejects the query
      // with "inconsistent types deduced for parameter $3".
      `INSERT INTO user_daily_usage (user_id, day, kind, amount)
       SELECT $1::uuid, (now() AT TIME ZONE 'utc')::date, $2::text, $3::int
        WHERE $3::int <= $4::int
       ON CONFLICT (user_id, day, kind) DO UPDATE
         SET amount = user_daily_usage.amount + EXCLUDED.amount
         WHERE user_daily_usage.amount + EXCLUDED.amount <= $4
       RETURNING amount`,
      [userId, kind, amount, limit],
    );

    if (rows[0]) return { ok: true, tier, used: rows[0].amount, limit };

    // No row returned: either the DO UPDATE was skipped by its WHERE (over limit) or
    // the initial insert itself would exceed the limit. Read the current value to
    // report it accurately.
    const current = await query<{ amount: number }>(
      `SELECT amount FROM user_daily_usage
        WHERE user_id=$1 AND day=(now() AT TIME ZONE 'utc')::date AND kind=$2`,
      [userId, kind],
    );
    return {
      ok: false,
      reason: "exceeded",
      tier,
      used: current[0]?.amount ?? limit,
      limit,
      resetsAt: nextResetIso(),
    };
  } catch (err) {
    const policy = FAIL_POLICY[kind];
    const message = err instanceof Error ? err.message : String(err);
    console.error(`QUOTA SYSTEM UNAVAILABLE for ${kind} (policy=${policy}):`, message);

    /**
     * Reported to Sentry EXPLICITLY, not via console.error.
     *
     * The original code only logged, and the backend's Sentry setup has no
     * captureConsoleIntegration — so the "loud" alarm reached Railway logs that
     * nobody watches and never reached Sentry at all. That made the fail-open rate
     * unalertable, which matters because graceful degradation masks defects: a
     * parameter type-deduction bug in the usage SQL was invisible precisely because
     * allow-policy kinds fell through to this path and kept serving traffic.
     *
     * A fixed fingerprint groups every occurrence into ONE issue, so a Sentry alert
     * can fire on any nonzero event rate rather than on a novel issue appearing.
     */
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      scope.setTag("quota_kind", kind);
      scope.setTag("quota_fail_policy", policy);
      scope.setFingerprint(["quota-system-unavailable"]);
      scope.setContext("quota", { kind, policy, cause: message });
      Sentry.captureMessage(
        `QUOTA SYSTEM UNAVAILABLE (policy=${policy}) — usage is not being enforced`,
      );
    });

    if (policy === "allow") {
      // Proceed so students are not locked out by a counter being unavailable, but
      // the event above is what stops this from being silent.
      return { ok: true, tier: "FREE", used: 0, limit: 0 };
    }
    return { ok: false, reason: "unavailable", kind };
  }
}

/**
 * Give back units after a failed operation.
 *
 * Reservation happens before the work, so a request that dies upstream (a provider
 * outage, say) would otherwise burn the student's allowance for something they never
 * received. Best-effort: failing to refund must not turn a failure into a second one.
 */
export async function refundQuota(
  userId: string,
  kind: UsageKind,
  amount = 1,
): Promise<void> {
  try {
    await query(
      `UPDATE user_daily_usage
          SET amount = GREATEST(0, amount - $3)
        WHERE user_id=$1 AND day=(now() AT TIME ZONE 'utc')::date AND kind=$2`,
      [userId, kind, amount],
    );
  } catch (err) {
    console.warn(
      `could not refund ${amount} ${kind} for ${userId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** Today's usage and limits for every kind — powers Settings → Usage. */
export async function usageSummary(userId: string): Promise<{
  tier: Tier;
  resetsAt: string;
  kinds: { kind: UsageKind; used: number; limit: number }[];
}> {
  const tier = await resolveTier(userId);
  const rows = await query<{ kind: UsageKind; daily_limit: number; amount: number | null }>(
    `SELECT pl.kind, pl.daily_limit, u.amount
       FROM plan_limits pl
       LEFT JOIN user_daily_usage u
         ON u.kind = pl.kind
        AND u.user_id = $1
        AND u.day = (now() AT TIME ZONE 'utc')::date
      WHERE pl.tier = $2
      ORDER BY pl.kind`,
    [userId, tier],
  );
  return {
    tier,
    resetsAt: nextResetIso(),
    kinds: rows.map((r) => ({
      kind: r.kind,
      used: r.amount ?? 0,
      limit: r.daily_limit,
    })),
  };
}

/** The 429 / 503 body for a denied request. Shape is what the UI switches on. */
export function quotaErrorBody(result: Extract<QuotaResult, { ok: false }>) {
  if (result.reason === "unavailable") {
    return {
      // Distinct code so the UI can say "trouble on our end" instead of "you ran
      // out" — the whole point of separating these two states.
      code: "QUOTA_UNAVAILABLE" as const,
      message:
        "We're having trouble checking your usage right now. This is on our end — please try again shortly.",
    };
  }
  return {
    code: "QUOTA_EXCEEDED" as const,
    message: "You've reached today's limit for this feature.",
    tier: result.tier,
    limit: result.limit,
    used: result.used,
    resetsAt: result.resetsAt,
  };
}

export function quotaStatusCode(result: Extract<QuotaResult, { ok: false }>): 429 | 503 {
  return result.reason === "unavailable" ? 503 : 429;
}
