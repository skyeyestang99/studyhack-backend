import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Neon requires SSL; the connection string includes sslmode=require.
  ssl: config.databaseUrl.includes("sslmode=require")
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  // Release idle clients so Neon can scale to zero / reclaim connections, and
  // fail fast instead of hanging if the DB is unreachable.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

/** Scoped query function used inside a transaction. */
export type TxQuery = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) => Promise<R[]>;

/**
 * Run `fn` inside a single transaction (BEGIN/COMMIT, ROLLBACK on throw).
 * `fn` receives a query function bound to the transaction's client.
 */
export async function withTransaction<T>(fn: (q: TxQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q: TxQuery = async (text, params) =>
      (await client.query(text, params as never[])).rows as never[];
    const result = await fn(q);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
