import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { runMigrations } from "../src/db/migrate.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";

const pool = makePool();
const migration = "0018_draft_paragraph_lineage.sql";
const dir = fileURLToPath(new URL("../db/migrations", import.meta.url));
const down = () => readFile(new URL("../db/rollback/0018_draft_paragraph_lineage.down.sql", import.meta.url), "utf8");
const registrations = async () => (await pool.query("SELECT * FROM schema_migrations ORDER BY filename")).rows;
const heads = async () => (await pool.query("SELECT * FROM chapter_drafts")).rows;
const P = "dp_00000000-0000-4000-8000-000000000001";
const O = "b_000000000002";
const document = [{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"River.",paragraph_id:O}];
const lineage = [{kind:"merge",old_id:P,new_id:O}];
const content = "# North\r\n\r\nRiver.\n";
async function seed() {
  const {seriesId,bookId} = await seedSeries(pool,"usr_aa");
  const {chapter,version} = await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},content,"draft_edit");
  return {seriesId,chapter,version};
}
beforeEach(() => resetDb(pool));
afterAll(async () => { await resetDb(pool); await pool.end(); });

test("AC1 preserves the D21 head and enforces the nullable lineage shape", async () => {
  const {chapter,version} = await seed();
  await pool.query(await down());
  try {
    await pool.query("INSERT INTO chapter_drafts(chapter_id,base_version,content,revision,editor_document) VALUES($1,$2,$3,1,$4::jsonb)",
      [chapter.id,version.id,content,JSON.stringify(document)]);
    const before = await heads();
    expect(await runMigrations(pool,dir)).toEqual([migration]);
    expect(await heads()).toEqual(before.map(row=>({...row,paragraph_lineage:null})));
    expect((await pool.query("SELECT data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='chapter_drafts' AND column_name='paragraph_lineage'")).rows)
      .toEqual([{data_type:"jsonb",is_nullable:"YES",column_default:null}]);
    for (const bad of ["{}","null","[]","1","true",'"text"']) {
      await expect(pool.query("UPDATE chapter_drafts SET paragraph_lineage=$1::jsonb",[bad]))
        .rejects.toMatchObject({code:"23514",constraint:"chapter_drafts_paragraph_lineage_shape"});
    }
    await expect(pool.query("UPDATE chapter_drafts SET editor_document=NULL, paragraph_lineage=$1::jsonb",[JSON.stringify(lineage)]))
      .rejects.toMatchObject({code:"23514",constraint:"chapter_drafts_paragraph_lineage_shape"});
    expect(await heads()).toEqual(before.map(row=>({...row,paragraph_lineage:null})));
    await pool.query("UPDATE chapter_drafts SET paragraph_lineage=$1::jsonb",[JSON.stringify(lineage)]);
    expect(await heads()).toEqual(before.map(row=>({...row,paragraph_lineage:lineage})));
  } finally { await runMigrations(pool,dir); }
});

test("AC2 refuses populated down and clears lineage only through the inherited head clear",async()=>{
  const {seriesId,chapter,version}=await seed();
  await pool.query("INSERT INTO chapter_drafts(chapter_id,base_version,content,revision,editor_document,paragraph_lineage) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb)",
    [chapter.id,version.id,content,JSON.stringify(document),JSON.stringify(lineage)]);
  const before=await heads(), migrations=await registrations();
  await expect(pool.query(await down())).rejects.toMatchObject({code:"AX002",message:"draft paragraph lineage must survive rollback"});
  expect(await heads()).toEqual(before);
  expect(await registrations()).toEqual(migrations);
  await pool.query("SELECT commit_inputs($1,'corpus','usr_aa','chapter.version.append',$2::jsonb)",[seriesId,JSON.stringify([{kind:"chapter_version",chapter_id:chapter.id,content:"next",source:"draft_edit"}])]);
  expect(await heads()).toEqual([]);
  const immutable=async()=>Promise.all(["chapter_versions","chapter_active","ledger","blocks","scenes"].map(async table=>
    (await pool.query("SELECT row_to_json(t) AS row FROM "+table+" t ORDER BY row_to_json(t)::text")).rows));
  const saved=await immutable();
  try {
    await pool.query(await down());
    expect(await registrations()).toEqual(migrations.filter(row=>row.filename!==migration));
    expect(await immutable()).toEqual(saved);
    expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='chapter_drafts' AND column_name='paragraph_lineage'")).rows).toEqual([]);
  } finally { await runMigrations(pool,dir); }
});
