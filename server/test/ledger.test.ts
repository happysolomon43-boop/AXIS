import { afterAll, beforeEach, expect, test } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { expectReapplyAll, rollbackAll, seedSeries } from "./seed.js";

const pool = makePool();

function insertLedger(seriesId: string, overrides: {
  lSeq?: number; door?: string; actor?: string; op?: string; targetIds?: string[];
} = {}) {
  const { lSeq = 1, door = "corpus", actor = "usr_alice", op = "chapter.create",
    targetIds = ["ch_000000000001"] } = overrides;
  return pool.query(
    `INSERT INTO ledger (series_id, l_seq, door, actor, op, target_ids)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING at`,
    [seriesId, lSeq, door, actor, op, targetIds],
  );
}

beforeEach(async () => {
  await resetDb(pool);
});

afterAll(async () => {
  await pool.end();
});

test("AC1 creates the ledger columns, composite primary key, and timestamp default", async () => {
  const { rows: columns } = await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ledger'
     ORDER BY ordinal_position`,
  );
  expect(columns).toEqual([
    ["series_id", "text"], ["l_seq", "bigint"], ["at", "timestamp with time zone"],
    ["door", "text"], ["actor", "text"], ["op", "text"], ["target_ids", "ARRAY"],
  ].map(([column_name, data_type]) => ({ column_name, data_type, is_nullable: "NO" })));

  const { rows: keys } = await pool.query(
    `SELECT k.column_name
     FROM information_schema.table_constraints AS c
     JOIN information_schema.key_column_usage AS k
       USING (constraint_catalog, constraint_schema, constraint_name, table_catalog, table_schema, table_name)
     WHERE c.table_schema = current_schema() AND c.table_name = 'ledger' AND c.constraint_type = 'PRIMARY KEY'
     ORDER BY k.ordinal_position`,
  );
  expect(keys).toEqual([{ column_name: "series_id" }, { column_name: "l_seq" }]);

  const { seriesId } = await seedSeries(pool);
  const { rows } = await insertLedger(seriesId);
  expect(rows).toEqual([{ at: expect.any(Date) }]);
});

test("AC2 enforces the ledger column checks and keys", async () => {
  const { seriesId } = await seedSeries(pool);
  await insertLedger(seriesId);

  for (const invalid of [
    { lSeq: 0 }, { door: "text" }, { door: "Corpus" }, { actor: "alice" },
    { actor: "usr_a" }, { op: "Chapter.Create" }, { op: "" }, { op: "a".repeat(65) },
    { targetIds: [] },
  ]) {
    await expect(insertLedger(seriesId, invalid)).rejects.toMatchObject({ code: "23514" });
  }
  await expect(insertLedger(seriesId, { lSeq: 2, op: "a".repeat(64) }))
    .resolves.toMatchObject({ rowCount: 1 });
  await expect(insertLedger(seriesId)).rejects.toMatchObject({ code: "23505" });
  await expect(insertLedger("ser_000000000000")).rejects.toMatchObject({ code: "23503" });
  await expect(pool.query("DELETE FROM series WHERE id = $1", [seriesId]))
    .rejects.toMatchObject({ code: "23503" });
});

test("AC3 rejects ledger mutations and permits reset and a new insert", async () => {
  const { seriesId } = await seedSeries(pool);
  await insertLedger(seriesId);
  for (const sql of ["UPDATE ledger SET op = 'chapter.edit'", "DELETE FROM ledger"]) {
    await expect(pool.query(sql)).rejects.toMatchObject({
      code: "AX001", message: "append-only table ledger",
    });
  }
  await resetDb(pool);
  expect((await pool.query("SELECT * FROM ledger")).rows).toEqual([]);

  const next = await seedSeries(pool);
  await expect(insertLedger(next.seriesId)).resolves.toMatchObject({ rowCount: 1 });
});

test("AC4 rolls back and reapplies the ledger and immutable trigger", async () => {
  await rollbackAll(pool);
  const { rows } = await pool.query(
    `SELECT to_regclass('ledger') AS ledger, to_regprocedure('axis_reject_change()') AS guard`,
  );
  expect(rows).toEqual([{ ledger: null, guard: null }]);

  await expectReapplyAll(pool);
  const { rows: triggers } = await pool.query(
    "SELECT tgname FROM pg_trigger WHERE tgrelid = 'ledger'::regclass AND NOT tgisinternal",
  );
  expect(triggers).toEqual([{ tgname: "ledger_immutable" }]);
});
