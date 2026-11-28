import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { randomUUID } from "node:crypto";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";
import { state } from "./namedCutsFixtures.js";

const pool=makePool(), owner={"x-axis-user":"usr_aa"}, foreign={"x-axis-user":"usr_bb"};
const P="dp_00000000-0000-4000-8000-000000000001";
const Q="dp_00000000-0000-4000-8000-000000000002";
const R="dp_00000000-0000-4000-8000-000000000003";
let app:ReturnType<typeof buildApp>, id:string, base:string, O:string;
const rawSplit="# North\n\nRiv\n\ner.", rawJoin="# North\n\nRiver.";
const heading={kind:"heading",text:"North",paragraph_id:null};
const splitDoc=()=>[heading,{kind:"paragraph",text:"Riv",paragraph_id:O},{kind:"paragraph",text:"er.",paragraph_id:P}];
const joinDoc=()=>[heading,{kind:"paragraph",text:"River.",paragraph_id:O}];
const split=()=>[{kind:"split",old_id:O,new_id:P}];
const merge=()=>[{kind:"merge",old_id:P,new_id:O}];
beforeEach(async()=>{
  await resetDb(pool);
  const {seriesId,bookId}=await seedSeries(pool,"usr_aa");
  const result=await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},"# North\r\n\r\nRiver.\n","draft_edit");
  id=result.chapter.id;base=result.version.id;
  O=(await pool.query("SELECT block_uid FROM blocks WHERE version_id=$1 AND kind='paragraph'",[base])).rows[0].block_uid;
  app=buildApp({pool});
});
afterEach(()=>app.close());
afterAll(async()=>{await resetDb(pool);await pool.end()});
const put=(payload:object|string,headers:Record<string,string>=owner,chapter=id)=>app.inject({method:"PUT",url:"/chapters/"+chapter+"/draft",headers,payload});
const get=(suffix="/working-state?view=editor-lineage",headers:Record<string,string>=owner)=>app.inject({method:"GET",url:"/chapters/"+id+suffix,headers});
const row=async()=>(await pool.query("SELECT * FROM chapter_drafts WHERE chapter_id=$1",[id])).rows[0];
const body=(revision=0)=>({content:rawSplit,base_version:base,base_revision:revision,editor_document:splitDoc(),paragraph_lineage:split()});
const joined=(revision:number)=>({content:rawJoin,base_version:base,base_revision:revision,editor_document:joinDoc(),paragraph_lineage:merge()});
const keys=["active_version_id","blocks","chapter","draft","scenes","sync","version"];
const invalid=(path:string,message:string)=>({error:{code:"validation_failed",message:"Request validation failed",details:{errors:[{path,message}]}}});
test("AC1 and AC2 atomic head and exact read, replacement, omission and explicit clearing",async()=>{
  const before=await state(pool);
  const first=await put(body());expect(first.statusCode,first.body).toBe(200);
  expect(Object.keys(first.json()).sort()).toEqual(["base_version","chapter","revision","sync"]);
  expect(first.json().revision).toBe(1);
  expect(await row()).toEqual({chapter_id:id,base_version:base,revision:1,content:rawSplit,editor_document:splitDoc(),paragraph_lineage:split()});
  const read=await get();expect(read.statusCode,read.body).toBe(200);expect(read.headers["cache-control"]).toBe("no-store");
  expect(Object.keys(read.json()).sort()).toEqual([...keys,"editor_document","paragraph_lineage"].sort());
  expect(read.json()).toMatchObject({editor_document:splitDoc(),paragraph_lineage:split(),draft:{content:rawSplit,revision:1,base_version:base},sync:first.json().sync});
  expect((await get("/working-state?view=%65ditor-lineage")).json()).toEqual(read.json());
  expect((await put(joined(1))).json().revision).toBe(2);
  expect(await row()).toMatchObject({content:rawJoin,revision:2,editor_document:joinDoc(),paragraph_lineage:merge()});
  const {paragraph_lineage:_,...omit}=joined(2);
  expect((await put(omit)).json().revision).toBe(3);expect((await row()).paragraph_lineage).toEqual(merge());
  const replacement={...omit,base_revision:3,content:"Other",editor_document:[{kind:"paragraph",text:"Other",paragraph_id:O}]};
  expect((await put(replacement)).json().revision).toBe(4);expect((await row()).paragraph_lineage).toBeNull();
  expect((await put(joined(4))).json().revision).toBe(5);
  expect((await put({...joined(5),paragraph_lineage:[]})).json().revision).toBe(6);expect((await row()).paragraph_lineage).toBeNull();
  expect((await put(joined(6))).json().revision).toBe(7);
  const legacy={content:rawJoin,base_version:base,base_revision:7};
  expect((await put(legacy)).json().revision).toBe(8);
  expect(await row()).toMatchObject({editor_document:joinDoc(),paragraph_lineage:merge()});
  expect((await put({...legacy,base_revision:8,content:rawJoin+"\n"})).json().revision).toBe(9);
  expect(await row()).toMatchObject({editor_document:null,paragraph_lineage:null,content:rawJoin+"\n",revision:9});
  const after=await state(pool);expect({...after,heads:[]}).toEqual({...before,heads:[]});
});
test("AC3 stale guard wins, exact validation and inherited transport precedence",async()=>{
  expect((await put(body())).statusCode).toBe(200);
  const before=await state(pool);
  const {editor_document:_,...noDoc}=body(1);
  const badLineage=invalid("/paragraph_lineage","must be sorted lineage records that match the editor document");
  const cases=[
    [noDoc,invalid("/paragraph_lineage","must accompany an editor_document")],
    [{...body(1),paragraph_lineage:null},badLineage],
    [{...body(1),paragraph_lineage:[...split(),{kind:"merge",old_id:Q,new_id:O}]},badLineage],
    [{...body(1),paragraph_lineage:[{kind:"split",old_id:O,new_id:R}]},badLineage],
    [{...body(1),editor_document:null},invalid("/editor_document","must match the draft text and contain valid paragraph identities")],
  ] as const;
  for(const [payload,error] of cases){
    const result=await put(payload);expect(result.statusCode).toBe(400);expect(result.json()).toEqual(error);
    for(const [reason,stale] of [["version",{...payload,base_version:"ver_000000000000"}],["revision",{...payload,base_revision:0}]] as const){
      const conflict=await put(stale);expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({error:{code:"conflict",message:"Draft is out of date",details:{reason,current_version:base,current_revision:1}}});
    }
    expect(await state(pool)).toEqual(before);
  }
  expect((await put(noDoc,{})).json()).toEqual({error:{code:"auth_required",message:"Missing or invalid X-Axis-User header",details:null}});
  for(const result of [await put(noDoc,foreign),await put(noDoc,owner,"x".repeat(65))]){
    expect(result.statusCode).toBe(404);expect(result.json()).toEqual({error:{code:"not_found",message:"Chapter not found",details:null}});
  }
  const malformed=await put("{",{...owner,"content-type":"application/json"});
  expect(malformed.statusCode).toBe(400);expect(malformed.json()).toEqual({error:{code:"validation_failed",message:"Request could not be parsed",details:null}});
  const unsupported=await put("plain",{...owner,"content-type":"text/plain"});
  expect(unsupported.statusCode).toBe(415);expect(unsupported.json()).toEqual({error:{code:"unsupported_media_type",message:"Content-Type must be application/json",details:null}});
  const oversized=await put({...body(1),content:"\u0001".repeat(1_400_000)});
  expect(oversized.statusCode).toBe(413);expect(oversized.json()).toEqual({error:{code:"payload_too_large",message:"Request body too large",details:null}});
  expect(await state(pool)).toEqual(before);
});
test("AC4 exact projection selection and null states, corrupt metadata fails closed",async()=>{
  expect((await get()).json()).toMatchObject({draft:null,editor_document:null,paragraph_lineage:null});
  expect((await put({content:rawJoin,base_version:base,base_revision:0})).statusCode).toBe(200);
  expect((await get()).json()).toMatchObject({draft:{revision:1},editor_document:null,paragraph_lineage:null});
  const {paragraph_lineage:_,...d21}=joined(1);
  expect((await put(d21)).statusCode).toBe(200);
  expect((await get()).json()).toMatchObject({draft:{revision:2},editor_document:joinDoc(),paragraph_lineage:null});
  expect((await put(joined(2))).statusCode).toBe(200);
  const documentOnly=await get("/working-state?view=editor-document");
  expect(documentOnly.statusCode).toBe(200);expect(Object.keys(documentOnly.json()).sort()).toEqual([...keys,"editor_document"].sort());
  for(const suffix of ["/working-state","/working-state?view=","/working-state?view=other","/working-state?view=editor-lineage&view=editor-lineage","/working-state?view=editor-lineage&view=editor-document"]){
    const legacy=await get(suffix);expect(legacy.statusCode).toBe(200);expect(Object.keys(legacy.json()).sort()).toEqual(keys);
  }
  expect(Object.keys((await get("/draft")).json()).sort()).toEqual(["chapter","draft","sync"]);
  expect(Object.keys((await get("/draft?view=sync")).json())).toEqual(["sync"]);
  await pool.query("UPDATE chapter_drafts SET paragraph_lineage=$1::jsonb WHERE chapter_id=$2",[JSON.stringify([{kind:"merge",old_id:P,new_id:R}]),id]);
  const before=await state(pool);
  const corrupt=await get();expect(corrupt.statusCode).toBe(500);expect(corrupt.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
  const denied=await get(undefined,foreign);expect(denied.statusCode).toBe(404);expect(denied.json()).toEqual({error:{code:"not_found",message:"Chapter not found",details:null}});
  expect((await get("/working-state?view=editor-document")).statusCode).toBe(200);
  expect(await state(pool)).toEqual(before);
});

test("concurrent guarded heads admit exactly one complete pair",async()=>{
  expect((await put(body())).statusCode).toBe(200);
  const before=await state(pool),attempts=[joined(1),{...body(1),paragraph_lineage:[]}];
  const results=await Promise.all(attempts.map(x=>put(x)));
  expect(results.map(x=>x.statusCode).sort()).toEqual([200,409]);
  const winner=attempts[results.findIndex(x=>x.statusCode===200)];
  expect(await row()).toMatchObject({content:winner.content,revision:2,editor_document:winner.editor_document,paragraph_lineage:winner.paragraph_lineage.length?winner.paragraph_lineage:null});
  const after=await state(pool);expect({...after,heads:[]}).toEqual({...before,heads:[]});
});

test.each(["versions","send","snapshots","restore","keep-mine"] as const)("D22 head shares the guarded immutable clear boundary: %s",async action=>{
  expect((await put(body())).statusCode).toBe(200);
  const admitted=await state(pool);
  const post=(payload:object)=>app.inject({method:"POST",url:"/chapters/"+id+"/"+action,headers:owner,payload});
  const request_id=randomUUID();
  const content=action==="keep-mine"?"Local text.":rawSplit;
  const payload=action==="restore"?{request_id,version_id:base}:
    {request_id,content,base_version:base,base_revision:1,...(action==="snapshots"?{}:{parent_version:base})};
  if(action!=="restore"){
    const stale=await post({...payload,base_revision:0});
    expect(stale.statusCode,stale.body).toBe(409);
    expect(await state(pool)).toEqual(admitted);
  }
  const written=await post(payload);
  expect(written.statusCode,written.body).toBe(201);
  const after=await state(pool);
  expect(after.heads).toEqual([]);
  expect(after.versions.length).toBeGreaterThan(admitted.versions.length);
  expect(after.versions.every(v=>!("editor_document" in v)&&!("paragraph_lineage" in v))).toBe(true);
  const read=await get();expect(read.statusCode,read.body).toBe(200);
  expect(read.json()).toMatchObject({draft:null,editor_document:null,paragraph_lineage:null});
  const stale=await put({...body(1),paragraph_lineage:null});
  expect(stale.statusCode).toBe(409);expect(stale.json().error.details.reason).toBe("version");
  expect(await state(pool)).toEqual(after);
});
