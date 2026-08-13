import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Quota tests (Iteration A).
 *
 * Two proofs matter more than coverage here:
 *
 *  1. Limits are TABLE-DRIVEN — changing a plan_limits row changes enforcement with no
 *     code deploy. That is the property that makes pricing changeable, and it is easy
 *     to accidentally lose by reading a constant somewhere.
 *
 *  2. The check is load-bearing — mutating it makes these tests go red. Same
 *     discipline as the IDOR suite: a quota test that cannot fail is decoration.
 */
vi.mock("../r2.js", () => ({
  putObject: vi.fn(async () => {}),
  presignGet: vi.fn(async () => "https://signed.example/x"),
  deleteObject: vi.fn(async () => {}),
}));

let actingUserId = "";
vi.mock("../plugins/auth.js", () => ({
  MOCK_USER_ID: "00000000-0000-0000-0000-000000000001",
  requireAuth: async (req: FastifyRequest) => {
    (req as FastifyRequest & { userId?: string }).userId = actingUserId;
  },
  isAdmin: async () => false,
  requireAdmin: async () => {},
}));

process.env.USE_MOCK_AGENT = "true";
process.env.AGENT_URL = "http://agent.test";
process.env.INTERNAL_JWT_SECRET = "test-internal-secret";

const { buildApp } = await import("../app.js");
const { pool, query } = await import("../db.js");
const { runMigrations } = await import("../migrate.js");
const { consumeQuota, resolveTier, usageSummary } = await import("../lib/quota.js");

const databaseAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = databaseAvailable ? describe : describe.skip;

let app: FastifyInstance;
const created: string[] = [];

async function userOnTier(tier: string) {
  const id = randomUUID();
  created.push(id);
  await query(
    "INSERT INTO users (id, email, name, tier) VALUES ($1,$2,'Quota',$3) ON CONFLICT (id) DO NOTHING",
    [id, `quota-${id}@test.local`, tier],
  );
  actingUserId = id;
  return id;
}

