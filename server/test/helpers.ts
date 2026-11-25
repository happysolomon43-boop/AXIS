import type { Pool } from "pg";
import { createPool } from "../src/db/pool.js";

export function makePool(): Pool {
  const url = process.env.AXIS_TEST_DATABASE_URL;
  if (!url) throw new Error("AXIS_TEST_DATABASE_URL is required");
  return createPool(url);
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE series CASCADE");
}
