import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, expect, test } from "vitest";
import { makePool, resetDb } from "./helpers.js";
import { fixture } from "./namedCutsFixtures.js";
const pool = makePool();
const filename = "0012_named_cuts.sql";
const insert = "INSERT INTO named_cuts(chapter_id,version_id,series_id,l_seq,label) VALUES($1,$2,$3,$4,$5)";
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

test("AXB-0091 AC1 down and reapply preserve predecessor data in one isolated transaction", async () => {
  const f = await fixture(pool);
  try {
    const first = await f.create();
    const saved = await f.write(first.chapter.id, "The bell rang.");
    const up = await readFile(new URL("../db/migrations/" + filename, import.meta.url), "utf8");
    const down = await readFile(new URL("../db/rollback/0012_named_cuts.down.sql", import.meta.url), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(new URL("../db/rollback/0015_restore_checkpoint_labels.down.sql", import.meta.url), "utf8"));
      await client.query(await readFile(new URL("../db/rollback/0014_snapshot_label_lifecycles.down.sql", import.meta.url), "utf8"));
      const migrationRows = async () => (await client.query("SELECT filename FROM schema_migrations ORDER BY filename")).rows;
      const original = await migrationRows();
      expect(original).toHaveLength(16);
      const definitions = async () => (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='named_cuts'::regclass ORDER BY definition")).rows;
      const expected = await definitions();
      const reapply = async () => { await client.query(up); await client.query("INSERT INTO schema_migrations(filename) VALUES($1)", [filename]); };
      const checkDown = async () => {
        expect((await client.query("SELECT to_regclass('named_cuts') AS name")).rows).toEqual([{ name: null }]);
        expect(await migrationRows()).toEqual(original.filter(row=>row.filename!==filename));
        expect((await client.query("SELECT id FROM chapter_versions WHERE id=$1", [saved.version.id])).rowCount).toBe(1);
        expect((await client.query("SELECT l_seq FROM ledger WHERE series_id=$1 AND l_seq=$2", [f.seriesId, saved.version.l_seq])).rowCount).toBe(1);
      };
      await client.query(down); await checkDown(); await reapply();
      expect(await definitions()).toEqual(expected);
      await client.query(insert, [first.chapter.id, saved.version.id, f.seriesId, saved.version.l_seq, "Before the bell"]);
      const exported = (await client.query("SELECT chapter_id,version_id,series_id,l_seq,kind,label,pack_pins,created_at::text AS created_at FROM named_cuts")).rows;
      expect(exported).toHaveLength((await client.query("SELECT count(*)::int AS n FROM named_cuts")).rows[0].n);
      expect(exported).toHaveLength(1);
      await client.query(down); await checkDown(); await reapply();
      expect(await migrationRows()).toEqual(original);
      expect(await definitions()).toEqual(expected);
      expect((await client.query("SELECT * FROM named_cuts")).rows).toEqual([]);
      expect((await client.query("SELECT to_regclass('named_cuts_ledger_idx')::text AS name")).rows).toEqual([{name:"named_cuts_ledger_idx"}]);
      for (const row of exported) {
        await client.query("INSERT INTO named_cuts(chapter_id,version_id,series_id,l_seq,kind,label,pack_pins,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [row.chapter_id,row.version_id,row.series_id,row.l_seq,row.kind,row.label,JSON.stringify(row.pack_pins),row.created_at]);
      }
      expect((await client.query("SELECT chapter_id,version_id,series_id,l_seq,kind,label,pack_pins,created_at::text AS created_at FROM named_cuts")).rows).toEqual(exported);
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  } finally { await f.app.close(); }
});
test("AXB-0091 AC2 column types, defaults, restrictions and valid row preservation", async () => {
  const f = await fixture(pool);
  try {
    const first = await f.create(), other = await f.create();
    const saved = await f.write(first.chapter.id, "The bell rang.");
    const args = [first.chapter.id, saved.version.id, f.seriesId, saved.version.l_seq, "Before the bell"];
    const cols = await pool.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='named_cuts' ORDER BY ordinal_position");
    expect(cols.rows.map(r => [r.column_name,r.data_type,r.is_nullable])).toEqual([
      ["chapter_id","text","NO"],["version_id","text","NO"],["series_id","text","NO"],["l_seq","bigint","NO"],
      ["kind","text","NO"],["label","text","NO"],["pack_pins","jsonb","NO"],["created_at","timestamp with time zone","NO"]
    ]);
    await pool.query(insert,args);
    const row = (await pool.query("SELECT * FROM named_cuts")).rows[0];
    expect(row).toEqual({chapter_id:args[0],version_id:args[1],series_id:args[2],l_seq:String(args[3]),kind:"snapshot",label:args[4],pack_pins:{},created_at:expect.any(Date)});
    await expect(pool.query(insert,args)).rejects.toMatchObject({code:"23505"});
    await expect(pool.query(insert,[other.chapter.id,...args.slice(1)])).rejects.toMatchObject({code:"23503"});
    const v = await f.write(other.chapter.id,"Other");
    const others = [other.chapter.id,v.version.id,f.seriesId,v.version.l_seq];
    await expect(pool.query(insert,[...others.slice(0,3),999999,"Valid"])).rejects.toMatchObject({code:"23503"});
    for(const label of [""," unnormalized ","x".repeat(201)]) await expect(pool.query(insert,[...others,label])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query(insert.replace("label)","label,kind)").replace("$5)","$5,'other')"),[...others,"Valid"])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query(insert.replace("label)","label,pack_pins)").replace("$5)","$5,'[]'::jsonb)"),[...others,"Valid"])).rejects.toMatchObject({code:"23514"});
    expect((await pool.query("SELECT * FROM named_cuts")).rows).toEqual([row]);
  } finally { await f.app.close(); }
});
