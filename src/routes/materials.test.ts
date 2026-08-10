import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import FormData from "form-data";
import type { FastifyInstance } from "fastify";

// Mock R2 so tests don't touch real object storage.
vi.mock("../r2.js", () => ({
  putObject: vi.fn(async () => {}),
  presignGet: vi.fn(async () => "https://signed.example/preview"),
  deleteObject: vi.fn(async () => {}),
}));

// Force mock auth for tests regardless of local .env.
process.env.MOCK_AUTH = "true";
process.env.AGENT_URL = "http://agent.test";
process.env.INTERNAL_JWT_SECRET = "test-internal-secret";

const { buildApp } = await import("../app.js");
const { pool } = await import("../db.js");
const { runMigrations } = await import("../migrate.js");

const MOCK_USER = "00000000-0000-0000-0000-000000000001"; // matches auth MOCK_USER_ID
const SEEDED_COURSE = "33333333-3333-3333-3333-333333333333"; // MATH 20D (migration 0002)

const databaseAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = databaseAvailable ? describe : describe.skip;

let app: FastifyInstance | undefined;

function getApp(): FastifyInstance {
  if (!app) throw new Error("Test app was not initialized");
  return app;
}

beforeAll(async () => {
  if (!databaseAvailable) return;
  await runMigrations();
  app = await buildApp();
  await app.ready();
  // Create the mock user + enroll in the seeded course so course-scoped writes pass auth.
  await pool.query(
    `INSERT INTO users (id, email, name) VALUES ($1, 'mock@studyhack.local', 'Mock User')
     ON CONFLICT (id) DO NOTHING`,
    [MOCK_USER],
  );
  await pool.query(
    `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)
     ON CONFLICT (user_id, course_id) DO NOTHING`,
    [MOCK_USER, SEEDED_COURSE],
  );
});

afterAll(async () => {
  await app?.close();
  await pool.end().catch(() => {});
});

