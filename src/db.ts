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
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}
