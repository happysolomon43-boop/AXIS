import type { Pool, PoolClient } from "pg";
import { afterAll, beforeEach, expect, test } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { expectReapplyAll, rollbackAll, seedSeries } from "./seed.js";

const pool = makePool();
type Queryable = Pick<Pool | PoolClient, "query">;

function insertLedger(seriesId: string, lSeq: number, db: Queryable = pool) {
  return db.query(
    `INSERT INTO ledger (series_id, l_seq, door, actor, op, target_ids)
     VALUES ($1, $2, 'corpus', 'usr_alice', 'chapter.create', ARRAY['x'])`,
    [seriesId, lSeq],
  );
}

async function insertChapter(bookId: string, orderKey = "0000001000") {
  const { rows: [row] } = await pool.query<{ id: string }>(
    "INSERT INTO chapters (book_id, order_key) VALUES ($1, $2) RETURNING id",
    [bookId, orderKey],
  );
  if (!row) throw new Error("Chapter insert returned no row");
  return row.id;
}

type VersionValues = {
  versionNo?: number;
  source?: string;
  content?: string;
  textHash?: string;
  parent?: string | null;
  lSeq?: number;
};

async function insertVersion(
  seriesId: string,
  chapterId: string,
  values: VersionValues = {},
  db: Queryable = pool,
) {
  const { versionNo = 1, source = "draft_edit", content = "abc", textHash = "a".repeat(64),
    parent = null, lSeq = 1 } = values;
  const { rows: [row] } = await db.query<{ id: string }>(
    `INSERT INTO chapter_versions
       (series_id, chapter_id, version_no, source, content, text_hash, hints_hash, parent_version, l_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [seriesId, chapterId, versionNo, source, content, textHash, "b".repeat(64), parent, lSeq],
  );
  if (!row) throw new Error("Version insert returned no row");
  return row.id;
}

function insertActive(
  seriesId: string,
  chapterId: string,
  versionId: string | null,
  sinceL: number,
  db: Queryable = pool,
) {
  return db.query(
    "INSERT INTO chapter_active (series_id, chapter_id, version_id, since_l) VALUES ($1, $2, $3, $4)",
    [seriesId, chapterId, versionId, sinceL],
  );
}

async function seedCorpus() {
  const { seriesId, bookId } = await seedSeries(pool);
  await insertLedger(seriesId, 1);
  const chapterId = await insertChapter(bookId);
  const versionId = await insertVersion(seriesId, chapterId);
  await insertActive(seriesId, chapterId, versionId, 1);
  return { seriesId, bookId, chapterId, versionId };
}

async function expectDeferredLedger(
  seriesId: string,
  lSeq: number,
  insert: (client: PoolClient) => Promise<unknown>,
): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await insert(client);
    await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });

    await client.query("BEGIN");
    await insert(client);
    await insertLedger(seriesId, lSeq, client);
    await expect(client.query("COMMIT")).resolves.toMatchObject({ command: "COMMIT" });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

async function corpusObjects() {
  const { rows } = await pool.query(
    `SELECT to_regclass('chapters')::text AS chapters,
            to_regclass('chapter_versions')::text AS chapter_versions,
            to_regclass('chapter_active')::text AS chapter_active,
            to_regtype('version_source')::text AS version_source`,
  );
  return rows;
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 creates the exact Corpus columns, enum order, and generated IDs", async () => {
  const { chapterId, versionId } = await seedCorpus();
  expect(chapterId).toMatch(/^ch_[0-9a-f]{12}$/);
  expect(versionId).toMatch(/^ver_[0-9a-f]{12}$/);

  const { rows: columns } = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN ('chapters', 'chapter_versions', 'chapter_active')
     ORDER BY table_name, ordinal_position`,
  );
  const expected = {
    chapter_active: [
      ["series_id", "text"], ["chapter_id", "text"], ["version_id", "text", "YES"], ["since_l", "bigint"],
    ],
    chapter_versions: [
      ["id", "text"], ["series_id", "text"], ["chapter_id", "text"], ["version_no", "integer"],
      ["source", "USER-DEFINED"], ["content", "text"], ["text_hash", "text"], ["hints_hash", "text"],
      ["parent_version", "text", "YES"], ["l_seq", "bigint"],
    ],
    chapters: [["id", "text"], ["book_id", "text"], ["order_key", "text"]],
  };
  expect(columns).toEqual(Object.entries(expected).flatMap(([table_name, entries]) =>
    entries.map(([column_name, data_type, is_nullable = "NO"]) =>
      ({ table_name, column_name, data_type, is_nullable })),
  ));

  const { rows: labels } = await pool.query<{ label: string }>(
    "SELECT unnest(enum_range(NULL::version_source))::text AS label",
  );
  expect(labels.map(({ label }) => label)).toEqual([
    "draft_edit", "send", "reupload", "restore", "import", "bulk_replace", "checkpoint",
  ]);
});

