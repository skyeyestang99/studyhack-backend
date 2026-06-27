import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import FormData from "form-data";
import type { FastifyInstance } from "fastify";

// Mock R2 so tests don't touch real object storage.
vi.mock("../r2.js", () => ({
  putObject: vi.fn(async () => {}),
  presignGet: vi.fn(async () => "https://signed.example/preview"),
  deleteObject: vi.fn(async () => {}),
}));

const { buildApp } = await import("../app.js");
const { pool } = await import("../db.js");
const { runMigrations } = await import("../migrate.js");

let app: FastifyInstance;

beforeAll(async () => {
  await runMigrations();
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("materials API", () => {
  it("GET /api/health -> 200 UP", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("UP");
  });

  it("upload -> list -> delete lifecycle", async () => {
    const courseId = `test-${Date.now()}`;
    const form = new FormData();
    form.append("file", Buffer.from("integration test content"), {
      filename: "test.pdf",
      contentType: "application/pdf",
    });
    form.append("courseId", courseId);
    form.append("materialType", "NOTES");

    const upload = await app.inject({
      method: "POST",
      url: "/api/materials/upload",
      payload: form,
      headers: form.getHeaders(),
    });
    expect(upload.statusCode).toBe(201);
    const created = upload.json();
    expect(created.fileName).toBe("test.pdf");
    expect(created.materialType).toBe("NOTES");
    expect(created.status).toBe("READY");
    expect(created.previewUrl).toContain("signed.example");

    const list = await app.inject({
      method: "GET",
      url: `/api/materials?courseId=${courseId}`,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json();
    expect(items.some((m: { id: string }) => m.id === created.id)).toBe(true);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/materials/${created.id}`,
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/api/materials?courseId=${courseId}`,
    });
    expect(after.json().some((m: { id: string }) => m.id === created.id)).toBe(false);
  });
});
