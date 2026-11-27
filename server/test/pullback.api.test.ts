import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { ChapterCreated, VersionWritten } from "../src/corpus/repo.js";
import { runMigrations } from "../src/db/migrate.js";
import type { PullBackWritten } from "../src/pullback/pullback.js";
import { makePool, resetDb } from "./helpers.js";
import { seedSeries } from "./seed.js";

const pool = makePool();
const apiPool = {
  query: vi.fn(pool.query.bind(pool)),
  connect: vi.fn(() => pool.connect()),
};
const alice = { "x-axis-user": "usr_alice" };
const bob = { "x-axis-user": "usr_bob" };
const migration = "0011_chapter_pullbacks.sql";
const migrationDir = fileURLToPath(new URL("../db/migrations", import.meta.url));
let app: FastifyInstance;
let bookId: string;

beforeEach(async () => {
  await resetDb(pool);
  ({ bookId } = await seedSeries(pool));
  await seedSeries(pool, "usr_bob");
  vi.clearAllMocks();
  app = buildApp({ pool: apiPool as unknown as Pool });
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await pool.end();
});

async function create() {
  const reply = await app.inject({ method: "POST", url: `/books/${bookId}/chapters`, headers: alice, payload: { content: "abc" } });
  expect(reply.statusCode).toBe(201);
  return reply.json<ChapterCreated>();
}

async function send(id: string, content: string, parent_version: string) {
  const reply = await app.inject({ method: "POST", url: `/chapters/${id}/send`, headers: alice, payload: { content, parent_version } });
  expect(reply.statusCode).toBe(201);
  return reply.json<VersionWritten>();
}

async function sentChapter() {
  const first = await create();
  const sent = await send(first.chapter.id, "abc", first.version.id);
  return { ...sent, id: first.chapter.id };
}

function pullBack(id: string, headers: Record<string, string> = alice) {
  return app.inject({ method: "POST", url: `/chapters/${id}/pull-back`, headers });
}

async function marks() {
  return (await pool.query("SELECT chapter_id, book_version FROM chapter_pullbacks")).rows;
}


function errorEnvelope(code: string, message: string) {
  return { error: { code, message, details: null } };
}

test("AC1 applies, rolls back and reapplies migration 0011 and constrains the marked version", async () => {
  const down = await readFile(new URL("../db/rollback/0011_chapter_pullbacks.down.sql", import.meta.url), "utf8");
  const migrationRows = () => pool.query("SELECT filename FROM schema_migrations");
  const table = () => pool.query("SELECT to_regclass('chapter_pullbacks')::text AS name");
  const { rows: columns } = await pool.query(
    `SELECT column_name, is_nullable, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'chapter_pullbacks' ORDER BY ordinal_position`,
  );
  expect(columns).toEqual([
    { column_name: "chapter_id", is_nullable: "NO", data_type: "text" },
    { column_name: "book_version", is_nullable: "NO", data_type: "text" },
  ]);
  const { rows: [key] } = await pool.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'chapter_pullbacks'::regclass AND contype = 'p'",
  );
  expect(key).toEqual({ definition: "PRIMARY KEY (chapter_id)" });
  expect((await migrationRows()).rows).toHaveLength(15);
  const first = await create();
  const second = await create();
  await pool.query("INSERT INTO chapter_pullbacks VALUES ($1, $2)", [first.chapter.id, first.version.id]);

  await pool.query(down);
  try {
    expect((await table()).rows).toEqual([{ name: null }]);
    const { rows } = await migrationRows();
    expect(rows).toHaveLength(14);
    expect(rows).not.toContainEqual({ filename: migration });
    await expect(runMigrations(pool, migrationDir)).resolves.toEqual([migration]);
    expect((await table()).rows).toEqual([{ name: "chapter_pullbacks" }]);
    expect((await migrationRows()).rows).toHaveLength(15);
    expect(await marks()).toEqual([]);
    await expect(pool.query("INSERT INTO chapter_pullbacks VALUES ($1, $2)", [first.chapter.id, second.version.id]))
      .rejects.toMatchObject({ code: "23503" });
  } finally {
    await runMigrations(pool, migrationDir);
  }
});