describeIfDb("usage quotas", () => {
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (created.length) {
      await query("DELETE FROM user_daily_usage WHERE user_id = ANY($1)", [created]);
      await query("DELETE FROM users WHERE id = ANY($1)", [created]);
    }
    // Leave no altered pricing behind for other suites.
    await query("DELETE FROM plan_limits WHERE tier='FREE' AND kind='escalation'");
    await query(
      "INSERT INTO plan_limits (tier,kind,daily_limit) VALUES ('FREE','escalation',0) ON CONFLICT (tier,kind) DO UPDATE SET daily_limit=0",
    );
    await app?.close();
    await pool.end();
  });

  it("counts usage and allows up to the limit, then refuses", async () => {
    const id = await userOnTier("FREE");
    // FREE/study_guide is seeded at 0 — the simplest possible denial.
    const denied = await consumeQuota(id, "study_guide");
    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.reason).toBe("exceeded");

    // FREE/quick_help is 10.
    for (let i = 1; i <= 10; i++) {
      const r = await consumeQuota(id, "quick_help");
      expect(r.ok, `call ${i} should be allowed`).toBe(true);
      expect(r.ok === true && r.used).toBe(i);
    }
    const eleventh = await consumeQuota(id, "quick_help");
    expect(eleventh.ok).toBe(false);
    expect(
      eleventh.ok === false && eleventh.reason === "exceeded" ? eleventh.used : -1,
    ).toBe(10);
  });

  it("is TIER-AWARE: the same operation has different limits per tier", async () => {
    const free = await userOnTier("FREE");
    const beta = await userOnTier("BETA");

    const freeLimit = (await consumeQuota(free, "quick_help")) as { limit: number };
    const betaLimit = (await consumeQuota(beta, "quick_help")) as { limit: number };
    expect(freeLimit.limit).toBe(10);
    expect(betaLimit.limit).toBe(500);
    expect(await resolveTier(beta)).toBe("BETA");
  });

  it("PROOF 1: changing a plan_limits row changes enforcement with NO code deploy", async () => {
    const id = await userOnTier("FREE");

    // Seeded at 0, so escalation is refused.
    expect((await consumeQuota(id, "escalation")).ok).toBe(false);

    // Change pricing in the database only. No deploy, no restart, no code edit.
    await query(
      "UPDATE plan_limits SET daily_limit=2 WHERE tier='FREE' AND kind='escalation'",
    );

    // Same binary, same process — different enforcement.
    expect((await consumeQuota(id, "escalation")).ok).toBe(true);
    expect((await consumeQuota(id, "escalation")).ok).toBe(true);
    expect((await consumeQuota(id, "escalation")).ok).toBe(false);
  });

  it("denies a tier/kind pair that was never priced, rather than defaulting to unlimited", async () => {
    const id = await userOnTier("FREE");
    await query("DELETE FROM plan_limits WHERE tier='FREE' AND kind='exam_insights'");
    const r = await consumeQuota(id, "exam_insights");
    expect(r.ok).toBe(false);
    // Restore so later assertions and other suites see seeded pricing.
    await query(
      "INSERT INTO plan_limits (tier,kind,daily_limit) VALUES ('FREE','exam_insights',20) ON CONFLICT (tier,kind) DO NOTHING",
    );
  });

  it("meters ocr_page in PAGES, so one action can consume many units", async () => {
    const id = await userOnTier("FREE"); // FREE/ocr_page = 15 (measured-cost derived)
    const r = await consumeQuota(id, "ocr_page", 12);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.used).toBe(12);

    // 12 + 10 exceeds 15, so this single action is refused as a whole rather than
    // partially charged.
    const over = await consumeQuota(id, "ocr_page", 10);
    expect(over.ok).toBe(false);
    // Not partially charged: the whole action is refused, so usage stays at 15.
    expect(over.ok === false && over.reason === "exceeded" ? over.used : -1).toBe(12);
  });

  it("refuses a chat request BEFORE streaming starts, with a structured 429", async () => {
    const id = await userOnTier("FREE");
    await query(
      `INSERT INTO user_daily_usage (user_id, day, kind, amount)
       VALUES ($1,(now() AT TIME ZONE 'utc')::date,'quick_help',10)
       ON CONFLICT (user_id,day,kind) DO UPDATE SET amount=10`,
      [id],
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/quick-help",
      payload: { message: "help me" },
    });

    // A 429 is only expressible because the check runs before writeHead.
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("QUOTA_EXCEEDED");
    expect(body.tier).toBe("FREE");
    expect(body.limit).toBe(10);
    expect(body.used).toBe(10);
    expect(body.resetsAt).toBeTruthy();
    // The client must be able to distinguish this from a service problem.
    expect(body.code).not.toBe("QUOTA_UNAVAILABLE");
    // And it must not be an SSE stream.
    expect(res.headers["content-type"]).not.toContain("text/event-stream");
  });

  it("reports usage and limits together, so a meter can be shown before refusal", async () => {
    const id = await userOnTier("BETA");
    await consumeQuota(id, "quick_help", 3);
    const summary = await usageSummary(id);
    expect(summary.tier).toBe("BETA");
    const qh = summary.kinds.find((k) => k.kind === "quick_help");
    expect(qh).toEqual({ kind: "quick_help", used: 3, limit: 500 });
    // Kinds with no usage today still appear, with used: 0.
    expect(summary.kinds.find((k) => k.kind === "upload")?.used).toBe(0);
  });

  it("keeps concurrent requests within the limit (the pattern a script abuses)", async () => {
    const id = await userOnTier("FREE"); // quick_help = 10
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consumeQuota(id, "quick_help")),
    );
    const allowed = results.filter((r) => r.ok).length;
    // Check-then-increment would let more than 10 through here.
    expect(allowed).toBe(10);
  });
});
