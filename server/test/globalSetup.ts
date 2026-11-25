import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

export default async function setup(): Promise<void> {
  const url = process.env.AXIS_TEST_DATABASE_URL;
  if (!url) throw new Error("AXIS_TEST_DATABASE_URL is required");

  const pool = createPool(url);
  try {
    const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
    await runMigrations(pool, dir);
  } finally {
    await pool.end();
  }
}
