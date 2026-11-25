import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { runMigrations } from "../src/db/migrate.js";
import { makePool, resetDb } from "./helpers.js";
import { expectReapplyAll, helloHash, intakeCounts, rollbackAll, seedSeries, story } from "./seed.js";

const pool = makePool();
const migration = "0008_commit_inputs_activate.sql";

async function commit(seriesId: string, rows: object[]) {
  const { rows: [row] } = await pool.query<{ result: { l_seq: number; ids: string[] } }>(
    "SELECT commit_inputs($1, 'corpus', 'usr_alice', 'chapter.send', $2::jsonb) AS result",
    [seriesId, JSON.stringify(rows)],
  );
  if (!row) throw new Error("Commit returned no result");
  return row.result;
}

async function create(seriesId: string, bookId: string, content = "abc") {
  return createChapterWithFirstVersion(pool, "usr_alice", { id: bookId, series_id: seriesId }, content, "draft_edit");
}

function appended(chapterId: string, content = "hello") {
  return { kind: "chapter_version", chapter_id: chapterId, content, source: "send" };
}

async function activations(chapterId: string) {
  const { rows } = await pool.query(
    `SELECT series_id, chapter_id, version_id, since_l::int FROM chapter_active
     WHERE chapter_id = $1 ORDER BY since_l`, [chapterId],
  );
  return rows;
}

async function expectSend() {
  const { seriesId, bookId } = await seedSeries(pool);
  const { chapter, version } = await create(seriesId, bookId);
  expect(version.l_seq).toBe(1);
  expect(await activations(chapter.id)).toEqual([]);

  const result = await commit(seriesId, [{ ...appended(chapter.id), activate: true }]);
  expect(result).toEqual({ l_seq: 2, ids: [expect.stringMatching(/^ver_[0-9a-f]{12}$/)] });
  const [versionId] = result.ids;
  const { rows: versions } = await pool.query(
    `SELECT version_no, source, parent_version, text_hash, l_seq::int,
            (SELECT count(*)::int FROM blocks WHERE version_id = v.id) AS blocks,
            (SELECT count(*)::int FROM scenes WHERE version_id = v.id) AS scenes
     FROM chapter_versions AS v WHERE v.id = $1`, [versionId],
  );
  expect(versions).toEqual([{
    version_no: 2, source: "send", parent_version: version.id, text_hash: helloHash, l_seq: 2, blocks: 1, scenes: 1,
  }]);
  expect(await activations(chapter.id)).toEqual([
    { series_id: seriesId, chapter_id: chapter.id, version_id: versionId, since_l: 2 },
  ]);
  const { rows: ledger } = await pool.query(
    "SELECT door, actor, op, target_ids FROM ledger WHERE series_id = $1 AND l_seq = 2", [seriesId],
  );
  expect(ledger).toEqual([{ door: "corpus", actor: "usr_alice", op: "chapter.send", target_ids: [versionId] }]);
  return { seriesId, chapterId: chapter.id };
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 activates the version in the same commit and treats omitted, null and false as inactive", async () => {
  const { seriesId, chapterId } = await expectSend();

  const before = await activations(chapterId);
  for (const [offset, activate] of [undefined, null, false].entries()) {
    const result = await commit(seriesId, [{ ...appended(chapterId), activate }]);
    expect(result.l_seq).toBe(3 + offset);
    expect(result.ids).toHaveLength(1);
    expect(await activations(chapterId)).toEqual(before);
  }
});

test("AC2 rejects invalid or duplicate activation atomically and preserves the next position", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const { chapter, version } = await create(seriesId, bookId);
  const row = appended(chapter.id, "abc");
  const before = await intakeCounts(pool);

  async function reject(rows: object[], code: string, message?: string) {
    await expect(commit(seriesId, rows)).rejects.toMatchObject(message ? { code, message } : { code });
    expect(await intakeCounts(pool)).toEqual(before);
  }

  for (const activate of ["true", 1, {}, []]) {
    await reject([{ ...row, activate }], "AX002", "invalid row");
  }
  await reject([{ ...row, activate: true, hints: [null, null] }], "AX002", "invalid hints");
  const activate = { ...row, activate: true };
  await reject([activate, { kind: "chapter_active", chapter_id: chapter.id, version_id: version.id }], "23505");
  await reject([activate, activate], "23505");
  expect((await commit(seriesId, [activate])).l_seq).toBe(2);
});

test("AC3 activates two chapters at one ledger position and leaves first-version creation unchanged", async () => {
  const { seriesId, bookId } = await seedSeries(pool);
  const c = await create(seriesId, bookId);
  const d = await create(seriesId, bookId);
  const result = await commit(seriesId, [
    { ...appended(c.chapter.id, "x"), activate: true },
    { ...appended(d.chapter.id, "y"), activate: true },
  ]);
  expect(result.l_seq).toBe(3);
  expect(result.ids).toHaveLength(2);
  expect(result.ids[0]).not.toBe(result.ids[1]);
  for (const [index, { chapter }] of [c, d].entries()) {
    expect(await activations(chapter.id)).toEqual([
      { series_id: seriesId, chapter_id: chapter.id, version_id: result.ids[index], since_l: result.l_seq },
    ]);
  }
  expect((await pool.query("SELECT l_seq::int, target_ids FROM ledger WHERE l_seq = 3")).rows)
    .toEqual([{ l_seq: 3, target_ids: result.ids }]);

  const created = await create(seriesId, bookId, story);
  expect(await activations(created.chapter.id)).toEqual([]);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM blocks WHERE version_id = $1) AS blocks,
            (SELECT count(*)::int FROM scenes WHERE version_id = $1) AS scenes`,
    [created.version.id],
  );
  expect(rows).toEqual([{ blocks: 6, scenes: 3 }]);
});

test("AC4 reverses 0008 alone and restores activation through partial and full reapplication", async () => {
  const rollback = new URL("../db/rollback/0008_commit_inputs_activate.down.sql", import.meta.url);
  await pool.query(await readFile(rollback, "utf8"));
  expect((await pool.query("SELECT filename FROM schema_migrations WHERE filename = $1", [migration])).rows)
    .toEqual([]);
  const { rows: [definition] } = await pool.query<{ body: string }>(
    "SELECT pg_get_functiondef('commit_inputs(text,text,text,text,jsonb)'::regprocedure) AS body",
  );
  expect(definition?.body).not.toContain("activate");
  const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
  expect(await runMigrations(pool, dir)).toEqual([migration]);
  await expectSend();

  await rollbackAll(pool);
  await expectReapplyAll(pool);
  await expectSend();
});
