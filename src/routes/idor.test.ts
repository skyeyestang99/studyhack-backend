import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Cross-user access (IDOR) suite — beta item B5.
 *
 * Every resource in this product is addressed by a UUID that appears in a URL, and
 * the whole model depends on students sharing a course pool without being able to
 * read each other's conversations, uploads, or study guides. A static audit showed
 * the ownership predicates are currently correct; the point of this suite is that a
 * future refactor cannot quietly remove one.
 *
 * MOCK_AUTH resolves every request to one fixed user, which makes it useless for
 * testing isolation, so auth is mocked with a switchable identity instead. That
 * exercises the real HTTP surface — route handler, guard, and SQL — rather than
 * testing the helpers in isolation, which is where an IDOR would actually appear.
 */
vi.mock("../r2.js", () => ({
  putObject: vi.fn(async () => {}),
  presignGet: vi.fn(async () => "https://signed.example/preview"),
  getObjectBytes: vi.fn(async () => Buffer.from("%PDF-1.4 test")),
  deleteObject: vi.fn(async () => {}),
}));

// The acting user for the next request. Swapped between assertions to simulate a
// second student hitting the first student's URLs.
let actingUserId = "";

vi.mock("../plugins/auth.js", () => ({
  MOCK_USER_ID: "00000000-0000-0000-0000-000000000001",
  requireAuth: async (req: FastifyRequest) => {
    (req as FastifyRequest & { userId?: string }).userId = actingUserId;
  },
  isAdmin: async () => false,
  requireAdmin: async () => {},
}));

process.env.AGENT_URL = "http://agent.test";
process.env.INTERNAL_JWT_SECRET = "test-internal-secret";
process.env.USE_MOCK_AGENT = "true";

const { buildApp } = await import("../app.js");
const { pool } = await import("../db.js");
const { runMigrations } = await import("../migrate.js");

const databaseAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = databaseAvailable ? describe : describe.skip;

const OWNER = randomUUID();
const ATTACKER = randomUUID();
const COURSE = "33333333-3333-3333-3333-333333333333"; // MATH 20D, seeded by 0002

let app: FastifyInstance;
let ownedConversationId = "";
let ownedMaterialId = "";
let ownedGuideId = "";

const as = (userId: string) => {
  actingUserId = userId;
};

describeIfDb("cross-user access is denied (IDOR)", () => {
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();

    for (const [id, email] of [
      [OWNER, `owner-${OWNER}@test.local`],
      [ATTACKER, `attacker-${ATTACKER}@test.local`],
    ] as const) {
      await pool.query(
        "INSERT INTO users (id, email, name) VALUES ($1,$2,'Test') ON CONFLICT (id) DO NOTHING",
        [id, email],
      );
      // BOTH users are enrolled in the same course on purpose: that is the real
      // shape of the product. Isolation must come from per-resource ownership, not
      // from the attacker lacking course access.
      await pool.query(
        `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)
         ON CONFLICT (user_id, course_id) DO NOTHING`,
        [id, COURSE],
      );
    }

    ownedConversationId = randomUUID();
    await pool.query(
      "INSERT INTO conversations (id, user_id, course_id, title) VALUES ($1,$2,$3,'Owner thread')",
      [ownedConversationId, OWNER, COURSE],
    );
    await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content)
       VALUES ($1,$2,'user','a private question')`,
      [randomUUID(), ownedConversationId],
    );

    ownedMaterialId = randomUUID();
    await pool.query(
      `INSERT INTO materials
         (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type,
          size_bytes, sha256, status, embedding_status, scope, chunk_count)
       VALUES ($1,$2,$3,'NOTES','private.pdf','k/private.pdf','application/pdf',
               10,$4,'READY','done','personal',1)`,
      // chunk_count must be > 0: migration 0021 makes a zero-chunk 'done'
      // unrepresentable, which this fixture originally violated.
      [ownedMaterialId, OWNER, COURSE, randomUUID().replace(/-/g, "")],
    );

    ownedGuideId = randomUUID();
    await pool.query(
      `INSERT INTO study_guides
         (id, owner_user_id, course_id, target, retrieval_mode, status)
       VALUES ($1,$2,$3,'Owner guide','course','ready')`,
      [ownedGuideId, OWNER, COURSE],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM study_guides WHERE owner_user_id = ANY($1)", [
      [OWNER, ATTACKER],
    ]);
    await pool.query("DELETE FROM materials WHERE owner_user_id = ANY($1)", [
      [OWNER, ATTACKER],
    ]);
    await pool.query("DELETE FROM conversations WHERE user_id = ANY($1)", [
      [OWNER, ATTACKER],
    ]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [[OWNER, ATTACKER]]);
    await app?.close();
    await pool.end();
  });

  it("the owner can read their own resources (guards aren't just denying everything)", async () => {
    as(OWNER);
    for (const url of [
      `/api/conversations/${ownedConversationId}/messages`,
      `/api/materials/${ownedMaterialId}`,
      `/api/study-guides/${ownedGuideId}`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `owner should reach ${url}`).toBe(200);
    }
  });

  it("another enrolled student cannot READ the owner's resources", async () => {
    as(ATTACKER);
    for (const url of [
      `/api/conversations/${ownedConversationId}/messages`,
      `/api/materials/${ownedMaterialId}`,
      `/api/study-guides/${ownedGuideId}`,
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect([403, 404], `${url} leaked to another user (${res.statusCode})`).toContain(
        res.statusCode,
      );
    }
  });

  it("another enrolled student cannot WRITE or DELETE the owner's resources", async () => {
    as(ATTACKER);
    const attempts: [string, string][] = [
      ["DELETE", `/api/conversations/${ownedConversationId}`],
      ["DELETE", `/api/materials/${ownedMaterialId}`],
      ["DELETE", `/api/study-guides/${ownedGuideId}`],
      ["POST", `/api/materials/${ownedMaterialId}/retry`],
    ];
    for (const [method, url] of attempts) {
      const res = await app.inject({ method: method as "GET", url });
      expect([403, 404], `${method} ${url} allowed (${res.statusCode})`).toContain(
        res.statusCode,
      );
    }

    // The resources must still exist — a denied request must not delete anything.
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM conversations WHERE id=$1) AS conv,
         (SELECT count(*) FROM materials WHERE id=$2 AND deleted_at IS NULL) AS mat,
         (SELECT count(*) FROM study_guides WHERE id=$3) AS guide`,
      [ownedConversationId, ownedMaterialId, ownedGuideId],
    );
    expect(rows[0].conv).toBe("1");
    expect(rows[0].mat).toBe("1");
    expect(rows[0].guide).toBe("1");
  });

  it("a personal-scope upload is not visible to a classmate's list (B6)", async () => {
    as(ATTACKER);
    const res = await app.inject({ method: "GET", url: "/api/materials" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id: string }[];
    expect(
      body.some((m) => m.id === ownedMaterialId),
      "personal-scope material appeared in another user's material list",
    ).toBe(false);
  });

  it("an unenrolled user cannot reach course-scoped endpoints", async () => {
    const outsider = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, name) VALUES ($1,$2,'Outsider') ON CONFLICT (id) DO NOTHING",
      [outsider, `outsider-${outsider}@test.local`],
    );
    as(outsider);
    const res = await app.inject({
      method: "GET",
      url: `/api/courses/${COURSE}/exam-insights`,
    });
    expect([403, 404]).toContain(res.statusCode);
    await pool.query("DELETE FROM users WHERE id=$1", [outsider]);
  });
});
