import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { request, withPreview } from "./preview-smoke.mjs";
const { chromium } = await import(pathToFileURL(process.env.AXIS_BROWSER_MODULE).href);
const part=(page,name)=>page.locator('[data-part="'+name+'"]');
const computed=(locator,property)=>locator.evaluate((el,key)=>getComputedStyle(el).getPropertyValue(key),property);
const rgb=s=>s.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(n=>s.startsWith("color(srgb")?n*255:n);
const luminance=s=>rgb(s).map(n=>n/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
const themes=["light","dark","sepia"], profiles=["literary","modern","warm"];
const failures=[];
function floor(label,a,b,min){
 const ratio=contrast(a,b);console.log(JSON.stringify({label,foreground:a,background:b,ratio,minimum:min}));
 if(ratio<min)failures.push({label,foreground:a,background:b,ratio,minimum:min});
}
const artifact=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,"axis-d19-browser"):null;
async function snap(locator,name){const shot=await locator.screenshot({animations:"disabled",caret:"hide"});if(artifact)await writeFile(join(artifact,name+".png"),shot);return shot;}
async function loaded(page,url,series){
 await page.addInitScript(id=>localStorage.setItem("axis.lastSeriesId",id),series);
 await page.goto(url);await part(page,"chapter-open").first().click();await part(page,"editor").waitFor();
}
function nativeOrder(page){return page.locator('[data-surface="draft"]').evaluate(root=>Array.from(root.querySelectorAll("[data-part]")).map(e=>[e.getAttribute("data-part"),e.tagName,e.getAttribute("aria-label"),e.matches("button")?e.textContent:null]));}
function tooltip(page,reason){return page.locator('[role="tooltip"]').filter({hasText:reason});}
const reason="Finish or cancel the open snapshot form.";
async function assertGeometry(page,tip){
 const b=await tip.boundingBox();
 const v=await page.evaluate(()=>({x:visualViewport?.offsetLeft??0,y:visualViewport?.offsetTop??0,w:visualViewport?.width??innerWidth,h:visualViewport?.height??innerHeight}));
 assert.ok(b&&b.width<=260.1&&b.x>=v.x+7.5&&b.y>=v.y+7.5&&b.x+b.width<=v.x+v.w-7.5&&b.y+b.height<=v.y+v.h-7.5,JSON.stringify({b,v}));
 assert.equal(await computed(tip,"position"),"fixed");
 assert.equal(await computed(tip,"border-top-left-radius"),"6px");
 assert.equal(await computed(tip,"padding-inline-start"),"8px");
 assert.equal(await computed(tip,"padding-block-start"),"4px");
 assert.equal(await computed(tip,"z-index"),"70");
 assert.equal(await computed(tip,"animation-name"),"none");
 assert.equal(await computed(tip,"transition-duration"),"0s");
 assert.ok(await tip.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
}
await withPreview(async()=>{
 if(artifact)await mkdir(artifact,{recursive:true});
 const tree=await request(1,"POST","/series",201,{title:"D19 browser acceptance"});
 const first=await request(2,"POST","/books/"+tree.books[0].id+"/chapters",201,{content:"# North\n\nRiver.\n\nHe nodded.\n\nHe nodded.\n\n* * *\n\nBrook."});
 const browser=await chromium.launch({headless:true,...(process.env.AXIS_BROWSER_EXECUTABLE?{executablePath:process.env.AXIS_BROWSER_EXECUTABLE}:{})});
 let old;
 try{
  const root=process.env.AXIS_D18_CLIENT;
  if(root){
   old=spawn(process.execPath,[join(root,"node_modules/vite/bin/vite.js"),"preview","--port","4174","--strictPort"],{cwd:root,stdio:"inherit",env:{...process.env,AXIS_API_URL:"http://localhost:3000"}});
   for(let i=0;i<100;i++){try{if((await fetch("http://localhost:4174/")).ok)break;}catch{}if(i===99)throw new Error("D18 preview unavailable");await new Promise(r=>setTimeout(r,200));}
  }
  const context=await browser.newContext({viewport:{width:1360,height:900},reducedMotion:"reduce"});
  const page=await context.newPage(),writes=[];
  page.on("request",r=>{if(["PUT","POST","DELETE","PATCH"].includes(r.method()))writes.push(r.method());});
  await loaded(page,"http://localhost:4173/",tree.series.id);
  const editor=part(page,"editor"),leaf=page.locator(".ax-leaf"),trigger=part(page,"snapshot");
  const initialOrder=await nativeOrder(page);
  assert.equal(await editor.getAttribute("aria-label"),"Chapter text");
  assert.equal(await editor.locator("hr").getAttribute("aria-label"),"Scene break");
  assert.equal(await editor.locator("[data-block-uid]").count(),0);
  assert.equal(await trigger.getAttribute("aria-describedby"),null);
  const before=await snap(editor,"d19-clean");
  if(root){
   const baseline=await context.newPage();await loaded(baseline,"http://localhost:4174/",tree.series.id);
   assert.deepEqual(await nativeOrder(baseline),initialOrder);
   assert.ok((await snap(part(baseline,"editor"),"d18-clean")).equals(before),"D19 clean manuscript differs from predecessor");
   await part(baseline,"snapshot").click();
   await trigger.click();
   assert.deepEqual(await nativeOrder(baseline),await nativeOrder(page));
   await baseline.close();
  }else{await trigger.click();}
  const tip=tooltip(page,reason);
  await page.mouse.move(1,1);
  assert.equal(await trigger.getAttribute("aria-disabled"),"true");
  assert.equal(await trigger.getAttribute("aria-describedby"),await tip.getAttribute("id"));
  assert.equal(await tip.isVisible(),false);
  // Establish a fresh, unfocused hover; measure real event-to-visibility
  // time rather than relying on how long a busy CI driver takes to poll.
  await trigger.focus();await page.keyboard.press("Escape");
  await part(page,"snapshot-name").focus();await page.mouse.move(1,1);
  await tip.waitFor({state:"hidden"});
  await page.evaluate(()=>{
   const anchor=document.querySelector('[data-part="snapshot"]'),tip=document.getElementById(anchor.getAttribute("aria-describedby"));
   window.__d19Hover={start:null,end:null,token:getComputedStyle(anchor).getPropertyValue("--ax-dwell-tooltip"),grace:getComputedStyle(anchor).getPropertyValue("--ax-dur-hover")};
   anchor.addEventListener("pointerenter",()=>{window.__d19Hover.start=performance.now();},{once:true});
   const observer=new MutationObserver(()=>{
    if(!tip.hidden){window.__d19Hover.end=performance.now();observer.disconnect();}
   });
   observer.observe(tip,{attributes:true,attributeFilter:["hidden"]});
  });
  const anchorBox=await trigger.boundingBox();
  await page.mouse.move(anchorBox.x+anchorBox.width/2,anchorBox.y+anchorBox.height/2);
  await tip.waitFor({state:"visible",timeout:2000});
  const dwell=await page.evaluate(()=>window.__d19Hover);
  console.log("D19 native hover dwell:",JSON.stringify(dwell));
  assert.ok(dwell.start!==null&&dwell.end!==null&&dwell.end-dwell.start>=499,JSON.stringify(dwell));
  await assertGeometry(page,tip);
  // Passing from anchor into the tooltip must preserve visibility across the gap.
  const b=await tip.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
  await page.waitForTimeout(150);assert.equal(await tip.isVisible(),true);
  await page.mouse.move(1,1);await tip.waitFor({state:"hidden",timeout:1000});
  await page.keyboard.press("Tab");await trigger.focus();await tip.waitFor({state:"visible"});assert.equal(await trigger.evaluate(e=>document.activeElement===e),true);
  assert.equal(await computed(trigger,"opacity"),"1");assert.equal(await computed(trigger,"outline-width"),"2px");
  await page.keyboard.press("Escape");await tip.waitFor({state:"hidden"});
  await page.waitForTimeout(600);assert.equal(await tip.isVisible(),false);
  assert.equal(await trigger.evaluate(e=>document.activeElement===e),true);
  await part(page,"snapshot-name").focus();await trigger.focus();await tip.waitFor({state:"visible"});
  await page.mouse.click(1,1);await tip.waitFor({state:"hidden"});
  for(const scale of [16,32]){
   await page.evaluate(px=>document.documentElement.style.fontSize=px+"px",scale);
   for(const width of [320,767,768,1024,1261,1262,1360]){
    await page.setViewportSize({width,height:900});
    await part(page,"snapshot-name").focus();await trigger.focus();await tip.waitFor({state:"visible"});
    await assertGeometry(page,tip);
    assert.equal(await computed(tip,"font-size"),scale*.75+"px");
    assert.equal(await computed(tip,"line-height"),scale+"px");
   }
  }
  await page.evaluate(()=>document.documentElement.style.fontSize="16px");await page.setViewportSize({width:1360,height:900});
  for(const theme of themes)for(const profile of profiles){
   await page.evaluate(([t,p])=>{document.documentElement.dataset.theme=t;const leaf=document.querySelector(".ax-leaf");leaf.dataset.theme=t;leaf.dataset.profile=p;},[theme,profile]);
   await part(page,"snapshot-name").focus();await trigger.focus();await tip.waitFor({state:"visible"});await assertGeometry(page,tip);
   const paper=await computed(leaf,"background-color"),ink=await computed(leaf,"color"),edge=await computed(leaf.locator(".ax-leaf-edge").first(),"background-color");
   const shell=await computed(page.locator("body"),"background-color");
   const colors=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement);return Object.fromEntries(["surface-raised","border-control","text-primary","text-secondary","text-tertiary","focus"].map(k=>[k,s.getPropertyValue("--ax-color-"+k).trim()]));});
   const cssColor=async hex=>page.evaluate(h=>{const e=document.createElement("span");e.style.color=h;document.body.append(e);const c=getComputedStyle(e).color;e.remove();return c;},hex);
   const label=theme+"/"+profile;
   floor(label+" page ink",ink,paper,10.3);floor(label+" leaf vs paper",edge,paper,2);floor(label+" leaf vs shell",edge,shell,2);
   floor(label+" tooltip text",await computed(tip,"color"),await computed(tip,"background-color"),4.5);
   floor(label+" focus ring vs shell",await computed(trigger,"outline-color"),shell,3);
   for(const fill of [shell,paper,await cssColor(colors["surface-raised"])]){
    floor(label+" control border",await cssColor(colors["border-control"]),fill,3);
    floor(label+" body ink",await cssColor(colors["text-primary"]),fill,7);
    floor(label+" secondary ink",await cssColor(colors["text-secondary"]),fill,4.5);
    floor(label+" tertiary ink",await cssColor(colors["text-tertiary"]),fill,4.5);
   }
   if(theme==="dark")floor(label+" tooltip outline",await computed(tip,"border-top-color"),await computed(tip,"background-color"),3);
   await snap(tip,"tooltip-"+theme+"-"+profile);
  }
  await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
  assert.equal(await computed(tip,"forced-color-adjust"),"auto");assert.equal(await computed(tip,"border-top-width"),"1px");
  assert.equal(await computed(tip,"transition-duration"),"0s");await assertGeometry(page,tip);
  await page.emulateMedia({forcedColors:"none",reducedMotion:"reduce"});
  await page.evaluate(()=>{document.documentElement.dataset.theme="light";const leaf=document.querySelector(".ax-leaf");leaf.dataset.theme="light";leaf.dataset.profile="literary";});
  await part(page,"snapshot-name").focus();await page.keyboard.press("Escape");
  await part(page,"snapshot-form").waitFor({state:"detached"});assert.equal(await page.locator(".ax-tooltip").count(),0);
  assert.equal(await trigger.getAttribute("aria-describedby"),null);
  assert.ok((await snap(editor,"d19-after-tooltip")).equals(before),"Tooltip changed manuscript rendering");
  assert.deepEqual(writes,[]);
  const fonts=await page.evaluate(()=>({declared:[...document.fonts].map(f=>({family:f.family,status:f.status})),computedEditor:getComputedStyle(document.querySelector(".ax-leaf")).fontFamily,computedChrome:getComputedStyle(document.body).fontFamily}));
  console.log("D19 font inventory (declared faces; system fallback is not verified licensed font metrics):",JSON.stringify(fonts));
  await context.close();
  const touch=await browser.newContext({viewport:{width:1360,height:900},hasTouch:true,reducedMotion:"reduce"});
  const mobile=await touch.newPage();await loaded(mobile,"http://localhost:4173/",tree.series.id);
  await part(mobile,"snapshot").click();const mt=part(mobile,"snapshot"),tt=tooltip(mobile,reason);
  const pos=await mt.boundingBox();assert.ok(pos.width>=44&&pos.height>=44);
  const cdp=await touch.newCDPSession(mobile);
  const point={x:pos.x+pos.width/2,y:pos.y+pos.height/2};
  const send=(type,points)=>cdp.send("Input.dispatchTouchEvent",{type,touchPoints:points});
  await send("touchStart",[point]);await mobile.waitForTimeout(150);await send("touchEnd",[]);
  await mobile.waitForTimeout(550);assert.equal(await tt.isVisible(),false,"short touch showed tooltip");
  await mobile.evaluate(()=>{
   const anchor=document.querySelector('[data-part="snapshot"]'),tip=document.getElementById(anchor.getAttribute("aria-describedby"));
   window.__d19Touch={start:null,end:null};
   anchor.addEventListener("pointerdown",()=>{window.__d19Touch.start=performance.now();},{once:true});
   const observer=new MutationObserver(()=>{if(!tip.hidden){window.__d19Touch.end=performance.now();observer.disconnect();}});
   observer.observe(tip,{attributes:true,attributeFilter:["hidden"]});
  });
  await send("touchStart",[point]);await tt.waitFor({state:"visible",timeout:2000});
  const touchDwell=await mobile.evaluate(()=>window.__d19Touch);
  console.log("D19 native long-press dwell:",JSON.stringify(touchDwell));
  assert.ok(touchDwell.start!==null&&touchDwell.end!==null&&touchDwell.end-touchDwell.start>=499,JSON.stringify(touchDwell));
  await send("touchEnd",[]);
  await mobile.waitForTimeout(150);assert.equal(await tt.isVisible(),true);
  await mobile.keyboard.press("Escape");await tt.waitFor({state:"hidden"});
  await touch.close();
  const live=await request(3,"GET","/chapters/"+first.chapter.id+"/working-state",200);
  assert.equal(live.version.id,first.version.id);assert.equal(live.draft,null);
 }finally{
  await browser.close();if(old)old.kill("SIGTERM");
 }
});
console.log("D19 fixed-colour contrast conflicts:",JSON.stringify(failures,null,2));
assert.equal(failures.length,0,"D19 DV-6 fixed-colour contrast requirements failed (no rounding or threshold relaxation)");
console.log("D19 browser acceptance passed");
