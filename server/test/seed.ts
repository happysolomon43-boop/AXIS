import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { expect } from "vitest";
import { runMigrations } from "../src/db/migrate.js";

export async function seedSeries(
  pool: Pool,
  ownerId = "usr_alice",
): Promise<{ seriesId: string; bookId: string }> {
  const { rows: [series] } = await pool.query<{ id: string }>(
    "INSERT INTO series (owner_id, title) VALUES ($1, 'Ashfall') RETURNING id",
    [ownerId],
  );
  if (!series) throw new Error("Series seed returned no row");
  const { rows: [book] } = await pool.query<{ id: string }>(
    `INSERT INTO books (series_id, title, ordinal, author_id)
     VALUES ($1, 'Ashfall', 1, $2) RETURNING id`,
    [series.id, ownerId],
  );
  if (!book) throw new Error("Book seed returned no row");
  return { seriesId: series.id, bookId: book.id };
}

export async function rollbackAll(pool: Pool): Promise<void> {
  const dir = fileURLToPath(new URL("../db/rollback", import.meta.url));
  const names = (await readdir(dir)).filter((name) => name.endsWith(".down.sql")).sort().reverse();
  for (const name of names) {
    await pool.query(await readFile(join(dir, name), "utf8"));
  }
}

export async function expectReapplyAll(pool: Pool): Promise<void> {
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  await expect(runMigrations(pool, dir)).resolves.toEqual(names);
}

export async function corpusCounts(pool: Pool) {
  const { rows: [counts] } = await pool.query<{
    ledger: number; chapters: number; versions: number; active: number;
  }>(
    `SELECT (SELECT count(*)::int FROM ledger) AS ledger,
            (SELECT count(*)::int FROM chapters) AS chapters,
            (SELECT count(*)::int FROM chapter_versions) AS versions,
            (SELECT count(*)::int FROM chapter_active) AS active`,
  );
  return counts;
}