describeIfDb("materials API", () => {
  it("GET /api/health -> 200 UP", async () => {
    const res = await getApp().inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("UP");
  });

  it("upload -> list -> delete lifecycle", async () => {
    const courseId = SEEDED_COURSE;
    const form = new FormData();
    // Unique content each run so the sha256 dedup guard doesn't 409 on re-runs.
    form.append("file", Buffer.from(`integration test content ${Date.now()}`), {
      filename: "test.pdf",
      contentType: "application/pdf",
    });
    form.append("courseId", courseId);
    form.append("materialType", "NOTES");

    const upload = await getApp().inject({
      method: "POST",
      url: "/api/materials/upload",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(upload.statusCode).toBe(201);
    const created = upload.json();
    expect(created.fileName).toBe("test.pdf");
    expect(created.materialType).toBe("NOTES");
    expect(created.status).toBe("VALIDATING"); // pending embedding until ingested
    expect(created.previewUrl).toContain("signed.example");

    const list = await getApp().inject({
      method: "GET",
      url: `/api/materials?courseId=${courseId}`,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json();
    expect(items.some((m: { id: string }) => m.id === created.id)).toBe(true);

    const del = await getApp().inject({
      method: "DELETE",
      url: `/api/materials/${created.id}`,
    });
    expect(del.statusCode).toBe(204);

    const after = await getApp().inject({
      method: "GET",
      url: `/api/materials?courseId=${courseId}`,
    });
    expect(after.json().some((m: { id: string }) => m.id === created.id)).toBe(false);
  });

  it("rejects an empty file (U1)", async () => {
    const form = new FormData();
    form.append("file", Buffer.from(""), {
      filename: "empty.pdf",
      contentType: "application/pdf",
    });
    form.append("courseId", SEEDED_COURSE);
    form.append("materialType", "NOTES");
    const res = await getApp().inject({
      method: "POST",
      url: "/api/materials/upload",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("retries failed material ingestion and triggers the agent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const form = new FormData();
    form.append("file", Buffer.from(`retry test content ${Date.now()}`), {
      filename: "retry.pdf",
      contentType: "application/pdf",
    });
    form.append("courseId", SEEDED_COURSE);
    form.append("materialType", "NOTES");

    const upload = await getApp().inject({
      method: "POST",
      url: "/api/materials/upload",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(upload.statusCode).toBe(201);
    const created = upload.json();

    await pool.query(
      `UPDATE materials
          SET embedding_status='failed',
              embedding_attempts=1,
              embedding_error='test failure',
              last_attempted_at=now()
        WHERE id=$1`,
      [created.id],
    );

    const retry = await getApp().inject({
      method: "POST",
      url: `/api/materials/${created.id}/retry`,
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      id: created.id,
      status: "VALIDATING",
      embeddingError: null,
      lastAttemptedAt: null,
    });
    const rows = await pool.query(
      "SELECT embedding_status, embedding_error, last_attempted_at FROM materials WHERE id=$1",
      [created.id],
    );
    expect(rows.rows[0]).toMatchObject({
      embedding_status: "pending",
      embedding_error: null,
      last_attempted_at: null,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://agent.test/ingest",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ materialId: created.id }),
      }),
    );

    await pool.query("UPDATE materials SET deleted_at=now() WHERE id=$1", [
      created.id,
    ]);
    fetchSpy.mockRestore();
  });
});

describeIfDb("server-side fuzzy catalog search", () => {
  it("matches UCSD through stored aliases and blocks duplicate creation", async () => {
    const search = await getApp().inject({
      method: "GET",
      url: "/api/schools?q=ucsd",
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().matches[0].item.name).toMatch(
      /UC San Diego|University of California-San Diego/,
    );
    expect(search.json().matches[0].strong).toBe(true);
    expect(search.json().canCreate).toBe(false);

    const duplicate = await getApp().inject({
      method: "POST",
      url: "/api/schools",
      payload: { name: "UCSD", confirmed: true },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().candidates.matches[0].item.name).toMatch(
      /UC San Diego|University of California-San Diego/,
    );
  });

  it("serializes concurrent school creation and prevents duplicates", async () => {
    const name = `QA ${randomUUID()}`;
    const [a, b] = await Promise.all([
      getApp().inject({
        method: "POST",
        url: "/api/schools",
        payload: { name, confirmed: true },
      }),
      getApp().inject({
        method: "POST",
        url: "/api/schools",
        payload: { name, confirmed: true },
      }),
    ]);

    const statusCodes = [a.statusCode, b.statusCode].sort();
    expect(statusCodes).toEqual([201, 409]);

    const rows = await pool.query(
      "SELECT count(*)::int AS count FROM schools WHERE name=$1",
      [name],
    );
    expect(rows.rows[0].count).toBe(1);
  });
});

describeIfDb("conversations access control", () => {
  it("rejects a non-UUID courseId with 400 and inserts no row (T3/T4)", async () => {
    const before = await getApp().inject({ method: "GET", url: "/api/conversations" });
    expect(before.statusCode).toBe(200);
    const beforeCount = before.json().length;

    const res = await getApp().inject({
      method: "POST",
      url: "/api/conversations",
      payload: { courseId: "not-a-uuid", questionText: "hi" },
    });
    expect(res.statusCode).toBe(400);

    // The list must still be healthy (no 500) and no poison row was inserted.
    const after = await getApp().inject({ method: "GET", url: "/api/conversations" });
    expect(after.statusCode).toBe(200);
    expect(after.json().length).toBe(beforeCount);
  });

  it("blocks chatting a course the user is not enrolled in with 403 (A1)", async () => {
    // A real, existing course the mock user is NOT enrolled in.
    const sid = randomUUID();
    const pid = randomUUID();
    const cid = randomUUID();
    await pool.query(`INSERT INTO schools (id, name) VALUES ($1,'QA School') ON CONFLICT DO NOTHING`, [sid]);
    await pool.query(
      `INSERT INTO professors (id, name, school_id) VALUES ($1,'QA Prof',$2) ON CONFLICT DO NOTHING`,
      [pid, sid],
    );
    await pool.query(
      `INSERT INTO courses (id, name, code, school_id, professor_id) VALUES ($1,'QA Course','QA 1',$2,$3) ON CONFLICT DO NOTHING`,
      [cid, sid, pid],
    );

    const res = await getApp().inject({
      method: "POST",
      url: "/api/conversations",
      payload: { courseId: cid, questionText: "solve this for me" },
    });
    expect(res.statusCode).toBe(403);
  });
});
