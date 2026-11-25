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

export async function seedVersion(
  pool: Pool,
  seriesId: string,
  bookId: string,
  content = "abc",
): Promise<{ chapterId: string; versionId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [chapter] } = await client.query<{ id: string }>(
      `INSERT INTO chapters (book_id, order_key)
       SELECT $1, lpad((COALESCE(max(order_key::bigint), 0) + 1000)::text, 10, '0')
       FROM chapters WHERE book_id = $1 RETURNING id`,
      [bookId],
    );
    if (!chapter) throw new Error("Chapter seed returned no row");
    const { rows: [ledger] } = await client.query<{ l_seq: string }>(
      `INSERT INTO ledger (series_id, l_seq, door, actor, op, target_ids)
       SELECT $1, COALESCE(max(l_seq), 0) + 1, 'corpus', 'usr_alice', 'chapter.create', ARRAY[$2::text]
       FROM ledger WHERE series_id = $1 RETURNING l_seq`,
      [seriesId, chapter.id],
    );
    if (!ledger) throw new Error("Ledger seed returned no row");
    const { rows: [version] } = await client.query<{ id: string }>(
      `INSERT INTO chapter_versions
         (series_id, chapter_id, version_no, source, content, text_hash, hints_hash, parent_version, l_seq)
       VALUES ($1, $2, 1, 'draft_edit', $3, repeat('a', 64), repeat('b', 64), NULL, $4) RETURNING id`,
      [seriesId, chapter.id, content, ledger.l_seq],
    );
    if (!version) throw new Error("Version seed returned no row");
    await client.query("COMMIT");
    return { chapterId: chapter.id, versionId: version.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function intakeCounts(pool: Pool) {
  const { rows: [counts] } = await pool.query<{
    ledger: number; chapters: number; versions: number; active: number; blocks: number; scenes: number;
  }>(
    `SELECT (SELECT count(*)::int FROM ledger) AS ledger,
            (SELECT count(*)::int FROM chapters) AS chapters,
            (SELECT count(*)::int FROM chapter_versions) AS versions,
            (SELECT count(*)::int FROM chapter_active) AS active,
            (SELECT count(*)::int FROM blocks) AS blocks,
            (SELECT count(*)::int FROM scenes) AS scenes`,
  );
  return counts;
}

export const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const helloHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
export const story = "# Chapter One\n\nShe turned the key.\n\n* * *\n\nHe waited.\n---\nThey left.\n";
export const storyBlocks = [
  { ordinal: 1, kind: "heading", text: "Chapter One", scene: 1 },
  { ordinal: 2, kind: "paragraph", text: "She turned the key.", scene: 1 },
  { ordinal: 3, kind: "scene_break", text: "* * *", scene: null },
  { ordinal: 4, kind: "paragraph", text: "He waited.", scene: 2 },
  { ordinal: 5, kind: "scene_break", text: "---", scene: null },
  { ordinal: 6, kind: "paragraph", text: "They left.", scene: 3 },
];
export const storyScenes = [
  { ordinal: 1, first_block: 1, last_block: 2 },
  { ordinal: 2, first_block: 4, last_block: 4 },
  { ordinal: 3, first_block: 6, last_block: 6 },
];
