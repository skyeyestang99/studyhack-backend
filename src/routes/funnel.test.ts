import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Funnel-accuracy tests.
 *
 * viewed_exam_insights originally fired on every request, and the panel fetches on
 * mount — so simply opening a course home counted, including courses with no past
 * assessments where the student saw an empty state. That inflated the single metric
 * meant to prove the differentiator works, which is worse than not measuring it: it
 * would have reported success whether or not the feature did anything.
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

// Swapped per test so one case returns content and the other returns none.
let mockTopics: unknown[] = [];
vi.mock("../agent/agent-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class StubAgent {
    async examInsights() {
      return {
        summary: "s",
        topics: mockTopics,
        assessmentCount: mockTopics.length,
        chunkCount: mockTopics.length * 4,
      };
    }
  }
  return { ...actual, MockAgentClient: StubAgent, RealAgentClient: StubAgent };
});

process.env.USE_MOCK_AGENT = "true";
process.env.AGENT_URL = "http://agent.test";
process.env.INTERNAL_JWT_SECRET = "test-internal-secret";

const { buildApp } = await import("../app.js");
const { pool, query } = await import("../db.js");
const { runMigrations } = await import("../migrate.js");

const databaseAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = databaseAvailable ? describe : describe.skip;

// Two different courses on purpose: the route caches per course, and an empty
// analysis for a course with no assessments is legitimately cacheable — so reusing
// one course would make the second case read the first case's cached emptiness.
const COURSE_EMPTY = "33333333-3333-3333-3333-333333333333"; // MATH 20D
const COURSE_WITH_CONTENT = "33333333-3333-3333-3333-333333333337"; // MATH 20C
let app: FastifyInstance;
const users: string[] = [];

async function freshUser(courseId: string) {
  const id = randomUUID();
  users.push(id);
  await query(
    "INSERT INTO users (id, email, name) VALUES ($1,$2,'Funnel') ON CONFLICT (id) DO NOTHING",
    [id, `funnel-${id}@test.local`],
  );
  await query(
    `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)
     ON CONFLICT (user_id, course_id) DO NOTHING`,
    [id, courseId],
  );
  actingUserId = id;
  return id;
}

const milestonesOf = async (id: string) =>
  (await query<{ milestone: string }>(
    "SELECT milestone FROM user_milestones WHERE user_id=$1",
    [id],
  )).map((r) => r.milestone);

describeIfDb("activation funnel accuracy", () => {
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (users.length) {
      await query("DELETE FROM users WHERE id = ANY($1)", [users]);
    }
    await app?.close();
    await pool.end();
  });

  it("does NOT record viewed_exam_insights when there is nothing to see", async () => {
    const id = await freshUser(COURSE_EMPTY);
    mockTopics = [];

    const res = await app.inject({
      method: "GET",
      url: `/api/courses/${COURSE_EMPTY}/exam-insights`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).topics).toHaveLength(0);

    // Opening a course with no past assessments must not count as reaching the
    // funnel's payoff step.
    await new Promise((r) => setTimeout(r, 150)); // recording is fire-and-forget
    expect(await milestonesOf(id)).not.toContain("viewed_exam_insights");
  });

  it("records viewed_exam_insights when the analysis has real content", async () => {
    const id = await freshUser(COURSE_WITH_CONTENT);
    mockTopics = [
      { topic: "Lagrange multipliers", howItsTested: "two constraints", appearances: 2, sources: [] },
    ];

    const res = await app.inject({
      method: "GET",
      url: `/api/courses/${COURSE_WITH_CONTENT}/exam-insights`,
    });
    expect(res.statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 150));
    expect(await milestonesOf(id)).toContain("viewed_exam_insights");
  });

  it("accepts generated_study_guide, so the retention hook is recordable", async () => {
    const id = await freshUser(COURSE_EMPTY);
    // Fails loudly if migration 0024 and the Milestone union ever drift apart.
    await expect(
      query("INSERT INTO user_milestones (user_id, milestone) VALUES ($1,'generated_study_guide')", [
        id,
      ]),
    ).resolves.toBeTruthy();
    expect(await milestonesOf(id)).toContain("generated_study_guide");
  });

  it("still rejects a milestone outside the vocabulary", async () => {
    const id = await freshUser(COURSE_EMPTY);
    await expect(
      query("INSERT INTO user_milestones (user_id, milestone) VALUES ($1,'made_up')", [id]),
    ).rejects.toThrow();
  });
});
