import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Course library tests (Part 2).
 *
 * The important assertions here are NEGATIVE — that the library response does not carry
 * owner-only fields. This endpoint's whole risk is that it serves someone else's row, and
 * the failure mode is a field appearing rather than an error being thrown.
 */
vi.mock("../r2.js", () => ({
  putObject: vi.fn(async () => {}),
  presignGet: vi.fn(async () => "https://signed.example/preview"),
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

const dbAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = dbAvailable ? describe : describe.skip;

/**
 * A course created solely for this suite.
 *
 * The summary asserts absolute counts (contributors, pages, per-type totals), so it
 * cannot share the seeded MATH 20D course — other suites add materials there every run,
 * and contributorCount came back as 18 instead of 2. A library test that depends on
 * leftover data from other tests is not testing the library.
 */
const COURSE = randomUUID();
const SCHOOL = randomUUID();
const PROFESSOR = randomUUID();
const OWNER = randomUUID();
const CLASSMATE = randomUUID();
const OUTSIDER = randomUUID();

let app: FastifyInstance;
const materialIds: string[] = [];

async function addMaterial(opts: {
  owner: string;
  type: string;
  fileName: string;
  scope?: string;
  embeddingStatus?: string;
  pages?: number;
  citedCount?: number;
}) {
  const id = randomUUID();
  materialIds.push(id);
  await query(
    `INSERT INTO materials
       (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type,
        size_bytes, sha256, status, embedding_status, scope, chunk_count, content_text,
        rejection_reason, embedding_error, cited_count)
     VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',2048,$7,'READY',$8,$9,1,
             'SECRET EXTRACTED TEXT','SECRET REJECTION','SECRET INGEST ERROR',$10)`,
    [
      id,
      opts.owner,
      COURSE,
      opts.type,
      opts.fileName,
      `k/${id}.pdf`,
      randomUUID().replace(/-/g, ""),
      opts.embeddingStatus ?? "done",
      opts.scope ?? "shared",
      opts.citedCount ?? 0,
    ],
  );
  if (opts.pages) {
    for (let p = 1; p <= opts.pages; p++) {
      await query(
        `INSERT INTO material_chunks
           (material_id, chunk_index, content, scope, course_id, owner_user_id, token_count, page)
         VALUES ($1,$2,'chunk',$3,$4,$5,10,$6)`,
        [id, p - 1, opts.scope ?? "shared", COURSE, opts.owner, p],
      );
    }
  }
  return id;
}

const asUser = (id: string) => {
  actingUserId = id;
};

describeIfDb("course material library", () => {
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();

    await query(
      "INSERT INTO schools (id, name) VALUES ($1,'Library Test University') ON CONFLICT (id) DO NOTHING",
      [SCHOOL],
    );
    await query(
      "INSERT INTO professors (id, name, school_id) VALUES ($1,'Prof Library',$2) ON CONFLICT (id) DO NOTHING",
      [PROFESSOR, SCHOOL],
    );
    await query(
      `INSERT INTO courses (id, code, name, school_id, professor_id)
       VALUES ($1,'LIB 100','Library Test Course',$2,$3) ON CONFLICT (id) DO NOTHING`,
      [COURSE, SCHOOL, PROFESSOR],
    );

    for (const [id, label] of [
      [OWNER, "Owner"],
      [CLASSMATE, "Classmate"],
      [OUTSIDER, "Outsider"],
    ] as const) {
      await query(
        "INSERT INTO users (id, email, name, tier) VALUES ($1,$2,$3,'BETA') ON CONFLICT (id) DO NOTHING",
        [id, `lib-${id}@test.local`, label],
      );
    }
    // Owner and classmate enrolled; outsider deliberately not.
    for (const id of [OWNER, CLASSMATE]) {
      await query(
        `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)
         ON CONFLICT (user_id, course_id) DO NOTHING`,
        [id, COURSE],
      );
    }

    await addMaterial({ owner: OWNER, type: "EXAM", fileName: "midterm-2024.pdf", pages: 8, citedCount: 12 });
    await addMaterial({ owner: OWNER, type: "QUIZ", fileName: "quiz-3.pdf", pages: 2 });
    await addMaterial({ owner: CLASSMATE, type: "LECTURE_NOTES", fileName: "week1-notes.pdf", pages: 5 });
    // Personal scope: must never appear in the shared library.
    await addMaterial({ owner: OWNER, type: "LECTURE_NOTES", fileName: "my-private.pdf", scope: "personal", pages: 3 });
    // Someone else's failed upload: absent for the classmate, visible to its owner.
    await addMaterial({ owner: OWNER, type: "HOMEWORK", fileName: "broken.pdf", embeddingStatus: "failed" });
  }, 120_000);

  afterAll(async () => {
    if (materialIds.length) {
      await query("DELETE FROM material_chunks WHERE material_id = ANY($1)", [materialIds]);
      await query("DELETE FROM materials WHERE id = ANY($1)", [materialIds]);
    }
    await query("DELETE FROM enrollments WHERE course_id=$1", [COURSE]);
    await query("DELETE FROM users WHERE id = ANY($1)", [[OWNER, CLASSMATE, OUTSIDER]]);
    await query("DELETE FROM courses WHERE id=$1", [COURSE]);
    await query("DELETE FROM professors WHERE id=$1", [PROFESSOR]);
    await query("DELETE FROM schools WHERE id=$1", [SCHOOL]);
    await app?.close();
    await pool.end();
  });

  const getLibrary = async (userId: string, qs = "") => {
    asUser(userId);
    const res = await app.inject({
      method: "GET",
      url: `/api/courses/${COURSE}/materials${qs}`,
    });
    return { res, body: res.statusCode === 200 ? JSON.parse(res.body) : null };
  };

  it("POSITIVE CONTROL: an enrolled classmate CAN list the shared library", async () => {
    const { res, body } = await getLibrary(CLASSMATE);
    expect(res.statusCode).toBe(200);
    // Including the owner's uploads — that is the entire point.
    const names = body.materials.map((m: { fileName: string }) => m.fileName);
    expect(names).toContain("midterm-2024.pdf");
    expect(names).toContain("week1-notes.pdf");
  });

  it("does NOT leak owner-only fields (assert keys ABSENT, not just falsy)", async () => {
    const { body } = await getLibrary(CLASSMATE);
    const row = body.materials.find((m: { fileName: string }) => m.fileName === "midterm-2024.pdf");
    expect(row).toBeTruthy();

    // A future field is added by touching the serializer, so absence is asserted by key.
    for (const forbidden of [
      "ownerUserId",
      "owner_user_id",
      "r2Key",
      "r2_key",
      "previewUrl",
      "downloadUrl",
      "contentText",
      "content_text",
      "rejectionReason",
      "embeddingError",
      "embeddingAttempts",
      "lastAttemptedAt",
    ]) {
      expect(Object.keys(row), `library row exposed ${forbidden}`).not.toContain(forbidden);
    }
    // And the secret values must not appear anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET EXTRACTED TEXT");
    expect(raw).not.toContain("SECRET REJECTION");
    expect(raw).not.toContain("SECRET INGEST ERROR");
    expect(raw).not.toContain(OWNER);
  });

  it("personal-scope material never appears in the library", async () => {
    const { body } = await getLibrary(CLASSMATE);
    const names = body.materials.map((m: { fileName: string }) => m.fileName);
    expect(names).not.toContain("my-private.pdf");
    // Not even for its own owner: the library is the SHARED shelf.
    const own = await getLibrary(OWNER);
    expect(own.body.materials.map((m: { fileName: string }) => m.fileName)).not.toContain(
      "my-private.pdf",
    );
  });

  it("another user's FAILED upload is absent, but its owner still sees it", async () => {
    const classmateView = await getLibrary(CLASSMATE);
    expect(
      classmateView.body.materials.map((m: { fileName: string }) => m.fileName),
    ).not.toContain("broken.pdf");

    const ownerView = await getLibrary(OWNER);
    expect(ownerView.body.materials.map((m: { fileName: string }) => m.fileName)).toContain(
      "broken.pdf",
    );
  });

  it("coarsens status to READY or PROCESSING only", async () => {
    const { body } = await getLibrary(CLASSMATE);
    for (const m of body.materials) {
      expect(["READY", "PROCESSING"]).toContain(m.status);
    }
  });

  it("an unenrolled user gets 403, not data", async () => {
    const { res } = await getLibrary(OUTSIDER);
    expect([403, 404]).toContain(res.statusCode);
  });

  it("summary describes the whole shelf and matches the insights threshold", async () => {
    const { body } = await getLibrary(CLASSMATE);
    const s = body.summary;
    // EXAM + QUIZ + HOMEWORK(failed, still shared) count as assessments.
    expect(s.counts.EXAM).toBe(1);
    expect(s.counts.QUIZ).toBe(1);
    expect(s.assessmentCount).toBeGreaterThanOrEqual(2);
    expect(s.contributorCount).toBe(2); // owner + classmate
    expect(s.totalPages).toBeGreaterThan(0);
    // 3 is the same threshold the exam-insights panel uses for "reliable trend".
    expect(s.insightsReady).toBe(s.assessmentCount >= 3);
    // Group order comes from the server so display priority is decided in one place.
    expect(s.groupOrder[0]).toBe("EXAM");
  });

  it("summary does not change when the page is filtered", async () => {
    // It describes what backs the COURSE, so paging must not alter it.
    const all = await getLibrary(CLASSMATE);
    const filtered = await getLibrary(CLASSMATE, "?type=EXAM&limit=1");
    expect(filtered.body.materials).toHaveLength(1);
    expect(filtered.body.summary.assessmentCount).toBe(all.body.summary.assessmentCount);
    expect(filtered.body.summary.contributorCount).toBe(all.body.summary.contributorCount);
  });

  it("derives pageCount from chunks rather than a stored column", async () => {
    const { body } = await getLibrary(CLASSMATE);
    const exam = body.materials.find((m: { fileName: string }) => m.fileName === "midterm-2024.pdf");
    expect(exam.pageCount).toBe(8);
  });

  it("surfaces citedCount, and orders 'recommended' by it", async () => {
    const { body } = await getLibrary(CLASSMATE, "?sort=recommended");
    expect(body.materials[0].fileName).toBe("midterm-2024.pdf"); // cited 12 times
    expect(body.materials[0].citedCount).toBe(12);
  });

  it("rejects an unknown type filter instead of silently returning everything", async () => {
    const { res } = await getLibrary(CLASSMATE, "?type=PPT");
    expect(res.statusCode).toBe(400);
  });

  it("caps limit server-side", async () => {
    const { body } = await getLibrary(CLASSMATE, "?limit=100000");
    expect(body.page.limit).toBeLessThanOrEqual(100);
  });

  it("uploadedByMe distinguishes mine from a classmate's", async () => {
    const { body } = await getLibrary(CLASSMATE);
    const mine = body.materials.find((m: { fileName: string }) => m.fileName === "week1-notes.pdf");
    const theirs = body.materials.find((m: { fileName: string }) => m.fileName === "midterm-2024.pdf");
    expect(mine.uploadedByMe).toBe(true);
    expect(theirs.uploadedByMe).toBe(false);
  });
});