test("AC3 checks identity, malformed IDs, ownership and whether the chapter is in the Book", async () => {
  const { id } = await sentChapter();
  const { chapter: neverSent } = await create();
  const chapterNotFound = errorEnvelope("not_found", "Chapter not found");
  const notInBook = errorEnvelope("not_in_book", "Chapter has no Book version");
  const auth = await pullBack(id, {});
  expect(auth.statusCode).toBe(401);
  expect(auth.json().error.code).toBe("auth_required");

  for (const reply of [await pullBack(id, bob), await pullBack("ch_missing")]) {
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual(chapterNotFound);
  }
  const unsent = await pullBack(neverSent.id);
  expect(unsent.statusCode).toBe(409);
  expect(unsent.json()).toEqual(notInBook);

  const inactive = await app.inject({
    method: "POST", url: `/chapters/${id}/activate`, headers: alice, payload: { version_id: null },
  });
  expect(inactive.statusCode).toBe(200);
  const rejected = await pullBack(id);
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json()).toEqual(notInBook);
  expect(await marks()).toEqual([]);

  vi.clearAllMocks();
  const tooLong = await pullBack("a".repeat(101));
  expect(tooLong.statusCode).toBe(404);
  expect(tooLong.json()).toEqual(errorEnvelope("not_found", "Route not found"));
  for (const malformed of ["a".repeat(70), "ch_%00"]) {
    const reply = await pullBack(malformed);
    expect(reply.statusCode).toBe(404);
    expect(reply.json()).toEqual(chapterNotFound);
  }
  expect(apiPool.query).not.toHaveBeenCalled();
  expect(apiPool.connect).not.toHaveBeenCalled();
});


