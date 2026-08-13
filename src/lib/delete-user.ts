import { pool, query } from "../db.js";
import { deleteObject } from "../r2.js";

export interface DeletionReport {
  userId: string;
  email: string | null;
  dryRun: boolean;
  /** Rows removed per table. */
  rows: Record<string, number>;
  /** Uploaded files removed from object storage. */
  storageObjects: number;
  /** Object keys that could NOT be deleted — must be swept manually. */
  storageFailures: string[];
  /** Shared-pool uploads removed, which classmates could previously retrieve. */
  sharedMaterialsRemoved: number;
}

/**
 * Erase everything belonging to one user.
 *
 * Beta item C3. This was previously blocked on the observation that
 * materials.owner_user_id is `text` with no foreign key, but that is only one of
 * three distinct problems, and the other two are worse:
 *
 *  1. CASCADE tables (conversations -> messages, enrollments, flashcards,
 *     syllabus_events, user_milestones) disappear with the user row. Fine.
 *
 *  2. The five study-guide tables have foreign keys with NO ACTION, so
 *     `DELETE FROM users` FAILS outright until they are cleared. Account deletion
 *     could never have worked for any user who generated a study guide.
 *
 *  3. materials, material_chunks and message_feedback have no enforced reference,
 *     so deleting the user leaves them behind permanently — invisible orphans
 *     still holding the student's uploaded coursework. This is the case that turns
 *     "we deleted your account" into a false statement.
 *
 * Ordering is deliberate: object storage is emptied BEFORE the database rows that
 * point at it. If a storage delete fails we abort with the references intact, so
 * the operation can be retried. Deleting rows first would strand files in R2 with
 * nothing left pointing at them — the worst outcome for something whose whole
 * purpose is erasure.
 *
 * Shared-scope uploads are deleted too, and counted separately in the report.
 * Keeping a student's contributions after telling them their data was deleted
 * would be dishonest; classmates losing that material is the honest cost.
 */