test("AC2 enforces order key, version, hash, size, and active row constraints", async () => {
  const { seriesId, bookId, chapterId, versionId } = await seedCorpus();

  for (const orderKey of ["1000", "abc", "000000100a", "00000001000"]) {
    await expect(insertChapter(bookId, orderKey)).rejects.toMatchObject({ code: "23514" });
  }
  for (const values of [
    { versionNo: 0 }, { textHash: "a".repeat(63) }, { textHash: "A" + "a".repeat(63) },
    { content: "a".repeat(1000001) }, { lSeq: 0 }, { parent: versionId }, { versionNo: 2 },
  ]) {
    await expect(insertVersion(seriesId, chapterId, values)).rejects.toMatchObject({ code: "23514" });
  }
  await expect(insertVersion(seriesId, chapterId, {
    versionNo: 2, parent: versionId, content: "a".repeat(1000000),
  })).resolves.toMatch(/^ver_[0-9a-f]{12}$/);
  await expect(insertVersion(seriesId, chapterId)).rejects.toMatchObject({ code: "23505" });
  await expect(insertVersion(seriesId, chapterId, { source: "send " }))
    .rejects.toMatchObject({ code: "22P02" });

  await expect(insertActive(seriesId, chapterId, versionId, 0)).rejects.toMatchObject({ code: "23514" });
  await expect(insertActive(seriesId, chapterId, versionId, 1)).rejects.toMatchObject({ code: "23505" });
  await insertLedger(seriesId, 2);
  await expect(insertActive(seriesId, chapterId, null, 2)).resolves.toMatchObject({ rowCount: 1 });
});

test("AC3 restricts foreign keys and defers both ledger references until commit", async () => {
  const { seriesId, bookId, chapterId, versionId } = await seedCorpus();
  const otherChapter = await insertChapter(bookId, "0000002000");
  const otherVersion = await insertVersion(seriesId, otherChapter);

  await expect(insertChapter("bk_000000000000")).rejects.toMatchObject({ code: "23503" });
  await expect(insertVersion(seriesId, "ch_000000000000")).rejects.toMatchObject({ code: "23503" });
  await expect(insertVersion(seriesId, chapterId, { versionNo: 2, parent: otherVersion }))
    .rejects.toMatchObject({ code: "23503" });
  await insertLedger(seriesId, 4);
  await expect(insertActive(seriesId, chapterId, otherVersion, 4)).rejects.toMatchObject({ code: "23503" });
  await expect(pool.query("DELETE FROM chapters WHERE id = $1", [chapterId]))
    .rejects.toMatchObject({ code: "23503" });
  await expect(pool.query("DELETE FROM books WHERE id = $1", [bookId]))
    .rejects.toMatchObject({ code: "23503" });

  await expectDeferredLedger(seriesId, 2, (client) =>
    insertVersion(seriesId, chapterId, { versionNo: 2, parent: versionId, lSeq: 2 }, client));
  await expectDeferredLedger(seriesId, 3, (client) =>
    insertActive(seriesId, chapterId, versionId, 3, client));
});

test("AC4 protects append-only rows while permitting chapter edits and reset", async () => {
  await seedCorpus();
  for (const [table, set] of [
    ["chapter_versions", "content = 'x'"],
    ["chapter_active", "version_id = NULL"],
  ]) {
    const error = { code: "AX001", message: `append-only table ${table}` };
    await expect(pool.query(`UPDATE ${table} SET ${set}`)).rejects.toMatchObject(error);
    await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject(error);
  }
  await expect(pool.query("UPDATE chapters SET order_key = '0000002000'"))
    .resolves.toMatchObject({ rowCount: 1 });

  await resetDb(pool);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM series) AS series,
            (SELECT count(*)::int FROM books) AS books,
            (SELECT count(*)::int FROM ledger) AS ledger,
            (SELECT count(*)::int FROM chapters) AS chapters,
            (SELECT count(*)::int FROM chapter_versions) AS chapter_versions,
            (SELECT count(*)::int FROM chapter_active) AS chapter_active`,
  );
  expect(rows).toEqual([{
    series: 0, books: 0, ledger: 0, chapters: 0, chapter_versions: 0, chapter_active: 0,
  }]);
});

test("AC5 removes and restores the Corpus schema", async () => {
  await rollbackAll(pool);
  expect(await corpusObjects()).toEqual([{
    chapters: null, chapter_versions: null, chapter_active: null, version_source: null,
  }]);
  await expectReapplyAll(pool);
  expect(await corpusObjects()).toEqual([{
    chapters: "chapters", chapter_versions: "chapter_versions",
    chapter_active: "chapter_active", version_source: "version_source",
  }]);
});