const A="ch_00000000000a", B="ch_00000000000b", V="ver_00000000000a", VB="ver_00000000000b";
const seriesId="ser_000000000001", d18Book="bk_000000000001", owner={"x-axis-user":"usr_aa"}, other={"x-axis-user":"usr_bb"};
const hints=[{pov:"Mara",location:null,time:null,time_mode:"linear"}];
const pullPath="/chapters/"+A+"/pull-back", draftPath="/chapters/"+A+"/draft";
async function seedD18() {
  await resetDb(pool);
  await pool.query("INSERT INTO series(id,owner_id,title) VALUES ($1,'usr_aa','Ashfall')",[seriesId]);
  await pool.query("INSERT INTO books(id,series_id,title,ordinal,author_id) VALUES ($1,$2,'Ashfall',1,'usr_aa')",[d18Book,seriesId]);
  await pool.query("INSERT INTO chapters(id,book_id,order_key) VALUES ($1,$3,'0000001000'),($2,$3,'0000002000')",[B,A,d18Book]);
  for(const [ch,ver,content,h,l] of [[B,VB,"Brook.",[],1],[A,V,"River.",hints,2]] as const){
    await pool.query("INSERT INTO ledger(series_id,l_seq,door,actor,op,target_ids) VALUES ($1,$2,'corpus','usr_aa','chapter.send',ARRAY[$3::text])",[seriesId,l,ver]);
    await pool.query("INSERT INTO chapter_versions(id,series_id,chapter_id,version_no,source,content,text_hash,hints_hash,parent_version,l_seq) VALUES ($1,$2,$3,1,'send',$4,encode(sha256(convert_to(axis_fold($4),'UTF8')),'hex'),axis_hints_hash($5::jsonb),NULL,$6)",[ver,seriesId,ch,content,JSON.stringify(h),l]);
    await pool.query("SELECT axis_intake_store($1,$2::jsonb)",[ver,JSON.stringify(h)]);
    await pool.query("INSERT INTO chapter_active(series_id,chapter_id,version_id,since_l) VALUES ($1,$2,$3,$4)",[seriesId,ch,ver,l]);
  }
  await pool.query("INSERT INTO chapter_drafts(chapter_id,base_version,content,revision) VALUES ($1,$2,'River.',1)",[A,V]);
  await pool.query("INSERT INTO named_cuts(chapter_id,version_id,series_id,l_seq,label) VALUES ($1,$2,$3,1,'Existing name')",[B,VB,seriesId]);
}
async function counts(){
  return (await pool.query("SELECT (SELECT count(*)::int FROM ledger) AS ledger,(SELECT count(*)::int FROM chapter_versions) AS versions,(SELECT count(*)::int FROM chapter_active) AS active,(SELECT count(*)::int FROM chapter_drafts) AS heads,(SELECT count(*)::int FROM chapter_pullbacks) AS marks,(SELECT count(*)::int FROM named_cuts) AS labels")).rows[0]!;
}
async function latest(){
  return (await pool.query("SELECT id,source,content,hints_hash,parent_version FROM chapter_versions WHERE chapter_id=$1 ORDER BY version_no DESC LIMIT 1",[A])).rows[0]!;
}
async function snapshot(){
  return {counts:await counts(),head:(await pool.query("SELECT * FROM chapter_drafts WHERE chapter_id=$1",[A])).rows,
    mark:await marks(),active:(await pool.query("SELECT * FROM chapter_active ORDER BY chapter_id,since_l")).rows,latest:await latest(),
    labels:(await pool.query("SELECT * FROM named_cuts ORDER BY chapter_id")).rows};
}
const guarded=()=>app.inject({method:"POST",url:pullPath,headers:owner,payload:{expected_active_version_id:V}});
const conflict=(reason:string)=>({error:{code:"pull_back_conflict",message:"Pull back requires a different action",details:{reason}}});
const assertSuccess=(response:Awaited<ReturnType<typeof guarded>>)=>{
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({chapter:{id:A,book_id:d18Book,order_key:"0000002000"},active_version_id:V});
};