export async function deleteUserData(
  userId: string,
  opts: { dryRun?: boolean } = {},
): Promise<DeletionReport> {
  const dryRun = opts.dryRun ?? false;
  const report: DeletionReport = {
    userId,
    email: null,
    dryRun,
    rows: {},
    storageObjects: 0,
    storageFailures: [],
    sharedMaterialsRemoved: 0,
  };

  const [user] = await query<{ email: string }>("SELECT email FROM users WHERE id=$1", [
    userId,
  ]);
  if (!user) throw new Error(`user ${userId} not found`);
  report.email = user.email;

  // owner_user_id is text, so compare as text rather than relying on a uuid cast.
  const materials = await query<{ id: string; r2_key: string; scope: string }>(
    "SELECT id, r2_key, scope FROM materials WHERE owner_user_id = $1::text",
    [userId],
  );
  report.sharedMaterialsRemoved = materials.filter((m) => m.scope === "shared").length;

  // Counted BEFORE deleting, and used for both paths. Rows removed by ON DELETE
  // CASCADE return no rowCount, so reporting only what the explicit statements
  // touched made a real deletion look like it had removed nothing but the user row.
  const counts = await countAll(userId);
  report.rows = { ...counts };

  if (dryRun) {
    report.storageObjects = materials.filter((m) => m.r2_key).length;
    return report;
  }

  // --- storage first: never drop the reference before the referent ---
  for (const m of materials) {
    if (!m.r2_key) continue;
    try {
      await deleteObject(m.r2_key);
      report.storageObjects += 1;
    } catch (err) {
      report.storageFailures.push(m.r2_key);
      console.error(
        `failed to delete object ${m.r2_key}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (report.storageFailures.length > 0) {
    throw new Error(
      `aborted before deleting database rows: ${report.storageFailures.length} object(s) ` +
        `could not be removed from storage. Retry once storage is reachable — the rows ` +
        `still reference them, so nothing has been stranded.`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const del = async (label: string, sql: string) => {
      const res = await client.query(sql, [userId]);
      if (res.rowCount) {
        report.rows[label] = Math.max(report.rows[label] ?? 0, res.rowCount);
      }
    };

    // Study-guide family. Two separate ordering constraints apply:
    //  - the child tables reference users with NO ACTION, so they must go before
    //    the user row;
    //  - study_guides.current_version_id references study_guide_versions, so that
    //    pointer has to be cleared BEFORE the versions are deleted, otherwise
    //    fk_study_guides_current_version rejects it.
    await client.query(
      "UPDATE study_guides SET current_version_id=NULL WHERE owner_user_id=$1",
      [userId],
    );
    await del(
      "study_guide_versions",
      `DELETE FROM study_guide_versions WHERE created_by_user_id=$1
         OR guide_id IN (SELECT id FROM study_guides WHERE owner_user_id=$1)`,
    );
    await del(
      "study_guide_revision_requests",
      "DELETE FROM study_guide_revision_requests WHERE owner_user_id=$1",
    );
    await del("study_guide_jobs", "DELETE FROM study_guide_jobs WHERE owner_user_id=$1");
    await del(
      "study_guide_idempotency_keys",
      "DELETE FROM study_guide_idempotency_keys WHERE owner_user_id=$1",
    );
    await del("study_guides", "DELETE FROM study_guides WHERE owner_user_id=$1");

    // Unenforced references — these are the rows that would otherwise be orphaned.
    await del(
      "material_chunks",
      "DELETE FROM material_chunks WHERE owner_user_id=$1::text",
    );
    await del("materials", "DELETE FROM materials WHERE owner_user_id=$1::text");
    await del("message_feedback", "DELETE FROM message_feedback WHERE user_id=$1");

    // Everything remaining cascades from the user row.
    await del("users", "DELETE FROM users WHERE id=$1");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return report;
}

/** Row counts a real run would delete, for --dry-run. */
async function countAll(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const probes: [string, string][] = [
    ["conversations", "SELECT count(*) n FROM conversations WHERE user_id=$1"],
    [
      "messages",
      `SELECT count(*) n FROM messages
        WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=$1)`,
    ],
    ["enrollments", "SELECT count(*) n FROM enrollments WHERE user_id=$1"],
    ["flashcards", "SELECT count(*) n FROM flashcards WHERE user_id=$1"],
    ["syllabus_events", "SELECT count(*) n FROM syllabus_events WHERE user_id=$1"],
    ["user_milestones", "SELECT count(*) n FROM user_milestones WHERE user_id=$1"],
    ["message_feedback", "SELECT count(*) n FROM message_feedback WHERE user_id=$1"],
    ["study_guides", "SELECT count(*) n FROM study_guides WHERE owner_user_id=$1"],
    ["study_guide_jobs", "SELECT count(*) n FROM study_guide_jobs WHERE owner_user_id=$1"],
    [
      "materials",
      "SELECT count(*) n FROM materials WHERE owner_user_id=$1::text",
    ],
    [
      "material_chunks",
      "SELECT count(*) n FROM material_chunks WHERE owner_user_id=$1::text",
    ],
  ];
  for (const [label, sql] of probes) {
    try {
      const rows = await query<{ n: string }>(sql, [userId]);
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) counts[label] = n;
    } catch {
      // A table that doesn't exist in this environment is not a dry-run failure.
    }
  }
  return counts;
}

/**
 * Rows still referencing a user id, used to prove a deletion left nothing behind.
 * Exported so the test suite asserts erasure rather than trusting the row counts
 * the deletion itself reported.
 */
export async function findResidualRows(userId: string): Promise<Record<string, number>> {
  return countAll(userId).then(async (counts) => {
    const [u] = await query<{ n: string }>("SELECT count(*) n FROM users WHERE id=$1", [
      userId,
    ]);
    if (Number(u?.n ?? 0) > 0) counts.users = Number(u.n);
    return counts;
  });
}
