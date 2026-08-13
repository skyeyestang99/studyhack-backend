import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fail-policy tests, with the quota layer failing IN ISOLATION.
 *
 * Why isolation matters — a correction to the claim made when this shipped:
 *
 * The design doc said a database blip would degrade to "tutoring still works, large
 * uploads pause". Testing it against a genuinely unreachable database showed that is
 * FALSE for a total outage: requireAuth itself queries the database (the Clerk path
 * runs `SELECT id FROM users WHERE clerk_id=$1`), so every authenticated request 500s
 * in auth and the quota policy is never consulted.
 *
 * The per-operation fail policy is therefore scoped to failures ISOLATED to the quota
 * layer — a statement timeout on the usage upsert, lock contention on
 * user_daily_usage, a missing plan_limits row, a bad migration — which are real and
 * more common than a total outage. These tests exercise exactly that, by making only
 * quota queries throw.
 *
 * Making the original claim true would require auth to survive a brief outage (an
 * in-memory clerk_id -> user_id cache). Tracked as a follow-up, not pretended here.
 */

const QUOTA_TABLES = /plan_limits|user_daily_usage/;
let failQuotaQueries = false;

const captured: { message: string; tags: Record<string, string>; fingerprint: string[] }[] = [];
vi.mock("../instrument.js", () => ({
  Sentry: {
    withScope: (fn: (scope: unknown) => void) => {
      const rec = { message: "", tags: {} as Record<string, string>, fingerprint: [] as string[] };
      const scope = {
        setLevel: () => {},
        setTag: (k: string, v: string) => {
          rec.tags[k] = v;
        },
        setFingerprint: (f: string[]) => {
          rec.fingerprint = f;
        },
        setContext: () => {},
      };
      fn(scope);
      captureTarget = rec;
      fn === undefined;
    },
    captureMessage: (m: string) => {
      if (captureTarget) {
        captureTarget.message = m;
        captured.push(captureTarget);
        captureTarget = null;
      }
    },
  },
}));
let captureTarget: { message: string; tags: Record<string, string>; fingerprint: string[] } | null = null;

vi.mock("../db.js", () => ({
  pool: { connect: vi.fn(), end: vi.fn(), query: vi.fn() },
  query: vi.fn(async (sql: string) => {
    if (failQuotaQueries && QUOTA_TABLES.test(sql)) {
      throw new Error("simulated quota-layer failure (statement timeout)");
    }
    if (/FROM users WHERE id=/.test(sql)) return [{ tier: "FREE" }];
    if (/plan_limits/.test(sql)) return [{ daily_limit: 10 }];
    if (/user_daily_usage/.test(sql)) return [{ amount: 1 }];
    return [];
  }),
  withTransaction: vi.fn(),
}));

const { consumeQuota } = await import("./quota.js");

describe("quota fail policy (quota layer failing in isolation)", () => {
  beforeEach(() => {
    failQuotaQueries = false;
    captured.length = 0;
    vi.clearAllMocks();
  });

  it("ALLOWS chat when the quota layer is broken, because one action costs ~$0.0005", async () => {
    failQuotaQueries = true;
    for (const kind of ["quick_help", "course_chat", "study_guide", "exam_insights"] as const) {
      const r = await consumeQuota("11111111-1111-1111-1111-111111111111", kind);
      expect(r.ok, `${kind} should fail OPEN`).toBe(true);
    }
  });

  it("DENIES upload and ocr_page when the quota layer is broken, because one action is unbounded", async () => {
    failQuotaQueries = true;
    for (const kind of ["upload", "ocr_page"] as const) {
      const r = await consumeQuota("11111111-1111-1111-1111-111111111111", kind);
      expect(r.ok, `${kind} should fail CLOSED`).toBe(false);
      // Must be reported as OUR problem, not as the student's allowance running out.
      expect(r.ok === false && r.reason).toBe("unavailable");
    }
  });

  it("logs the fail-open loudly, so graceful degradation cannot hide a defect", async () => {
    // This is the hazard that already bit once: a type-deduction bug in the usage SQL
    // was invisible because allow-policy kinds silently fell through to fail-open.
    // The log line is what makes a nonzero fail-open rate alertable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    failQuotaQueries = true;
    await consumeQuota("11111111-1111-1111-1111-111111111111", "quick_help");
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).toContain("QUOTA SYSTEM UNAVAILABLE");
    expect(logged).toContain("policy=allow");
    spy.mockRestore();
  });

  it("reports fail-open to Sentry with a STABLE fingerprint, so a rate alert can fire", async () => {
    // console.error alone was not enough: the backend's Sentry setup has no
    // captureConsoleIntegration, so the alarm reached Railway logs nobody watches and
    // never reached Sentry. Without an event there, "alert on any nonzero fail-open
    // rate" is impossible to configure.
    failQuotaQueries = true;
    await consumeQuota("11111111-1111-1111-1111-111111111111", "quick_help");
    await consumeQuota("11111111-1111-1111-1111-111111111111", "course_chat");

    expect(captured).toHaveLength(2);
    expect(captured[0].message).toContain("QUOTA SYSTEM UNAVAILABLE");
    expect(captured[0].tags.quota_fail_policy).toBe("allow");
    expect(captured[0].tags.quota_kind).toBe("quick_help");
    // Same fingerprint for every occurrence => one issue whose event RATE is alertable,
    // rather than a new issue each time that only alerts on first sight.
    expect(captured[0].fingerprint).toEqual(["quota-system-unavailable"]);
    expect(captured[1].fingerprint).toEqual(captured[0].fingerprint);
  });

  it("does not fail open when the quota layer is healthy", async () => {
    failQuotaQueries = false;
    const r = await consumeQuota("11111111-1111-1111-1111-111111111111", "quick_help");
    expect(r.ok).toBe(true);
    // A real allowance, not the fail-open placeholder of limit 0.
    expect(r.ok === true && r.limit).toBe(10);
  });
});
