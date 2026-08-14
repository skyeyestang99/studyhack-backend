import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, query } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  ASSESSMENT_TYPES,
  LIBRARY_GROUP_ORDER,
  MATERIAL_TYPES,
  isMaterialType,
} from "./material-types.js";

const dbAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = dbAvailable ? describe : describe.skip;

const OWNER = randomUUID();
const COURSE = "33333333-3333-3333-3333-333333333333";
const created: string[] = [];

async function insertMaterial(materialType: string) {
  const id = randomUUID();
  created.push(id);
  await query(
    `INSERT INTO materials
       (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type,
        size_bytes, sha256, status, embedding_status, scope, chunk_count)
     VALUES ($1,$2,$3,$4,'f.pdf',$5,'application/pdf',10,$6,'READY','done','shared',1)`,
    [id, OWNER, COURSE, materialType, `t/${id}.pdf`, randomUUID().replace(/-/g, "")],
  );
  return id;
}

describe("material type taxonomy", () => {
  it("has no format-based names left — the axis is purpose", () => {
    // "PPT" described a file format while every other value described purpose, which is
    // what let a PDF of slides be mislabelled.
    expect(MATERIAL_TYPES).not.toContain("PPT");
    expect(MATERIAL_TYPES).not.toContain("NOTES");
    expect(MATERIAL_TYPES).toContain("SLIDES");
    expect(MATERIAL_TYPES).toContain("LECTURE_NOTES");
  });

  it("includes QUIZ and SOLUTIONS, which used to vanish from Exam Insights", () => {
    // Filed as NOTES, a quiz was invisible to the feature that most needs it.
    expect(ASSESSMENT_TYPES).toContain("QUIZ");
    expect(ASSESSMENT_TYPES).toContain("SOLUTIONS");
    expect(ASSESSMENT_TYPES).toContain("EXAM");
    expect(ASSESSMENT_TYPES).toContain("HOMEWORK");
  });

  it("orders library groups by contribution value, not alphabetically", () => {
    // The order teaches which contribution matters most; alphabetical would put
    // EXAM after nothing useful and bury the scarcest material.
    const first = LIBRARY_GROUP_ORDER.indexOf("EXAM");
    const notes = LIBRARY_GROUP_ORDER.indexOf("LECTURE_NOTES");
    expect(first).toBeLessThan(notes);
    // Every type must be placed, or a material silently renders in no group.
    expect([...LIBRARY_GROUP_ORDER].sort()).toEqual([...MATERIAL_TYPES].sort());
  });

  it("rejects values outside the vocabulary", () => {
    expect(isMaterialType("EXAM")).toBe(true);
    expect(isMaterialType("PPT")).toBe(false);
    expect(isMaterialType("exam")).toBe(false);
    expect(isMaterialType(undefined)).toBe(false);
  });
});

describeIfDb("material type taxonomy (database)", () => {
  beforeAll(async () => {
    await runMigrations();
    await query(
      "INSERT INTO users (id, email, name) VALUES ($1,$2,'Tax') ON CONFLICT (id) DO NOTHING",
      [OWNER, `tax-${OWNER}@test.local`],
    );
  }, 60_000);

  afterAll(async () => {
    if (created.length) {
      await query("DELETE FROM material_chunks WHERE material_id = ANY($1)", [created]);
      await query("DELETE FROM materials WHERE id = ANY($1)", [created]);
    }
    await query("DELETE FROM users WHERE id=$1", [OWNER]);
    await pool.end();
  });

  it("accepts every type in the vocabulary", async () => {
    for (const type of MATERIAL_TYPES) {
      await expect(insertMaterial(type), `${type} was rejected`).resolves.toBeTruthy();
    }
  });

  it("the CHECK constraint rejects a legacy or typo'd value", async () => {
    // No constraint existed before migration 0026, which is exactly how values outside
    // the vocabulary accumulated in the first place.
    await expect(insertMaterial("PPT")).rejects.toThrow();
    await expect(insertMaterial("EXAMS")).rejects.toThrow();
  });

  it("no legacy PPT/NOTES rows survived the backfill", async () => {
    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM materials WHERE material_type IN ('PPT','NOTES')",
    );
    expect(rows[0].n).toBe("0");
  });
});
