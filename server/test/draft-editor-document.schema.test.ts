import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { runMigrations } from "../src/db/migrate.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";

const pool = makePool();
const migration = "0017_draft_editor_document.sql";
const directory = fileURLToPath(new URL("../db/migrations", import.meta.url));
const down = () => readFile(new URL("../db/rollback/0017_draft_editor_document.down.sql", import.meta.url), "utf8");
const registrations = async () => (await pool.query("SELECT * FROM schema_migrations ORDER BY filename")).rows;
const head = async () => (await pool.query("SELECT * FROM chapter_drafts")).rows;
beforeEach(() => resetDb(pool));
afterAll(async () => { await resetDb(pool); await pool.end(); });

test("AC1 preserves legacy raw bytes and rejects invalid JSONB shapes", async () => {
  const { seriesId, bookId } = await seedSeries(pool, "usr_aa");
  const {chapter,version} = await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},"base","draft_edit");
  const content = "# North\r\n\r\nRiver.\n";
  await pool.query(await down());
  try {
    await pool.query("INSERT INTO chapter_drafts(chapter_id,base_version,content,revision) VALUES($1,$2,$3,1)",[chapter.id,version.id,content]);
    const before = await head();
    expect(await runMigrations(pool,directory)).toEqual([migration]);
    expect(await head()).toEqual(before.map(row=>({...row,editor_document:null})));
    for (const bad of ["{}","null","[]"]) {
      await expect(pool.query("UPDATE chapter_drafts SET editor_document=$1::jsonb",[bad])).rejects.toMatchObject({
        code:"23514",constraint:"chapter_drafts_editor_document_shape"});
    }
  } finally { await runMigrations(pool,directory); }
});
test("AC2 populated down refuses atomically; immutable append clears the head",async()=>{
  const {seriesId,bookId}=await seedSeries(pool,"usr_aa");
  const {chapter,version}=await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},"base","draft_edit");
  const doc=[{kind:"paragraph",text:"draft",paragraph_id:"dp_00000000-0000-4000-8000-000000000001"}];
  await pool.query("INSERT INTO chapter_drafts(chapter_id,base_version,content,revision,editor_document) VALUES($1,$2,'draft',1,$3::jsonb)",[chapter.id,version.id,JSON.stringify(doc)]);
  const before=await head(), migrations=await registrations();
  await expect(pool.query(await down())).rejects.toMatchObject({code:"AX002",message:"draft editor documents must survive rollback"});
  expect(await head()).toEqual(before);expect(await registrations()).toEqual(migrations);
  await pool.query("SELECT commit_inputs($1,'corpus','usr_aa','chapter.version.append',$2::jsonb)",[seriesId,JSON.stringify([{kind:"chapter_version",chapter_id:chapter.id,content:"next",source:"draft_edit"}])]);
  expect(await head()).toEqual([]);
  const immutable = async () => Promise.all(["chapter_versions","chapter_active","ledger","blocks","scenes"].map(async table =>
    (await pool.query("SELECT row_to_json(t) AS row FROM "+table+" t ORDER BY row_to_json(t)::text")).rows));
  const saved=await immutable();
  try {
    await pool.query(await down());
    expect(await registrations()).toEqual(migrations.filter(row=>row.filename!==migration));
    expect(await immutable()).toEqual(saved);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='chapter_drafts' AND column_name='editor_document'")).rows).toEqual([]);
  } finally { await runMigrations(pool,directory); }
});