test("AXB-0129 AC1 preserves an inert version, hints and every active coordinate",async()=>{
  await seedD18();
  const before=await snapshot();
  assertSuccess(await guarded());
  const after=await snapshot();
  expect(after.counts).toEqual({...before.counts,ledger:before.counts.ledger+1,versions:before.counts.versions+1,heads:0,marks:1});
  expect(after.latest).toMatchObject({source:"draft_edit",content:"River.",hints_hash:before.latest.hints_hash,parent_version:V});
  expect(after.latest.id).not.toBe(V);
  expect(after.active).toEqual(before.active);expect(after.labels).toEqual(before.labels);expect(after.head).toEqual([]);
  expect(after.mark).toEqual([{chapter_id:A,book_version:V}]);
  expect((await pool.query("SELECT actor,door,op,target_ids FROM ledger WHERE op='chapter.pull_back'")).rows).toEqual([{actor:"usr_aa",door:"corpus",op:"chapter.pull_back",target_ids:[after.latest.id]}]);
  expect((await pool.query("SELECT pov_hint,location_hint,time_hint,time_mode FROM scenes WHERE version_id=$1",[after.latest.id])).rows).toEqual([{pov_hint:"Mara",location_hint:null,time_hint:null,time_mode:"linear"}]);
  const history=await app.inject({method:"GET",url:"/chapters/"+A+"/history",headers:owner});
  expect(history.statusCode).toBe(200);expect(history.json()).toMatchObject({active_version_id:V,versions:[{id:after.latest.id,source:"draft_edit",snapshot:null,can_name_snapshot:false},{id:V}]});
  expect((await pool.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(15);
});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {resolve,promise};}
async function ordered(first:()=>PromiseLike<unknown>,second:()=>PromiseLike<unknown>){
  const locked=deferred(), release=deferred(), queued=deferred();
  const one=await pool.connect(), two=await pool.connect();
  const original1=one.query.bind(one),original2=two.query.bind(two);
  const query1=vi.spyOn(one,"query").mockImplementation((async(sql:string,values?:unknown[])=>{
    const result=await original1(sql,values);
    if(sql.includes("FOR NO KEY UPDATE")&&sql.includes("FROM series")){locked.resolve();await release.promise;}
    return result;
  }) as PoolClient["query"]);
  const query2=vi.spyOn(two,"query").mockImplementation((async(sql:string,values?:unknown[])=>{
    const result=original2(sql,values);
    if(sql.includes("FOR NO KEY UPDATE")&&sql.includes("FROM series"))queued.resolve();
    return await result;
  }) as PoolClient["query"]);
  apiPool.connect.mockResolvedValueOnce(one).mockResolvedValueOnce(two);
  let p1:Promise<unknown>|undefined,p2:Promise<unknown>|undefined;
  try{
    p1=Promise.resolve(first());
    await Promise.race([locked.promise,p1.then(()=>{throw new Error("first did not acquire Series lock");})]);
    p2=Promise.resolve(second());
    await Promise.race([queued.promise,p2.then(()=>{throw new Error("second did not request Series lock");})]);
    release.resolve();
    return await Promise.all([p1,p2]) as [Awaited<ReturnType<typeof guarded>>,Awaited<ReturnType<typeof guarded>>];
  }finally{
    release.resolve();
    await Promise.allSettled([p1,p2]);
    query1.mockRestore();query2.mockRestore();
  }
}
test("AXB-0129 AC2 two actual connections serialize the first press and replay",async()=>{
  await seedD18();
  const [first,second]=await ordered(guarded,guarded);assertSuccess(first);assertSuccess(second);
  expect((await pool.query("SELECT count(*)::int AS n FROM ledger WHERE op='chapter.pull_back'")).rows[0].n).toBe(1);
  expect((await pool.query("SELECT count(*)::int AS n FROM chapter_versions WHERE chapter_id=$1",[A])).rows[0].n).toBe(2);
  const after=await snapshot();
  assertSuccess(await app.inject({method:"POST",url:pullPath,headers:owner}));
  expect(await snapshot()).toEqual(after);
});
test("AXB-0129 AC3 denial matrix preserves all six counts, active version, mark and raw head",async()=>{
  for(const scenario of ["anonymous","foreign","unknown","extra","null-value","wrong-id","null-body","malformed","type","oversize","released","inactive","stale","different","folded","hints"]){
    await seedD18();
    let expected=409,code="pull_back_conflict",details:unknown={reason:"base_choice_required"};
    let options:import("light-my-request").InjectOptions={method:"POST",url:pullPath,headers:owner,payload:{expected_active_version_id:V}};
    switch(scenario){
      case "anonymous":options={...options,headers:{},payload:{extra:1}};expected=401;code="auth_required";details=null;break;
      case "foreign":options={...options,headers:other};expected=404;code="not_found";details=null;break;
      case "unknown":options={...options,url:"/chapters/ch_ffffffffffff/pull-back"};expected=404;code="not_found";details=null;break;
      case "extra":options={...options,payload:{expected_active_version_id:V,extra:true}};expected=400;code="validation_failed";details=undefined;break;
      case "null-value":options={...options,payload:{expected_active_version_id:null}};expected=400;code="validation_failed";details=undefined;break;
      case "wrong-id":options={...options,payload:{expected_active_version_id:"ver_BAD"}};expected=400;code="validation_failed";details=undefined;break;
      case "null-body":options={...options,headers:{...owner,"content-type":"application/json"},payload:"null"};expected=400;code="validation_failed";details=undefined;break;
      case "malformed":options={...options,headers:{...owner,"content-type":"application/json"},payload:"{"};expected=400;code="validation_failed";details=null;break;
      case "type":options={...options,headers:{...owner,"content-type":"text/plain"},payload:"x"};expected=415;code="unsupported_media_type";details=null;break;
      case "oversize":options={...options,payload:{expected_active_version_id:"x".repeat(1048577)}};expected=413;code="payload_too_large";details=null;break;
      case "released":await pool.query("UPDATE books SET status='released' WHERE id=$1",[d18Book]);details={reason:"released_book"};break;
      case "inactive":await app.inject({method:"POST",url:"/chapters/"+A+"/activate",headers:owner,payload:{version_id:null}});code="not_in_book";details=null;break;
      case "stale":options={...options,payload:{expected_active_version_id:VB}};details={reason:"active_changed"};break;
      case "different":await pool.query("UPDATE chapter_drafts SET content='River B' WHERE chapter_id=$1",[A]);break;
      case "folded":await pool.query("UPDATE chapter_drafts SET content='  River.  ' WHERE chapter_id=$1",[A]);break;
      case "hints":await pool.query("SELECT commit_inputs($1,'corpus','usr_aa','chapter.version.append',$2::jsonb)",[seriesId,JSON.stringify([{kind:"chapter_version",chapter_id:A,content:"River.",source:"draft_edit",parent_version:V}])]);break;
    }
    const before=await snapshot();
    const response=await app.inject(options);
    expect(response.statusCode,scenario).toBe(expected);
    expect(response.json().error.code,scenario).toBe(code);
    if(details!==undefined)expect(response.json().error.details,scenario).toEqual(details);
    else expect(response.json().error.details.errors.length,scenario).toBeGreaterThan(0);
    if(code==="pull_back_conflict")expect(response.json()).toEqual(conflict((details as {reason:string}).reason));
    if(code==="not_found")expect(response.json()).toEqual(errorEnvelope("not_found","Chapter not found"));
    if(code==="not_in_book")expect(response.json()).toEqual(errorEnvelope("not_in_book","Chapter has no Book version"));
    expect(await snapshot(),scenario).toEqual(before);
  }
});
test("AXB-0129 AC4 whichever cooperating writer acquires the Series lock first wins",async()=>{
  const put=()=>app.inject({method:"PUT",url:draftPath,headers:owner,payload:{content:"river B",base_version:V,base_revision:1}});
  await seedD18();
  const [written,denied]=await ordered(put,guarded);
  expect(written.statusCode).toBe(200);expect(denied.statusCode).toBe(409);expect(denied.json()).toEqual(conflict("base_choice_required"));
  expect((await snapshot()).head).toEqual([{chapter_id:A,base_version:V,revision:2,content:"river B"}]);
  await seedD18();
  const [landed,stale]=await ordered(guarded,put);assertSuccess(landed);
  expect(stale.statusCode).toBe(409);expect(stale.json().error).toMatchObject({code:"conflict",details:{reason:"version",current_version:(await latest()).id,current_revision:0}});
  expect((await snapshot()).head).toEqual([]);
});
test("AXB-0129 AC5 mark insert failure rolls back the new version and its head clear",async()=>{
  await seedD18();const before=await snapshot();
  await pool.query("CREATE FUNCTION d18_fail_mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only mark failure'; END $$; CREATE TRIGGER d18_fail_mark BEFORE INSERT ON chapter_pullbacks FOR EACH ROW EXECUTE FUNCTION d18_fail_mark()");
  try{
    const reply=await guarded();expect(reply.statusCode).toBe(500);expect(reply.json()).toEqual(errorEnvelope("internal","Internal error"));
    expect(await snapshot()).toEqual(before);
  }finally{await pool.query("DROP TRIGGER IF EXISTS d18_fail_mark ON chapter_pullbacks; DROP FUNCTION IF EXISTS d18_fail_mark()");}
});
