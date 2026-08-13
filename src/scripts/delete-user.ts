import { pool, query } from "../db.js";
import { deleteUserData } from "../lib/delete-user.js";

/**
 * Delete a user and all of their data.
 *
 *   npm run delete:user -- <email|uuid>            # dry run, shows what would go
 *   npm run delete:user -- <email|uuid> --confirm  # actually deletes
 *
 * Dry run is the default deliberately: this is irreversible, and the destructive
 * path should require typing something extra rather than being one arrow-up away in
 * shell history.
 */
async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  const confirmed = args.includes("--confirm");

  if (!target) {
    console.error("usage: npm run delete:user -- <email|uuid> [--confirm]");
    process.exit(1);
  }

  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const rows = await query<{ id: string; email: string }>(
    isUuid ? "SELECT id, email FROM users WHERE id=$1" : "SELECT id, email FROM users WHERE lower(email)=lower($1)",
    [target],
  );
  if (!rows[0]) {
    console.error(`no user matching ${target}`);
    process.exit(1);
  }

  const { id, email } = rows[0];
  console.log(`${confirmed ? "DELETING" : "DRY RUN for"} ${email} (${id})\n`);

  const report = await deleteUserData(id, { dryRun: !confirmed });

  const entries = Object.entries(report.rows);
  if (entries.length === 0) {
    console.log("  no data rows found");
  } else {
    for (const [table, n] of entries) console.log(`  ${table.padEnd(30)} ${n}`);
  }
  console.log(`  ${"storage objects".padEnd(30)} ${report.storageObjects}`);
  if (report.sharedMaterialsRemoved > 0) {
    console.log(
      `\n  NOTE: ${report.sharedMaterialsRemoved} upload(s) were shared with classmates ` +
        `and ${confirmed ? "were" : "would be"} removed from the course pool too.`,
    );
  }
  if (report.storageFailures.length > 0) {
    console.log(`\n  STORAGE FAILURES (sweep manually): ${report.storageFailures.length}`);
  }
  if (!confirmed) {
    console.log("\n  dry run — nothing was deleted. Re-run with --confirm.");
  } else {
    console.log("\n  done.");
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exit(1);
});
