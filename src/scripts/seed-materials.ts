import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { query } from "../db.js";
import { putObject } from "../r2.js";

// Seeds a few authored study docs into R2 + Neon as SHARED course materials,
// so there is real content for the ingest/embedding + retrieval-eval pipeline.
// Idempotent: skips any file whose sha256 already exists. Run: npm run seed:materials

const SEED_OWNER = "seed-system";
const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../seed/materials");

interface SeedItem {
  file: string;
  courseCode: string;
  materialType: "NOTES" | "HOMEWORK" | "EXAM" | "PPT" | "SYLLABUS";
}

const MANIFEST: SeedItem[] = [
  { file: "math20d-notes-first-order-odes.md", courseCode: "MATH 20D", materialType: "NOTES" },
  { file: "math20d-hw-separable.md", courseCode: "MATH 20D", materialType: "HOMEWORK" },
  { file: "cse101-notes-divide-conquer.md", courseCode: "CSE 101", materialType: "NOTES" },
];

const norm = (c: string) => c.toUpperCase().replace(/\s+/g, "");

async function courseIdByCode(code: string): Promise<string | null> {
  const rows = await query<{ id: string }>(
    "SELECT id FROM courses WHERE upper(replace(code,' ',''))=$1 LIMIT 1",
    [norm(code)],
  );
  return rows[0]?.id ?? null;
}

async function main(): Promise<void> {
  let created = 0;
  let skipped = 0;
  for (const item of MANIFEST) {
    const courseId = await courseIdByCode(item.courseCode);
    if (!courseId) {
      console.warn(`skip ${item.file}: course ${item.courseCode} not found`);
      continue;
    }
    const buf = readFileSync(join(SEED_DIR, item.file));
    const sha256 = createHash("sha256").update(buf).digest("hex");

    const existing = await query<{ id: string }>(
      "SELECT id FROM materials WHERE sha256=$1 AND deleted_at IS NULL",
      [sha256],
    );
    if (existing[0]) {
      console.log(`skip (already seeded): ${item.file}`);
      skipped++;
      continue;
    }

    const id = randomUUID();
    const key = `materials/seed/${courseId}/${item.file}`;
    await putObject(key, buf, "text/markdown");
    await query(
      `INSERT INTO materials
         (id, owner_user_id, course_id, material_type, file_name, r2_key,
          content_type, size_bytes, sha256, status, scope, embedding_status)
       VALUES ($1,$2,$3,$4,$5,$6,'text/markdown',$7,$8,'READY','shared','pending')`,
      [id, SEED_OWNER, courseId, item.materialType, item.file, key, buf.length, sha256],
    );
    console.log(`seeded: ${item.file} -> ${item.courseCode} (${courseId})`);
    created++;
  }
  console.log(`done: ${created} created, ${skipped} skipped`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
