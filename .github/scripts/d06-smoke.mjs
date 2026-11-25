import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const children = [];
function start(command, args, cwd) {
  const proc = spawn(command, args, { cwd, stdio: 'inherit', env: process.env });
  const done = once(proc, 'exit');
  children.push({ proc, done });
}
async function waitFor(url) {
  for (let i=0; i<100; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Startup failed: '+url);
}
async function api(method, path, status, body) {
  const response = await fetch('http://localhost:4173/api'+path, {
    method, headers: {'X-Axis-User':'usr_alice', ...(body===undefined ? {} : {'Content-Type':'application/json'})},
    ...(body===undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(10000)
  });
  const data=await response.json();
  assert.equal(response.status,status,method+' '+path+' '+JSON.stringify(data));
  console.log(method,path,status);
  return data;
}
let error;
try {
  start('node',['dist/src/main.js'],'server');
  start('node',['.d06-preview.mjs'],'client');
  await waitFor('http://localhost:3000/health');
  await waitFor('http://localhost:4173');
  const series=await api('POST','/series',201,{title:'Ashfall'});
  const book=series.books[0].id;
  const first=await api('POST','/books/'+book+'/chapters',201,{content:''});
  const ch=first.chapter.id, v1=first.version.id;
  const path='/chapters/'+ch;
  let detail=await api('GET',path,200);
  assert.equal(detail.version.id,v1); assert.equal(detail.version.content,'');
  assert.deepEqual(detail.blocks,[]); assert.equal(detail.active_version_id,null);
  const content='# Title\n\nHello';
  const saved=await api('POST',path+'/versions',201,{content,parent_version:v1});
  assert.equal(saved.version.version_no,2); assert.equal(saved.version.source,'draft_edit');
  assert.equal(saved.active_version_id,null);
  detail=await api('GET',path,200);
  assert.equal(detail.version.content,content);
  assert.deepEqual(detail.blocks.map(({kind,text})=>({kind,text})),[{kind:'heading',text:'Title'},{kind:'paragraph',text:'Hello'}]);
  const sent=await api('POST',path+'/send',201,{content,parent_version:saved.version.id});
  assert.equal(sent.version.version_no,3); assert.equal(sent.version.source,'send');
  assert.equal(sent.active_version_id,sent.version.id);
  const list=await api('GET','/books/'+book+'/chapters',200);
  assert.equal(list.chapters.length,1);
  assert.equal(list.chapters[0].title,'Title'); assert.equal(list.chapters[0].word_count,2);
  assert.equal(list.chapters[0].version_id,sent.version.id);
  assert.equal(list.chapters[0].active_version_id,sent.version.id);
} catch (e) { error=e; }
finally {
  for (const {proc} of children) if(proc.exitCode===null && proc.signalCode===null) proc.kill('SIGTERM');
  const timer=setTimeout(()=>{for(const {proc} of children) if(proc.exitCode===null && proc.signalCode===null) proc.kill('SIGKILL');},10000);
  try {
    const exits=await Promise.all(children.map(x=>x.done));
    console.log('Process exits:',JSON.stringify(exits));
    for(const [code,signal] of exits) assert.equal(code,0,'Nonzero process exit: '+signal);
  } catch(e) { error??=e; } finally { clearTimeout(timer); }
}
if(error) throw error;
console.log('D06 live smoke passed');
