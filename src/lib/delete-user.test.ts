import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const deletedKeys: string[] = [];
vi.mock("../r2.js", () => ({
  putObject: vi.fn(async () => {}),
  presignGet: vi.fn(async () => "https://signed.example/x"),
  deleteObject: vi.fn(async (key: string) => {
    deletedKeys.push(key);
  }),
}));

const { pool, query } = await import("../db.js");
const { runMigrations } = await import("../migrate.js");
const { deleteUserData, findResidualRows } = await import("./delete-user.js");

const databaseAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
const describeIfDb = databaseAvailable ? describe : describe.skip;

const COURSE = "33333333-3333-3333-3333-333333333333"; // MATH 20D, seeded by 0002

/** A user with data in every table that references a user. */
async function seedUser() {
  const id = randomUUID();
  await query(
    "INSERT INTO users (id, email, name) VALUES ($1,$2,'Doomed') ON CONFLICT (id) DO NOTHING",
    [id, `del-${id}@test.local`],
  );
  await query(
    `INSERT INTO enrollments (user_id, course_id) VALUES ($1,$2)
     ON CONFLICT (user_id, course_id) DO NOTHING`,
    [id, COURSE],
  );

  const convId = randomUUID();
  await query(
    "INSERT INTO conversations (id, user_id, course_id, title) VALUES ($1,$2,$3,'t')",
    [convId, id, COURSE],
  );
  await query(
    "INSERT INTO messages (id, conversation_id, role, content) VALUES ($1,$2,'user','hi')",
    [randomUUID(), convId],
  );

  // Shared scope: deletion must remove it from the class pool as well.
  const matId = randomUUID();
  await query(
    `INSERT INTO materials
       (id, owner_user_id, course_id, material_type, file_name, r2_key, content_type,
        size_bytes, sha256, status, embedding_status, scope, chunk_count)
     VALUES ($1,$2,$3,'NOTES','n.pdf',$4,'application/pdf',10,$5,'READY','done','shared',1)`,
    [matId, id, COURSE, `k/${matId}.pdf`, randomUUID().replace(/-/g, "")],
  );
  await query(
    `INSERT INTO material_chunks
       (material_id, chunk_index, content, scope, course_id, owner_user_id, token_count)
     VALUES ($1,0,'chunk','shared',$2,$3,5)`,
    [matId, COURSE, id],
  );

  // Study guides: these FKs are NO ACTION, so they are what used to make
  // DELETE FROM users fail outright.
  const guideId = randomUUID();
  await query(
    `INSERT INTO study_guides (id, owner_user_id, course_id, target, retrieval_mode, status)
     VALUES ($1,$2,$3,'g','course','ready')`,
    [guideId, id, COURSE],
  );
  const versionId = randomUUID();
  await query(
    `INSERT INTO study_guide_versions
       (id, guide_id, version_number, origin, created_by_user_id, title, summary)
     VALUES ($1,$2,1,'generated',$3,'v1','s')`,
    [versionId, guideId, id],
  );
  await query("UPDATE study_guides SET current_version_id=$1 WHERE id=$2", [
    versionId,
    guideId,
  ]);
  await query(
    `INSERT INTO study_guide_jobs
       (id, type, scope_type, scope_id, guide_id, owner_user_id, dedupe_key, status)
     VALUES ($1,'generate_guide','guide',$2,$2,$3,$4,'completed')`,
    [randomUUID(), guideId, id, `dedupe-${randomUUID()}`],
  );

  await query("INSERT INTO user_milestones (user_id, milestone) VALUES ($1,'added_course')", [
    id,
  ]);

  return { id, matId, guideId };
}

describeIfDb("account deletion (C3)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("a dry run reports what would go and deletes nothing", async () => {
    const { id } = await seedUser();
    const report = await deleteUserData(id, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.rows.materials).toBe(1);
    expect(report.rows.study_guides).toBe(1);
    expect(report.rows.conversations).toBe(1);

    // Still all there.
    const residual = await findResidualRows(id);
    expect(residual.users).toBe(1);
    expect(residual.materials).toBe(1);
    expect(deletedKeys).toHaveLength(0);

    await deleteUserData(id); // clean up
  });

  it("erases every table, including the ones with no enforced reference", async () => {
    const { id } = await seedUser();
    await deleteUserData(id);

    // The real assertion: nothing anywhere still references this user. Checked
    // independently rather than trusting the counts the deletion reported.
    const residual = await findResidualRows(id);
    expect(residual).toEqual({});
  });

  it("removes uploaded files from storage, not just the database rows", async () => {
    deletedKeys.length = 0;
    const { id, matId } = await seedUser();
    const report = await deleteUserData(id);

    expect(report.storageObjects).toBe(1);
    expect(deletedKeys).toContain(`k/${matId}.pdf`);
  });

  it("succeeds for a user with study guides — the FKs that used to block deletion", async () => {
    const { id, guideId } = await seedUser();
    await expect(deleteUserData(id)).resolves.toBeTruthy();

    const guides = await query("SELECT 1 FROM study_guides WHERE id=$1", [guideId]);
    expect(guides).toHaveLength(0);
  });

  it("reports shared uploads separately, since classmates lose access to them", async () => {
    const { id } = await seedUser();
    const report = await deleteUserData(id);
    expect(report.sharedMaterialsRemoved).toBe(1);
  });

  it("refuses to delete an unknown user rather than silently doing nothing", async () => {
    await expect(deleteUserData(randomUUID())).rejects.toThrow(/not found/);
  });
});
