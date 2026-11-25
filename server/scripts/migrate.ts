import { fileURLToPath } from "node:url";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";

async function migrate(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) throw new Error("DATABASE_URL is required");

  const pool = createPool(url);
  try {
    const dir = fileURLToPath(new URL("../../db/migrations", import.meta.url));
    const applied = await runMigrations(pool, dir);
    if (applied.length === 0) {
      console.log("no pending migrations");
    }
    for (const filename of applied) {
      console.log(`applied ${filename}`);
    }
  } finally {
    await pool.end();
  }
}

try {
  await migrate();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
