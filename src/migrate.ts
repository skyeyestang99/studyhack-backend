import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

/**
 * Arbitrary but fixed key for the Postgres advisory lock that serialises
 * migration runs.
 *
 * Without it, two deploys racing (API + study-guide worker, or two API
 * instances) both read the same set of applied migrations, both decide the same
 * file is pending, and both try to apply it. One then dies on either a
 * non-idempotent DDL statement or the schema_migrations primary key — which is
 * exactly how the worker service's first deploy failed at its pre-deploy step.
 *
 * The lock makes concurrency safe regardless of how many deploy paths run
 * migrations: the loser waits, re-reads state, and finds nothing to do.
 */
const MIGRATION_LOCK_KEY = 8_113_072_026;

/** Apply any pending SQL migrations. Does not close the pool (callers manage it). */
export async function runMigrations(): Promise<void> {
  const lock = await pool.connect();
  try {
    // Blocks until any other migration run finishes. Session-scoped, so it is
    // released even if this process is killed mid-run.
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    // Read AFTER taking the lock — reading before would reintroduce the race.
    const appliedRows = await pool.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const applied = new Set(appliedRows.rows.map((r) => r.name));

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log("skip   ", file);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log("applied", file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
  } finally {
    await lock
      .query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY])
      .catch(() => {
        /* session close releases it anyway */
      });
    lock.release();
  }
}

// CLI entry: `npm run migrate` (dev, tsx) or `node dist/migrate.js` (prod / Railway pre-deploy)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => pool.end())
    .then(() => console.log("migrations up to date"))
    .catch((err) => {
      console.error("MIGRATION FAILED", err);
      process.exit(1);
    });
}
