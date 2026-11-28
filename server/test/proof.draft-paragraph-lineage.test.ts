import {afterAll,expect,test,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {createChapterWithFirstVersion} from "../src/corpus/repo.js";
import * as syncReader from "../src/sync/read.js";
import {makePool,resetDb} from "./helpers.js";
import {seedSeries} from "./seed.js";
import {state} from "./namedCutsFixtures.js";
const pool=makePool();
afterAll(()=>pool.end());
test("BC8 Break-It: sync failure rolls back the complete admitted lineage head and retry succeeds",async()=>{
  await resetDb(pool);
  const {seriesId,bookId}=await seedSeries(pool,"usr_aa");
  const {chapter,version}=await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},"# North\r\n\r\nRiver.\n","draft_edit");
  const app=buildApp({pool}),headers={"x-axis-user":"usr_aa"},path="/chapters/"+chapter.id;
  const O=(await pool.query("SELECT block_uid FROM blocks WHERE version_id=$1 AND kind='paragraph'",[version.id])).rows[0].block_uid;
  const P="dp_00000000-0000-4000-8000-000000000001";
  const heading={kind:"heading",text:"North",paragraph_id:null};
  const split={base_version:version.id,base_revision:0,content:"# North\n\nRiv\n\ner.",editor_document:[heading,{kind:"paragraph",text:"Riv",paragraph_id:O},{kind:"paragraph",text:"er.",paragraph_id:P}],paragraph_lineage:[{kind:"split",old_id:O,new_id:P}]};
  const join={base_version:version.id,base_revision:1,content:"# North\n\nRiver.",editor_document:[heading,{kind:"paragraph",text:"River.",paragraph_id:O}],paragraph_lineage:[{kind:"merge",old_id:P,new_id:O}]};
  let pending=0;
  const put=async(payload:object)=>{pending++;try{return await app.inject({method:"PUT",url:path+"/draft",headers,payload});}finally{pending--;}};
  try{
    const first=await put(split);expect(first.statusCode,first.body).toBe(200);expect(first.json().revision).toBe(1);
    const before=await state(pool);
    const stub=vi.spyOn(syncReader,"readChapterSync").mockRejectedValueOnce(new Error("isolated lineage sync failure"));
    try{
      const failed=await put(join);expect(failed.statusCode).toBe(500);expect(failed.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
      expect(stub).toHaveBeenCalledTimes(1);expect(await state(pool)).toEqual(before);
    }finally{stub.mockRestore();}
    const retry=await put(join);expect(retry.statusCode,retry.body).toBe(200);expect(retry.json().revision).toBe(2);
    const after=await state(pool);expect({...after,heads:[]}).toEqual({...before,heads:[]});
    expect(after.heads).toHaveLength(1);expect(after.heads[0]).toMatchObject({revision:2,content:join.content,editor_document:join.editor_document,paragraph_lineage:join.paragraph_lineage});
    const read=await app.inject({method:"GET",url:path+"/working-state?view=editor-lineage",headers});
    expect(read.statusCode).toBe(200);expect(read.json()).toMatchObject({paragraph_lineage:join.paragraph_lineage});
  }finally{vi.restoreAllMocks();await app.close();await resetDb(pool);expect(pending).toBe(0);}
});
