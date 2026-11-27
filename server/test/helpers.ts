import { randomUUID } from "node:crypto";
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

export function writeGuard(base_version: string, base_revision = 0) {
  return { request_id: randomUUID(), base_version, base_revision };
}

export async function observedWriteGuard(pool: Pool, chapterId: string) {
  const { rows: [current] } = await pool.query<{ id: string; revision: number }>(
    `SELECT v.id, COALESCE(d.revision, 0) AS revision
     FROM chapter_versions v LEFT JOIN chapter_drafts d ON d.chapter_id = v.chapter_id
     WHERE v.chapter_id = $1 ORDER BY v.version_no DESC LIMIT 1`, [chapterId],
  );
  return writeGuard(current?.id ?? "ver_000000000000", current?.revision ?? 0);
}
