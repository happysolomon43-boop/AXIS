import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { runMigrations } from "../src/db/migrate.js";
import { makePool, resetDb } from "./helpers.js";
import { expectReapplyAll, intakeCounts, rollbackAll, seedSeries } from "./seed.js";

const pool = makePool();
const owner = "usr_alice";
const migration = "0010_chapter_drafts.sql";
const insert = "INSERT INTO chapter_drafts (chapter_id, base_version, content, revision) VALUES ($1, $2, $3, $4)";

beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function seedChapter() {
  const { seriesId, bookId } = await seedSeries(pool);
  const book = { id: bookId, series_id: seriesId };
  const { chapter, version } = await createChapterWithFirstVersion(pool, owner, book, "abc", "draft_edit");
  return { chapter, version, book };
}

test("AC1 enforces the head shape, limits, chapter and version references, and permits updates", async () => {
  const { chapter, version, book } = await seedChapter();
  const other = await createChapterWithFirstVersion(pool, owner, book, "abc", "draft_edit");
  await expect(pool.query(insert, [chapter.id, "ver_000000000000", "abc", 1])).rejects.toMatchObject({ code: "23503" });
  await expect(pool.query(insert, [chapter.id, other.version.id, "abc", 1])).rejects.toMatchObject({ code: "23503" });
  await expect(pool.query(insert, [chapter.id, version.id, "abc", 0])).rejects.toMatchObject({ code: "23514" });
  await expect(pool.query(insert, [chapter.id, version.id, "a".repeat(1000001), 1])).rejects.toMatchObject({ code: "23514" });
  await pool.query(insert, [chapter.id, version.id, "abc", 1]);
  const head = { chapter_id: chapter.id, base_version: version.id, content: "abc", revision: 1 };
  expect((await pool.query("SELECT * FROM chapter_drafts")).rows).toEqual([head]);
  await expect(pool.query(insert, [chapter.id, version.id, "abc", 1])).rejects.toMatchObject({ code: "23505" });
  await expect(pool.query("DELETE FROM chapters WHERE id = $1", [chapter.id])).rejects.toMatchObject({ code: "23503" });
  expect((await pool.query(
    "UPDATE chapter_drafts SET content = 'abcd', revision = 2 WHERE chapter_id = $1 RETURNING *",
    [chapter.id],
  )).rows).toEqual([{ ...head, content: "abcd", revision: 2 }]);
});

test("AC2 clears only the version writer's head, supports reset, and rolls back and reapplies all migrations", async () => {
  const { chapter, version, book } = await seedChapter();
  const other = await createChapterWithFirstVersion(pool, owner, book, "other", "draft_edit");
  await pool.query(insert, [chapter.id, version.id, "draft", 1]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of [other, { chapter, version }]) {
      await client.query("SELECT commit_inputs($1, 'corpus', $2, 'chapter.version.append', $3::jsonb)", [
        book.series_id, owner, JSON.stringify([{
          kind: "chapter_version", chapter_id: row.chapter.id,
          parent_version: row.version.id, content: "second", source: "draft_edit",
        }]),
      ]);
      const { rows } = await client.query("SELECT chapter_id FROM chapter_drafts");
      expect(rows).toEqual(row.chapter.id === other.chapter.id ? [{ chapter_id: chapter.id }] : []);
    }
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }

  expect((await pool.query("SELECT chapter_id FROM chapter_drafts")).rows).toEqual([{ chapter_id: chapter.id }]);
  const before = await intakeCounts(pool);
  const down = await readFile(new URL("../db/rollback/0010_chapter_drafts.down.sql", import.meta.url), "utf8");
  try {
    await pool.query(down);
    expect(await intakeCounts(pool)).toEqual(before);
    expect((await pool.query("SELECT to_regclass('chapter_drafts') AS drafts")).rows).toEqual([{ drafts: null }]);
    expect((await pool.query("SELECT filename FROM schema_migrations WHERE filename = $1", [migration])).rows).toEqual([]);
  } finally {
    await runMigrations(pool, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  }

  await pool.query(insert, [chapter.id, version.id, "draft", 1]);
  await resetDb(pool);
  expect((await pool.query("SELECT * FROM chapter_drafts")).rows).toEqual([]);
  await rollbackAll(pool);
  await expectReapplyAll(pool);
  expect((await pool.query("SELECT count(*)::int AS count FROM schema_migrations")).rows).toEqual([{ count: 12 }]);
  expect((await pool.query("SELECT * FROM chapter_drafts")).rows).toEqual([]);
});
