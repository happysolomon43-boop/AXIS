import { afterAll, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";
import { state } from "./namedCutsFixtures.js";

const pool=makePool(), headers={"x-axis-user":"usr_aa"};
beforeEach(()=>resetDb(pool));
afterAll(()=>pool.end());
test("BC8: held stale writer cannot replace the admitted head",async()=>{
  const {seriesId,bookId}=await seedSeries(pool,"usr_aa");
  const {chapter,version}=await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},"# North\r\n\r\nRiver.\n","draft_edit");
  const winner=buildApp({pool}), loser=buildApp({pool});
  const path="/chapters/"+chapter.id, get=(app:typeof winner)=>app.inject({method:"GET",url:path+"/working-state?view=editor-document",headers});
  let release!:()=>void, pending=false;
  const held=new Promise<void>(resolve=>{release=resolve});
  let losing:Promise<unknown>|undefined;
  try {
    const a=(await get(winner)).json(), b=(await get(loser)).json();
    expect(a.version.id).toBe(version.id);expect(b.version.id).toBe(version.id);expect(a.draft).toBeNull();expect(b.draft).toBeNull();
    const before=await state(pool), uid=a.blocks[1].block_uid;
    const document=[{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"Riv",paragraph_id:uid},{kind:"paragraph",text:"er.",paragraph_id:"dp_00000000-0000-4000-8000-000000000001"}];
    const content="# North\n\nRiv\n\ner.";
    const oldGuard={base_version:b.version.id,base_revision:b.draft?.revision??0};
    pending=true;
    const delayed=held.then(()=>loser.inject({method:"PUT",url:path+"/draft",headers,payload:{...oldGuard,content:"Other text.",editor_document:[{kind:"paragraph",text:"Other text.",paragraph_id:"dp_00000000-0000-4000-8000-000000000002"}]}})).finally(()=>{pending=false});
    losing=delayed;
    const written=await winner.inject({method:"PUT",url:path+"/draft",headers,payload:{base_version:a.version.id,base_revision:0,content,editor_document:document}});
    expect(written.statusCode,written.body).toBe(200);expect(written.json().revision).toBe(1);
    release();
    const rejected=await delayed;expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toEqual({error:{code:"conflict",message:"Draft is out of date",details:{reason:"revision",current_version:version.id,current_revision:1}}});
    expect((await get(loser)).json()).toMatchObject({editor_document:document,draft:{content,revision:1,base_version:version.id}});
    const after=await state(pool);expect({...after,heads:[]}).toEqual({...before,heads:[]});
    expect(after.heads).toHaveLength(1);expect(after.heads[0]).toMatchObject({content,editor_document:document,revision:1});
    expect(after.versions.every(row=>!("editor_document" in row))).toBe(true);
  } finally {
    release();await losing;await Promise.all([winner.close(),loser.close()]);await resetDb(pool);expect(pending).toBe(false);
  }
});
