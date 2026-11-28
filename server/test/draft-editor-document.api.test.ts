import { Writable } from "node:stream";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { createChapterWithFirstVersion } from "../src/corpus/repo.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";
import * as syncReader from "../src/sync/read.js";
import { state } from "./namedCutsFixtures.js";

const pool=makePool(), owner={"x-axis-user":"usr_aa"}, foreign={"x-axis-user":"usr_bb"};
const P="dp_00000000-0000-4000-8000-000000000001";
let app: ReturnType<typeof buildApp>, id:string, base:string, document:unknown[];
let logs: string[];
const content="# North\n\nRiv\n\ner.";
beforeEach(async()=>{
  await resetDb(pool);
  const {seriesId,bookId}=await seedSeries(pool,"usr_aa");
  const result=await createChapterWithFirstVersion(pool,"usr_aa",{id:bookId,series_id:seriesId},"# North\r\n\r\nRiver.\n","draft_edit");
  id=result.chapter.id;base=result.version.id;
  const uid=(await pool.query("SELECT block_uid FROM blocks WHERE version_id=$1 AND kind='paragraph'",[base])).rows[0].block_uid;
  document=[{kind:"heading",text:"North",paragraph_id:null},{kind:"paragraph",text:"Riv",paragraph_id:uid},{kind:"paragraph",text:"er.",paragraph_id:P}];
  logs=[];
  app=buildApp({pool},new Writable({write(chunk,_encoding,done){logs.push(String(chunk));done();}}));
});
afterEach(async()=>{vi.restoreAllMocks();await app.close()});
afterAll(async()=>{await resetDb(pool);await pool.end()});
const body=(revision=0)=>({content,base_version:base,base_revision:revision,editor_document:document});
const put=(payload:object|string,headers:Record<string,string>=owner,chapter=id)=>app.inject({method:"PUT",url:"/chapters/"+chapter+"/draft",headers,payload});
const get=(suffix="/working-state?view=editor-document",headers:Record<string,string>=owner)=>app.inject({method:"GET",url:"/chapters/"+id+suffix,headers});
const row=async()=>(await pool.query("SELECT * FROM chapter_drafts WHERE chapter_id=$1",[id])).rows[0];
test("write AC1/2 and read AC1/2 keep exact document, bytes and inherited projections",async()=>{
  const before=await state(pool);
  expect((await get()).json()).toMatchObject({draft:null,editor_document:null});
  const first=await put(body());expect(first.statusCode,first.body).toBe(200);
  expect(Object.keys(first.json()).sort()).toEqual(["base_version","chapter","revision","sync"]);
  expect(first.json().revision).toBe(1);
  expect(await row()).toEqual({chapter_id:id,base_version:base,revision:1,content,editor_document:document});
  const read=await get();expect(read.statusCode).toBe(200);expect(read.headers["cache-control"]).toBe("no-store");
  expect(Object.keys(read.json()).sort()).toEqual(["active_version_id","blocks","chapter","draft","editor_document","scenes","sync","version"]);
  expect(read.json()).toMatchObject({editor_document:document,draft:{content,revision:1,base_version:base},sync:first.json().sync});
  expect((await get("/working-state?view=%65ditor-document")).json()).toEqual(read.json());
  const repeated=await put(body());expect(repeated.statusCode).toBe(409);expect(repeated.json().error.details).toEqual({reason:"revision",current_version:base,current_revision:1});
  expect(await row()).toEqual({chapter_id:id,base_version:base,revision:1,content,editor_document:document});
  for(const suffix of ["/working-state","/working-state?view=","/working-state?view=other","/working-state?view=editor-document&view=editor-document"]){
    const legacy=await get(suffix);expect(legacy.statusCode).toBe(200);expect(Object.keys(legacy.json()).sort()).toEqual(["active_version_id","blocks","chapter","draft","scenes","sync","version"]);
  }
  expect((await get("/draft")).json()).not.toHaveProperty("editor_document");
  expect(Object.keys((await get("/draft?view=sync")).json())).toEqual(["sync"]);
  const {editor_document:_,...legacy}=body(1);
  expect((await put(legacy)).json().revision).toBe(2);expect((await row()).editor_document).toEqual(document);
  expect((await put({...legacy,base_revision:2,content:content+"\n"})).json().revision).toBe(3);
  expect(await row()).toMatchObject({content:content+"\n",editor_document:null,revision:3});
  expect((await get()).json()).toMatchObject({draft:{content:content+"\n",revision:3},editor_document:null});
  const after=await state(pool);expect({...after,heads:[]}).toEqual({...before,heads:[]});
});
test("write AC3/4 checks guard before nested validation and rejects protected failures",async()=>{
  expect((await put(body())).statusCode).toBe(200);
  const before=await state(pool);
  const invalid={...body(1),editor_document:null};
  const current=await put(invalid);expect(current.statusCode).toBe(400);
  expect(current.json()).toEqual({error:{code:"validation_failed",message:"Request validation failed",details:{errors:[{path:"/editor_document",message:"must match the draft text and contain valid paragraph identities"}]}}});
  for (const [reason,payload] of [["version",{...invalid,base_version:"ver_000000000000"}],["revision",{...invalid,base_revision:0}]] as const){
    const result=await put(payload);expect(result.statusCode).toBe(409);
    expect(result.json()).toEqual({error:{code:"conflict",message:"Draft is out of date",details:{reason,current_version:base,current_revision:1}}});
  }
  const denied=await put(invalid,{});
  expect(denied.statusCode).toBe(401);expect(denied.json()).toEqual({error:{code:"auth_required",message:"Missing or invalid X-Axis-User header",details:null}});
  for(const reply of [await put(invalid,foreign),await put(invalid,owner,"c".repeat(65))]){
    expect(reply.statusCode).toBe(404);expect(reply.json()).toEqual({error:{code:"not_found",message:"Chapter not found",details:null}});
  }
  const malformed=await put("{", {...owner,"content-type":"application/json"});
  expect(malformed.statusCode).toBe(400);expect(malformed.json()).toEqual({error:{code:"validation_failed",message:"Request could not be parsed",details:null}});
  const unsupported=await put("plain",{...owner,"content-type":"text/plain"});
  expect(unsupported.statusCode).toBe(415);expect(unsupported.json()).toEqual({error:{code:"unsupported_media_type",message:"Content-Type must be application/json",details:null}});
  const oversized=await put({...body(1),content:"\u0001".repeat(1_400_000)});
  expect(oversized.statusCode).toBe(413);expect(oversized.json()).toEqual({error:{code:"payload_too_large",message:"Request body too large",details:null}});
  expect(await state(pool)).toEqual(before);
});
test("read AC3 invalid persisted data fails internally, owner check precedes validation",async()=>{
  expect((await put(body())).statusCode).toBe(200);
  await pool.query("UPDATE chapter_drafts SET editor_document='[{}]'::jsonb WHERE chapter_id=$1",[id]);
  const before=await state(pool);
  const read=await get();expect(read.statusCode).toBe(500);
  expect(read.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
  expect((await get(undefined,foreign)).statusCode).toBe(404);
  expect((await get("/working-state")).statusCode).toBe(200);
  expect(await state(pool)).toEqual(before);
});

test("write AC4 rolls back content, document and revision together when sync projection fails",async()=>{
  expect((await put(body())).statusCode).toBe(200);
  const before=await state(pool);
  const changed=[{kind:"paragraph",text:"Other text.",paragraph_id:"dp_00000000-0000-4000-8000-000000000002"}];
  const read=vi.spyOn(syncReader,"readChapterSync");
  read.mockRejectedValueOnce(new Error("sync projection failed "+id+" "+base+" "+P+" Other text."));
  const result=await put({content:"Other text.",base_version:base,base_revision:1,editor_document:changed});
  expect(result.statusCode).toBe(500);
  expect(result.json()).toEqual({error:{code:"internal",message:"Internal error",details:null}});
  expect(await state(pool)).toEqual(before);
  expect((await get()).json()).toMatchObject({editor_document:document,draft:{content,revision:1,base_version:base}});
  const output=logs.join("");for(const secret of [id,base,P,"Other text.","sync projection failed",JSON.stringify(content).slice(1,-1)])expect(output).not.toContain(secret);
  const failures=output.trim().split("\n").map(line=>JSON.parse(line)).filter(row=>row.event==="request_failed");
  expect(failures).toHaveLength(1);expect(failures[0]).toMatchObject({event:"request_failed",error_class:"unexpected",statusCode:500});
});
