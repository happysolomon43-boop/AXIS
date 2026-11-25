import { afterAll, beforeEach, expect, test } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { expectReapplyAll, rollbackAll, seedSeries, seedVersion } from "./seed.js";

const pool = makePool();
const blockUid = "b_000000000001";
const hash = "a".repeat(64);

function insertBlock(versionId: string, values: {
  uid?: string; ordinal?: number; kind?: string; text?: string; hash?: string;
} = {}) {
  return pool.query(
    `INSERT INTO blocks (version_id, block_uid, ordinal, kind, text, hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [versionId, values.uid ?? blockUid, values.ordinal ?? 1, values.kind ?? "paragraph",
      values.text ?? "abc", values.hash ?? hash],
  );
}

function insertScene(versionId: string, values: {
  ordinal?: number; fingerprint?: string; first?: number; last?: number; pov?: string; timeMode?: string;
}) {
  return pool.query(
    `INSERT INTO scenes (version_id, ordinal, fingerprint, first_block, last_block, pov_hint, time_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [versionId, values.ordinal ?? 2, values.fingerprint ?? hash, values.first ?? 1,
      values.last ?? 1, values.pov ?? null, values.timeMode ?? "linear"],
  );
}

async function seedBlockAndScene() {
  const { seriesId, bookId } = await seedSeries(pool);
  const { versionId } = await seedVersion(pool, seriesId, bookId);
  const block = await insertBlock(versionId);
  const scene = await pool.query(
    `INSERT INTO scenes (version_id, ordinal, fingerprint, first_block, last_block)
     VALUES ($1, 1, $2, 1, 1) RETURNING id, pov_hint, location_hint, time_hint, time_mode`,
    [versionId, hash],
  );
  return { versionId, block: block.rows[0], scene: scene.rows[0] };
}

async function expectAppendOnly() {
  for (const [table, change] of [["blocks", "text = 'abc'"], ["scenes", "time_mode = 'linear'"]]) {
    const error = { code: "AX001", message: `append-only table ${table}` };
    await expect(pool.query(`UPDATE ${table} SET ${change}`)).rejects.toMatchObject(error);
    await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject(error);
  }
}

async function schemaObjects() {
  return (await pool.query(
    `SELECT to_regclass('blocks')::text AS blocks, to_regclass('scenes')::text AS scenes,
            to_regtype('block_kind')::text AS block_kind, to_regtype('time_mode')::text AS time_mode`,
  )).rows;
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 creates the exact block and scene schemas, enums, generated IDs, and defaults", async () => {
  const { rows: columns } = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name IN ('blocks', 'scenes')
     ORDER BY table_name, ordinal_position`,
  );
  const expected = {
    blocks: [
      ["id", "text"], ["version_id", "text"], ["block_uid", "text"], ["ordinal", "integer"],
      ["kind", "USER-DEFINED"], ["text", "text"], ["hash", "text"],
    ],
    scenes: [
      ["id", "text"], ["version_id", "text"], ["ordinal", "integer"], ["fingerprint", "text"],
      ["first_block", "integer"], ["last_block", "integer"],
      ["pov_hint", "text", "YES"], ["location_hint", "text", "YES"], ["time_hint", "text", "YES"],
      ["time_mode", "USER-DEFINED"],
    ],
  };
  expect(columns).toEqual(Object.entries(expected).flatMap(([table_name, definitions]) =>
    definitions.map(([column_name, data_type, is_nullable = "NO"]) =>
      ({ table_name, column_name, data_type, is_nullable })),
  ));
  const enums = await pool.query(
    `SELECT enum_range(NULL::block_kind)::text[] AS block_kind,
            enum_range(NULL::time_mode)::text[] AS time_mode`,
  );
  expect(enums.rows).toEqual([{
    block_kind: ["paragraph", "heading", "scene_break"], time_mode: ["linear", "flashback", "skip", "loop"],
  }]);

  const { block, scene } = await seedBlockAndScene();
  expect(block).toEqual({ id: expect.stringMatching(/^blk_[0-9a-f]{12}$/) });
  expect(scene).toEqual({
    id: expect.stringMatching(/^scn_[0-9a-f]{12}$/),
    pov_hint: null, location_hint: null, time_hint: null, time_mode: "linear",
  });
});

test("AC2 enforces block and scene checks, uniqueness, and references", async () => {
  const { versionId } = await seedBlockAndScene();
  const secondUid = "b_000000000002";
  for (const values of [
    { uid: "b_zz" }, { uid: "B_000000000001" }, { uid: "b_00000000001" },
    { ordinal: 0 }, { text: "" }, { text: "a".repeat(1000001) }, { hash: "a".repeat(63) },
  ]) {
    await expect(insertBlock(versionId, { uid: secondUid, ordinal: 2, ...values }))
      .rejects.toMatchObject({ code: "23514" });
  }
  await expect(insertBlock(versionId, { uid: secondUid, ordinal: 2, kind: "bogus" }))
    .rejects.toMatchObject({ code: "22P02" });
  await expect(insertBlock(versionId, { uid: secondUid })).rejects.toMatchObject({ code: "23505" });
  await expect(insertBlock(versionId, { ordinal: 2 })).rejects.toMatchObject({ code: "23505" });
  await expect(insertBlock("ver_000000000000")).rejects.toMatchObject({ code: "23503" });

  for (const values of [
    { ordinal: 0 }, { fingerprint: "a".repeat(63) }, { first: 0 }, { first: 2, last: 1 },
    { pov: "" }, { pov: "a".repeat(201) },
  ]) {
    await expect(insertScene(versionId, values)).rejects.toMatchObject({ code: "23514" });
  }
  await expect(insertScene(versionId, { timeMode: "sideways" })).rejects.toMatchObject({ code: "22P02" });
  await expect(insertScene(versionId, { first: 5, last: 5 })).rejects.toMatchObject({ code: "23503" });
  await expect(insertScene(versionId, { ordinal: 1 })).rejects.toMatchObject({ code: "23505" });
  await expect(insertScene(versionId, { pov: "a".repeat(200) })).resolves.toMatchObject({ rowCount: 1 });
});

test("AC3 makes both tables append-only and permits cascading test truncation", async () => {
  await seedBlockAndScene();
  await expectAppendOnly();
  await resetDb(pool);
  expect((await pool.query("SELECT * FROM blocks")).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM scenes")).rows).toEqual([]);
});

test("AC4 rolls back and restores the tables and append-only guards", async () => {
  await rollbackAll(pool);
  expect(await schemaObjects()).toEqual([{ blocks: null, scenes: null, block_kind: null, time_mode: null }]);
  await expectReapplyAll(pool);
  expect(await schemaObjects()).toEqual([{
    blocks: "blocks", scenes: "scenes", block_kind: "block_kind", time_mode: "time_mode",
  }]);
  await seedBlockAndScene();
  await expectAppendOnly();
});
