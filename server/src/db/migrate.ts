import { reportFailure } from "../logging.js";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

export async function runMigrations(pool: Pool, dir: string): Promise<string[]> {
  const filenames = (await readdir(dir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  let migrationFailed = false;
  let discardClient = false;

  try {
    await client.query("SELECT pg_advisory_lock(41001)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const recorded = new Set(rows.map(({ filename }) => filename));

    for (const filename of filenames) {
      if (recorded.has(filename)) continue;

      const sql = await readFile(join(dir, filename), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [filename],
        );
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          reportFailure("database_rollback_failed", rollbackError);
          discardClient = true;
        }
        throw error;
      }
      applied.push(filename);
    }

    return applied;
  } catch (error) {
    migrationFailed = true;
    throw error;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(41001)");
    } catch (error) {
      discardClient = true;
      if (!migrationFailed) throw error;
    } finally {
      client.release(discardClient);
    }
  }
}
