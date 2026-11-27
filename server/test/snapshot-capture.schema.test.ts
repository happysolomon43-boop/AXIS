import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, expect, test } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { fixture, labels, state } from "./namedCutsFixtures.js";

const pool = makePool();
const filename = "0013_snapshot_capture_requests.sql";
const insert = "INSERT INTO snapshot_capture_requests(chapter_id,request_id,request_hash,captured_version_id,draft_base_version_id,draft_base_revision,created_version) VALUES($1,$2,$3,$4,$5,$6,$7)";
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

test("AXB-0099 AC1 isolated down and up preserve named version and ledger", async () => {
  const f = await fixture(pool);
  try {
    const first = await f.create();
    const saved = await f.write(first.chapter.id, "The bell rang.");
    expect((await f.name(first.chapter.id, saved.version.id, "Before the bell")).statusCode).toBe(201);
    const before = await state(pool);
    const named = await labels(pool);
    const up = await readFile(new URL("../db/migrations/" + filename, import.meta.url), "utf8");
    const down = await readFile(new URL("../db/rollback/0013_snapshot_capture_requests.down.sql", import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(new URL("../db/rollback/0015_restore_checkpoint_labels.down.sql", import.meta.url), "utf8"));
      await client.query(await readFile(new URL("../db/rollback/0014_snapshot_label_lifecycles.down.sql", import.meta.url), "utf8"));
      const migrations = async () => (await client.query("SELECT * FROM schema_migrations ORDER BY filename")).rows;
      const original = await migrations();
      expect(original).toHaveLength(14);
      expect(original[12].filename).toBe(filename);
      await client.query(down);
      expect((await client.query("SELECT to_regclass('snapshot_capture_requests') AS name")).rows).toEqual([{name:null}]);
      expect(await migrations()).toEqual(original.filter(row => row.filename !== filename));
      expect((await client.query("SELECT * FROM named_cuts ORDER BY chapter_id, version_id")).rows).toEqual(named);
      expect((await client.query("SELECT * FROM chapter_versions ORDER BY id")).rows).toEqual(before.versions);
      expect((await client.query("SELECT * FROM ledger ORDER BY series_id, l_seq")).rows).toEqual(before.ledger);
      await client.query(up);
      await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [filename]);
      expect((await migrations()).map(row => row.filename)).toEqual(original.map(row => row.filename));
      expect((await client.query("SELECT * FROM snapshot_capture_requests")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM named_cuts ORDER BY chapter_id, version_id")).rows).toEqual(named);
      expect((await client.query("SELECT * FROM chapter_versions ORDER BY id")).rows).toEqual(before.versions);
      expect((await client.query("SELECT * FROM ledger ORDER BY series_id, l_seq")).rows).toEqual(before.ledger);
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  } finally { await f.app.close(); }
});

test("AXB-0099 AC2 receipt constraints preserve the valid row", async () => {
  const f = await fixture(pool);
  try {
    const a = await f.create(), b = await f.create();
    const next = await f.write(a.chapter.id, "New version.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(new URL("../db/rollback/0015_restore_checkpoint_labels.down.sql", import.meta.url), "utf8"));
      await client.query(await readFile(new URL("../db/rollback/0014_snapshot_label_lifecycles.down.sql", import.meta.url), "utf8"));
      const id = randomUUID();
      const args = [a.chapter.id, id, "a".repeat(64), a.version.id, next.version.id, 1, false];
      const columns = (await client.query("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='snapshot_capture_requests' ORDER BY ordinal_position")).rows;
      expect(columns.map(c => [c.column_name,c.data_type,c.is_nullable,c.column_default])).toEqual([
        ["chapter_id","text","NO",null],["request_id","uuid","NO",null],
        ["request_hash","text","NO",null],["captured_version_id","text","NO",null],
        ["draft_base_version_id","text","NO",null],["draft_base_revision","integer","NO",null],
        ["created_version","boolean","NO",null]
      ]);
      await client.query(insert,args);
      const original = (await client.query("SELECT * FROM snapshot_capture_requests")).rows;
      expect(original).toEqual([{chapter_id:a.chapter.id, request_id:id, request_hash:"a".repeat(64),captured_version_id:a.version.id,draft_base_version_id:next.version.id,draft_base_revision:1,created_version:false}]);
      const bad = async (index: number, value: unknown, code: string) => {
        const row: unknown[] = [...args];
        if (index >= 0) { row[1] = randomUUID(); row[index] = value; }
        await client.query("SAVEPOINT bad_receipt");
        try { await expect(client.query(insert,row)).rejects.toMatchObject({code}); }
        finally { await client.query("ROLLBACK TO SAVEPOINT bad_receipt"); await client.query("RELEASE SAVEPOINT bad_receipt"); }
      };
      await bad(-1,null,"23505");
      await bad(3,b.version.id,"23503");
      await bad(4,b.version.id,"23503");
      await bad(2,"A".repeat(64),"23514");
      await bad(5,-1,"23514");
      await bad(6,true,"23514");
      expect((await client.query("SELECT * FROM snapshot_capture_requests")).rows).toEqual(original);
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  } finally { await f.app.close(); }
});
